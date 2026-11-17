import { ApiProperty } from '@nestjs/swagger';
import { RequiredText } from '../../common/validation/fields.js';

export class ProfileDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty({ nullable: true }) fullName!: string | null;
}

export class UpdateProfileDto {
  @ApiProperty({ minLength: 2, maxLength: 120, example: 'Asha Rao' })
  @RequiredText('Full name', 120, 2)
  fullName!: string;
}
