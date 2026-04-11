import { Module } from "@nestjs/common";
import { AssetsModule } from "../assets/assets.module";
import { QueueModule } from "../queue/queue.module";
import { SessionsModule } from "../sessions/sessions.module";
import { JobHardwareService } from "./job-hardware.service";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";

@Module({
    imports: [AssetsModule, QueueModule, SessionsModule],
    controllers: [JobsController],
    providers: [JobsService, JobHardwareService],
})
export class JobsModule { }