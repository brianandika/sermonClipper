import { Module } from "@nestjs/common";
import { ClipProcessQueueService } from "./clip-process-queue.service";

@Module({
    providers: [ClipProcessQueueService],
    exports: [ClipProcessQueueService],
})
export class QueueModule { }