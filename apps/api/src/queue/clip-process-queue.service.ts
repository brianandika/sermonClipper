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
}