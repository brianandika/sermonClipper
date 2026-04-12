export const env = {
    port: Number.parseInt(process.env.API_PORT ?? "3000", 10),
    sessionTtlDays: Number.parseInt(process.env.SESSION_TTL_DAYS ?? "7", 10),
    resultTtlDays: Number.parseInt(process.env.RESULT_TTL_DAYS ?? "7", 10),
    assetTtlDays: Number.parseInt(process.env.ASSET_TTL_DAYS ?? (process.env.SESSION_TTL_DAYS ?? "7"), 10),
    jobTtlDays: Number.parseInt(process.env.JOB_TTL_DAYS ?? (process.env.RESULT_TTL_DAYS ?? "7"), 10),
    cleanupIntervalMinutes: Number.parseInt(process.env.CLEANUP_INTERVAL_MINUTES ?? "60", 10),
    nodeEnv: process.env.NODE_ENV ?? "development",
    workRoot: process.env.WORK_ROOT ?? "/workspaces/sermonClipper/work",
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
};
