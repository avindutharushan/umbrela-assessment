import { IsString, IsOptional, IsEnum, IsDateString, IsInt } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Priority } from './create-item.dto';

export class UpdateItemDto {
  @ApiPropertyOptional({ example: 'Updated title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ example: 'Updated description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: Priority })
  @IsEnum(Priority)
  @IsOptional()
  priority?: Priority;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @ApiPropertyOptional({ description: 'Current version for optimistic locking' })
  @IsInt()
  version: number;
}
