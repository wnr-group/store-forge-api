import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { conflict, invalid, notFound } from '../../common/app.exception.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { StorageService } from '../storage/storage.service.js';
import { newObjectName } from '../storage/storage-paths.js';
import { requireStore } from '../themes/themes.shared.js';
import type {
  FinalizeMediaDto,
  MediaAssetDto,
  MediaUploadRequestDto,
  MediaUploadTargetDto,
} from './studio.dto.js';
import { withStudioErrors } from './studio.service.js';

type MediaRow = {
  id: string;
  kind: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  alt_text: string | null;
  attestation_id: string | null;
  finalized_at: string | Date | null;
  created_at: string | Date;
};

const COLUMNS = sql`id, kind, storage_path, mime_type, size_bytes, width, height, alt_text, attestation_id, finalized_at, created_at`;

const mediaNotFound = () =>
  notFound('That file could not be found.', 'MEDIA_NOT_FOUND');

const toDto = (r: MediaRow): MediaAssetDto => ({
  id: r.id,
  kind: r.kind,
  storagePath: r.storage_path,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes,
  width: r.width,
  height: r.height,
  altText: r.alt_text,
  attestationId: r.attestation_id,
  finalizedAt: r.finalized_at ? new Date(r.finalized_at) : null,
  createdAt: new Date(r.created_at),
});

/**
 * Studio media. The object path is never taken from the client: it is `{tenant id}/{random name}.{extension of the
 * checked type}`, a direct child of the tenant folder. Type, size and dimensions are validated twice (DTO, then the
 * table's CHECK constraints), and finalizing re-reads type and size from Storage. Dimensions are the client's
 * declaration: the API does not decode images.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  async requestUpload(
    org: OrgContext,
    user: AuthUser,
    dto: MediaUploadRequestDto,
  ): Promise<MediaUploadTargetDto> {
    const name = newObjectName(dto.mimeType);
    if (!name)
      throw invalid('Only JPEG, PNG and WebP images are allowed.', {
        mimeType: 'Unsupported type',
      });
    const path = `${org.tenantId}/${name}`;
    return withStudioErrors(() =>
      this.db.withUser(org.userId, async (tx) => {
        const store = await requireStore(tx, org);
        // Raw SQL: the app role may only insert specific columns (migration 0037).
        const rows = rowsOf<{ id: string }>(
          await tx.execute(sql`insert into public.media_assets
            (tenant_id, store_id, owner_user_id, kind, storage_path, mime_type, size_bytes, width, height, alt_text)
            values (${org.tenantId}::uuid, ${store.id}::uuid, ${org.userId}::uuid, ${dto.kind}, ${path}, ${dto.mimeType},
                    ${dto.sizeBytes}::int, ${dto.width}::int, ${dto.height}::int, ${dto.altText ?? null})
            returning id`),
        );
        const target = await this.storage.createUploadTargetAt(
          user.token,
          path,
        );
        return { id: rows[0].id, ...target };
      }),
    );
  }

  async finalize(
    org: OrgContext,
    user: AuthUser,
    id: string,
    dto: FinalizeMediaDto,
  ): Promise<MediaAssetDto> {
    return withStudioErrors(() =>
      this.db.withUser(org.userId, async (tx) => {
        const found = rowsOf<MediaRow & { tenant_id: string }>(
          await tx.execute(
            sql`select ${COLUMNS}, tenant_id from public.media_assets
                where id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid for update`,
          ),
        )[0];
        if (!found) throw mediaNotFound();

        if (!found.finalized_at) {
          const verified = await this.storage.verifyChildObject(
            user.token,
            org.tenantId,
            found.storage_path,
          );
          if (verified.mimeType !== found.mime_type) {
            await this.storage.removeObjects(user.token, [found.storage_path]);
            throw invalid(
              'The uploaded file is not the type that was announced.',
              { mimeType: 'Does not match the upload request' },
              'MEDIA_TYPE_MISMATCH',
            );
          }
          await tx.execute(
            sql`update public.media_assets set size_bytes = ${verified.sizeBytes}::int, finalized_at = now()
                where id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid`,
          );
        }
        if (dto.attestationId) {
          if (
            found.attestation_id &&
            found.attestation_id !== dto.attestationId
          )
            throw conflict(
              'This file already has an attestation.',
              { attestationId: 'Already linked' },
              'ATTESTATION_ALREADY_LINKED',
            );
          await tx.execute(
            sql`update public.media_assets set attestation_id = ${dto.attestationId}::uuid
                where id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid`,
          );
        }
        const row = rowsOf<MediaRow>(
          await tx.execute(
            sql`select ${COLUMNS} from public.media_assets where id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid`,
          ),
        )[0];
        return toDto(row);
      }),
    );
  }
}
