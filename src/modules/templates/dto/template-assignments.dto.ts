import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class AssignmentItemDto {
  @ApiProperty({ enum: ['product', 'collection'] })
  @IsIn(['product', 'collection'])
  resourceType!: 'product' | 'collection';

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  resourceId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  templateId!: string;
}

export class BulkAssignmentsDto {
  @ApiProperty({
    type: [AssignmentItemDto],
    minItems: 1,
    maxItems: 100,
    description: 'Array of up to 100 template assignments',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AssignmentItemDto)
  assignments!: AssignmentItemDto[];
}

export class UnassignResourceDto {
  @ApiProperty({ enum: ['product', 'collection'] })
  @IsIn(['product', 'collection'])
  resourceType!: 'product' | 'collection';

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  resourceId!: string;
}

export class BulkUnassignDto {
  @ApiProperty({
    type: [UnassignResourceDto],
    minItems: 1,
    maxItems: 100,
    description: 'Array of up to 100 resources to unassign',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => UnassignResourceDto)
  resources!: UnassignResourceDto[];
}
