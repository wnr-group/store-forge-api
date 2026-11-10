import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Min } from 'class-validator';

export class RestoreVersionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'ID of the version to restore into the mutable draft',
  })
  @IsUUID()
  versionId!: string;

  @ApiProperty({
    description: 'Expected revision of the draft before restoration',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}
