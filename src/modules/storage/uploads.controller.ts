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
} from './storage-paths.js';
import { StorageService } from './storage.service.js';

class UploadFileDto {
  @ApiProperty({ enum: IMAGE_TYPES })
  @IsIn(IMAGE_TYPES, { message: 'Only JPEG, PNG and WebP images are allowed.' })
  type!: (typeof IMAGE_TYPES)[number];

  @ApiProperty({ description: 'Size in bytes, at most 5 MB.' })
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
      'Product or collection id the files will belong to (required unless scope is `store`).',
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
      'Object path to send back when saving the product, collection or store.',
  })
  path!: string;
  @ApiProperty({ description: 'One-time upload token.' }) token!: string;
  @ApiProperty({
    description: 'PUT the file here (Supabase signed upload URL).',
  })
  signedUrl!: string;
}

@ApiTags('uploads')
@Controller('uploads')
@OrgScoped()
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  @Post('signed-urls')
  @ApiEndpoint({
    summary: 'Get one-time signed upload URLs',
    description:
      'The target folder is derived from the verified organization, never from the request. Upload each file straight to Supabase Storage, then send the returned `path` when saving the product / collection / store.',
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
    if (!can({ role: org.role, permissions: org.permissions }, needed))
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
    return this.storage.createUploadTargets(user.token, folder, dto.files);
  }
}
