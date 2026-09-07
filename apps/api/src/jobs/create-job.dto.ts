import { Type } from "class-transformer";
import {
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsEnum,
    IsIn,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Max,
    Min,
    ValidateIf,
} from "class-validator";
import { HardwareOption, MAX_FADE_SECONDS, type JobKind } from "@sermon-clipper/shared";

const JOB_KINDS: JobKind[] = ["sermon", "transcribeSource", "short", "burnSubtitles"];

export class CreateJobDto {
    @IsString()
    assetId!: string;

    // Absent ⇒ "sermon" (the original landscape flow).
    @IsOptional()
    @IsIn(JOB_KINDS)
    kind?: JobKind;

    @IsOptional()
    @IsString()
    introImageAssetId?: string;

    @IsOptional()
    @IsString()
    @IsNotEmpty()
    outputAudioFilename?: string;

    @IsOptional()
    @IsString()
    @IsNotEmpty()
    outputVideoFilename?: string;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    introDuration?: number;

    // transcribeSource and burnSubtitles don't need a clip range at all (they
    // operate on a whole existing video, identified by sourceJobId, or the
    // whole asset) — sermon/short require start/end unconditionally.
    @ValidateIf((o: CreateJobDto) => o.kind !== "transcribeSource" && o.kind !== "burnSubtitles")
    @Type(() => Number)
    @IsNumber()
    startTime!: number;

    @ValidateIf((o: CreateJobDto) => o.kind !== "transcribeSource" && o.kind !== "burnSubtitles")
    @Type(() => Number)
    @IsNumber()
    endTime!: number;

    // "short" only: 9:16 window horizontal position (0..1) and zoom (>=1).
    @ValidateIf((o: CreateJobDto) => o.kind === "short")
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    @Max(1)
    cropX?: number;

    // "short" only: 9:16 window vertical position (0..1). Optional for backward
    // compatibility — a missing value is treated as 0.5 (centered).
    @IsOptional()
    @ValidateIf((o: CreateJobDto) => o.kind === "short" && o.cropY !== undefined)
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    @Max(1)
    cropY?: number;

    // Below 1 = zoom out (letterboxed); above 1 = zoom in (tighter crop).
    @ValidateIf((o: CreateJobDto) => o.kind === "short")
    @Type(() => Number)
    @IsNumber()
    @Min(0.3)
    @Max(2.5)
    zoom?: number;

    @IsOptional()
    @IsBoolean()
    captions?: boolean;

    // "short" only: append the branded church end card (default true).
    @IsOptional()
    @IsBoolean()
    endCard?: boolean;

    @IsOptional()
    @IsString()
    title?: string;

    // "short" only: the sermon/transcribe job this short groups under in the
    // queue. Metadata only — the worker ignores it.
    @IsOptional()
    @IsString()
    parentJobId?: string;

    @IsOptional()
    @IsArray()
    @Type(() => Number)
    @IsNumber({}, { each: true })
    clipStarts?: number[];

    @IsOptional()
    @IsArray()
    @Type(() => Number)
    @IsNumber({}, { each: true })
    clipEnds?: number[];

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    transitionDuration?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    fps?: number;

    @IsOptional()
    @IsEnum(HardwareOption)
    hardware?: HardwareOption;

    // "sermon" only: deliver the finished transcript to SermonGuide. Defaults to
    // true in the worker when omitted; the UI sends false to opt out.
    @IsOptional()
    @IsBoolean()
    deliverTranscript?: boolean;

    // "sermon" only: fade the composed output in/out this many seconds at
    // each end. 0 = no fade. Omitted ⇒ worker default (1s, the original
    // always-on behavior).
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    @Max(MAX_FADE_SECONDS)
    fadeSeconds?: number;

    // "sermon" only: skip the standard 1920x1080 canvas and keep the source's
    // own resolution/aspect ratio instead. Default false (unchanged behavior).
    @IsOptional()
    @IsBoolean()
    preserveAspectRatio?: boolean;

    // "transcribeSource" (retry mode) and "burnSubtitles": the other job
    // whose finished video this one operates on.
    @IsOptional()
    @IsString()
    sourceJobId?: string;

    // "burnSubtitles" only, required: the reviewed WebVTT text to burn in.
    @IsOptional()
    @IsString()
    captionsVtt?: string;
}