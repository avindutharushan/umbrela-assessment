import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsBoolean,
  IsInt,
  Min,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateStageDto {
  @ApiProperty({ example: 'Draft' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  position?: number;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isStart?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsBoolean()
  @IsOptional()
  isFinal?: boolean;
}

export class CreateTransitionPermissionDto {
  @ApiPropertyOptional({ example: 'ADMIN' })
  @IsString()
  @IsOptional()
  role?: string;

  @ApiPropertyOptional({ example: 'uuid-of-specific-user' })
  @IsString()
  @IsOptional()
  userId?: string;
}

export class CreateTransitionDto {
  @ApiProperty({ example: 'Draft', description: 'Name of the source stage' })
  @IsString()
  fromStageName: string;

  @ApiProperty({ example: 'Review', description: 'Name of the target stage' })
  @IsString()
  toStageName: string;

  @ApiPropertyOptional({ example: 'Submit for Review' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ type: [CreateTransitionPermissionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTransitionPermissionDto)
  @IsOptional()
  permissions?: CreateTransitionPermissionDto[];
}

export class CreateTemplateDto {
  @ApiProperty({ example: 'Document Approval' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Standard document approval workflow' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ type: [CreateStageDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2, { message: 'A template must have at least 2 stages' })
  @ValidateNested({ each: true })
  @Type(() => CreateStageDto)
  stages: CreateStageDto[];

  @ApiProperty({ type: [CreateTransitionDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1, { message: 'A template must have at least 1 transition' })
  @ValidateNested({ each: true })
  @Type(() => CreateTransitionDto)
  transitions: CreateTransitionDto[];
}
