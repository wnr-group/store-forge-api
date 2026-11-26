import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequireExplicitOrganization,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CreateShipmentDto,
  ShipmentDetailDto,
  ShipmentDto,
  ShipmentLabelDto,
  ShipmentListQueryDto,
} from './shipments.dto.js';
import { ShipmentTrackingService } from './shipment-tracking.service.js';
import { ShipmentsService } from './shipments.service.js';

/** Booking and tracking call the carrier's servers, so they are limited more tightly than ordinary edits. */
const CARRIER_CALL = { default: { limit: 20, ttl: 60_000 } };

@ApiTags('shipments')
@Controller()
@OrgScoped()
// Booking and tracking act with one organization's own carrier account, so the organization is always named, never guessed.
@RequireExplicitOrganization()
export class ShipmentsController {
  constructor(
    private readonly shipments: ShipmentsService,
    private readonly tracking: ShipmentTrackingService,
  ) {}

  @Get('shipments')
  @RequirePermission('orders:view')
  @ApiEndpoint({
    summary: 'List shipments',
    description:
      'Every parcel booked with your carriers, newest first, a page at a time. Filter by shipment status or carrier.',
    auth: 'org',
    permission: 'orders:view',
    response: [ShipmentDto],
    paginated: true,
    message: 'Shipments retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() query: ShipmentListQueryDto) {
    return this.shipments.list(org, query);
  }

  @Get('orders/:orderId/shipments')
  @RequirePermission('orders:view')
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'List the shipments of an order',
    description:
      'The parcels booked for one order, oldest first. An order can have several when it is sent in parts.',
    auth: 'org',
    permission: 'orders:view',
    response: [ShipmentDto],
    message: 'Order shipments retrieved successfully',
    errors: [404],
  })
  forOrder(
    @CurrentOrg() org: OrgContext,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.shipments.listForOrder(org, orderId);
  }

  @Post('orders/:orderId/shipments')
  @Throttle(CARRIER_CALL)
  @RequirePermission('orders:manage')
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Create a shipment',
    description:
      'Books a parcel for the order (all of it, or the items you name) with one of your own connected carriers. The order must be confirmed and paid (or cash on delivery). The carrier is the one you name, else the one priced at checkout, else the one your shipping settings choose. The shipment is saved before the carrier is called: if the carrier does not answer you get 503 `SHIPMENT_PENDING` with the shipment id and can retry it without it being booked twice. A cash-on-delivery order ships in one parcel (the courier collects the whole amount). On success the order moves to ready to ship, with the waybill number, courier, tracking link and label (when the carrier provides one).',
    auth: 'org',
    permission: 'orders:manage',
    body: CreateShipmentDto,
    response: ShipmentDetailDto,
    status: 201,
    message: 'Shipment created successfully',
    errors: [404, 409, 429, 503],
  })
  create(
    @CurrentOrg() org: OrgContext,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateShipmentDto,
  ) {
    return this.shipments.create(org, orderId, dto);
  }

  @Get('shipments/:id')
  @RequirePermission('orders:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one shipment',
    description:
      'The parcel with its items and its full tracking history, newest first.',
    auth: 'org',
    permission: 'orders:view',
    response: ShipmentDetailDto,
    message: 'Shipment retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.shipments.get(org, id);
  }

  @Post('shipments/:id/retry')
  @Throttle(CARRIER_CALL)
  @RequirePermission('orders:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Retry booking a shipment',
    description:
      'Finishes booking a shipment that was saved but not confirmed by the carrier. It resumes where the carrier got to, so the parcel is never booked twice.',
    auth: 'org',
    permission: 'orders:manage',
    response: ShipmentDetailDto,
    message: 'Shipment booked successfully',
    errors: [404, 409, 429, 503],
  })
  retry(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.shipments.retry(org, id);
  }

  @Post('shipments/:id/cancel')
  @Throttle(CARRIER_CALL)
  @RequirePermission('orders:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Cancel a shipment',
    description:
      "Cancels a parcel with the carrier while it has not been picked up. The items go back to being shippable and the order's fulfilment status updates. A parcel the carrier already has cannot be cancelled here (409 `SHIPMENT_NOT_CANCELLABLE`).",
    auth: 'org',
    permission: 'orders:manage',
    response: ShipmentDetailDto,
    message: 'Shipment cancelled successfully',
    errors: [404, 409, 429, 503],
  })
  cancel(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shipments.cancel(org, id);
  }

  @Post('shipments/:id/refresh')
  @Throttle(CARRIER_CALL)
  @RequirePermission('orders:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Refresh tracking',
    description:
      'Asks the carrier where the parcel is right now and records the answer. Tracking also updates by itself (carrier webhooks and a scheduled check), so this is only for when you want it immediately. The order follows its shipments: shipped, out for delivery, delivered, returned.',
    auth: 'org',
    permission: 'orders:manage',
    response: ShipmentDetailDto,
    message: 'Tracking refreshed successfully',
    errors: [404, 409, 429, 503],
  })
  async refresh(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.tracking.refresh(org.tenantId, id, 'owner');
    return this.shipments.get(org, id);
  }

  @Get('shipments/:id/label')
  @RequirePermission('orders:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'See whether a label is available',
    description:
      'Says whether a shipping label exists: `stored` means the PDF can be downloaded from the label file route, `url` is a link to a label the carrier holds.',
    auth: 'org',
    permission: 'orders:view',
    response: ShipmentLabelDto,
    message: 'Label status retrieved successfully',
    errors: [404],
  })
  label(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.shipments.label(org, id);
  }

  @Post('shipments/:id/label')
  @Throttle(CARRIER_CALL)
  @RequirePermission('orders:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Generate the label',
    description:
      'Asks the carrier for the shipping label again (for example when it was not ready at booking). A PDF is stored and can then be downloaded; a link is kept as it is. 503 `LABEL_NOT_READY` when the carrier has not produced it yet.',
    auth: 'org',
    permission: 'orders:manage',
    response: ShipmentLabelDto,
    message: 'Label generated successfully',
    errors: [404, 409, 429, 503],
  })
  generateLabel(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shipments.generateLabel(org, id);
  }

  @Get('shipments/:id/label/file')
  @RequirePermission('orders:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('application/pdf')
  @ApiEndpoint({
    summary: 'Download the label PDF',
    description:
      'The stored label as a PDF file (not wrapped in the usual JSON envelope). 404 `LABEL_NOT_FOUND` when only a carrier link exists or nothing was produced yet.',
    auth: 'org',
    permission: 'orders:view',
    response: null,
    message: 'Label retrieved successfully',
    errors: [404],
  })
  async labelFile(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const pdf = await this.shipments.labelFile(org, id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="shipping-label-${id.slice(0, 8)}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(pdf);
  }
}
