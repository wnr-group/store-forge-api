import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class RollbackDto {
  @ApiProperty({
    format: 'uuid',
    description: 'ID of the version to roll back to',
  })
  @IsUUID()
  versionId!: string;
}
