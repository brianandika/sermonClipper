import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { ClipProcessJobData, QueueName } from "@sermon-clipper/shared";
import { env } from "../config/env";

@Injectable()
export class ClipProcessQueueService {
    async enqueue(queueName: QueueName, payload: ClipProcessJobData) {
        const connection = new IORedis(env.redisUrl, {
            maxRetriesPerRequest: null,
            lazyConnect: true,
        });
        connection.on("error", () => undefined);

        const queue = new Queue<ClipProcessJobData>(queueName, { connection });

        try {
            await queue.add(queueName, payload, {
                jobId: payload.jobId,
                removeOnComplete: 100,
                removeOnFail: 100,
            });
        }
        finally {
            await queue.close();
            connection.disconnect();
        }
    }

    async removeIfWaiting(queueName: QueueName, jobId: string) {
        const connection = new IORedis(env.redisUrl, {
            maxRetriesPerRequest: null,
            lazyConnect: true,
        });
        connection.on("error", () => undefined);

        const queue = new Queue<ClipProcessJobData>(queueName, { connection });

        try {
            const job = await queue.getJob(jobId);

            if (!job) {
                return { removed: false, state: null };
            }

            const state = await job.getState();
            if (state === "waiting" || state === "delayed" || state === "prioritized" || state === "waiting-children") {
                await job.remove();
                return { removed: true, state };
            }

            return { removed: false, state };
        }
        finally {
            await queue.close();
            connection.disconnect();
        }
    }
}