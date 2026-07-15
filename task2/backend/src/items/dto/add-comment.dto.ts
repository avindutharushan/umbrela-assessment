import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddCommentDto {
  @ApiProperty({ example: 'This needs to be reviewed by the security team.' })
  @IsString()
  @MinLength(1)
  body: string;
}
