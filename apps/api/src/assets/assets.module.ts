import { Module } from "@nestjs/common";
import { SessionsModule } from "../sessions/sessions.module";
import { AssetsController } from "./assets.controller";
import { AssetMediaService } from "./asset-media.service";
import { AssetsService } from "./assets.service";

@Module({
    imports: [SessionsModule],
    controllers: [AssetsController],
    providers: [AssetsService, AssetMediaService],
    exports: [AssetsService],
})
export class AssetsModule { }