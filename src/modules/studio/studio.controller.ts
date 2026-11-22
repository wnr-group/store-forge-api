import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  CurrentUser,
  OrgScoped,
  PlatformAccess,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import { invalid } from '../../common/app.exception.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import { MediaService } from './media.service.js';
import {
  ReadinessReportDto,
  ReadinessRequestDto,
} from './readiness/readiness.dto.js';
import { ReadinessService } from './readiness/readiness.service.js';
import { PlatformStudioService } from './platform-studio.service.js';
import {
  AttestationDto,
  CreateAttestationDto,
  CreateLegalWordingDto,
  DiscardDraftDto,
  FeatureApprovalDto,
  FinalizeMediaDto,
  LegalWordingDto,
  MediaAssetDto,
  MediaUploadRequestDto,
  MediaUploadTargetDto,
  RecordFeatureApprovalDto,
  RolloutEventsQueryDto,
  SetStudioRolloutDto,
  StudioRolloutDto,
  StudioRolloutEventDto,
  StudioSettingsDto,
  StudioStatusDto,
  UpdateStudioSettingsDto,
} from './studio.dto.js';
import { StudioService } from './studio.service.js';

const WORDING_KEY = /^[a-z][a-z0-9_.-]{1,63}$/;

/** Studio routes for the signed-in member's own store. */
@ApiTags('studio')
@Controller('store')
@OrgScoped()
export class StudioController {
  constructor(
    private readonly studio: StudioService,
    private readonly media: MediaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get('studio/status')
  @RequirePermission('design:view')
  @ApiEndpoint({
    summary: 'Is the new Studio on for my store?',
    description:
      'Tells the dashboard whether the new Studio is switched on for this store (off by default; only a Platform Admin can change it), whether the store may save schema version 2 documents, the point of no return if one was recorded, and which legally gated features are available. A feature stays `unavailable` until legal approval is recorded.',
    auth: 'org',
    permission: 'design:view',
    response: StudioStatusDto,
    message: 'Studio status retrieved successfully',
    errors: [403, 404],
  })
  status(@CurrentOrg() org: OrgContext) {
    return this.studio.status(org);
  }

  @Post('studio/readiness')
  @RequirePermission('design:view')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiEndpoint({
    summary: 'Check my design before publishing',
    description:
      'Runs the publish-readiness checks on the drafts of your store (or one page) and lists the problems: blockers (must be fixed), warnings (must be acknowledged to publish) and information. Each issue says what is wrong, where, and which control fixes it. Nothing is changed. When the new Studio is on for the store, publishing runs the same checks again and refuses blockers; otherwise the report is advice only (`enforced` is false).',
    auth: 'org',
    permission: 'design:view',
    body: ReadinessRequestDto,
    response: ReadinessReportDto,
    message: 'Readiness report created successfully',
    errors: [400, 403, 404],
  })
  readinessReport(
    @CurrentOrg() org: OrgContext,
    @Body() dto: ReadinessRequestDto,
  ) {
    return this.readiness.report(org, dto.templateId);
  }

  @Get('legal/wordings/:key')
  @RequirePermission('design:view')
  @ApiParam({ name: 'key', example: 'badge_upload.attestation' })
  @ApiEndpoint({
    summary: 'Read an approved legal wording',
    description:
      'Get the newest approved version of a legal wording, to show before someone attests. Drafts and retired versions are never returned. Send the returned `key` and `version` back when you attest.',
    auth: 'org',
    permission: 'design:view',
    response: LegalWordingDto,
    message: 'Legal wording retrieved successfully',
    errors: [400, 403, 404],
  })
  wording(@CurrentOrg() org: OrgContext, @Param('key') key: string) {
    if (!WORDING_KEY.test(key))
      throw invalid('That wording key is not valid.', { key: 'Invalid key' });
    return this.studio.approvedWording(org, key);
  }

  @Post('attestations')
  @RequirePermission('design:attest')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiEndpoint({
    summary: 'Record an attestation',
    description:
      'Record that you accepted an exact version of an approved legal wording (for a badge image upload or a review import). Unknown or unapproved wording is rejected. Attestations can never be changed or deleted. Needs the `attest` capability (the Owner has it).',
    auth: 'org',
    permission: 'design:attest',
    body: CreateAttestationDto,
    response: AttestationDto,
    status: 201,
    message: 'Attestation recorded successfully',
    errors: [400, 403],
  })
  attest(@CurrentOrg() org: OrgContext, @Body() dto: CreateAttestationDto) {
    return this.studio.attest(org, dto);
  }

  @Post('media-assets/upload-requests')
  @RequirePermission('design:edit')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiEndpoint({
    summary: 'Get a link to upload a Studio image',
    description:
      'Ask for a one-time upload link for a Studio image (for example a badge). Only JPEG, PNG and WebP up to 5 MB are accepted; SVG is never accepted. The file location is chosen by the server inside your organization folder, never by the request. Upload the file to the signed address, then call finalize.',
    auth: 'org',
    permission: 'design:edit',
    body: MediaUploadRequestDto,
    response: MediaUploadTargetDto,
    status: 201,
    message: 'Upload URL created successfully',
    errors: [400, 403],
  })
  uploadRequest(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: MediaUploadRequestDto,
  ) {
    return this.media.requestUpload(org, user, dto);
  }

  @Post('media-assets/:id/finalize')
  @RequirePermission('design:edit')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Finish a Studio image upload',
    description:
      'Confirm the file was uploaded. The type and size are read from Storage (not from the request) and must match what was announced. Optionally links the attestation made for this file. Calling it again is safe.',
    auth: 'org',
    permission: 'design:edit',
    body: FinalizeMediaDto,
    response: MediaAssetDto,
    message: 'Image finalized successfully',
    errors: [400, 403, 404, 409],
  })
  finalize(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinalizeMediaDto,
  ) {
    return this.media.finalize(org, user, id, dto);
  }

  @Get('studio/settings')
  @RequirePermission('design:view')
  @ApiEndpoint({
    summary: 'Get store studio settings',
    description: 'Get the store studio settings such as review disclosure wording and language.',
    auth: 'org',
    permission: 'design:view',
    response: StudioSettingsDto,
    message: 'Studio settings retrieved successfully',
  })
  getSettings(@CurrentOrg() org: OrgContext) {
    return this.studio.getSettings(org);
  }

  @Patch('studio/settings')
  @RequirePermission('design:edit')
  @ApiEndpoint({
    summary: 'Update store studio settings',
    description: 'Update the review disclosure wording or language for the store.',
    auth: 'org',
    permission: 'design:edit',
    body: UpdateStudioSettingsDto,
    response: StudioSettingsDto,
    message: 'Studio settings updated successfully',
    errors: [400, 403],
  })
  updateSettings(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateStudioSettingsDto,
  ) {
    return this.studio.updateSettings(org, user, dto);
  }

  @Get('studio/speed')
  @RequirePermission('design:view')
  @ApiEndpoint({
    summary: 'Get Web Vitals performance statistics',
    description: 'Aggregated Web Vitals performance statistics for the store from real visitor sessions.',
    auth: 'org',
    permission: 'design:view',
    message: 'Web vitals retrieved successfully',
  })
  getSpeed(@CurrentOrg() org: OrgContext) {
    return this.studio.getSpeed(org);
  }

  @Post('studio/review-requests')
  @RequirePermission('design:edit')
  @ApiEndpoint({
    summary: 'Mark drafts ready for review',
    description: 'Submit current store draft templates for review and lock their revision fingerprint.',
    auth: 'org',
    permission: 'design:edit',
    message: 'Review request submitted successfully',
    errors: [403],
  })
  requestReview(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.studio.requestReview(org, user);
  }

  @Get('studio/review-requests/current')
  @RequirePermission('design:view')
  @ApiEndpoint({
    summary: 'Get current active review request',
    description: 'Get the active review request and draft revision fingerprint if one is pending.',
    auth: 'org',
    permission: 'design:view',
    message: 'Current review request retrieved successfully',
  })
  getCurrentReview(@CurrentOrg() org: OrgContext) {
    return this.studio.getCurrentReview(org);
  }

  @Get('studio/changes')
  @RequirePermission('design:view')
  @ApiEndpoint({
    summary: 'Get summary of unpublished draft changes',
    description: 'Compare all active templates against published versions to list changes.',
    auth: 'org',
    permission: 'design:view',
    message: 'Draft changes retrieved successfully',
  })
  getChanges(@CurrentOrg() org: OrgContext) {
    return this.studio.getChanges(org);
  }

  @Get('studio/ledger')
  @RequirePermission('design:view')
  @ApiEndpoint({
    summary: 'View change ledger',
    description: 'Query recent change ledger entries for templates and sections.',
    auth: 'org',
    permission: 'design:view',
    message: 'Change ledger retrieved successfully',
  })
  getLedger(
    @CurrentOrg() org: OrgContext,
    @Query('templateId') templateId?: string,
  ) {
    return this.studio.getLedger(org, templateId);
  }

  @Post('studio/discard')
  @RequirePermission('design:edit')
  @ApiEndpoint({
    summary: 'Discard draft changes',
    description: 'Discard draft changes for a template back to published version. Requires discard capability.',
    auth: 'org',
    permission: 'design:edit',
    body: DiscardDraftDto,
    message: 'Draft changes discarded successfully',
    errors: [400, 403, 404],
  })
  discardDraft(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: DiscardDraftDto,
  ) {
    return this.studio.discardDraft(org, user, dto);
  }
}

/** Platform Admin only. */
@ApiTags('platform-admin')
@Controller('platform')
@PlatformAccess()
export class PlatformStudioController {
  constructor(private readonly platform: PlatformStudioService) {}

  @Put('organizations/:id/studio-rollout')
  @PlatformAccess({ bucket: 'org.edit' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Organization id' })
  @ApiEndpoint({
    summary: 'Turn the new Studio on or off for an organization',
    description:
      "Switch the new Studio on or off for the organization's store. A reason is required. The change is saved in the store's rollout history and in the audit log. Turning it off deletes no data and does not affect the storefront.",
    auth: 'platform',
    permission: 'any Platform Admin',
    body: SetStudioRolloutDto,
    response: StudioRolloutDto,
    message: 'Studio rollout updated successfully',
    errors: [400, 403, 404],
  })
  setRollout(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetStudioRolloutDto,
  ) {
    return this.platform.setRollout(admin.id, id, dto);
  }

  @Get('organizations/:id/studio-rollout/events')
  @ApiParam({ name: 'id', format: 'uuid', description: 'Organization id' })
  @ApiEndpoint({
    summary: 'See the Studio rollout history',
    description:
      "The history of Studio on/off changes for the organization's store, newest first, with the reason and who changed it. Entries can never be edited or deleted.",
    auth: 'platform',
    response: [StudioRolloutEventDto],
    paginated: true,
    message: 'Rollout history retrieved successfully',
    errors: [403, 404],
  })
  events(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RolloutEventsQueryDto,
  ) {
    return this.platform.listRolloutEvents(admin.id, id, query);
  }

  @Post('legal/wordings')
  @PlatformAccess({ bucket: 'settings.update' })
  @ApiEndpoint({
    summary: 'Add a legal wording version',
    description:
      'Add the next version of a legal wording (the server assigns the version number). A wording added as `approved` can never be edited again. This does not approve any feature.',
    auth: 'platform',
    permission: 'any Platform Admin',
    body: CreateLegalWordingDto,
    response: LegalWordingDto,
    status: 201,
    message: 'Legal wording created successfully',
    errors: [400, 403],
  })
  createWording(
    @CurrentUser() admin: AuthUser,
    @Body() dto: CreateLegalWordingDto,
  ) {
    return this.platform.createWording(admin.id, dto);
  }

  @Post('legal/approvals')
  @PlatformAccess({ bucket: 'settings.update' })
  @ApiEndpoint({
    summary: 'Record a legal approval for a feature',
    description:
      'Record that legal approved a feature against an approved wording version, with who approved it, when and for which release. Until this exists the feature stays unavailable. Approvals can never be edited or deleted. Only record approvals that really exist.',
    auth: 'platform',
    permission: 'any Platform Admin',
    body: RecordFeatureApprovalDto,
    response: FeatureApprovalDto,
    status: 201,
    message: 'Feature approval recorded successfully',
    errors: [400, 403],
  })
  recordApproval(
    @CurrentUser() admin: AuthUser,
    @Body() dto: RecordFeatureApprovalDto,
  ) {
    return this.platform.recordApproval(admin.id, dto);
  }
}
