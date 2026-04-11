import "dotenv/config";
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { env } from "./config/env";

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { cors: true });

    app.use(cookieParser());
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidUnknownValues: false,
        }),
    );

    await app.listen(env.port);
    process.stdout.write(`API listening on http://localhost:${env.port}\n`);
}

bootstrap().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
});
