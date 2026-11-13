import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsObject, Min } from 'class-validator';
import type { TemplateDocument } from '../../../infrastructure/database/template-deps/document.js';

export class SaveDraftDto {
  @ApiProperty({
    description: 'Expected revision of the template before saving',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({
    description: 'Updated template document JSON',
  })
  @IsObject()
  @IsNotEmpty()
  document!: TemplateDocument;
}
