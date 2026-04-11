import { BadRequestException, Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { JobResponse } from "@sermon-clipper/shared";
import { SESSION_COOKIE_NAME } from "@sermon-clipper/shared";
import { AssetsService } from "../assets/assets.service";
import { SessionService } from "../sessions/session.service";
import { CreateJobDto } from "./create-job.dto";
import { JobsService } from "./jobs.service";

@Controller("jobs")
export class JobsController {
    constructor(
        private readonly jobsService: JobsService,
        private readonly assetsService: AssetsService,
        private readonly sessionService: SessionService,
    ) { }

    @Post()
    async create(
        @Req() request: Request,
        @Body() body: CreateJobDto,
    ): Promise<JobResponse> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        await this.assetsService.getOwnedAsset(session.id, body.assetId);

        if (body.introImageAssetId) {
            const introAsset = await this.assetsService.getOwnedAsset(session.id, body.introImageAssetId);

            if (!introAsset.mimeType.startsWith("image/")) {
                throw new BadRequestException("Intro image asset must be an image");
            }
        }

        const job = await this.jobsService.create(session.id, body.assetId, body);
        return this.jobsService.toResponse(job);
    }

    @Get(":jobId")
    async getJob(
        @Req() request: Request,
        @Param("jobId") jobId: string,
    ): Promise<JobResponse> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const job = await this.jobsService.getOwnedJob(session.id, jobId);
        return this.jobsService.toResponse(job);
    }
}