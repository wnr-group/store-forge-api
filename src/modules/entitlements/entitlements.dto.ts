import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class FeatureStateDto {
  @ApiProperty({ example: 'google_analytics' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() group!: string;
  @ApiProperty({
    description: 'Whether the organization may use it right now.',
  })
  enabled!: boolean;
  @ApiProperty({
    enum: ['plan', 'unrestricted', 'override'],
    description:
      'Where the answer comes from: the plan, an unrestricted plan, or an exception StoreForge set for this organization.',
  })
  source!: string;
}

export class LimitStateDto {
  @ApiProperty({ example: 'products' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['count', 'bytes'] }) unit!: string;
  @ApiProperty({
    description:
      'Whether going past the hard limit is refused. Limits that are not enforced (orders) are only reported.',
  })
  enforced!: boolean;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The current number. Empty when it could not be measured (storage).',
  })
  used!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Warn from this number. Empty means no warning level.',
  })
  soft!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Refuse past this number. Empty means unlimited.',
  })
  hard!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Share of the hard limit used, in whole percent.',
  })
  percent!: number | null;
  @ApiProperty({
    enum: ['ok', 'warning', 'reached', 'unknown'],
    description:
      '`warning` from the soft limit or 80% of the hard limit; `reached` at or past the hard limit.',
  })
  level!: string;
  @ApiProperty({ enum: ['plan', 'unrestricted', 'override'] }) source!: string;
}

export class EntitlementsDto {
  @ApiProperty() planCode!: string;
  @ApiProperty() planName!: string;
  @ApiProperty() isUnrestricted!: boolean;
  @ApiProperty({
    enum: ['trialing', 'active', 'past_due', 'canceled', 'expired'],
    description: 'A trial whose end date has passed reads as `expired`.',
  })
  subscriptionStatus!: string;
  @ApiProperty({
    description:
      'False when the subscription is canceled or expired: nothing is granted then.',
  })
  entitled!: boolean;
  @ApiPropertyOptional({ nullable: true }) trialEndsAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) currentPeriodEnd!: string | null;
  @ApiProperty({ type: [FeatureStateDto] }) features!: FeatureStateDto[];
  @ApiProperty({ type: [LimitStateDto] }) limits!: LimitStateDto[];
  @ApiProperty({
    type: [LimitStateDto],
    description:
      'The limits at `warning` or `reached`, so a dashboard can show a notice without filtering.',
  })
  attention!: LimitStateDto[];
}

export class EntitlementsQueryDto {
  @ApiPropertyOptional({
    description:
      'Also measure storage. It reads the file store, so ask only on screens that show it.',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  storage: boolean = false;
}
