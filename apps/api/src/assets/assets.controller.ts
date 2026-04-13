import {
    BadRequestException,
    Controller,
    Get,
    Param,
    Post,
    Req,
    Res,
    UploadedFile,
    UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import type { Request, Response } from "express";
import {
    SESSION_COOKIE_NAME,
    type AssetResponse,
    type PeaksResponse,
} from "@sermon-clipper/shared";
import { env } from "../config/env";
import { SessionService } from "../sessions/session.service";
import { AssetMediaService } from "./asset-media.service";
import { AssetsService } from "./assets.service";

const uploadTempDir = join(env.workRoot, "_upload_tmp");

const uploadStorage = diskStorage({
    destination: (_request, _file, callback) => {
        mkdirSync(uploadTempDir, { recursive: true });
        callback(null, uploadTempDir);
    },
    filename: (_request, file, callback) => {
        const extension = extname(file.originalname || "") || ".bin";
        callback(null, `${randomUUID()}${extension}`);
    },
});

@Controller("assets")
export class AssetsController {
    constructor(
        private readonly assetsService: AssetsService,
        private readonly assetMediaService: AssetMediaService,
        private readonly sessionService: SessionService,
    ) { }

    private toAssetResponse(asset: {
        id: string;
        sessionId: string;
        originalFilename: string;
        mimeType: string;
        fileSize: bigint;
        sourcePath: string;
        fps: number | null;
        duration: number | null;
        status: string;
        createdAt: Date;
        updatedAt: Date;
    }): AssetResponse {
        return {
            assetId: asset.id,
            sessionId: asset.sessionId,
            originalFilename: asset.originalFilename,
            mimeType: asset.mimeType,
            fileSize: asset.fileSize.toString(),
            sourcePath: asset.sourcePath,
            fps: asset.fps,
            duration: asset.duration,
            status: asset.status,
            createdAt: asset.createdAt.toISOString(),
            updatedAt: asset.updatedAt.toISOString(),
        };
    }

    private async resolveSession(request: Request, response: Response) {
        const session = await this.sessionService.bootstrapSession(
            env.sessionTtlDays,
            request.cookies?.[SESSION_COOKIE_NAME],
        );

        response.cookie(SESSION_COOKIE_NAME, session.id, {
            httpOnly: true,
            sameSite: "lax",
            secure: env.nodeEnv === "production",
            expires: session.expiresAt,
            path: "/",
        });

        return session;
    }

    @Post("upload")
    @UseInterceptors(FileInterceptor("file", {
        storage: uploadStorage,
        limits: {
            fileSize: env.uploadMaxBytes,
        },
    }))
    async upload(
        @Req() request: Request,
        @Res({ passthrough: true }) response: Response,
        @UploadedFile() file: Express.Multer.File,
    ): Promise<AssetResponse> {
        if (!file) {
            throw new BadRequestException("File is required");
        }

        const session = await this.resolveSession(request, response);
        const asset = await this.assetsService.create(session.id, file);
        return this.toAssetResponse(asset);
    }

    @Get(":assetId")
    async getAsset(
        @Req() request: Request,
        @Param("assetId") assetId: string,
    ): Promise<AssetResponse> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const asset = await this.assetsService.getOwnedAsset(session.id, assetId);
        return this.toAssetResponse(asset);
    }

    @Get(":assetId/source")
    async getAssetSource(
        @Req() request: Request,
        @Res() response: Response,
        @Param("assetId") assetId: string,
    ): Promise<void> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const asset = await this.assetsService.getOwnedAsset(session.id, assetId);

        response.type(asset.mimeType || "application/octet-stream");
        response.sendFile(asset.sourcePath);
    }

    @Get(":assetId/fps")
    async getFps(
        @Req() request: Request,
        @Param("assetId") assetId: string,
    ) {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const asset = await this.assetsService.getOwnedAsset(session.id, assetId);

        if (asset.fps && asset.duration) {
            return {
                fps: asset.fps,
                duration: asset.duration,
            };
        }

        const metadata = await this.assetMediaService.getFpsAndDuration(asset);
        await this.assetsService.updateMediaMetadata(asset.id, metadata);

        return metadata;
    }

    @Get(":assetId/peaks")
    async getPeaks(
        @Req() request: Request,
        @Param("assetId") assetId: string,
    ): Promise<PeaksResponse> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const asset = await this.assetsService.getOwnedAsset(session.id, assetId);
        try {
            const peaks = await this.assetMediaService.generatePeaks(asset);
            await this.assetsService.updateMediaMetadata(asset.id, { peaksPath: peaks.peaksPath });
            return peaks.payload;
        }
        catch {
            return {
                data: new Array<number>(1000).fill(0),
                length: 1000,
                bits: 16,
                sampleRate: 16000,
            };
        }
    }
}