import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SessionService {
    constructor(private readonly prisma: PrismaService) { }

    private getExpiry(ttlDays: number) {
        const sessionId = randomUUID();
        const expiresAt = new Date();
        expiresAt.setUTCDate(expiresAt.getUTCDate() + ttlDays);

        return {
            sessionId,
            expiresAt,
        };
    }

    async bootstrapSession(ttlDays: number, existingSessionId?: string | undefined) {
        if (existingSessionId) {
            const existing = await this.prisma.session.findUnique({
                where: { id: existingSessionId },
            });

            if (existing && existing.expiresAt > new Date()) {
                const expiresAt = new Date();
                expiresAt.setUTCDate(expiresAt.getUTCDate() + ttlDays);

                return this.prisma.session.update({
                    where: { id: existing.id },
                    data: {
                        lastActivityAt: new Date(),
                        expiresAt,
                    },
                });
            }
        }

        const { sessionId, expiresAt } = this.getExpiry(ttlDays);
        return this.prisma.session.create({
            data: {
                id: sessionId,
                expiresAt,
            },
        });
    }

    async requireSession(sessionId?: string) {
        if (!sessionId) {
            throw new BadRequestException("Session cookie is missing");
        }

        const session = await this.prisma.session.findUnique({
            where: { id: sessionId },
        });

        if (!session || session.expiresAt <= new Date()) {
            throw new NotFoundException("Session not found or expired");
        }

        return this.prisma.session.update({
            where: { id: sessionId },
            data: {
                lastActivityAt: new Date(),
            },
        });
    }

    createSession(ttlDays: number) {
        const { sessionId, expiresAt } = this.getExpiry(ttlDays);

        return {
            sessionId,
            expiresAt,
        };
    }
}
