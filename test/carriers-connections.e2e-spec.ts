import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import { rowsOf } from '../src/database/database.service.js';
import { CarriersService } from '../src/modules/shipping/carriers.service.js';
import { BlueDartProvider } from '../src/modules/shipping/providers/bluedart.provider.js';
import { CarrierHttp } from '../src/modules/shipping/providers/carrier-http.js';
import { DelhiveryProvider } from '../src/modules/shipping/providers/delhivery.provider.js';
import { ShippingProviderRegistry } from '../src/modules/shipping/providers/provider-registry.js';
import { ShiprocketProvider } from '../src/modules/shipping/providers/shiprocket.provider.js';
import { FakeCarrier } from './support/fake-carrier.js';
import {
  createTestDb,
  migrationsAvailable,
  type TestDb,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const SR_PASSWORD = 'sr-pass-GOOD-123456';
const DL_TOKEN = 'dl-token-GOOD-7890123';
const BD_SECRET = 'bd-secret-GOOD-4567890';
const SR = {
  email: 'api@shop.test',
  password: SR_PASSWORD,
  pickupLocation: 'Primary',
};
const DL = {
  apiToken: DL_TOKEN,
  pickupLocation: 'Main Warehouse',
  environment: 'staging',
};
const BD = {
  clientId: 'bd-client-GOOD-id',
  clientSecret: BD_SECRET,
  loginId: 'DEL1',
  licenceKey: 'bd-licence-GOOD-key',
  customerCode: '123',
  originArea: 'BLR',
};

async function failure(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe.skipIf(!migrationsAvailable)(
  'carrier connections, preferences and history (migration 0049)',
  () => {
    let t: TestDb;
    let w: World;
    let carrier: FakeCarrier;
    let svc: CarriersService;
    const owner = () =>
      ({ userId: w.alice, tenantId: w.tenantA, role: 'owner' }) as never;
    const ownerB = () =>
      ({ userId: w.bob, tenantId: w.tenantB, role: 'owner' }) as never;
    const events = (tenant: string) =>
      t.asOwner(
        async (pg) =>
          (
            await pg.query<Record<string, string>>(
              'select * from carrier_connection_events where tenant_id = $1 order by created_at, id',
              [tenant],
            )
          ).rows,
      );
    const row = (tenant: string, code: string) =>
      t.asOwner(
        async (pg) =>
          (
            await pg.query<Record<string, unknown>>(
              'select * from tenant_carrier_connections where tenant_id = $1 and provider_code = $2',
              [tenant, code],
            )
          ).rows[0],
      );

    beforeAll(async () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
        randomBytes(32).toString('base64');
      process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
      t = await createTestDb();
      w = await seedWorld(t);
      carrier = new FakeCarrier();
      // Shiprocket accepts one password; Delhivery one token; Blue Dart one secret.
      carrier.on('POST', '/v1/external/auth/login', (req) =>
        (req.json as { password?: string })?.password === SR_PASSWORD
          ? { body: { token: 'sr-token-1234' } }
          : { status: 403, body: { message: 'Invalid email or password' } },
      );
      carrier.on('GET', '/v1/external/settings/company/pickup', {
        body: {
          data: {
            shipping_address: [
              { pickup_location: 'Primary' },
              { pickup_location: 'Second' },
            ],
          },
        },
      });
      carrier.on('GET', '/c/api/pin-codes/json/', (req) =>
        req.headers.get('authorization') === `Token ${DL_TOKEN}`
          ? { body: { delivery_codes: [] } }
          : { status: 401 },
      );
      carrier.on('GET', '/in/transportation/token/v1/login', (req) =>
        req.headers.get('clientsecret') === BD_SECRET
          ? { body: { JWTToken: 'bd-jwt-1234' } }
          : { status: 401 },
      );
      const http = new CarrierHttp(carrier.fetch, {
        timeoutMs: 1000,
        retryDelayMs: 0,
      });
      svc = new CarriersService(
        t.service,
        new ShippingProviderRegistry([
          new ShiprocketProvider(http),
          new DelhiveryProvider(http),
          new BlueDartProvider(http),
        ]),
      );
    });
    afterAll(() => t.close());

    describe('connecting', () => {
      it('lists every supported carrier, none connected yet, with what each needs and how far it is verified', async () => {
        const list = await svc.list(owner());
        expect(list.map((c) => c.code)).toEqual([
          'shiprocket',
          'delhivery',
          'bluedart',
        ]);
        expect(list.every((c) => c.connection.connected === false)).toBe(true);
        expect(list.find((c) => c.code === 'bluedart')).toMatchObject({
          integrationStatus: 'unverified',
        });
        expect(
          list[0].credentialFields.find((f) => f.key === 'password'),
        ).toMatchObject({ secret: true, required: true });
      });

      it('connects a carrier: settings are readable, secrets are not, and nothing is turned on', async () => {
        const result = await svc.save(owner(), 'shiprocket', SR);
        expect(result.connection).toMatchObject({
          connected: true,
          enabled: false,
          isDefault: false,
          verificationStatus: 'unverified',
          settings: { email: 'api@shop.test', pickupLocation: 'Primary' },
          secretFieldsSaved: ['password'],
        });
        expect(JSON.stringify(result)).not.toContain(SR_PASSWORD);
        const stored = await row(w.tenantA, 'shiprocket');
        expect(JSON.stringify(stored)).not.toContain(SR_PASSWORD);
        expect(stored.settings).toEqual({
          email: 'api@shop.test',
          pickupLocation: 'Primary',
        });
        expect(String(stored.secrets_ciphertext)).toMatch(
          /^[A-Za-z0-9+/]+={0,2}$/,
        );
        expect((await events(w.tenantA)).map((e) => e.action)).toEqual([
          'connect',
        ]);
      });

      it('rejects every kind of bad setting at once, saves nothing, and never echoes the input', async () => {
        const err = await failure(
          svc.save(owner(), 'delhivery', {
            apiToken: 'x\ny',
            environment: 'moon-NOPE',
            surprise: 'boom-NOPE',
          }),
        );
        expect(err.code).toBe('CARRIER_SETTINGS_INVALID');
        expect(Object.keys(err.details as object).sort()).toEqual([
          'apiToken',
          'environment',
          'pickupLocation',
          'surprise',
        ]);
        expect(JSON.stringify(err.details)).not.toContain('NOPE');
        expect(await row(w.tenantA, 'delhivery')).toBeUndefined();
      });

      it('answers 404 for a carrier that does not exist', async () => {
        expect((await failure(svc.save(owner(), 'fedex', {}))).code).toBe(
          'CARRIER_NOT_SUPPORTED',
        );
        expect((await failure(svc.verify(owner(), 'fedex'))).code).toBe(
          'CARRIER_NOT_SUPPORTED',
        );
      });

      it('keeps a secret that is left out of an update, and the old secret still works', async () => {
        await svc.save(owner(), 'shiprocket', { pickupLocation: 'Second' });
        const result = await svc.verify(owner(), 'shiprocket'); // proves the password was kept: the fake accepts only the original
        expect(result.connection).toMatchObject({
          verificationStatus: 'verified',
          settings: { pickupLocation: 'Second' },
        });
      });
    });

    describe('checking and turning on', () => {
      it('records a successful check, then allows turning on and making the default', async () => {
        const verified = await svc.verify(owner(), 'shiprocket');
        expect(verified.connection).toMatchObject({
          verificationStatus: 'verified',
          verificationError: null,
        });
        expect(verified.connection.verifiedAt).toBeInstanceOf(Date);
        expect(
          (await svc.setEnabled(owner(), 'shiprocket', { enabled: true }))
            .connection.enabled,
        ).toBe(true);
        const def = await svc.setDefault(owner(), 'shiprocket', {
          isDefault: true,
        });
        expect(def.connection).toMatchObject({
          enabled: true,
          isDefault: true,
        });
      });

      it('turns itself off, un-defaults and asks for a new check whenever a setting changes', async () => {
        const changed = await svc.save(owner(), 'shiprocket', {
          pickupLocation: 'Primary',
        });
        expect(changed.connection).toMatchObject({
          enabled: false,
          isDefault: false,
          verificationStatus: 'unverified',
          verifiedAt: null,
        });
        await svc.verify(owner(), 'shiprocket');
        await svc.setEnabled(owner(), 'shiprocket', { enabled: true });
        await svc.setDefault(owner(), 'shiprocket', { isDefault: true });
      });

      it('does not reset anything when an update changes nothing', async () => {
        const same = await svc.save(owner(), 'shiprocket', {
          email: 'api@shop.test',
          pickupLocation: 'Primary',
          password: SR_PASSWORD,
        });
        expect(same.connection).toMatchObject({
          enabled: true,
          isDefault: true,
          verificationStatus: 'verified',
        });
      });

      it('records a refusal as a failed check, turns the carrier off, and shows a safe reason', async () => {
        await svc.save(owner(), 'shiprocket', {
          password: 'wrong-password-123',
        });
        const failed = await svc.verify(owner(), 'shiprocket');
        expect(failed.connection).toMatchObject({
          verificationStatus: 'failed',
          enabled: false,
          isDefault: false,
        });
        expect(failed.connection.verificationError).toMatch(/did not accept/);
        expect(JSON.stringify(failed)).not.toContain('wrong-password-123');
        await svc.save(owner(), 'shiprocket', { password: SR_PASSWORD });
        await svc.verify(owner(), 'shiprocket');
        await svc.setEnabled(owner(), 'shiprocket', { enabled: true });
        await svc.setDefault(owner(), 'shiprocket', { isDefault: true });
      });

      it('leaves the saved state alone when the carrier cannot be reached', async () => {
        const down = new FakeCarrier().on('POST', '/v1/external/auth/login', {
          status: 503,
        });
        const http = new CarrierHttp(down.fetch, {
          timeoutMs: 500,
          retryDelayMs: 0,
        });
        const offline = new CarriersService(
          t.service,
          new ShippingProviderRegistry([
            new ShiprocketProvider(http),
            new DelhiveryProvider(http),
            new BlueDartProvider(http),
          ]),
        );
        expect(
          (await failure(offline.verify(owner(), 'shiprocket'))).code,
        ).toBe('CARRIER_UNAVAILABLE');
        expect((await row(w.tenantA, 'shiprocket')).verification_status).toBe(
          'verified',
        );
      });

      it('cannot be turned on before a successful check, or when not connected', async () => {
        await svc.save(owner(), 'delhivery', DL);
        expect(
          (
            await failure(
              svc.setEnabled(owner(), 'delhivery', { enabled: true }),
            )
          ).code,
        ).toBe('CARRIER_NOT_VERIFIED');
        expect((await failure(svc.verify(owner(), 'bluedart'))).code).toBe(
          'CARRIER_NOT_CONNECTED',
        );
        expect(
          (
            await failure(
              svc.setEnabled(owner(), 'bluedart', { enabled: true }),
            )
          ).code,
        ).toBe('CARRIER_NOT_CONNECTED');
      });

      it('needs the Owner to acknowledge an integration that has not been checked against the real carrier', async () => {
        await svc.save(owner(), 'bluedart', BD);
        await svc.verify(owner(), 'bluedart');
        expect(
          (
            await failure(
              svc.setEnabled(owner(), 'bluedart', { enabled: true }),
            )
          ).code,
        ).toBe('INTEGRATION_UNVERIFIED');
        expect(
          (
            await failure(
              svc.setEnabled(owner(), 'bluedart', {
                enabled: true,
                acknowledgeUnverifiedIntegration: false,
              }),
            )
          ).code,
        ).toBe('INTEGRATION_UNVERIFIED');
        expect(
          (
            await svc.setEnabled(owner(), 'bluedart', {
              enabled: true,
              acknowledgeUnverifiedIntegration: true,
            })
          ).connection.enabled,
        ).toBe(true);
        await svc.setEnabled(owner(), 'bluedart', { enabled: false });
      });
    });

    describe('trying settings without saving', () => {
      it('reports the carrier’s verdict and stores nothing', async () => {
        const before = await row(w.tenantA, 'delhivery');
        expect(
          await svc.test(owner(), 'delhivery', { apiToken: DL_TOKEN }),
        ).toMatchObject({ valid: true });
        expect(
          await svc.test(owner(), 'delhivery', {
            apiToken: 'a-wrong-token-1234',
          }),
        ).toMatchObject({ valid: false });
        expect(await row(w.tenantA, 'delhivery')).toEqual(before);
      });

      it('can test a brand-new carrier from scratch, and rejects incomplete settings before calling anyone', async () => {
        expect(
          (
            await svc.test(owner(), 'bluedart', {
              ...BD,
              clientSecret: 'bad-secret-123456',
            })
          ).valid,
        ).toBe(false);
        const calls = carrier.requests.length;
        expect(
          (
            await failure(
              svc.test(ownerB(), 'delhivery', { apiToken: 'only-a-token-1' }),
            )
          ).code,
        ).toBe('CARRIER_SETTINGS_INVALID');
        expect(carrier.requests.length).toBe(calls);
      });
    });

    describe('the default carrier', () => {
      it('is one at a time: a new default replaces the old', async () => {
        await svc.verify(owner(), 'delhivery');
        await svc.setEnabled(owner(), 'delhivery', { enabled: true });
        expect(
          (
            await failure(
              svc.setDefault(owner(), 'bluedart', { isDefault: true }),
            )
          ).code,
        ).toBe('CARRIER_NOT_ENABLED');
        await svc.setDefault(owner(), 'delhivery', { isDefault: true });
        const list = await svc.list(owner());
        expect(
          list.filter((c) => c.connection.isDefault).map((c) => c.code),
        ).toEqual(['delhivery']);
        expect((await svc.preferences(owner())).defaultCarrier).toBe(
          'delhivery',
        );
      });

      it('is cleared when its carrier is turned off or disconnected', async () => {
        await svc.setEnabled(owner(), 'delhivery', { enabled: false });
        expect((await svc.preferences(owner())).defaultCarrier).toBeNull();
        expect((await svc.get(owner(), 'delhivery')).connection).toMatchObject({
          enabled: false,
          isDefault: false,
        });
      });

      it('can be removed explicitly', async () => {
        await svc.verify(owner(), 'delhivery');
        await svc.setEnabled(owner(), 'delhivery', { enabled: true });
        await svc.setDefault(owner(), 'delhivery', { isDefault: true });
        expect(
          (await svc.setDefault(owner(), 'delhivery', { isDefault: false }))
            .connection.isDefault,
        ).toBe(false);
      });
    });

    describe('the database holds the rules too', () => {
      it('refuses an enabled carrier that was never verified, and a default that is not enabled', async () => {
        await expect(
          t.asOwner((pg) =>
            pg.query(
              "update tenant_carrier_connections set enabled = true, verification_status = 'unverified' where tenant_id = $1 and provider_code = 'bluedart'",
              [w.tenantA],
            ),
          ),
        ).rejects.toThrow();
        await expect(
          t.asOwner((pg) =>
            pg.query(
              "update tenant_carrier_connections set is_default = true where tenant_id = $1 and provider_code = 'bluedart' and not enabled",
              [w.tenantA],
            ),
          ),
        ).rejects.toThrow();
      });

      it('allows at most one default per organization', async () => {
        await svc.verify(owner(), 'delhivery');
        await svc.setEnabled(owner(), 'delhivery', { enabled: true });
        await expect(
          t.asOwner((pg) =>
            pg.query(
              'update tenant_carrier_connections set is_default = true where tenant_id = $1',
              [w.tenantA],
            ),
          ),
        ).rejects.toThrow();
      });

      it('stops the Owner from writing the state columns or reading the secret columns directly', async () => {
        await expect(
          t.service.withUser(w.alice, (tx) =>
            tx.execute(
              sql`update public.tenant_carrier_connections set enabled = true`,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          t.service.withUser(w.alice, (tx) =>
            tx.execute(
              sql`select secrets_ciphertext from public.tenant_carrier_connections`,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          t.service.withUser(w.alice, (tx) =>
            tx.execute(
              sql`select * from public.get_carrier_credentials(${w.tenantA}::uuid)`,
            ),
          ),
        ).rejects.toThrow();
      });
    });

    describe('history', () => {
      it('records who did what, newest first, with setting names but never values', async () => {
        const page = await svc.events(owner(), {
          page: 1,
          limit: 100,
          search: '',
          sortOrder: 'desc',
        } as never);
        const actions = page.items.map((e) => e.action);
        for (const a of [
          'connect',
          'update',
          'verify',
          'verify_failed',
          'enable',
          'disable',
          'set_default',
          'unset_default',
        ])
          expect(actions, a).toContain(a);
        expect(page.items[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          page.items.at(-1)!.createdAt.getTime(),
        );
        expect(page.items.every((e) => e.actorName === 'Alice Owner')).toBe(
          true,
        );
        const text = JSON.stringify(page.items);
        for (const secret of [
          SR_PASSWORD,
          DL_TOKEN,
          BD_SECRET,
          'wrong-password-123',
        ])
          expect(text).not.toContain(secret);
        expect(page.items.find((e) => e.action === 'update')!.note).toMatch(
          /^Changed: /,
        );
      });

      it('filters by action and pages through', async () => {
        const verifies = await svc.events(owner(), {
          page: 1,
          limit: 100,
          search: '',
          sortOrder: 'desc',
          action: 'verify',
        } as never);
        expect(verifies.items.length).toBeGreaterThan(0);
        expect(verifies.items.every((e) => e.action === 'verify')).toBe(true);
        const first = await svc.events(owner(), {
          page: 1,
          limit: 2,
          search: '',
          sortOrder: 'desc',
        } as never);
        const second = await svc.events(owner(), {
          page: 2,
          limit: 2,
          search: '',
          sortOrder: 'desc',
        } as never);
        expect(first.items).toHaveLength(2);
        expect(second.items.map((e) => e.id)).not.toEqual(
          first.items.map((e) => e.id),
        );
      });

      it('cannot be edited or deleted', async () => {
        await expect(
          t.service.withUser(w.alice, (tx) =>
            tx.execute(
              sql`update public.carrier_connection_events set note = 'x'`,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          t.service.withUser(w.alice, (tx) =>
            tx.execute(sql`delete from public.carrier_connection_events`),
          ),
        ).rejects.toThrow();
      });
    });

    describe('disconnecting', () => {
      it('deletes the connection and its credentials for good, and logs it', async () => {
        await svc.disconnect(owner(), 'bluedart');
        expect(await row(w.tenantA, 'bluedart')).toBeUndefined();
        expect((await svc.get(owner(), 'bluedart')).connection.connected).toBe(
          false,
        );
        expect((await failure(svc.disconnect(owner(), 'bluedart'))).code).toBe(
          'CARRIER_NOT_CONNECTED',
        );
        expect((await events(w.tenantA)).at(-1)).toMatchObject({
          provider_code: 'bluedart',
          action: 'disconnect',
        });
        const stillThere = await t.service.withCheckout(w.tenantA, async (tx) =>
          rowsOf(
            await tx.execute(
              sql`select * from public.get_carrier_credentials(${w.tenantA}::uuid, 'bluedart')`,
            ),
          ),
        );
        expect(stillThere).toEqual([]);
      });
    });

    describe('tenant isolation', () => {
      it('keeps each organization’s carriers to itself, and lets two use the same carrier independently', async () => {
        expect(
          (await svc.list(ownerB())).every((c) => !c.connection.connected),
        ).toBe(true);
        expect((await failure(svc.verify(ownerB(), 'shiprocket'))).code).toBe(
          'CARRIER_NOT_CONNECTED',
        );
        expect(
          (
            await failure(
              svc.setEnabled(ownerB(), 'shiprocket', { enabled: true }),
            )
          ).code,
        ).toBe('CARRIER_NOT_CONNECTED');
        expect(
          (await failure(svc.disconnect(ownerB(), 'shiprocket'))).code,
        ).toBe('CARRIER_NOT_CONNECTED');
        await svc.save(ownerB(), 'shiprocket', {
          ...SR,
          email: 'b@shop.test',
          pickupLocation: 'B-warehouse',
        });
        expect(
          (await svc.get(ownerB(), 'shiprocket')).connection.settings,
        ).toEqual({ email: 'b@shop.test', pickupLocation: 'B-warehouse' });
        expect(
          (await svc.get(owner(), 'shiprocket')).connection.settings.email,
        ).toBe('api@shop.test');
        expect(
          (
            await svc.events(ownerB(), {
              page: 1,
              limit: 50,
              search: '',
              sortOrder: 'desc',
            } as never)
          ).items.every((e) => e.providerCode === 'shiprocket'),
        ).toBe(true);
      });

      it('lets the checkout role read only its pinned organization’s credentials', async () => {
        const other = await t.service.withCheckout(w.tenantA, async (tx) =>
          rowsOf(
            await tx.execute(
              sql`select * from public.get_carrier_credentials(${w.tenantB}::uuid)`,
            ),
          ),
        );
        expect(other).toEqual([]);
        const own = await t.service.withCheckout(w.tenantA, async (tx) =>
          rowsOf<{ provider_code: string }>(
            await tx.execute(
              sql`select provider_code from public.get_carrier_credentials(${w.tenantA}::uuid)`,
            ),
          ),
        );
        expect(own.map((r) => r.provider_code)).toContain('shiprocket');
      });

      it('refuses to open ciphertext copied from another organization (it is bound to its tenant)', async () => {
        await t.asOwner((pg) =>
          pg.query(
            `update tenant_carrier_connections b set secrets_ciphertext = a.secrets_ciphertext, iv = a.iv, auth_tag = a.auth_tag, key_version = a.key_version
           from tenant_carrier_connections a where a.tenant_id = $1 and a.provider_code = 'shiprocket' and b.tenant_id = $2 and b.provider_code = 'shiprocket'`,
            [w.tenantA, w.tenantB],
          ),
        );
        expect((await failure(svc.verify(ownerB(), 'shiprocket'))).code).toBe(
          'SHIPPING_UNAVAILABLE',
        );
      });
    });

    describe('preferences', () => {
      it('start as manual / lowest cost and count the carriers that are on', async () => {
        expect(await svc.preferences(ownerB())).toMatchObject({
          selectionMode: 'manual',
          strategy: 'lowest_cost',
          activeCarrierCount: 0,
          defaultCarrier: null,
          updatedAt: null,
        });
        const mine = await svc.preferences(owner());
        expect(mine.activeCarrierCount).toBeGreaterThan(0);
      });

      it('are saved per organization', async () => {
        const saved = await svc.savePreferences(owner(), {
          selectionMode: 'automatic',
          strategy: 'fastest',
        });
        expect(saved).toMatchObject({
          selectionMode: 'automatic',
          strategy: 'fastest',
        });
        expect(saved.updatedAt).toBeInstanceOf(Date);
        await svc.savePreferences(owner(), {
          selectionMode: 'automatic',
          strategy: 'preferred',
        });
        expect((await svc.preferences(owner())).strategy).toBe('preferred');
        expect((await svc.preferences(ownerB())).selectionMode).toBe('manual');
      });

      it('can be read by the pinned checkout role of their own organization only', async () => {
        const mine = await t.service.withCheckout(w.tenantA, async (tx) =>
          rowsOf<{ strategy: string }>(
            await tx.execute(
              sql`select strategy from public.tenant_shipping_preferences`,
            ),
          ),
        );
        expect(mine).toEqual([{ strategy: 'preferred' }]);
      });
    });
  },
);
