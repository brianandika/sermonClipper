import { Module } from "@nestjs/common";
import { AssetsModule } from "./assets/assets.module";
import { CleanupModule } from "./cleanup/cleanup.module";
import { HealthModule } from "./health/health.module";
import { JobsModule } from "./jobs/jobs.module";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueModule } from "./queue/queue.module";
import { ResultsModule } from "./results/results.module";
import { SessionsModule } from "./sessions/sessions.module";

@Module({
    imports: [PrismaModule, QueueModule, HealthModule, SessionsModule, AssetsModule, JobsModule, ResultsModule, CleanupModule],
})
export class AppModule { }
