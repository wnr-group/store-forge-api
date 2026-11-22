import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { invalid } from '../../common/app.exception.js';
import { errorChain } from '../../common/db-errors.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { offsetOf } from '../../common/dto/pagination-query.dto.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { mapProvisioningError } from '../platform-admin/platform-errors.js';
import type {
  CreateLegalWordingDto,
  FeatureApprovalDto,
  LegalWordingDto,
  RecordFeatureApprovalDto,
  RolloutEventsQueryDto,
  SetStudioRolloutDto,
  StudioRolloutDto,
  StudioRolloutEventDto,
} from './studio.dto.js';
import { toWordingDto } from './studio.service.js';

type EventRaw = {
  id: string;
  store_id: string;
  actor_id: string;
  action: string;
  reason: string;
  previous: Record<string, unknown> | null;
  new: Record<string, unknown> | null;
  created_at: string | Date;
  total_count: string | number | bigint;
};

const asDate = (v: string | null | undefined) => (v ? new Date(v) : null);

/**
 * Platform Admin side of Studio: the per-store rollout flag and the legal wording / approval records. Every call goes
 * through a SECURITY DEFINER function that authorises the caller as a Platform Admin itself; the tables cannot be
 * reached directly. The rollout change and its history + audit rows are written in one transaction by the function.
 */
@Injectable()
export class PlatformStudioService {
  constructor(private readonly db: DatabaseService) {}

  async setRollout(
    adminId: string,
    organizationId: string,
    dto: SetStudioRolloutDto,
  ): Promise<StudioRolloutDto> {
    try {
      return await this.db.withUser(adminId, async (tx) => {
        const r = rowsOf<{
          r: {
            storeId: string;
            enabled: boolean;
            enabledAt: string | null;
            pointOfNoReturnAt: string | null;
          };
        }>(
          await tx.execute(
            sql`select public.platform_set_studio_rollout(${organizationId}::uuid, ${dto.enabled}, ${dto.reason}) as r`,
          ),
        )[0].r;
        return {
          storeId: r.storeId,
          enabled: r.enabled,
          enabledAt: asDate(r.enabledAt),
          pointOfNoReturnAt: asDate(r.pointOfNoReturnAt),
        };
      });
    } catch (e) {
      return mapProvisioningError(e);
    }
  }

  async listRolloutEvents(
    adminId: string,
    organizationId: string,
    q: RolloutEventsQueryDto,
  ): Promise<Paginated<StudioRolloutEventDto>> {
    try {
      return await this.db.withUser(adminId, async (tx) => {
        const rows = rowsOf<EventRaw>(
          await tx.execute(
            sql`select * from public.platform_list_studio_rollout_events(${organizationId}::uuid, ${q.limit}, ${offsetOf(q)})`,
          ),
        );
        return new Paginated(
          rows.map((r) => ({
            id: r.id,
            storeId: r.store_id,
            actorId: r.actor_id,
            action: r.action,
            reason: r.reason,
            previous: r.previous,
            new: r.new,
            createdAt: new Date(r.created_at),
          })),
          {
            page: q.page,
            limit: q.limit,
            total: Number(rows[0]?.total_count ?? 0),
          },
        );
      });
    } catch (e) {
      return mapProvisioningError(e);
    }
  }

  async createWording(
    adminId: string,
    dto: CreateLegalWordingDto,
  ): Promise<LegalWordingDto> {
    try {
      return await this.db.withUser(adminId, async (tx) => {
        const w = rowsOf<{ w: Parameters<typeof toWordingDto>[0] }>(
          await tx.execute(
            sql`select public.platform_create_legal_wording(${dto.key}, ${dto.languageTag}, ${dto.text}, ${dto.status}) as w`,
          ),
        )[0].w;
        return toWordingDto(w);
      });
    } catch (e) {
      return mapProvisioningError(e);
    }
  }

  async recordApproval(
    adminId: string,
    dto: RecordFeatureApprovalDto,
  ): Promise<FeatureApprovalDto> {
    try {
      return await this.db.withUser(adminId, async (tx) => {
        const a = rowsOf<{
          a: Omit<FeatureApprovalDto, 'approvedAt' | 'createdAt'> & {
            approvedAt: string;
            createdAt: string;
          };
        }>(
          await tx.execute(
            sql`select public.platform_record_feature_approval(${dto.featureKey}, ${dto.wordingKey}, ${dto.wordingVersion}::int,
              ${dto.approverRef}, ${dto.approvedAt}::timestamptz, ${dto.release}) as a`,
          ),
        )[0].a;
        return {
          ...a,
          approvedAt: new Date(a.approvedAt),
          createdAt: new Date(a.createdAt),
        };
      });
    } catch (e) {
      if (errorChain(e).includes('wording_not_approved'))
        throw invalid(
          'That wording version is not approved.',
          { wordingVersion: 'Use an approved version of the wording.' },
          'WORDING_NOT_APPROVED',
        );
      return mapProvisioningError(e);
    }
  }
}
