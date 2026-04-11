import { Controller, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { SESSION_COOKIE_NAME, type SessionBootstrapResponse } from "@sermon-clipper/shared";
import { env } from "../config/env";
import { SessionService } from "./session.service";

@Controller("sessions")
export class SessionsController {
    constructor(private readonly sessionService: SessionService) { }

    @Post("bootstrap")
    async bootstrap(
        @Req() request: Request,
        @Res({ passthrough: true }) response: Response,
    ): Promise<SessionBootstrapResponse> {
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

        return {
            sessionId: session.id,
            expiresAt: session.expiresAt.toISOString(),
            queueNames: {
                clipProcess: "clip-process",
                gpuEncode: "gpu-encode",
                youtubeUpload: "youtube-upload",
            },
        };
    }
}
