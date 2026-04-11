import { Module } from "@nestjs/common";
import { SessionsModule } from "../sessions/sessions.module";
import { ResultsController } from "./results.controller";
import { ResultsService } from "./results.service";

@Module({
    imports: [SessionsModule],
    controllers: [ResultsController],
    providers: [ResultsService],
    exports: [ResultsService],
})
export class ResultsModule { }