import { Controller, Get, Param, Req } from "@nestjs/common";
import type { Request } from "express";
import { SESSION_COOKIE_NAME, type ResultResponse } from "@sermon-clipper/shared";
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
}