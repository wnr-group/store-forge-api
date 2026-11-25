import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { Body, Controller, Post } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { forbidden, invalid } from '../../common/app.exception.js';
import { can } from '../../common/constants/permissions.js';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  CurrentUser,
  OrgScoped,
} from '../../common/decorators/decorators.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import {
  collectionFolder,
  IMAGE_TYPES,
  MAX_IMAGES_PER_PRODUCT,
  productFolder,
  storeFolder,
  VIDEO_TYPES,
} from './storage-paths.js';
import { StorageService } from './storage.service.js';

class UploadFileDto {
  @ApiProperty({ enum: [...IMAGE_TYPES, ...VIDEO_TYPES] })
  @IsIn([...IMAGE_TYPES, ...VIDEO_TYPES], {
    message:
      'Only JPEG, PNG and WebP images or MP4 and WebM videos are allowed.',
  })
  type!: (typeof IMAGE_TYPES)[number] | (typeof VIDEO_TYPES)[number];

  @ApiProperty({
    description:
      'File size in bytes. Images can be at most 5 MB; videos (store scope only) at most 50 MB.',
  })
  @IsInt()
  @Min(1)
  size!: number;
}

class RequestUploadsDto {
  @ApiProperty({ enum: ['product', 'collection', 'store'] })
  @IsIn(['product', 'collection', 'store'])
  scope!: 'product' | 'collection' | 'store';

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The id of the product or collection these files belong to. Required unless the scope is `store`.',
  })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiProperty({
    type: [UploadFileDto],
    minItems: 1,
    maxItems: MAX_IMAGES_PER_PRODUCT,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMAGES_PER_PRODUCT)
  @ValidateNested({ each: true })
  @Type(() => UploadFileDto)
  files!: UploadFileDto[];
}

class UploadTargetDto {
  @ApiProperty({
    description:
      'The file location. Send this back when you save the product, collection or store.',
  })
  path!: string;
  @ApiProperty({ description: 'A token that can be used for one upload only.' })
  token!: string;
  @ApiProperty({
    description:
      'Upload the file to this address with a PUT request. It is a signed Supabase upload link.',
  })
  signedUrl!: string;
}

@ApiTags('uploads')
@Controller('uploads')
@OrgScoped()
export class UploadsController {
  constructor(
    private readonly storage: StorageService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Post('signed-urls')
  @ApiEndpoint({
    summary: 'Get links to upload images',
    description:
      "Ask for secure, one-time upload links for your images. Choose what the images are for (a product, a collection or the store itself) and describe each file (its type and size). The folder the files go into is worked out from your own organization, never from the request, so nobody can upload into another store's folder. Then upload each file straight to Supabase Storage using its link, and send the `path` you got back when you save the product, collection or store.",
    auth: 'org',
    permission: '`store:manage` for scope `store`, otherwise `catalog:manage`',
    body: RequestUploadsDto,
    response: [UploadTargetDto],
    status: 201,
    message: 'Upload URLs created successfully',
  })
  async signedUrls(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: RequestUploadsDto,
  ) {
    const needed = dto.scope === 'store' ? 'store:manage' : 'catalog:manage';
    if (
      !can(
        {
          role: org.role,
          permissions: org.permissions,
          capabilities: org.capabilities,
        },
        needed,
      )
    )
      throw forbidden();
    if (dto.scope !== 'store' && !dto.ownerId)
      throw invalid('ownerId is required.', {
        ownerId: 'Required for product and collection uploads',
      });
    const folder =
      dto.scope === 'store'
        ? storeFolder(org.tenantId)
        : dto.scope === 'collection'
          ? collectionFolder(org.tenantId, dto.ownerId!)
          : productFolder(org.tenantId, dto.ownerId!);
    // New uploads stop once the plan storage limit is reached (the file sizes being asked for count too).
    await this.entitlements.assertWithinLimitAs(
      user.id,
      org.tenantId,
      'storage_bytes',
      dto.files.reduce((sum, file) => sum + file.size, 0),
    );
    return this.storage.createUploadTargets(
      user.token,
      folder,
      dto.files,
      dto.scope === 'store',
    );
  }
}
