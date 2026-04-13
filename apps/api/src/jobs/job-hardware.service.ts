import { Injectable } from "@nestjs/common";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HardwareOption } from "@prisma/client";
import { QUEUE_NAMES, type QueueName } from "@sermon-clipper/shared";
import { env } from "../config/env";

const execFileAsync = promisify(execFile);

interface HardwareResolution {
    queueName: QueueName;
    effectiveHardware: HardwareOption;
}

interface HardwareCapabilities {
    detected: HardwareOption;
    available: HardwareOption[];
}

@Injectable()
export class JobHardwareService {
    private capabilityPromise: Promise<Set<HardwareOption>> | null = null;

    private async canUseNvencEncoder() {
        try {
            await execFileAsync(env.ffmpegPath, [
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=1920x1080:rate=30",
                "-frames:v",
                "1",
                "-an",
                "-c:v",
                "h264_nvenc",
                "-f",
                "null",
                "-",
            ]);

            return true;
        }
        catch {
            return false;
        }
    }

    async resolve(requestedHardware: HardwareOption): Promise<HardwareResolution> {
        const availableHardware = await this.getAvailableHardware();
        const effectiveHardware = this.resolveEffectiveHardware(requestedHardware, availableHardware);

        return {
            queueName: this.getQueueName(effectiveHardware),
            effectiveHardware,
        };
    }

    async getCapabilities(): Promise<HardwareCapabilities> {
        const availableSet = await this.getAvailableHardware();
        const detected = this.resolveEffectiveHardware(HardwareOption.auto, availableSet);

        return {
            detected,
            available: Array.from(availableSet.values()),
        };
    }

    private async getAvailableHardware() {
        if (!this.capabilityPromise) {
            this.capabilityPromise = this.detectAvailableHardware();
        }

        return this.capabilityPromise;
    }

    private async detectAvailableHardware() {
        const available = new Set<HardwareOption>([HardwareOption.cpu]);

        try {
            const [{ stdout: hwaccelsStdout }, { stdout: encodersStdout }] = await Promise.all([
                execFileAsync(env.ffmpegPath, ["-hide_banner", "-hwaccels"]),
                execFileAsync(env.ffmpegPath, ["-hide_banner", "-encoders"]),
            ]);

            const hwaccels = hwaccelsStdout.toLowerCase();
            const encoders = encodersStdout.toLowerCase();

            if (encoders.includes("h264_nvenc")) {
                const nvencReady = await this.canUseNvencEncoder();
                if (nvencReady) {
                    available.add(HardwareOption.cuda);
                }
            }

            if (hwaccels.includes("qsv") && encoders.includes("h264_qsv")) {
                available.add(HardwareOption.intel);
            }

            if (hwaccels.includes("videotoolbox") && encoders.includes("h264_videotoolbox")) {
                available.add(HardwareOption.apple);
            }

            if (hwaccels.includes("vaapi") && encoders.includes("h264_vaapi")) {
                available.add(HardwareOption.vaapi);
            }
        }
        catch {
            return available;
        }

        return available;
    }

    private resolveEffectiveHardware(requestedHardware: HardwareOption, availableHardware: Set<HardwareOption>) {
        if (requestedHardware === HardwareOption.auto) {
            if (availableHardware.has(HardwareOption.cuda)) {
                return HardwareOption.cuda;
            }

            return HardwareOption.cpu;
        }

        if (availableHardware.has(requestedHardware)) {
            return requestedHardware;
        }

        return HardwareOption.cpu;
    }

    private getQueueName(effectiveHardware: HardwareOption) {
        if (effectiveHardware === HardwareOption.cuda) {
            return QUEUE_NAMES.gpuEncode;
        }

        return QUEUE_NAMES.clipProcess;
    }
}