import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SessionsController } from "./sessions.controller";
import { SessionService } from "./session.service";

@Module({
    imports: [PrismaModule],
    controllers: [SessionsController],
    providers: [SessionService],
    exports: [SessionService],
})
export class SessionsModule { }
