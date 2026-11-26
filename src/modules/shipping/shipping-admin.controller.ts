import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequireExplicitOrganization,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { MethodDto, MethodListQueryDto, SaveMethodDto } from './methods.dto.js';
import { MethodsService } from './methods.service.js';
import {
  CarrierComparisonDto,
  CarrierComparisonResultDto,
  OriginDto,
  PreviewDto,
  SaveOriginDto,
  ShippingQuoteDto,
} from './shipping-tools.dto.js';
import { ShippingToolsService } from './shipping-tools.service.js';
import { SaveZoneDto, ZoneDetailDto, ZoneDto } from './zones.dto.js';
import { ZonesService } from './zones.service.js';

const WRITE = { default: { limit: 60, ttl: 60_000 } };
const SLOW = { default: { limit: 10, ttl: 60_000 } };
const ORG_HEADER_NOTE =
  'This route REQUIRES the `X-Organization-Id` header (a missing or blank header is a 400 `ORGANIZATION_REQUIRED`).';

@ApiTags('shipping')
@Controller('shipping')
@OrgScoped()
@RequireExplicitOrganization()
export class ShippingAdminController {
  constructor(
    private readonly zones: ZonesService,
    private readonly methods: MethodsService,
    private readonly tools: ShippingToolsService,
  ) {}

  // --- zones -----------------------------------------------------------------------------------------------------------

  @Get('zones')
  @RequirePermission('shipping:view')
  @ApiEndpoint({
    summary: 'List shipping zones',
    description: `Your delivery zones with a summary of what each covers (states, cities, PIN codes, PIN ranges) and how many methods it has. Once you have any zone, shipping is enforced at checkout: an address no enabled zone covers cannot be delivered to. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:view',
    response: [ZoneDto],
    message: 'Shipping zones retrieved successfully',
  })
  listZones(@CurrentOrg() org: OrgContext) {
    return this.zones.list(org);
  }

  @Get('zones/:id')
  @RequirePermission('shipping:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one shipping zone',
    description: `The zone with everything it covers. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:view',
    response: ZoneDetailDto,
    message: 'Shipping zone retrieved successfully',
    errors: [404],
  })
  getZone(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.zones.get(org, id);
  }

  @Post('zones')
  @Throttle(WRITE)
  @RequirePermission('shipping:manage')
  @ApiEndpoint({
    summary: 'Create a shipping zone',
    description: `Groups destinations: whole country, states, cities, single PIN codes and PIN code ranges. An address belongs to the zone with the most specific area that matches it (PIN code, then PIN range, then city, then state, then country). The same area cannot be in two zones and PIN ranges of different zones cannot overlap (409 \`ZONE_CONFLICT\`, naming the clash). ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:manage',
    body: SaveZoneDto,
    response: ZoneDetailDto,
    status: 201,
    message: 'Shipping zone created successfully',
    errors: [409, 429],
  })
  createZone(@CurrentOrg() org: OrgContext, @Body() dto: SaveZoneDto) {
    return this.zones.create(org, dto);
  }

  @Put('zones/:id')
  @Throttle(WRITE)
  @RequirePermission('shipping:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Change a shipping zone',
    description: `Replaces the zone's name, switches and areas. The same no-clash rules as creating apply. A zone that is switched off means "not served": its addresses cannot check out. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:manage',
    body: SaveZoneDto,
    response: ZoneDetailDto,
    message: 'Shipping zone updated successfully',
    errors: [404, 409, 429],
  })
  updateZone(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveZoneDto,
  ) {
    return this.zones.update(org, id, dto);
  }

  @Delete('zones/:id')
  @Throttle(WRITE)
  @RequirePermission('shipping:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Delete a shipping zone',
    description: `Deletes the zone with its areas, methods and rate bands. Orders already placed keep what they were charged. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:manage',
    response: null,
    message: 'Shipping zone deleted successfully',
    errors: [404, 429],
  })
  async deleteZone(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.zones.remove(org, id);
  }

  // --- methods and rates -----------------------------------------------------------------------------------------------

  @Get('methods')
  @RequirePermission('shipping:view')
  @ApiEndpoint({
    summary: 'List shipping methods and their rates',
    description: `Every shipping method with how it is priced and its rate bands, optionally only for one zone (\`zoneId\`). ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:view',
    response: [MethodDto],
    message: 'Shipping methods retrieved successfully',
  })
  listMethods(
    @CurrentOrg() org: OrgContext,
    @Query() query: MethodListQueryDto,
  ) {
    return this.methods.list(org, query.zoneId);
  }

  @Get('methods/:id')
  @RequirePermission('shipping:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one shipping method',
    description: `One method with its rate bands. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:view',
    response: MethodDto,
    message: 'Shipping method retrieved successfully',
    errors: [404],
  })
  getMethod(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.methods.get(org, id);
  }

  @Post('methods')
  @Throttle(WRITE)
  @RequirePermission('shipping:manage')
  @ApiEndpoint({
    summary: 'Create a shipping method',
    description: `Adds a way to ship to a zone: flat, free, by weight, by order value, or priced live by your connected carriers. Set the free-shipping threshold, order value and weight limits, delivery time and whether cash on delivery is allowed. Weight and order-value methods need rate bands that start at 0, join up with no gap, and end open (400 \`METHOD_INVALID\`, per field). ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:manage',
    body: SaveMethodDto,
    response: MethodDto,
    status: 201,
    message: 'Shipping method created successfully',
    errors: [409, 429],
  })
  createMethod(@CurrentOrg() org: OrgContext, @Body() dto: SaveMethodDto) {
    return this.methods.create(org, dto);
  }

  @Put('methods/:id')
  @Throttle(WRITE)
  @RequirePermission('shipping:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Change a shipping method',
    description: `Replaces the method's settings and rate bands. It stays in its zone. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:manage',
    body: SaveMethodDto,
    response: MethodDto,
    message: 'Shipping method updated successfully',
    errors: [404, 409, 429],
  })
  updateMethod(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveMethodDto,
  ) {
    return this.methods.update(org, id, dto);
  }

  @Delete('methods/:id')
  @Throttle(WRITE)
  @RequirePermission('shipping:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Delete a shipping method',
    description: `Deletes the method and its rate bands. Orders already placed keep what they were charged. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:manage',
    response: null,
    message: 'Shipping method deleted successfully',
    errors: [404, 429],
  })
  async deleteMethod(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.methods.remove(org, id);
  }

  // --- origin and tools ------------------------------------------------------------------------------------------------

  @Get('origin')
  @RequirePermission('shipping:view')
  @ApiEndpoint({
    summary: 'See the pickup address',
    description: `Where parcels are collected. Carrier prices and shipments start from here. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:view',
    response: OriginDto,
    message: 'Pickup address retrieved successfully',
  })
  origin(@CurrentOrg() org: OrgContext) {
    return this.tools.origin(org);
  }

  @Put('origin')
  @Throttle(WRITE)
  @RequirePermission('shipping:manage')
  @ApiEndpoint({
    summary: 'Save the pickup address',
    description: `Sets where parcels are collected. Carrier-priced methods need it. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:manage',
    body: SaveOriginDto,
    response: OriginDto,
    message: 'Pickup address saved successfully',
    errors: [429],
  })
  saveOrigin(@CurrentOrg() org: OrgContext, @Body() dto: SaveOriginDto) {
    return this.tools.saveOrigin(org, dto);
  }

  @Post('preview')
  @HttpCode(200)
  @Throttle(SLOW)
  @RequirePermission('shipping:view')
  @ApiEndpoint({
    summary: 'Preview the delivery options for an address',
    description: `Shows what a shopper would be offered for an address, an items subtotal and a weight: the zone, each method's price and delivery time, whether cash on delivery is allowed, and which methods were left out and why. Carrier-priced methods ask your carriers for a live price. Nothing is saved. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'shipping:view',
    body: PreviewDto,
    response: ShippingQuoteDto,
    message: 'Delivery options previewed',
    errors: [400, 429],
  })
  preview(@CurrentOrg() org: OrgContext, @Body() dto: PreviewDto) {
    return this.tools.preview(org, dto);
  }

  @Post('carrier-quotes')
  @HttpCode(200)
  @Throttle(SLOW)
  @RequirePermission('carriers:manage')
  @ApiEndpoint({
    summary: 'Compare your connected carriers for a parcel',
    description: `Asks each connected, turned-on carrier whether it can deliver to a PIN code and what it would charge, lists the carriers that were skipped and why, and shows which one your selection settings (manual/automatic, strategy) would choose. A carrier is only offered if it confirmed delivery. Needs your pickup address. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    body: CarrierComparisonDto,
    response: CarrierComparisonResultDto,
    message: 'Carriers compared',
    errors: [400, 429, 503],
  })
  compare(@CurrentOrg() org: OrgContext, @Body() dto: CarrierComparisonDto) {
    return this.tools.compare(org, dto);
  }
}
