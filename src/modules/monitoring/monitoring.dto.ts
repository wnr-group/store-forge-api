import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { JOB_NAMES } from './job-catalog.js';

export class ServiceStatusDto {
  @ApiProperty({ example: 'database' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({
    enum: ['up', 'down', 'not_configured', 'not_checked'],
    description:
      '`up` and `down` were measured just now. `not_configured` means the server has no setting for it. `not_checked` means it is configured but this screen does not call it.',
  })
  status!: string;
  @ApiPropertyOptional({ nullable: true }) latencyMs!: number | null;
  @ApiPropertyOptional({ nullable: true }) detail!: string | null;
}

export class ErrorIssueDto {
  @ApiProperty() method!: string;
  @ApiProperty({ example: '/api/v1/products/:id' }) route!: string;
  @ApiProperty() errorName!: string;
  @ApiProperty({
    description: 'Sanitised: no ids, values, e-mail addresses or tokens.',
  })
  message!: string;
  @ApiProperty() count!: number;
  @ApiProperty() lastSeen!: Date;
}

export class HourCountDto {
  @ApiProperty() hour!: Date;
  @ApiProperty() count!: number;
}

export class ErrorStatsDto {
  @ApiProperty({
    description: 'False when the error records could not be read.',
  })
  available!: boolean;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty() last15Minutes!: number;
  @ApiProperty() last24Hours!: number;
  @ApiProperty({
    type: [HourCountDto],
    description: 'The last 24 hours, one entry per hour, zeros included.',
  })
  byHour!: HourCountDto[];
  @ApiProperty({
    type: [ErrorIssueDto],
    description: 'The most frequent errors of the last 24 hours.',
  })
  topIssues!: ErrorIssueDto[];
}

export class JobRunSummaryDto {
  @ApiProperty({ enum: ['ok', 'failed'] }) status!: string;
  @ApiProperty() startedAt!: Date;
  @ApiProperty() durationMs!: number;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  summary!: unknown;
  @ApiPropertyOptional({ nullable: true }) error!: string | null;
}

export class JobStatusDto {
  @ApiProperty({ enum: JOB_NAMES }) job!: string;
  @ApiProperty() label!: string;
  @ApiProperty({
    description: 'How often it is meant to run, from the recommended schedule.',
  })
  expectedEveryMinutes!: number;
  @ApiProperty({
    enum: ['ok', 'late', 'failing', 'never_run'],
    description:
      '`failing`: the last run failed. `late`: it has run before but not successfully for more than twice its interval. `never_run`: no run is recorded (it may simply not be scheduled).',
  })
  health!: string;
  @ApiPropertyOptional({ type: JobRunSummaryDto, nullable: true })
  lastRun!: JobRunSummaryDto | null;
  @ApiPropertyOptional({ nullable: true }) lastSuccessAt!: Date | null;
  @ApiProperty() runsLast24Hours!: number;
  @ApiProperty() failuresLast24Hours!: number;
}

export class AlertDto {
  @ApiProperty({ example: 'database-down' }) id!: string;
  @ApiProperty({ enum: ['critical', 'warning', 'info'] }) severity!: string;
  @ApiProperty() title!: string;
  @ApiProperty() detail!: string;
}

export class UnavailableMetricDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() reason!: string;
}

class ApiStatusDto {
  @ApiProperty({
    enum: ['up'],
    description: 'This answer is itself proof that the API is running.',
  })
  status!: string;
  @ApiProperty({
    description:
      'How long this server instance has been running. A new instance starts often on serverless hosting.',
  })
  instanceUptimeSeconds!: number;
  @ApiProperty() nodeVersion!: string;
  @ApiProperty({ example: 'production' }) environment!: string;
}

class DatabaseStatusDto {
  @ApiProperty({ enum: ['up', 'down'] }) status!: string;
  @ApiPropertyOptional({ nullable: true }) latencyMs!: number | null;
}

export class MonitoringOverviewDto {
  @ApiProperty() generatedAt!: Date;
  @ApiProperty({ type: ApiStatusDto }) api!: ApiStatusDto;
  @ApiProperty({ type: DatabaseStatusDto }) database!: DatabaseStatusDto;
  @ApiProperty({ type: [ServiceStatusDto] }) services!: ServiceStatusDto[];
  @ApiProperty({ type: ErrorStatsDto }) errors!: ErrorStatsDto;
  @ApiProperty({ type: [JobStatusDto] }) jobs!: JobStatusDto[];
  @ApiProperty({
    type: [AlertDto],
    description:
      'Computed now from the data above; critical first. Empty when nothing needs attention.',
  })
  alerts!: AlertDto[];
  @ApiProperty({
    type: [UnavailableMetricDto],
    description:
      'Things people expect on a monitoring screen that this system does not measure, and why. They are never shown as zero.',
  })
  unavailableMetrics!: UnavailableMetricDto[];
}

export class ErrorEventDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() occurredAt!: Date;
  @ApiProperty() method!: string;
  @ApiProperty() route!: string;
  @ApiProperty() status!: number;
  @ApiProperty() errorName!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The first application line of the stack, e.g. `ProductsService.create products.service.ts:812`.',
  })
  source!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The `X-Request-Id` of the failed request, to find it in the server logs.',
  })
  requestId!: string | null;
}

export class ErrorListQueryDto extends PaginationQueryDto {}

export class JobRunDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: JOB_NAMES }) job!: string;
  @ApiProperty({ enum: ['ok', 'failed'] }) status!: string;
  @ApiProperty() startedAt!: Date;
  @ApiProperty() finishedAt!: Date;
  @ApiProperty() durationMs!: number;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  summary!: unknown;
  @ApiPropertyOptional({ nullable: true }) error!: string | null;
}

export class JobRunsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['all', ...JOB_NAMES], default: 'all' })
  @IsOptional()
  @IsIn(['all', ...JOB_NAMES])
  job: 'all' | (typeof JOB_NAMES)[number] = 'all';

  @ApiPropertyOptional({ enum: ['all', 'ok', 'failed'], default: 'all' })
  @IsOptional()
  @IsIn(['all', 'ok', 'failed'])
  status: 'all' | 'ok' | 'failed' = 'all';
}
