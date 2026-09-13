import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
    type ClipProcessJobData,
    HardwareOption as SharedHardwareOption,
    JobStage,
    JobStatus as SharedJobStatus,
    MAX_SHORT_DURATION_SEC,
    QUEUE_NAMES,
    type CreateJobRequest,
    type JobKind,
    type QueueName,
} from "@sermon-clipper/shared";
import { type Prisma } from "@prisma/client";
import { HardwareOption } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ClipProcessQueueService } from "../queue/clip-process-queue.service";
import { JobHardwareService } from "./job-hardware.service";
import type { CreateJobDto } from "./create-job.dto";

type JobWithProgress = Prisma.JobGetPayload<{
    include: { progress: true; result: true };
}>;

function normalizeResultPath(path: string | null) {
    const trimmed = path?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

// "sermon"'s clipStarts/clipEnds describe GAPS to cut out of
// [startTime, endTime] — the kept output is everything between them,
// concatenated (see the worker's getSegments). Both arrays must be provided
// together, equal length, ordered, non-overlapping, and inside the range.
function validateClipGaps(payload: Pick<CreateJobDto, "startTime" | "endTime" | "clipStarts" | "clipEnds">) {
    const hasClipStarts = Boolean(payload.clipStarts?.length);
    const hasClipEnds = Boolean(payload.clipEnds?.length);

    if (hasClipStarts !== hasClipEnds) {
        throw new BadRequestException("clipStarts and clipEnds must be provided together");
    }

    if (!hasClipStarts || !payload.clipStarts || !payload.clipEnds) {
        return;
    }

    if (payload.clipStarts.length !== payload.clipEnds.length) {
        throw new BadRequestException("clipStarts and clipEnds must have the same length");
    }

    let previousClipEnd = payload.startTime;

    for (const [index, clipStart] of payload.clipStarts.entries()) {
        const clipEnd = payload.clipEnds[index] ?? clipStart;

        if (clipStart >= clipEnd) {
            throw new BadRequestException(`Clip gap ${index + 1} must start before it ends`);
        }

        if (clipStart < payload.startTime || clipEnd > payload.endTime) {
            throw new BadRequestException(`Clip gap ${index + 1} must stay within startTime and endTime`);
        }

        if (clipStart < previousClipEnd) {
            throw new BadRequestException(`Clip gap ${index + 1} overlaps or is out of order`);
        }

        previousClipEnd = clipEnd;
    }
}

function validateClipRanges(payload: CreateJobDto) {
    if (payload.startTime >= payload.endTime) {
        throw new BadRequestException("startTime must be less than endTime");
    }

    validateClipGaps(payload);

    if (payload.introDuration !== undefined && payload.introDuration <= 0) {
        throw new BadRequestException("introDuration must be greater than 0 when provided");
    }

    if (payload.transitionDuration !== undefined && payload.transitionDuration < 0) {
        throw new BadRequestException("transitionDuration must be 0 or greater when provided");
    }
}

function validateShortRange(payload: CreateJobDto) {
    if (!Number.isFinite(payload.startTime) || !Number.isFinite(payload.endTime)) {
        throw new BadRequestException("A short requires numeric startTime and endTime");
    }

    if (payload.startTime >= payload.endTime) {
        throw new BadRequestException("startTime must be less than endTime");
    }

    if (payload.endTime - payload.startTime > MAX_SHORT_DURATION_SEC + 0.001) {
        throw new BadRequestException(
            `A short can be at most ${MAX_SHORT_DURATION_SEC / 60} minutes long`,
        );
    }
}

// "burnSubtitles" always needs both — no meaningful default for either.
function validateBurnSubtitlesRequest(payload: CreateJobDto) {
    if (!payload.sourceJobId?.trim()) {
        throw new BadRequestException("Burning in subtitles requires sourceJobId");
    }
    if (!payload.captionsVtt?.trim()) {
        throw new BadRequestException(
            "Burning in subtitles requires a reviewed transcript. Prepare and review the transcript first.",
        );
    }
}

@Injectable()
export class JobsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly clipProcessQueueService: ClipProcessQueueService,
        private readonly jobHardwareService: JobHardwareService,
    ) { }

    // Verifies sourceJobId belongs to this session and already has a finished
    // video — shared by transcribeSource's retry mode and burnSubtitles, both
    // of which operate on another job's Result.videoPath rather than a fresh
    // upload. Throws a clear 400/404 here instead of letting the worker fail
    // on it later.
    private async requireOwnedVideoJob(sessionId: string, sourceJobId: string) {
        const sourceJob = await this.prisma.job.findFirst({
            where: { id: sourceJobId, sessionId },
            include: { result: true },
        });
        if (!sourceJob) {
            throw new NotFoundException("Source job not found");
        }
        if (!sourceJob.result?.videoPath) {
            throw new BadRequestException("Source job has no finished video yet");
        }
        return sourceJob;
    }

    async create(sessionId: string, assetId: string, payload: CreateJobDto) {
        const kind = payload.kind ?? "sermon";

        // Idempotency: never queue a second transcription for a video that is
        // already being transcribed. Re-mounting the Shorts tab or double-clicks
        // return the in-flight job instead of piling up duplicates. Keyed by
        // sourceJobId too, so the default (whole-asset) mode and a "retry
        // transcript for job X" request never dedupe against each other, and
        // retries for two different jobs don't collide either.
        if (kind === "transcribeSource") {
            const activeTranscriptions = await this.prisma.job.findMany({
                where: {
                    sessionId,
                    assetId,
                    status: {
                        notIn: [
                            SharedJobStatus.completed,
                            SharedJobStatus.failed,
                            SharedJobStatus.canceled,
                            SharedJobStatus.expired,
                        ],
                    },
                    payloadJson: { path: ["kind"], equals: "transcribeSource" },
                },
                include: { progress: true, result: true },
                orderBy: { createdAt: "desc" },
            });

            const match = activeTranscriptions.find((candidate) => {
                const candidatePayload = candidate.payloadJson as { sourceJobId?: string } | null;
                return (candidatePayload?.sourceJobId ?? null) === (payload.sourceJobId ?? null);
            });

            if (match) {
                return match;
            }
        }

        if (kind === "sermon") {
            validateClipRanges(payload);
        }
        else if (kind === "short") {
            validateShortRange(payload);
        }
        else if (kind === "burnSubtitles") {
            validateBurnSubtitlesRequest(payload);
            await this.requireOwnedVideoJob(sessionId, payload.sourceJobId!);
        }
        else if (kind === "transcribeSource" && payload.sourceJobId) {
            await this.requireOwnedVideoJob(sessionId, payload.sourceJobId);
        }

        const requestedHardware = (payload.hardware ?? HardwareOption.auto) as HardwareOption;
        const resolution = await this.jobHardwareService.resolve(requestedHardware);
        // Transcription never encodes video, so keep it off the (scarce) GPU
        // encode queue regardless of the resolved hardware.
        const queueName = kind === "transcribeSource" ? QUEUE_NAMES.clipProcess : resolution.queueName;

        const job = await this.prisma.job.create({
            data: {
                sessionId,
                assetId,
                status: SharedJobStatus.queued,
                requestedHardware,
                effectiveHardware: resolution.effectiveHardware,
                payloadJson: payload as unknown as Prisma.InputJsonValue,
                queueName,
                progress: {
                    create: {
                        stage: JobStage.extractClips,
                        stageProgress: 0,
                        overallProgress: 0,
                        message: "Queued for processing",
                    },
                },
            },
            include: {
                progress: true,
                result: true,
            },
        });

        try {
            await this.clipProcessQueueService.enqueue(queueName, { jobId: job.id });
        }
        catch (error) {
            return this.prisma.job.update({
                where: { id: job.id },
                data: {
                    status: SharedJobStatus.failed,
                    failureReason: `Failed to enqueue job: ${String(error)}`,
                    finishedAt: new Date(),
                    progress: {
                        upsert: {
                            create: {
                                stage: JobStage.extractClips,
                                stageProgress: 0,
                                overallProgress: 0,
                                message: "Failed to enqueue job",
                            },
                            update: {
                                stage: JobStage.extractClips,
                                stageProgress: 0,
                                overallProgress: 0,
                                message: "Failed to enqueue job",
                            },
                        },
                    },
                },
                include: {
                    progress: true,
                    result: true,
                },
            });
        }

        return job;
    }

    async getOwnedJob(sessionId: string, jobId: string) {
        const job = await this.prisma.job.findFirst({
            where: {
                id: jobId,
                sessionId,
            },
            include: {
                progress: true,
                result: true,
            },
        });

        if (!job) {
            throw new NotFoundException("Job not found");
        }

        return job;
    }

    async listOwnedJobs(sessionId: string) {
        return this.prisma.job.findMany({
            where: { sessionId },
            include: {
                progress: true,
                result: true,
            },
            orderBy: {
                createdAt: "desc",
            },
        });
    }

    async listJobs() {
        return this.prisma.job.findMany({
            include: {
                progress: true,
                result: true,
            },
            orderBy: {
                createdAt: "desc",
            },
        });
    }

    // All jobs of a given kind for a source asset (session-scoped), newest
    // first — the persisted "saved shorts"/"saved clips" for that source.
    async listJobsForAssetByKind(sessionId: string, assetId: string, kind: JobKind) {
        return this.prisma.job.findMany({
            where: {
                sessionId,
                assetId,
                payloadJson: { path: ["kind"], equals: kind },
            },
            include: {
                progress: true,
                result: true,
            },
            orderBy: {
                createdAt: "desc",
            },
        });
    }

    async listShortsForAsset(sessionId: string, assetId: string) {
        return this.listJobsForAssetByKind(sessionId, assetId, "short");
    }

    async cancelOwnedJob(sessionId: string, jobId: string) {
        const job = await this.getOwnedJob(sessionId, jobId);

        if (
            job.status === SharedJobStatus.completed
            || job.status === SharedJobStatus.failed
            || job.status === SharedJobStatus.canceled
            || job.status === SharedJobStatus.expired
        ) {
            throw new BadRequestException(`Job cannot be canceled from status ${job.status}`);
        }

        const queueOutcome = await this.clipProcessQueueService.removeIfWaiting(job.queueName as QueueName, job.id);
        const message = queueOutcome.removed
            ? "Canceled and removed from queue"
            : "Cancellation requested";

        return this.prisma.job.update({
            where: { id: job.id },
            data: {
                status: SharedJobStatus.canceled,
                finishedAt: new Date(),
                failureReason: "Canceled by user",
                progress: {
                    upsert: {
                        create: {
                            stage: JobStage.finalize,
                            stageProgress: 0,
                            overallProgress: job.progress?.overallProgress ?? 0,
                            message,
                        },
                        update: {
                            stage: JobStage.finalize,
                            stageProgress: 0,
                            overallProgress: job.progress?.overallProgress ?? 0,
                            message,
                        },
                    },
                },
            },
            include: {
                progress: true,
                result: true,
            },
        });
    }

    toResponse(job: JobWithProgress) {
        return {
            jobId: job.id,
            sessionId: job.sessionId,
            assetId: job.assetId,
            status: job.status as unknown as SharedJobStatus,
            requestedHardware: job.requestedHardware as unknown as SharedHardwareOption,
            effectiveHardware: job.effectiveHardware as unknown as SharedHardwareOption | null,
            queueName: job.queueName,
            payload: job.payloadJson as unknown as CreateJobRequest,
            failureReason: job.failureReason,
            createdAt: job.createdAt.toISOString(),
            startedAt: job.startedAt?.toISOString() ?? null,
            finishedAt: job.finishedAt?.toISOString() ?? null,
            result: job.result
                ? {
                    resultId: job.result.id,
                    jobId: job.result.jobId,
                    sessionId: job.result.sessionId,
                    videoPath: normalizeResultPath(job.result.videoPath),
                    audioPath: normalizeResultPath(job.result.audioPath),
                    transcriptPath: normalizeResultPath(job.result.transcriptPath),
                    manifestPath: normalizeResultPath(job.result.manifestPath),
                    sizeBytes: job.result.sizeBytes?.toString() ?? null,
                    duration: job.result.duration,
                    expiresAt: job.result.expiresAt.toISOString(),
                    createdAt: job.result.createdAt.toISOString(),
                }
                : null,
            progress: job.progress
                ? {
                    stage: job.progress.stage,
                    stageProgress: job.progress.stageProgress,
                    overallProgress: job.progress.overallProgress,
                    audioProgress: job.progress.audioProgress,
                    videoProgress: job.progress.videoProgress,
                    transcriptProgress: job.progress.transcriptProgress,
                    message: job.progress.message,
                    updatedAt: job.progress.updatedAt.toISOString(),
                }
                : null,
        };
    }
}