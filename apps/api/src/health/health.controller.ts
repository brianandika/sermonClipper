import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@sermon-clipper/shared";

@Controller()
export class HealthController {
    @Get("health")
    getHealth(): HealthResponse {
        return {
            status: "ok",
            service: "sermon-clipper-api",
            timestamp: new Date().toISOString(),
        };
    }
}
