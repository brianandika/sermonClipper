import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Asset } from "@prisma/client";
import type { TranscriptCue } from "@sermon-clipper/shared";
import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Express } from "express";
import { env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

function formatVttTime(seconds: number): string {
    const clamped = Math.max(0, seconds);
    let hours = Math.floor(clamped / 3600);
    let minutes = Math.floor((clamped % 3600) / 60);
    let secs = Math.floor(clamped % 60);
    let ms = Math.round((clamped - Math.floor(clamped)) * 1000);
    if (ms === 1000) {
        ms = 0;
        secs += 1;
        if (secs === 60) {
            secs = 0;
            minutes += 1;
            if (minutes === 60) {
                minutes = 0;
                hours += 1;
            }
        }
    }
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(ms, 3)}`;
}

// Serialize cues into a canonical WebVTT. Drops empty/invalid cues, orders by
// start, and neutralizes anything that would break the cue grammar.
function buildVtt(cues: TranscriptCue[]): string {
    const blocks = [...cues]
        .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
        .sort((a, b) => a.start - b.start)
        .map((cue) => ({ ...cue, text: cue.text.replace(/\r?\n+/g, " ").replace(/-->/g, "->").trim() }))
        .filter((cue) => cue.text.length > 0)
        .map((cue) => `${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}\n${cue.text}`);

    return blocks.length > 0 ? `WEBVTT\n\n${blocks.join("\n\n")}\n` : "WEBVTT\n";
}

@Injectable()
export class AssetsService {
    constructor(private readonly prisma: PrismaService) { }

    private getAssetBaseDir(sessionId: string, assetId: string) {
        return join(env.workRoot, sessionId, "assets", assetId);
    }

    private getSourceFilename(originalFilename: string) {
        const sanitizedBase = basename(originalFilename).replace(/[^a-zA-Z0-9._-]/g, "_");
        const extension = extname(sanitizedBase) || ".bin";
        return `source${extension}`;
    }

    async create(sessionId: string, file: Express.Multer.File) {
        const assetId = randomUUID();
        const assetDir = this.getAssetBaseDir(sessionId, assetId);
        const sourceFilename = this.getSourceFilename(file.originalname);
        const sourcePath = join(assetDir, sourceFilename);

        await mkdir(assetDir, { recursive: true });
        if (file.path) {
            await rename(file.path, sourcePath);
        }
        else {
            await writeFile(sourcePath, file.buffer);
        }

        return this.prisma.asset.create({
            data: {
                id: assetId,
                sessionId,
                originalFilename: file.originalname,
                mimeType: file.mimetype || "application/octet-stream",
                fileSize: BigInt(file.size),
                sourcePath,
                status: "uploaded",
            },
        });
    }

    async getOwnedAsset(sessionId: string, assetId: string) {
        const asset = await this.prisma.asset.findFirst({
            where: {
                id: assetId,
                sessionId,
            },
        });

        if (!asset) {
            throw new NotFoundException("Asset not found");
        }

        return asset;
    }

    async updateMediaMetadata(assetId: string, data: Partial<Pick<Asset, "fps" | "duration" | "peaksPath">>) {
        return this.prisma.asset.update({
            where: { id: assetId },
            data,
        });
    }

    // Overwrite the asset's transcript with edited cues (typo/spelling fixes).
    // Writes canonical WebVTT to the existing transcriptPath IN PLACE — so a
    // shorts source derived from a sermon also corrects that sermon's transcript.
    async updateTranscript(sessionId: string, assetId: string, cues: TranscriptCue[]) {
        const asset = await this.getOwnedAsset(sessionId, assetId);
        const targetPath = asset.transcriptPath?.trim()
            || join(this.getAssetBaseDir(sessionId, assetId), "transcript.vtt");

        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, buildVtt(cues), "utf8");

        if (asset.transcriptPath !== targetPath) {
            return this.prisma.asset.update({
                where: { id: assetId },
                data: { transcriptPath: targetPath },
            });
        }

        return asset;
    }

    // Derive a "shorts source" asset from a completed sermon job: it references
    // the job's output MP4 and VTT in place (no copy), so shorts reuse the
    // existing transcript instead of re-transcribing. Deduped by derivedFromJobId
    // so re-deriving the same job returns the same source.
    async deriveShortsSource(sessionId: string, jobId: string) {
        const job = await this.prisma.job.findFirst({
            where: { id: jobId, sessionId },
            include: { result: true },
        });

        if (!job) {
            throw new NotFoundException("Job not found");
        }

        const videoPath = job.result?.videoPath?.trim();
        if (job.status !== "completed" || !videoPath) {
            throw new BadRequestException("This job has no finished video to make shorts from");
        }

        const existing = await this.prisma.asset.findFirst({
            where: { sessionId, derivedFromJobId: jobId },
        });
        if (existing) {
            return existing;
        }

        // Safe to inherit only because the worker cuts the sermon transcript
        // from the result MP4 — the exact file this asset points at — rather
        // than the MP3. The two are not interchangeable: the intro image is
        // unshifted onto the video segment list only, and the programs use
        // different crossfade lengths, so an MP3-cut transcript sits ~intro
        // early and drifts at every segment boundary. The shorts editor
        // compares cue times straight against this video's currentTime, so if
        // that ever moves back to the MP3, this must become null and let the
        // asset take the "needs transcript" path instead.
        const transcriptPath = job.result?.transcriptPath?.trim() || null;
        let fileSize = BigInt(0);
        try {
            fileSize = BigInt((await stat(videoPath)).size);
        }
        catch {
            // Referenced file may already be gone (retention cleanup); a short
            // export will surface that clearly. Keep the source registerable.
        }

        return this.prisma.asset.create({
            data: {
                id: randomUUID(),
                sessionId,
                originalFilename: basename(videoPath),
                mimeType: "video/mp4",
                fileSize,
                sourcePath: videoPath,
                transcriptPath,
                status: "derived",
                derivedFromJobId: jobId,
            },
        });
    }
}