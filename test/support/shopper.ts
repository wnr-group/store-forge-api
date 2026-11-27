import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/**
 * Creates a storefront customer account through the real HTTP route and returns its session token. Placing an order needs one
 * (browsing and the cart do not), so every test that places an order over HTTP signs a shopper up first and sends the token
 * as `X-Customer-Session`.
 */
export async function registerShopper(
  app: INestApplication,
  slug = 'alpha-shop',
  email = `shopper-${randomBytes(6).toString('hex')}@example.test`,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/public/stores/${slug}/account/register`)
    .set(
      'X-Forwarded-For',
      `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    )
    .send({ fullName: 'Test Shopper', email, password: 'Shopper123' });
  if (res.status !== 201)
    throw new Error(
      `registerShopper failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  return res.body.data.sessionToken as string;
}
