import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SaveRazorpayConfigDto } from './payments.dto.js';

const KEY_ID = 'rzp_test_AbCdEfGh12345678';
const SECRET = 'SYNTH0aB3dE6gH9jK2mN5pQ8';

async function check(plain: object) {
  const errors = await validate(plainToInstance(SaveRazorpayConfigDto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
  return { failed: errors.map((e) => e.property).sort(), messages };
}

describe('SaveRazorpayConfigDto (AC-API-05, AC-API-06, AC-API-07)', () => {
  it('accepts a valid pair', async () => {
    expect((await check({ keyId: KEY_ID, keySecret: SECRET })).failed).toEqual(
      [],
    );
  });

  it('requires both fields', async () => {
    expect((await check({ keySecret: SECRET })).failed).toEqual(['keyId']);
    expect((await check({ keyId: KEY_ID })).failed).toEqual(['keySecret']);
    expect((await check({})).failed).toEqual(['keyId', 'keySecret']);
  });

  it('rejects unknown fields, including tenantId', async () => {
    const r = await check({ keyId: KEY_ID, keySecret: SECRET, tenantId: 'x' });
    expect(r.failed).toEqual(['tenantId']);
  });

  it('enforces the Key ID regex', async () => {
    expect(
      (await check({ keyId: 'rzp_test_abcdefg', keySecret: SECRET })).failed,
    ).toEqual(['keyId']);
    expect(
      (await check({ keyId: 'rzp_live_abcdefgh', keySecret: SECRET })).failed,
    ).toEqual([]);
  });

  it('enforces the secret boundary: 16 and 128 accepted, 15 and 129 rejected', async () => {
    for (const [len, failed] of [
      [15, ['keySecret']],
      [16, []],
      [128, []],
      [129, ['keySecret']],
    ] as const) {
      const r = await check({ keyId: KEY_ID, keySecret: 'a'.repeat(len) });
      expect(r.failed, `length ${len}`).toEqual(failed);
    }
  });

  it('does not trim: padded secrets are rejected', async () => {
    const r = await check({ keyId: KEY_ID, keySecret: ` ${SECRET}` });
    expect(r.failed).toEqual(['keySecret']);
  });

  it('never echoes the submitted secret or Key ID in an error message', async () => {
    const badSecret = `${SECRET}!bad`;
    const badKeyId = 'rzp_test_short';
    const r = await check({ keyId: badKeyId, keySecret: badSecret });
    expect(r.failed).toEqual(['keyId', 'keySecret']);
    for (const m of r.messages) {
      expect(m).not.toContain(badSecret);
      expect(m).not.toContain(SECRET);
      expect(m).not.toContain(badKeyId);
    }
  });
});
