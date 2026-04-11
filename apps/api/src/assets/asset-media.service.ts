import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { Asset } from "@prisma/client";
import { env } from "../config/env";

const execFileAsync = promisify(execFile);

interface FfprobeStreamsResponse {
    streams?: Array<{
        r_frame_rate?: string;
        duration?: string;
    }>;
    format?: {
        duration?: string;
    };
}

@Injectable()
export class AssetMediaService {
    async getFpsAndDuration(asset: Asset) {
        try {
            const { stdout } = await execFileAsync(env.ffprobePath, [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=r_frame_rate,duration",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                asset.sourcePath,
            ]);

            const parsed = JSON.parse(stdout) as FfprobeStreamsResponse;
            const stream = parsed.streams?.[0];
            const frameRate = stream?.r_frame_rate ?? "30/1";
            const [numerator, denominator] = frameRate.split("/").map((value) => Number.parseFloat(value));
            const fps = numerator && denominator ? numerator / denominator : 30;
            const duration = Number.parseFloat(stream?.duration ?? parsed.format?.duration ?? "0");

            return {
                fps,
                duration: Number.isFinite(duration) ? duration : null,
            };
        }
        catch {
            return {
                fps: 30,
                duration: null,
            };
        }
    }

    async generatePeaks(asset: Asset) {
        const tempWavPath = join(env.workRoot, asset.sessionId, "assets", asset.id, "peaks-temp.wav");
        const peaksPath = join(env.workRoot, asset.sessionId, "assets", asset.id, "peaks.json");

        try {
            await execFileAsync(env.ffmpegPath, [
                "-i",
                asset.sourcePath,
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-af",
                "highpass=f=300,lowpass=f=3000,volume=1.0",
                tempWavPath,
                "-y",
            ]);

            const { stderr } = await execFileAsync(env.ffmpegPath, [
                "-i",
                tempWavPath,
                "-filter_complex",
                "astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level",
                "-f",
                "null",
                "-",
            ]);

            const peaks: number[] = [];
            const speechMin = -40;
            const speechMax = -10;

            for (const line of stderr.split("\n")) {
                if (!line.includes("RMS_level")) {
                    continue;
                }

                const rawValue = Number.parseFloat(line.split("=")[1] ?? "0");
                if (!Number.isFinite(rawValue) || rawValue < speechMin) {
                    peaks.push(0);
                    continue;
                }

                const normalized = Math.min(1, Math.max(0, (rawValue - speechMin) / (speechMax - speechMin)));
                peaks.push(normalized);
            }

            const payload = {
                data: peaks.length > 0 ? peaks : new Array<number>(1000).fill(0),
                length: peaks.length > 0 ? peaks.length : 1000,
                bits: 16,
                sampleRate: 16000,
            };

            await writeFile(peaksPath, JSON.stringify(payload));
            return {
                peaksPath,
                payload,
            };
        }
        catch (error) {
            throw new InternalServerErrorException(
                `Failed to generate peaks for asset ${asset.id}: ${String(error)}`,
            );
        }
        finally {
            await rm(tempWavPath, { force: true });
        }
    }
}