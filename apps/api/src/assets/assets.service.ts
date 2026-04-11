import { Injectable, NotFoundException } from "@nestjs/common";
import type { Asset } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
        await writeFile(sourcePath, file.buffer);

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
}