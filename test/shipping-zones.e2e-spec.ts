import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import {
  createShippingWorld,
  ORIGIN,
  type ShippingWorld,
} from './support/shipping-world.js';
import { migrationsAvailable } from './support/pglite.js';

async function failure(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const to = (state: string, postalCode: string, city: string | null = null) => ({
  stateCode: state,
  postalCode,
  city,
});
const KA = '29';
const MH = '27';
const TN = '33';

describe.skipIf(!migrationsAvailable)(
  'shipping zones, methods and quotes (migration 0050)',
  () => {
    let s: ShippingWorld;

    beforeAll(async () => {
      s = await createShippingWorld();
    });
    afterAll(() => s.t.close());

    describe('zones', () => {
      it('create a zone of mixed areas and show it, with a summary in the list', async () => {
        const z = await s.zone('South', {
          states: ['Karnataka', 'Kerala'],
          cities: [{ state: 'Tamil Nadu', city: ' Chennai ' }],
          postalCodes: ['682001'],
          postalRanges: [{ from: '600001', to: '600100' }],
        });
        expect(z).toMatchObject({
          name: 'South',
          enabled: true,
          codAllowed: true,
          methodCount: 0,
        });
        expect(z.areaSummary).toEqual({
          country: false,
          states: 2,
          cities: 1,
          postalCodes: 1,
          postalRanges: 1,
        });
        expect(z.areas.states.map((x) => x.name).sort()).toEqual([
          'Karnataka',
          'Kerala',
        ]);
        expect(z.areas.cities).toEqual([
          { stateCode: TN, state: 'Tamil Nadu', city: 'chennai' },
        ]);
        expect(z.areas.postalRanges).toEqual([
          { from: '600001', to: '600100' },
        ]);
        const list = await s.zones.list(s.owner());
        expect(list.map((x) => x.name)).toEqual(['South']);
        expect(list[0]).not.toHaveProperty('areas');
      });

      it('refuse an area another zone already holds, and say which zone', async () => {
        const dupState = await failure(
          s.zone('Karnataka only', { states: ['Karnataka'] }),
        );
        expect(dupState.code).toBe('ZONE_CONFLICT');
        expect((dupState.details as { areas: string }).areas).toContain(
          '"South"',
        );
        expect(
          (
            await failure(
              s.zone('x1', { cities: [{ state: '33', city: 'CHENNAI' }] }),
            )
          ).code,
        ).toBe('ZONE_CONFLICT');
        expect(
          (await failure(s.zone('x2', { postalCodes: ['682001'] }))).code,
        ).toBe('ZONE_CONFLICT');
        expect(
          (
            await failure(
              s.zone('x3', {
                postalRanges: [{ from: '600050', to: '600500' }],
              }),
            )
          ).code,
        ).toBe('ZONE_CONFLICT');
        expect((await s.zones.list(s.owner())).length).toBe(1);
      });

      it('allow what is more specific than another zone, and one "everywhere else" zone', async () => {
        const specific = await s.zone('Mysuru + one PIN', {
          cities: [{ state: 'Karnataka', city: 'Mysuru' }],
          postalCodes: ['600050'],
        });
        expect(
          specific.areaSummary.cities + specific.areaSummary.postalCodes,
        ).toBe(2);
        const rest = await s.zone('Rest of India', { country: true });
        expect(rest.areas.country).toBe(true);
        expect(
          (await failure(s.zone('Another country zone', { country: true })))
            .code,
        ).toBe('ZONE_CONFLICT');
      });

      it('keep names unique per organization, ignoring case', async () => {
        expect((await failure(s.zone('south', { states: ['Goa'] }))).code).toBe(
          'ZONE_NAME_TAKEN',
        );
      });

      it('refuse an empty or invalid zone with per-entry messages, and save nothing', async () => {
        const before = (await s.zones.list(s.owner())).length;
        expect((await failure(s.zone('Empty', {}))).code).toBe(
          'ZONE_AREAS_INVALID',
        );
        const bad = await failure(
          s.zone('Bad', { states: ['Atlantis'], postalCodes: ['12'] }),
        );
        expect(Object.keys(bad.details as object).sort()).toEqual([
          'postalCodes.0',
          'states.0',
        ]);
        expect((await s.zones.list(s.owner())).length).toBe(before);
      });

      it('can be updated: its own areas never clash with themselves, and a failed update changes nothing', async () => {
        const south = (await s.zones.list(s.owner())).find(
          (z) => z.name === 'South',
        )!;
        const updated = await s.zones.update(s.owner(), south.id, {
          name: 'South India',
          codAllowed: false,
          areas: {
            states: ['Karnataka', 'Kerala', 'Goa'],
            cities: [{ state: 'Tamil Nadu', city: 'Chennai' }],
            postalCodes: ['682001'],
            postalRanges: [{ from: '600001', to: '600100' }],
          },
        } as never);
        expect(updated).toMatchObject({
          name: 'South India',
          codAllowed: false,
        });
        expect(updated.areaSummary.states).toBe(3);

        // Another zone already holds PIN 600050, so this update is refused as a whole...
        const failed = await failure(
          s.zones.update(s.owner(), south.id, {
            name: 'South India',
            areas: { states: ['Karnataka'], postalCodes: ['600050'] },
          } as never),
        );
        expect(failed.code).toBe('ZONE_CONFLICT');
        // ...and the zone is exactly what the last successful update left it as.
        const after = await s.zones.get(s.owner(), south.id);
        expect(after.areas.states.map((x) => x.name).sort()).toEqual([
          'Goa',
          'Karnataka',
          'Kerala',
        ]);
        expect(after.areas.postalCodes).toEqual(['682001']);
        expect(after.areas.postalRanges).toEqual([
          { from: '600001', to: '600100' },
        ]);
      });

      it('serialise edits: two at once that would overlap cannot both succeed', async () => {
        const results = await Promise.allSettled([
          s.zone('Race 1', {
            postalRanges: [{ from: '700001', to: '700500' }],
          }),
          s.zone('Race 2', {
            postalRanges: [{ from: '700400', to: '700900' }],
          }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const lost = results.find(
          (r) => r.status === 'rejected',
        ) as PromiseRejectedResult;
        expect((lost.reason as AppException).code).toBe('ZONE_CONFLICT');
      });

      it('are private to each organization, which may reuse names and areas', async () => {
        const mine = (await s.zones.list(s.owner())).find(
          (z) => z.name === 'South India',
        )!;
        const theirs = await s.zones.create(s.ownerB(), {
          name: 'South India',
          areas: { states: ['Karnataka'] },
        } as never);
        expect(theirs.id).not.toBe(mine.id);
        expect((await s.zones.list(s.ownerB())).map((z) => z.name)).toEqual([
          'South India',
        ]);
        expect((await failure(s.zones.get(s.ownerB(), mine.id))).code).toBe(
          'ZONE_NOT_FOUND',
        );
        expect(
          (
            await failure(
              s.zones.update(s.ownerB(), mine.id, {
                name: 'x',
                areas: { states: ['Goa'] },
              } as never),
            )
          ).code,
        ).toBe('ZONE_NOT_FOUND');
        expect((await failure(s.zones.remove(s.ownerB(), mine.id))).code).toBe(
          'ZONE_NOT_FOUND',
        );
        await s.zones.remove(s.ownerB(), theirs.id);
      });

      it('can be read but not changed by someone with only read access to the store settings (row level security)', async () => {
        expect(
          (await s.zones.list(s.member(s.w.members.reader))).length,
        ).toBeGreaterThan(0);
        await expect(
          s.zones.create(s.member(s.w.members.reader), {
            name: 'Sneaky',
            areas: { states: ['Goa'] },
          } as never),
        ).rejects.toThrow();
        expect(
          (await s.zones.list(s.member(s.w.members.writer))).length,
        ).toBeGreaterThan(0);
        await s.zones.create(s.member(s.w.members.writer), {
          name: 'Writer zone',
          areas: { postalCodes: ['110001'] },
        } as never);
      });
    });

    describe('methods', () => {
      it('create each kind of method, with rate bands where they belong', async () => {
        const z = await s.zone('Methods zone', { states: ['Punjab'] });
        const flat = await s.method(z.id, 'Standard', {
          pricingType: 'flat',
          flatRateMinor: 5000,
          estimatedDaysMin: 3,
          estimatedDaysMax: 5,
        });
        expect(flat).toMatchObject({
          pricingType: 'flat',
          flatRateMinor: 5000,
          estimatedDaysMin: 3,
          estimatedDaysMax: 5,
          tiers: [],
          zoneName: 'Methods zone',
        });
        const free = await s.method(z.id, 'Free', { pricingType: 'free' });
        expect(free.pricingType).toBe('free');
        const weight = await s.method(z.id, 'By weight', {
          pricingType: 'weight',
          tiers: [
            { from: 500, to: null, rateMinor: 9000 },
            { from: 0, to: 500, rateMinor: 4000 },
          ],
        });
        expect(weight.tiers).toEqual([
          { from: 0, to: 500, rateMinor: 4000 },
          { from: 500, to: null, rateMinor: 9000 },
        ]);
        await s.method(z.id, 'By value', {
          pricingType: 'order_value',
          tiers: [{ from: 0, to: null, rateMinor: 100 }],
        });
        await s.method(z.id, 'Live', {
          pricingType: 'carrier',
          handlingMinor: 2000,
          carrierCode: 'delhivery',
        });
        expect(
          (await s.methods.list(s.owner(), z.id)).map((m) => m.name).sort(),
        ).toEqual(['By value', 'By weight', 'Free', 'Live', 'Standard']);
        expect((await s.zones.get(s.owner(), z.id)).methodCount).toBe(5);
      });

      it('explain every problem per field before saving', async () => {
        const z = (await s.zones.list(s.owner())).find(
          (x) => x.name === 'Methods zone',
        )!;
        const bad = async (fields: Record<string, unknown>) =>
          (await failure(s.method(z.id, 'Bad', fields))).details as Record<
            string,
            string
          >;
        expect(await bad({ pricingType: 'flat' })).toHaveProperty(
          'flatRateMinor',
        );
        expect(
          await bad({ pricingType: 'free', freeOverMinor: 100 }),
        ).toHaveProperty('freeOverMinor');
        expect(
          await bad({
            pricingType: 'flat',
            flatRateMinor: 1,
            handlingMinor: 5,
          }),
        ).toHaveProperty('handlingMinor');
        expect(
          await bad({
            pricingType: 'flat',
            flatRateMinor: 1,
            carrierCode: 'delhivery',
          }),
        ).toHaveProperty('carrierCode');
        expect(
          await bad({ pricingType: 'carrier', carrierCode: 'bluedart' }),
        ).toHaveProperty('carrierCode'); // Blue Dart quotes no prices
        expect(
          await bad({ pricingType: 'carrier', carrierCode: 'fedex' }),
        ).toHaveProperty('carrierCode');
        expect(
          await bad({
            pricingType: 'flat',
            flatRateMinor: 1,
            minOrderMinor: 500,
            maxOrderMinor: 100,
          }),
        ).toHaveProperty('maxOrderMinor');
        expect(
          await bad({
            pricingType: 'flat',
            flatRateMinor: 1,
            minWeightGrams: 500,
            maxWeightGrams: 100,
          }),
        ).toHaveProperty('maxWeightGrams');
        expect(
          await bad({
            pricingType: 'flat',
            flatRateMinor: 1,
            estimatedDaysMin: 3,
          }),
        ).toHaveProperty('estimatedDaysMax');
        expect(
          await bad({
            pricingType: 'flat',
            flatRateMinor: 1,
            estimatedDaysMin: 5,
            estimatedDaysMax: 2,
          }),
        ).toHaveProperty('estimatedDaysMax');
        expect(await bad({ pricingType: 'weight' })).toHaveProperty('tiers');
        expect(
          (
            await bad({
              pricingType: 'weight',
              tiers: [
                { from: 0, to: 100, rateMinor: 1 },
                { from: 200, to: null, rateMinor: 1 },
              ],
            })
          ).tiers,
        ).toMatch(/gap/);
        expect(
          (
            await bad({
              pricingType: 'weight',
              tiers: [{ from: 10, to: null, rateMinor: 1 }],
            })
          ).tiers,
        ).toMatch(/start at 0/);
        expect(
          await bad({
            pricingType: 'flat',
            flatRateMinor: 1,
            tiers: [{ from: 0, to: null, rateMinor: 1 }],
          }),
        ).toHaveProperty('tiers');
      });

      it('keep names unique within a zone, and refuse an unknown zone', async () => {
        const z = (await s.zones.list(s.owner())).find(
          (x) => x.name === 'Methods zone',
        )!;
        expect(
          (await failure(s.method(z.id, 'standard', { pricingType: 'free' })))
            .code,
        ).toBe('METHOD_NAME_TAKEN');
        expect(
          (
            await failure(
              s.method('00000000-0000-4000-8000-000000000000', 'Ghost', {
                pricingType: 'free',
              }),
            )
          ).code,
        ).toBe('ZONE_NOT_FOUND');
      });

      it('update (replacing the rate bands), stay in their zone, and delete', async () => {
        const z = (await s.zones.list(s.owner())).find(
          (x) => x.name === 'Methods zone',
        )!;
        const weight = (await s.methods.list(s.owner(), z.id)).find(
          (m) => m.name === 'By weight',
        )!;
        const changed = await s.methods.update(s.owner(), weight.id, {
          zoneId: z.id,
          name: 'By weight',
          pricingType: 'weight',
          tiers: [
            { from: 0, to: 1000, rateMinor: 5000 },
            { from: 1000, to: null, rateMinor: 8000 },
          ],
        } as never);
        expect(changed.tiers).toHaveLength(2);
        const other = await s.zone('Other zone for move', {
          states: ['Meghalaya'],
        });
        expect(
          (
            await failure(
              s.methods.update(s.owner(), weight.id, {
                zoneId: other.id,
                name: 'By weight',
                pricingType: 'free',
              } as never),
            )
          ).code,
        ).toBe('METHOD_ZONE_FIXED');
        await s.methods.remove(s.owner(), weight.id);
        expect((await failure(s.methods.get(s.owner(), weight.id))).code).toBe(
          'METHOD_NOT_FOUND',
        );
      });

      it('are private to each organization', async () => {
        const theirs = await s.zones.create(s.ownerB(), {
          name: 'B zone',
          areas: { states: ['Punjab'] },
        } as never);
        const mine = (await s.methods.list(s.owner())).find(
          (m) => m.name === 'Standard',
        )!;
        expect((await failure(s.methods.get(s.ownerB(), mine.id))).code).toBe(
          'METHOD_NOT_FOUND',
        );
        expect(
          (await failure(s.methods.remove(s.ownerB(), mine.id))).code,
        ).toBe('METHOD_NOT_FOUND');
        expect((await s.methods.list(s.ownerB())).length).toBe(0);
        expect(
          (
            await failure(
              s.methods.create(s.ownerB(), {
                zoneId: (await s.zones.list(s.owner()))[0].id,
                name: 'Cross',
                pricingType: 'free',
              } as never),
            )
          ).code,
        ).toBe('ZONE_NOT_FOUND');
        await s.zones.remove(s.ownerB(), theirs.id);
      });

      it('go away with their zone', async () => {
        const z = await s.zone('Temporary', { states: ['Assam'] });
        await s.method(z.id, 'Temp method', { pricingType: 'free' });
        await s.zones.remove(s.owner(), z.id);
        expect(
          (await s.methods.list(s.owner())).some(
            (m) => m.name === 'Temp method',
          ),
        ).toBe(false);
      });
    });

    describe('delivery options for an address', () => {
      it('a store with no zones has nothing to enforce', async () => {
        const q = await s.quotes.options(s.w.tenantB, {
          destination: to(KA, '560001'),
          subtotalMinor: 100000,
          weightGrams: 500,
        });
        expect(q).toEqual({
          configured: false,
          deliverable: true,
          zone: null,
          options: [],
          unavailable: [],
          reason: null,
        });
      });

      describe('with zones', () => {
        let regional: string;
        let city: string;
        let pin: string;
        let everywhere: string;
        let off: string;

        beforeAll(async () => {
          for (const z of await s.zones.list(s.owner()))
            await s.zones.remove(s.owner(), z.id);
          regional = (await s.zone('Karnataka', { states: ['Karnataka'] })).id;
          city = (
            await s.zone('Mysuru', {
              cities: [{ state: 'Karnataka', city: 'Mysuru' }],
            })
          ).id;
          pin = (await s.zone('One PIN', { postalCodes: ['560001'] })).id;
          everywhere = (await s.zone('Rest of India', { country: true })).id;
          off = (
            await s.zone(
              'Disabled corner',
              { states: ['Goa'] },
              { enabled: false },
            )
          ).id;
          await s.method(regional, 'State flat', {
            pricingType: 'flat',
            flatRateMinor: 4000,
            estimatedDaysMin: 1,
            estimatedDaysMax: 2,
          });
          await s.method(city, 'City flat', {
            pricingType: 'flat',
            flatRateMinor: 2000,
          });
          await s.method(pin, 'PIN flat', {
            pricingType: 'flat',
            flatRateMinor: 1000,
          });
          await s.method(everywhere, 'Anywhere', {
            pricingType: 'flat',
            flatRateMinor: 9000,
            estimatedDaysMin: 5,
            estimatedDaysMax: 9,
          });
          await s.method(off, 'Never offered', { pricingType: 'free' });
        });

        const cart = (subtotalMinor = 100000, weightGrams = 500) => ({
          subtotalMinor,
          weightGrams,
        });
        const quote = (dest: ReturnType<typeof to>, c = cart()) =>
          s.quotes.options(s.w.tenantA, { destination: dest, ...c });

        it('give an address the zone of its most specific area', async () => {
          expect((await quote(to(KA, '560001', 'Bengaluru'))).zone?.name).toBe(
            'One PIN',
          ); // PIN beats state
          expect((await quote(to(KA, '570001', 'Mysuru'))).zone?.name).toBe(
            'Mysuru',
          ); // city beats state
          expect((await quote(to(KA, '570001', ' MYSURU '))).zone?.name).toBe(
            'Mysuru',
          ); // ...ignoring case and spaces
          expect((await quote(to(KA, '580001', 'Hubballi'))).zone?.name).toBe(
            'Karnataka',
          );
          expect((await quote(to(MH, '400001', 'Mumbai'))).zone?.name).toBe(
            'Rest of India',
          ); // country is the fallback
        });

        it('a PIN range beats a city or state, and a single PIN beats the range', async () => {
          const r = await s.zone('Range zone', {
            postalRanges: [{ from: '580000', to: '580099' }],
          });
          await s.method(r.id, 'Range flat', {
            pricingType: 'flat',
            flatRateMinor: 3000,
          });
          expect((await quote(to(KA, '580050', 'Hubballi'))).zone?.name).toBe(
            'Range zone',
          );
          expect((await quote(to(KA, '580100', 'Hubballi'))).zone?.name).toBe(
            'Karnataka',
          );
          await s.zones.remove(s.owner(), r.id);
        });

        it('price the options of the zone, with delivery times', async () => {
          const q = await quote(to(KA, '580001', 'Hubballi'));
          expect(q).toMatchObject({
            configured: true,
            deliverable: true,
            reason: null,
          });
          expect(q.options).toEqual([
            expect.objectContaining({
              name: 'State flat',
              chargeMinor: 4000,
              free: false,
              estimatedDays: { min: 1, max: 2 },
              codAllowed: true,
              carrier: null,
            }),
          ]);
        });

        it('a zone that is switched off means "not served": it does not fall back to a wider zone', async () => {
          const q = await quote(to('30', '403001', 'Panaji'));
          expect(q).toMatchObject({
            deliverable: false,
            options: [],
            reason: 'We do not deliver to this address.',
          });
        });

        it('an address no zone covers is not deliverable once any zone exists', async () => {
          await s.zones.remove(s.owner(), everywhere);
          const q = await quote(to(MH, '400001', 'Mumbai'));
          expect(q).toMatchObject({
            configured: true,
            deliverable: false,
            zone: null,
          });
          everywhere = (await s.zone('Rest of India', { country: true })).id;
          await s.method(everywhere, 'Anywhere', {
            pricingType: 'flat',
            flatRateMinor: 9000,
            estimatedDaysMin: 5,
            estimatedDaysMax: 9,
          });
        });

        it('apply order value and weight limits, and say why a method is left out', async () => {
          const z = await s.zone('Limits', { states: ['Punjab'] });
          await s.method(z.id, 'Small orders', {
            pricingType: 'flat',
            flatRateMinor: 5000,
            maxOrderMinor: 50000,
          });
          await s.method(z.id, 'Big orders', {
            pricingType: 'flat',
            flatRateMinor: 0,
            minOrderMinor: 50001,
          });
          await s.method(z.id, 'Light only', {
            pricingType: 'flat',
            flatRateMinor: 7000,
            maxWeightGrams: 1000,
          });
          const small = await quote(to('03', '140001'), cart(20000, 500));
          expect(small.options.map((o) => o.name).sort()).toEqual([
            'Light only',
            'Small orders',
          ]);
          expect(small.unavailable).toEqual([
            expect.objectContaining({
              name: 'Big orders',
              reason: expect.stringMatching(/below the minimum/),
            }),
          ]);
          const heavy = await quote(to('03', '140001'), cart(80000, 3000));
          expect(heavy.options.map((o) => o.name)).toEqual(['Big orders']);
          expect(heavy.options[0]).toMatchObject({
            chargeMinor: 0,
            free: true,
          });
          expect(heavy.unavailable.map((u) => u.name).sort()).toEqual([
            'Light only',
            'Small orders',
          ]);
          await s.zones.remove(s.owner(), z.id);
        });

        it('price by weight bands, by order value bands, and free over a threshold', async () => {
          const z = await s.zone('Priced', { states: ['Assam'] });
          await s.method(z.id, 'Weight', {
            pricingType: 'weight',
            tiers: [
              { from: 0, to: 1000, rateMinor: 4000 },
              { from: 1000, to: null, rateMinor: 9000 },
            ],
          });
          await s.method(z.id, 'Value', {
            pricingType: 'order_value',
            tiers: [
              { from: 0, to: 100000, rateMinor: 6000 },
              { from: 100000, to: null, rateMinor: 0 },
            ],
          });
          await s.method(z.id, 'Free over 2000', {
            pricingType: 'flat',
            flatRateMinor: 5000,
            freeOverMinor: 200000,
          });
          const price = async (subtotal: number, weight: number) =>
            Object.fromEntries(
              (
                await quote(to('18', '781001'), cart(subtotal, weight))
              ).options.map((o) => [o.name, o.chargeMinor]),
            );
          expect(await price(50000, 999)).toEqual({
            Weight: 4000,
            Value: 6000,
            'Free over 2000': 5000,
          });
          expect(await price(99999, 1000)).toEqual({
            Weight: 9000,
            Value: 6000,
            'Free over 2000': 5000,
          });
          expect(await price(100000, 5000)).toEqual({
            Weight: 9000,
            Value: 0,
            'Free over 2000': 5000,
          });
          expect(await price(200000, 500)).toEqual({
            Weight: 4000,
            Value: 0,
            'Free over 2000': 0,
          });
          await s.zones.remove(s.owner(), z.id);
        });

        it('never prices by weight when the weight is unknown, but a flat rate still works', async () => {
          const z = await s.zone('Unknown weight', { states: ['Assam'] });
          await s.method(z.id, 'Weight', {
            pricingType: 'weight',
            tiers: [{ from: 0, to: null, rateMinor: 100 }],
          });
          await s.method(z.id, 'Flat', {
            pricingType: 'flat',
            flatRateMinor: 3000,
          });
          const q = await quote(to('18', '781001'), cart(10000, 0));
          expect(q.options.map((o) => o.name)).toEqual(['Flat']);
          expect(q.unavailable).toEqual([
            expect.objectContaining({
              name: 'Weight',
              reason: 'The weight of the items is not known.',
            }),
          ]);
          await s.zones.remove(s.owner(), z.id);
        });

        it('allow cash on delivery only where the zone AND the method allow it', async () => {
          const z = await s.zone('Cash zone', { states: ['Assam'] });
          const noCash = await s.zone(
            'No cash zone',
            { states: ['Sikkim'] },
            { codAllowed: false },
          );
          await s.method(z.id, 'Cash ok', {
            pricingType: 'flat',
            flatRateMinor: 1000,
          });
          await s.method(z.id, 'Prepaid only', {
            pricingType: 'flat',
            flatRateMinor: 500,
            codAllowed: false,
          });
          await s.method(noCash.id, 'Anything', {
            pricingType: 'flat',
            flatRateMinor: 500,
          });
          const assam = await quote(to('18', '781001'));
          expect(
            Object.fromEntries(
              assam.options.map((o) => [o.name, o.codAllowed]),
            ),
          ).toEqual({ 'Cash ok': true, 'Prepaid only': false });
          expect((await quote(to('11', '737101'))).options[0].codAllowed).toBe(
            false,
          );
          await s.zones.remove(s.owner(), z.id);
          await s.zones.remove(s.owner(), noCash.id);
        });

        it('leave out a disabled method', async () => {
          const z = await s.zone('Toggle', { states: ['Assam'] });
          await s.method(z.id, 'On', { pricingType: 'free' });
          await s.method(z.id, 'Off', { pricingType: 'free', enabled: false });
          expect(
            (await quote(to('18', '781001'))).options.map((o) => o.name),
          ).toEqual(['On']);
          await s.zones.remove(s.owner(), z.id);
        });

        it('keep one organization’s zones out of another’s quotes', async () => {
          const other = await s.quotes.options(s.w.tenantB, {
            destination: to(KA, '560001'),
            subtotalMinor: 100,
            weightGrams: 100,
          });
          expect(other.configured).toBe(false);
        });
      });

      describe('with carriers', () => {
        let zoneId: string;

        beforeAll(async () => {
          for (const z of await s.zones.list(s.owner()))
            await s.zones.remove(s.owner(), z.id);
          zoneId = (await s.zone('Everywhere', { country: true })).id;
          await s.tools.saveOrigin(s.owner(), ORIGIN as never);
          await s.connect('shiprocket');
          await s.connect('delhivery');
        });

        const live = (extra: Record<string, unknown> = {}) =>
          s.method(zoneId, `Live ${Math.random().toString(36).slice(2, 7)}`, {
            pricingType: 'carrier',
            ...extra,
          });
        const quote = (
          pin = '400001',
          weight = 750,
          subtotal = 100000,
          paymentMethod?: 'cod',
        ) =>
          s.quotes.options(s.w.tenantA, {
            destination: to(MH, pin, 'Mumbai'),
            subtotalMinor: subtotal,
            weightGrams: weight,
            paymentMethod,
          });

        it('price a method from the best live quote, plus handling, and name the carrier', async () => {
          await s.methods
            .list(s.owner())
            .then((ms) =>
              Promise.all(ms.map((m) => s.methods.remove(s.owner(), m.id))),
            );
          await live({
            handlingMinor: 1500,
            estimatedDaysMin: 9,
            estimatedDaysMax: 9,
          });
          const q = await quote();
          expect(q.options).toHaveLength(1);
          // Strategy "lowest cost": Shiprocket's Xpressbees at 62.50 beats Delhivery's 74.62; handling 15.00 is added.
          expect(q.options[0]).toMatchObject({
            chargeMinor: 6250 + 1500,
            pricingType: 'carrier',
            estimatedDays: { min: 4, max: 4 },
            carrier: {
              code: 'shiprocket',
              serviceCode: '10',
              serviceName: 'Xpressbees Surface',
            },
          });
          expect(q.options[0].carrierQuote?.amountMinor).toBe(6250);
        });

        it('follow the Owner’s strategy: fastest, or the default carrier first', async () => {
          await s.carriers.savePreferences(s.owner(), {
            selectionMode: 'automatic',
            strategy: 'fastest',
          });
          expect((await quote()).options[0].carrier).toMatchObject({
            code: 'shiprocket',
            serviceCode: '11',
          });
          await s.carriers.setDefault(s.owner(), 'delhivery', {
            isDefault: true,
          });
          await s.carriers.savePreferences(s.owner(), {
            selectionMode: 'automatic',
            strategy: 'preferred',
          });
          expect((await quote()).options[0]).toMatchObject({
            chargeMinor: 7462 + 1500,
            carrier: { code: 'delhivery', serviceCode: 'S' },
          });
          // Pricing follows the strategy even when fulfilment is chosen by hand.
          await s.carriers.savePreferences(s.owner(), {
            selectionMode: 'manual',
            strategy: 'lowest_cost',
          });
          expect((await quote()).options[0].carrier?.code).toBe('shiprocket');
        });

        it('can be restricted to one carrier, and uses only carriers that confirm delivery', async () => {
          const methods = await s.methods.list(s.owner());
          await Promise.all(
            methods.map((m) => s.methods.remove(s.owner(), m.id)),
          );
          await live({ carrierCode: 'delhivery' });
          expect((await quote()).options[0].carrier?.code).toBe('delhivery');
          // PINs starting with 9 are served by nobody: no price, so the method is not offered (never a made-up price).
          const none = await quote('900001');
          expect(none.options).toEqual([]);
          expect(none.unavailable[0].reason).toMatch(/not available right now/);
        });

        it('is not offered when the weight is unknown, the pickup address is missing, or the carriers are down', async () => {
          expect((await quote('400001', 0)).unavailable[0].reason).toBe(
            'The weight of the items is not known.',
          );
          s.carrier.requests.length = 0;
          // Carriers failing: no price, so the method is not offered.
          const down = await s.t.asOwner((pg) =>
            pg.query(
              'update tenant_carrier_connections set enabled = false, is_default = false where tenant_id = $1',
              [s.w.tenantA],
            ),
          );
          expect(down).toBeDefined();
          const off = await quote();
          expect(off.options).toEqual([]);
          await s.t.asOwner((pg) =>
            pg.query(
              "update tenant_carrier_connections set enabled = true where tenant_id = $1 and verification_status = 'verified'",
              [s.w.tenantA],
            ),
          );
        });

        it('does not ask any carrier when nothing needs a live price', async () => {
          const methods = await s.methods.list(s.owner());
          await Promise.all(
            methods.map((m) => s.methods.remove(s.owner(), m.id)),
          );
          await s.method(zoneId, 'Flat only', {
            pricingType: 'flat',
            flatRateMinor: 1000,
          });
          const before = s.carrier.requests.length;
          expect((await quote()).options[0].chargeMinor).toBe(1000);
          expect(s.carrier.requests.length).toBe(before);
        });

        it('does not ask for a live price when the order already qualifies for free shipping', async () => {
          await s.method(zoneId, 'Live free over 500', {
            pricingType: 'carrier',
            freeOverMinor: 50000,
          });
          const before = s.carrier.requests.length;
          const q = await quote('400001', 750, 60000);
          expect(
            q.options.find((o) => o.name === 'Live free over 500'),
          ).toMatchObject({ chargeMinor: 0, free: true });
          expect(s.carrier.requests.length).toBe(before);
        });

        it('compares the connected carriers for a parcel and shows what the settings would choose', async () => {
          await s.carriers.savePreferences(s.owner(), {
            selectionMode: 'automatic',
            strategy: 'lowest_cost',
          });
          const result = await s.tools.compare(s.owner(), {
            destinationPostalCode: '400001',
            weightGrams: 750,
            paymentMode: 'prepaid',
          });
          expect(
            result.candidates
              .map((c) => `${c.providerCode}:${c.serviceCode}`)
              .sort(),
          ).toEqual([
            'delhivery:E',
            'delhivery:S',
            'shiprocket:10',
            'shiprocket:11',
          ]);
          expect(result.choice).toMatchObject({
            fellBack: false,
            candidate: { providerCode: 'shiprocket', serviceCode: '10' },
          });
          // Cash on delivery: Shiprocket's Bluedart Air does not collect cash.
          const cod = await s.tools.compare(s.owner(), {
            destinationPostalCode: '400001',
            weightGrams: 750,
            paymentMode: 'cod',
            declaredValueMinor: 100000,
          });
          expect(
            cod.candidates
              .map((c) => `${c.providerCode}:${c.serviceCode}`)
              .sort(),
          ).toEqual(['delhivery:E', 'delhivery:S', 'shiprocket:10']);
          const unserved = await s.tools.compare(s.owner(), {
            destinationPostalCode: '900001',
            weightGrams: 750,
            paymentMode: 'prepaid',
          });
          expect(unserved.candidates).toEqual([]);
          expect(unserved.skipped.length).toBe(2);
          expect(unserved.choice.candidate).toBeNull();
          await s.carriers.savePreferences(s.owner(), {
            selectionMode: 'manual',
            strategy: 'lowest_cost',
          });
          expect(
            (
              await s.tools.compare(s.owner(), {
                destinationPostalCode: '400001',
                weightGrams: 750,
                paymentMode: 'prepaid',
              })
            ).choice.candidate,
          ).toBeNull();
        });

        it('never uses a carrier that cannot confirm delivery, and says so', async () => {
          await s.carriers.save(s.owner(), 'bluedart', {
            clientId: 'bd-client-id-1',
            clientSecret: 'bd-secret-1234',
            loginId: 'L',
            licenceKey: 'bd-licence-1234',
            customerCode: '1',
            originArea: 'BLR',
          });
          await s.t.asOwner((pg) =>
            pg.query(
              "update tenant_carrier_connections set verification_status = 'verified', verified_at = now(), enabled = true where tenant_id = $1 and provider_code = 'bluedart'",
              [s.w.tenantA],
            ),
          );
          const result = await s.tools.compare(s.owner(), {
            destinationPostalCode: '400001',
            weightGrams: 750,
            paymentMode: 'prepaid',
          });
          expect(
            result.candidates.every((c) => c.providerCode !== 'bluedart'),
          ).toBe(true);
          expect(
            result.skipped.find((k) => k.providerCode === 'bluedart')?.reason,
          ).toMatch(/cannot confirm delivery/);
        });

        it('needs the pickup address to compare carriers', async () => {
          const err = await failure(
            s.tools.compare(s.ownerB(), {
              destinationPostalCode: '400001',
              weightGrams: 750,
              paymentMode: 'prepaid',
            }),
          );
          expect(err.code).toBe('ORIGIN_MISSING');
        });
      });
    });

    describe('the pickup address', () => {
      it('is saved per organization, with the state resolved', async () => {
        const saved = await s.tools.saveOrigin(s.ownerB(), {
          ...ORIGIN,
          state: '27',
          postalCode: '400001',
        } as never);
        expect(saved).toMatchObject({
          configured: true,
          state: 'Maharashtra',
          postalCode: '400001',
        });
        expect((await s.tools.origin(s.owner())).postalCode).toBe('560001');
        expect(
          (
            await failure(
              s.tools.saveOrigin(s.ownerB(), {
                ...ORIGIN,
                state: 'Atlantis',
              } as never),
            )
          ).kind,
        ).toBe('VALIDATION');
      });
    });
  },
);
