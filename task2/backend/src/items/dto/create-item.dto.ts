import { IsString, IsOptional, IsUUID, IsArray, IsDateString, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum Priority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export class CreateItemDto {
  @ApiProperty({ description: 'The template to create this item from' })
  @IsUUID()
  templateId: string;

  @ApiProperty({ example: 'Fix login bug on mobile' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ example: 'Users report being unable to login on iOS Safari' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: Priority, default: Priority.MEDIUM })
  @IsEnum(Priority)
  @IsOptional()
  priority?: Priority;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @ApiPropertyOptional({ description: 'User IDs to assign to this item', type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  assigneeIds?: string[];
}
