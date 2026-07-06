import { Injectable, NotFoundException } from "@nestjs/common";
import type { ResultResponse } from "@sermon-clipper/shared";
import { PrismaService } from "../prisma/prisma.service";

function normalizeResultPath(path: string | null) {
    const trimmed = path?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

@Injectable()
export class ResultsService {
    constructor(private readonly prisma: PrismaService) { }

    async getOwnedResultById(sessionId: string, resultId: string) {
        const result = await this.prisma.result.findFirst({
            where: {
                sessionId,
                id: resultId,
            },
        });

        if (!result) {
            throw new NotFoundException("Result not found");
        }

        return result;
    }

    async getOwnedResultByJobId(sessionId: string, jobId: string) {
        const result = await this.prisma.result.findFirst({
            where: {
                sessionId,
                jobId,
            },
        });

        if (!result) {
            throw new NotFoundException("Result not found");
        }

        return result;
    }

    toResponse(result: {
        id: string;
        jobId: string;
        sessionId: string;
        videoPath: string | null;
        audioPath: string | null;
        transcriptPath: string | null;
        manifestPath: string | null;
        sizeBytes: bigint | null;
        duration: number | null;
        expiresAt: Date;
        createdAt: Date;
    }): ResultResponse {
        return {
            resultId: result.id,
            jobId: result.jobId,
            sessionId: result.sessionId,
            videoPath: normalizeResultPath(result.videoPath),
            audioPath: normalizeResultPath(result.audioPath),
            transcriptPath: normalizeResultPath(result.transcriptPath),
            manifestPath: normalizeResultPath(result.manifestPath),
            sizeBytes: result.sizeBytes?.toString() ?? null,
            duration: result.duration,
            expiresAt: result.expiresAt.toISOString(),
            createdAt: result.createdAt.toISOString(),
        };
    }
}