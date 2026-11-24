import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import {
  BILLING_INTERVALS,
  SUBSCRIPTION_STATUSES,
} from '../../../common/constants/plan-catalog.js';

export class SubscriptionPlanDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() status!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() monthlyPriceMinor!: number;
  @ApiProperty() yearlyPriceMinor!: number;
  @ApiProperty() isUnrestricted!: boolean;
}

export class SubscriptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ type: SubscriptionPlanDto }) plan!: SubscriptionPlanDto;
  @ApiProperty({ enum: SUBSCRIPTION_STATUSES }) status!: string;
  @ApiProperty({ enum: BILLING_INTERVALS }) billingInterval!: string;
  @ApiPropertyOptional({ nullable: true }) trialEndsAt!: Date | null;
  @ApiProperty() currentPeriodStart!: Date;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The renewal date. Empty for a free plan.',
  })
  currentPeriodEnd!: Date | null;
  @ApiProperty() cancelAtPeriodEnd!: boolean;
  @ApiPropertyOptional({ nullable: true }) canceledAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AssignPlanDto {
  @ApiProperty({ format: 'uuid', description: 'An active plan.' })
  @IsUUID(undefined, { message: 'Choose a plan.' })
  planId!: string;

  @ApiPropertyOptional({ enum: BILLING_INTERVALS, default: 'monthly' })
  @IsOptional()
  @IsIn(BILLING_INTERVALS, { message: 'Choose monthly or yearly billing.' })
  billingInterval?: (typeof BILLING_INTERVALS)[number];

  @ApiPropertyOptional({
    description:
      'Start the plan trial. Defaults to true only when the organization has no subscription yet; changing plans does not start a new trial unless you ask.',
  })
  @IsOptional()
  @IsBoolean()
  startTrial?: boolean;
}
