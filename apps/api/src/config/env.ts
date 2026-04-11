export const env = {
    port: Number.parseInt(process.env.API_PORT ?? "3000", 10),
    sessionTtlDays: Number.parseInt(process.env.SESSION_TTL_DAYS ?? "7", 10),
    resultTtlDays: Number.parseInt(process.env.RESULT_TTL_DAYS ?? "7", 10),
    nodeEnv: process.env.NODE_ENV ?? "development",
    workRoot: process.env.WORK_ROOT ?? "/workspaces/sermonClipper/work",
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
};
