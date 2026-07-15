import { IsUUID, IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TransitionItemDto {
  @ApiProperty({ description: 'Target stage ID to transition to' })
  @IsUUID()
  toStageId: string;

  @ApiProperty({ description: 'Current version for optimistic locking' })
  @IsInt()
  version: number;
}
