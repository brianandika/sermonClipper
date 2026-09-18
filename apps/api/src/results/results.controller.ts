import { Controller, Get, NotFoundException, Param, Req, Res } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import type { Request } from "express";
import type { Response } from "express";
import { SESSION_COOKIE_NAME, vttToSrt, type ResultResponse } from "@sermon-clipper/shared";
import { SessionService } from "../sessions/session.service";
import { ResultsService } from "./results.service";

@Controller("results")
export class ResultsController {
    constructor(
        private readonly resultsService: ResultsService,
        private readonly sessionService: SessionService,
    ) { }

    @Get(":jobId")
    async getResult(
        @Req() request: Request,
        @Param("jobId") jobId: string,
    ): Promise<ResultResponse> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const result = await this.resultsService.getOwnedResultByJobId(session.id, jobId);
        return this.resultsService.toResponse(result);
    }

    @Get(":resultId/audio")
    async getAudioArtifact(
        @Req() request: Request,
        @Res() response: Response,
        @Param("resultId") resultId: string,
    ): Promise<void> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const result = await this.resultsService.getOwnedResultById(session.id, resultId);
        if (!result.audioPath) {
            throw new NotFoundException("Audio artifact is not ready yet");
        }
        response.type("audio/mpeg");
        response.sendFile(result.audioPath);
    }

    @Get(":resultId/video")
    async getVideoArtifact(
        @Req() request: Request,
        @Res() response: Response,
        @Param("resultId") resultId: string,
    ): Promise<void> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const result = await this.resultsService.getOwnedResultById(session.id, resultId);
        if (!result.videoPath) {
            throw new NotFoundException("Video artifact is not ready yet");
        }
        response.type("video/mp4");
        response.sendFile(result.videoPath);
    }

    @Get(":resultId/transcript")
    async getTranscriptArtifact(
        @Req() request: Request,
        @Res() response: Response,
        @Param("resultId") resultId: string,
    ): Promise<void> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const result = await this.resultsService.getOwnedResultById(session.id, resultId);
        if (!result.transcriptPath) {
            throw new NotFoundException("Transcript is not ready yet");
        }
        response.type("text/vtt");
        response.sendFile(result.transcriptPath);
    }

    // Serves the .srt export. Two sources, in priority order: a "burnSubtitles"
    // job's own pre-generated file (result.srtPath, written by the worker), or
    // — for a plain sermon result with only a .vtt transcript — a conversion
    // done on the fly here. Either way this is the same download the
    // Subtitles/Results UI links to; the caller doesn't need to know which
    // path produced it.
    @Get(":resultId/srt")
    async getSrtArtifact(
        @Req() request: Request,
        @Res() response: Response,
        @Param("resultId") resultId: string,
    ): Promise<void> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        const result = await this.resultsService.getOwnedResultById(session.id, resultId);

        response.type("application/x-subrip");

        if (result.srtPath) {
            response.sendFile(result.srtPath);
            return;
        }

        if (!result.transcriptPath) {
            throw new NotFoundException("No transcript is available to export as SRT");
        }

        const vtt = await readFile(result.transcriptPath, "utf8");
        response.send(vttToSrt(vtt));
    }
}