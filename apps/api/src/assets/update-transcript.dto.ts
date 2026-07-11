import { Type } from "class-transformer";
import { IsArray, IsNumber, IsString, Min, ValidateNested } from "class-validator";

export class TranscriptCueDto {
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    start!: number;

    @Type(() => Number)
    @IsNumber()
    @Min(0)
    end!: number;

    @IsString()
    text!: string;
}

export class UpdateTranscriptDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => TranscriptCueDto)
    cues!: TranscriptCueDto[];
}
