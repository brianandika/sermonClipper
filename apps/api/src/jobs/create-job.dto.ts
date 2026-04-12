import { Type } from "class-transformer";
import {
    ArrayMinSize,
    IsArray,
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    ValidateIf,
} from "class-validator";
import { HardwareOption } from "@sermon-clipper/shared";

export class CreateJobDto {
    @IsString()
    assetId!: string;

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

    @Type(() => Number)
    @IsNumber()
    startTime!: number;

    @Type(() => Number)
    @IsNumber()
    endTime!: number;

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