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
import { HardwareOption, type JobKind } from "@sermon-clipper/shared";

const JOB_KINDS: JobKind[] = ["sermon", "transcribeSource", "short"];

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

    // transcribeSource has no clip range; sermon/short both require start/end.
    @ValidateIf((o: CreateJobDto) => o.kind !== "transcribeSource")
    @Type(() => Number)
    @IsNumber()
    startTime!: number;

    @ValidateIf((o: CreateJobDto) => o.kind !== "transcribeSource")
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
}