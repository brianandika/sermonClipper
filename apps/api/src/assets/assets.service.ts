import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Asset } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Express } from "express";
import { env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

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