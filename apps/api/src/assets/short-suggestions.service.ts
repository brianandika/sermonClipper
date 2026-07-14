import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { MAX_SHORT_DURATION_SEC, type ShortSuggestion } from "@sermon-clipper/shared";
import { env } from "../config/env";
import { AssetsService } from "./assets.service";

interface ParsedCue {
    start: number;
    end: number;
    text: string;
}

// "HH:MM:SS.mmm" / "MM:SS.mmm" → seconds. Returns null on anything unparseable.
function parseVttTimestamp(raw: string): number | null {
    const match = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (!match) return null;
    const [, hours, minutes, seconds, millis] = match;
    const value =
        (hours ? Number.parseInt(hours, 10) * 3600 : 0) +
        Number.parseInt(minutes ?? "0", 10) * 60 +
        Number.parseInt(seconds ?? "0", 10) +
        (millis ? Number.parseInt(millis.padEnd(3, "0"), 10) / 1000 : 0);
    return Number.isFinite(value) ? value : null;
}

// Minimal WebVTT reader: pulls out "start --> end\ntext" blocks and ignores the
// header, NOTE blocks, and cue settings after the timestamps.
function parseVtt(text: string): ParsedCue[] {
    const cues: ParsedCue[] = [];
    const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.split("\n").filter((line) => line.trim().length > 0);
        const arrowIndex = lines.findIndex((line) => line.includes("-->"));
        if (arrowIndex === -1) continue;

        const [startRaw, endRaw] = lines[arrowIndex].split("-->");
        const start = parseVttTimestamp(startRaw ?? "");
        const end = parseVttTimestamp((endRaw ?? "").trim().split(/\s+/)[0] ?? "");
        if (start === null || end === null || end <= start) continue;

        const body = lines.slice(arrowIndex + 1).join(" ").trim();
        if (body.length > 0) cues.push({ start, end, text: body });
    }

    return cues;
}

// A compact, timecoded transcript the model can reason over. Each line is
// "[seconds] text" so the model can return start/end as source offsets.
function buildTimecodedTranscript(cues: ParsedCue[]): string {
    return cues.map((cue) => `[${cue.start.toFixed(1)}] ${cue.text}`).join("\n");
}

@Injectable()
export class ShortSuggestionsService {
    constructor(private readonly assets: AssetsService) { }

    async suggest(sessionId: string, assetId: string): Promise<ShortSuggestion[]> {
        if (!env.geminiApiKey) {
            throw new ServiceUnavailableException(
                "AI suggestions aren't configured. Set GEMINI_API_KEY on the API to enable them.",
            );
        }

        const asset = await this.assets.getOwnedAsset(sessionId, assetId);
        if (!asset.transcriptPath) {
            throw new BadRequestException("This source has no transcript yet. Prepare one first.");
        }

        let vtt: string;
        try {
            vtt = await readFile(asset.transcriptPath, "utf8");
        } catch {
            throw new NotFoundException("Transcript file could not be read.");
        }

        const cues = parseVtt(vtt);
        if (cues.length === 0) {
            throw new BadRequestException("The transcript has no usable cues to analyze.");
        }

        const duration = asset.duration && asset.duration > 0 ? asset.duration : undefined;
        const raw = await this.callGemini(buildTimecodedTranscript(cues));
        return this.normalize(raw, duration);
    }

    // One Gemini generateContent call with a forced JSON schema, so the response
    // is a parseable array without prose or markdown fences to strip.
    private async callGemini(transcript: string): Promise<unknown> {
        const prompt = [
            "You are helping a church turn a sermon into short vertical video clips (YouTube Shorts / Reels).",
            "Below is the sermon transcript. Each line is prefixed with its start time in seconds: \"[seconds] text\".",
            "",
            "Pick the 6-9 most compelling, self-contained moments to clip. Favor: a memorable story, a punchy",
            "one-liner, an emotional peak, a clear takeaway, or a surprising statement. Each moment should stand",
            `on its own without surrounding context and be between 20 and ${MAX_SHORT_DURATION_SEC} seconds long.`,
            "",
            "For each moment return: start and end (seconds into the sermon, aligned to the transcript timings),",
            "a short punchy heading (max ~60 characters, no quotes), and a one-to-two sentence description of why",
            "it would make a good short. Order them best-first.",
            "",
            "Transcript:",
            transcript,
        ].join("\n");

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`;
        const requestBody = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.4,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            start: { type: "number" },
                            end: { type: "number" },
                            heading: { type: "string" },
                            description: { type: "string" },
                        },
                        required: ["start", "end", "heading", "description"],
                    },
                },
            },
        };

        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });
        } catch (error) {
            throw new ServiceUnavailableException(
                `Couldn't reach the Gemini API: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new ServiceUnavailableException(
                `Gemini API error (${response.status}). ${detail.slice(0, 300)}`.trim(),
            );
        }

        const data = (await response.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            throw new ServiceUnavailableException("Gemini returned an empty response.");
        }

        try {
            return JSON.parse(text);
        } catch {
            throw new ServiceUnavailableException("Gemini returned a response that wasn't valid JSON.");
        }
    }

    // Coerce, validate, and clamp the model output so the UI only ever sees
    // well-formed moments inside the source and within the shorts length cap.
    private normalize(raw: unknown, duration: number | undefined): ShortSuggestion[] {
        if (!Array.isArray(raw)) return [];

        const suggestions: ShortSuggestion[] = [];
        for (const entry of raw) {
            if (!entry || typeof entry !== "object") continue;
            const candidate = entry as Record<string, unknown>;

            let start = Number(candidate.start);
            let end = Number(candidate.end);
            const heading = typeof candidate.heading === "string" ? candidate.heading.trim() : "";
            const description = typeof candidate.description === "string" ? candidate.description.trim() : "";

            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            start = Math.max(0, start);
            if (duration !== undefined) end = Math.min(end, duration);
            if (end <= start) continue;

            // Enforce the platform length cap by trimming the tail, not dropping it.
            if (end - start > MAX_SHORT_DURATION_SEC) end = start + MAX_SHORT_DURATION_SEC;
            if (!heading) continue;

            suggestions.push({
                start: Number(start.toFixed(3)),
                end: Number(end.toFixed(3)),
                heading: heading.slice(0, 120),
                description,
            });
        }

        return suggestions;
    }
}
