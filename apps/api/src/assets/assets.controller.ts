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
import { memoryStorage } from "multer";
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
    @UseInterceptors(FileInterceptor("file", { storage: memoryStorage() }))
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
        const peaks = await this.assetMediaService.generatePeaks(asset);
        await this.assetsService.updateMediaMetadata(asset.id, { peaksPath: peaks.peaksPath });

        return peaks.payload;
    }
}