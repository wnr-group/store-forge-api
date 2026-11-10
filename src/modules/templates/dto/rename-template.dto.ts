import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RenameTemplateDto {
  @ApiProperty({
    description: 'New template display name (1..80 code points)',
    maxLength: 80,
  })
  @IsString()
  @IsNotEmpty()
  name!: string;
}
