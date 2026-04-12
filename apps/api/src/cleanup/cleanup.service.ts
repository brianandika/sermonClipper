import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { JobStatus } from "@prisma/client";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

const TERMINAL_JOB_STATUSES: JobStatus[] = [
    JobStatus.completed,
    JobStatus.failed,
    JobStatus.canceled,
    JobStatus.expired,
];

@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(CleanupService.name);
    private intervalHandle: NodeJS.Timeout | null = null;
    private cleanupInProgress = false;

    constructor(private readonly prisma: PrismaService) { }

    onModuleInit() {
        const intervalMinutes = Math.max(1, env.cleanupIntervalMinutes);
        void this.runCleanup();
        this.intervalHandle = setInterval(() => {
            void this.runCleanup();
        }, intervalMinutes * 60 * 1000);
    }

    onModuleDestroy() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }

    private async runCleanup() {
        if (this.cleanupInProgress) {
            return;
        }

        this.cleanupInProgress = true;
        try {
            const expiredSessions = await this.pruneExpiredSessions();
            const oldJobs = await this.pruneOldTerminalJobs();
            const oldAssets = await this.pruneStaleUnreferencedAssets();

            if (expiredSessions > 0 || oldJobs > 0 || oldAssets > 0) {
                this.logger.log(`Cleanup removed ${expiredSessions} expired session(s), ${oldJobs} old job(s), and ${oldAssets} stale asset(s)`);
            }
        }
        catch (error) {
            this.logger.error(`Cleanup cycle failed: ${String(error)}`);
        }
        finally {
            this.cleanupInProgress = false;
        }
    }

    private async pruneExpiredSessions() {
        const now = new Date();
        const sessions = await this.prisma.session.findMany({
            where: {
                expiresAt: { lt: now },
            },
            select: { id: true },
        });

        if (sessions.length === 0) {
            return 0;
        }

        await Promise.all(
            sessions.map((session) => rm(this.getSessionRoot(session.id), { recursive: true, force: true })),
        );

        const deleted = await this.prisma.session.deleteMany({
            where: {
                id: { in: sessions.map((session) => session.id) },
            },
        });

        return deleted.count;
    }

    private async pruneOldTerminalJobs() {
        const cutoff = new Date(Date.now() - Math.max(1, env.jobTtlDays) * 24 * 60 * 60 * 1000);
        const jobs = await this.prisma.job.findMany({
            where: {
                status: { in: TERMINAL_JOB_STATUSES },
                OR: [
                    { finishedAt: { lt: cutoff } },
                    {
                        finishedAt: null,
                        createdAt: { lt: cutoff },
                    },
                ],
            },
            select: {
                id: true,
                sessionId: true,
            },
        });

        if (jobs.length === 0) {
            return 0;
        }

        await Promise.all(
            jobs.map((job) => rm(this.getJobRoot(job.sessionId, job.id), { recursive: true, force: true })),
        );

        const deleted = await this.prisma.job.deleteMany({
            where: {
                id: { in: jobs.map((job) => job.id) },
            },
        });

        return deleted.count;
    }

    private async pruneStaleUnreferencedAssets() {
        const cutoff = new Date(Date.now() - Math.max(1, env.assetTtlDays) * 24 * 60 * 60 * 1000);
        const assets = await this.prisma.asset.findMany({
            where: {
                updatedAt: { lt: cutoff },
                jobs: { none: {} },
            },
            select: {
                id: true,
                sessionId: true,
            },
        });

        if (assets.length === 0) {
            return 0;
        }

        await Promise.all(
            assets.map((asset) => rm(this.getAssetRoot(asset.sessionId, asset.id), { recursive: true, force: true })),
        );

        const deleted = await this.prisma.asset.deleteMany({
            where: {
                id: { in: assets.map((asset) => asset.id) },
            },
        });

        return deleted.count;
    }

    private getSessionRoot(sessionId: string) {
        return join(env.workRoot, sessionId);
    }

    private getJobRoot(sessionId: string, jobId: string) {
        return join(this.getSessionRoot(sessionId), "jobs", jobId);
    }

    private getAssetRoot(sessionId: string, assetId: string) {
        return join(this.getSessionRoot(sessionId), "assets", assetId);
    }
}
