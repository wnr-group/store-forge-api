import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddPlatformAdminDto } from '../../modules/platform-admin/admins/admins.dto.js';
import { CreateCustomerDto } from '../../modules/customers/customers.dto.js';
import { CreateProductDto } from '../../modules/products/products.dto.js';
import { CreateMemberDto } from '../../modules/team/team.dto.js';
import { UpdateStoreDto } from '../../modules/store/store.dto.js';
import { AdjustStockDto } from '../../modules/inventory/inventory.dto.js';
import { ProductListQueryDto } from '../../modules/products/products.dto.js';
import { isValidPhone, moneyValue } from './fields.js';

type Ctor<T> = new () => T;

/** The transformed instance and the property names that failed (what the ValidationPipe would reject). */
async function check<T extends object>(cls: Ctor<T>, plain: object) {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const failed = new Set<string>();
  const walk = (list: typeof errors, prefix = '') => {
    for (const e of list) {
      const key = prefix + e.property;
      if (e.constraints) failed.add(key);
      if (e.children?.length) walk(e.children, `${key}.`);
    }
  };
  walk(errors);
  return { instance, failed: [...failed].sort() };
}

describe('money and phone primitives', () => {
  it('parses plain non-negative decimals only', () => {
    expect(moneyValue('1,299.50')).toBe(1299.5);
    expect(moneyValue(' 10 ')).toBe(10);
    for (const bad of ['', '-1', '1e3', '0x10', '1.2.3', 'ten', '$5', '5.'])
      expect(moneyValue(bad), bad).toBeNull();
  });

  it('accepts international phone numbers with 7-15 digits', () => {
    expect(isValidPhone('+1 415 555 0100')).toBe(true);
    expect(isValidPhone('(020) 7946-0958')).toBe(true);
    for (const bad of ['abc', '12345', '+1234567890123456', '12 34 ab 5678'])
      expect(isValidPhone(bad), bad).toBe(false);
  });
});

describe('CreateProductDto', () => {
  const ok = { name: '  Tee  ', price: '10' };

  it('accepts the minimal valid product and trims the name', async () => {
    const { instance, failed } = await check(CreateProductDto, ok);
    expect(failed).toEqual([]);
    expect(instance.name).toBe('Tee');
  });

  it.each([
    ['empty name', { ...ok, name: '   ' }, 'name'],
    ['name over 200 chars', { ...ok, name: 'x'.repeat(201) }, 'name'],
    ['missing price', { name: 'Tee' }, 'price'],
    ['zero price', { ...ok, price: '0' }, 'price'],
    ['negative price', { ...ok, price: '-1' }, 'price'],
    ['non-numeric price', { ...ok, price: 'ten' }, 'price'],
    ['price as a number (must be decimal text)', { ...ok, price: 10 }, 'price'],
    ['bad slug', { ...ok, slug: 'Bad Slug!' }, 'slug'],
    ['one-letter slug', { ...ok, slug: 'a' }, 'slug'],
    ['bad status', { ...ok, status: 'archived' }, 'status'],
    ['negative quantity', { ...ok, quantity: -1 }, 'quantity'],
    ['fractional quantity', { ...ok, quantity: 1.5 }, 'quantity'],
    ['category not a uuid', { ...ok, categoryId: 'abc' }, 'categoryId'],
    [
      'more than 3 options',
      {
        ...ok,
        options: [1, 2, 3, 4].map((n) => ({ name: `O${n}`, values: ['a'] })),
      },
      'options',
    ],
    [
      'more than 10 images',
      {
        ...ok,
        images: Array.from({ length: 11 }, (_, i) => ({
          path: `tenant/product/file-${i}.png`,
        })),
      },
      'images',
    ],
    ['unknown field', { ...ok, tenantId: 'x' }, 'tenantId'],
  ])('rejects %s', async (_name, plain, field) => {
    expect(
      (await check(CreateProductDto, plain)).failed.some(
        (f) => f === field || f.startsWith(`${field}.`),
      ),
    ).toBe(true);
  });

  it('accepts string integers for quantity and normalises empty optional text to null', async () => {
    const { instance, failed } = await check(CreateProductDto, {
      ...ok,
      quantity: '12',
      description: '   ',
      sku: ' ',
    });
    expect(failed).toEqual([]);
    expect(instance.quantity).toBe(12);
    expect(instance.description).toBeNull();
    expect(instance.sku).toBeNull();
  });

  it('validates nested variants and options', async () => {
    const { failed } = await check(CreateProductDto, {
      ...ok,
      options: [{ name: '', values: [] }],
      variants: [{ options: { Size: 1 }, price: '0', quantity: -2 }],
    });
    expect(failed).toEqual(
      expect.arrayContaining([
        'options.0.name',
        'options.0.values',
        'variants.0.options',
        'variants.0.price',
        'variants.0.quantity',
      ]),
    );
  });
});

describe('other request DTOs', () => {
  it('customers: normalises e-mail and rejects bad e-mail / phone', async () => {
    const good = await check(CreateCustomerDto, {
      fullName: ' Dana ',
      email: ' DANA@Example.TEST ',
    });
    expect(good.failed).toEqual([]);
    expect(good.instance).toMatchObject({
      fullName: 'Dana',
      email: 'dana@example.test',
    });
    expect(
      (await check(CreateCustomerDto, { fullName: 'Dana', email: 'dana' }))
        .failed,
    ).toContain('email');
    expect(
      (
        await check(CreateCustomerDto, {
          fullName: 'Dana',
          email: 'd@e.test',
          phone: 'abc',
        })
      ).failed,
    ).toContain('phone');
    expect(
      (await check(CreateCustomerDto, { fullName: '', email: 'd@e.test' }))
        .failed,
    ).toContain('fullName');
  });

  it('team members: password policy and permission levels', async () => {
    const base = {
      fullName: 'New Hire',
      email: 'h@e.test',
      password: 'Passw0rd-1',
      permissions: {
        products: 'write',
        orders: 'read',
        customers: 'none',
        settings: 'read',
      },
    };
    expect((await check(CreateMemberDto, base)).failed).toEqual([]);
    for (const password of [
      'short1A',
      'nodigitshere',
      '12345678',
      'x'.repeat(73) + '1',
    ])
      expect(
        (await check(CreateMemberDto, { ...base, password })).failed,
        password,
      ).toContain('password');
    expect(
      (
        await check(CreateMemberDto, {
          ...base,
          permissions: { ...base.permissions, orders: 'write' },
        })
      ).failed,
    ).toContain('permissions.orders');
    expect(
      (
        await check(CreateMemberDto, {
          ...base,
          permissions: { ...base.permissions, settings: 'none' },
        })
      ).failed,
    ).toContain('permissions.settings');
    expect(
      (await check(CreateMemberDto, { ...base, role: 'owner' })).failed,
    ).toContain('role');
  });

  it('platform admins: only the two known levels', async () => {
    const base = {
      fullName: 'Ada Admin',
      email: 'a@e.test',
      password: 'Passw0rd-1',
      role: 'admin',
    };
    expect((await check(AddPlatformAdminDto, base)).failed).toEqual([]);
    expect(
      (await check(AddPlatformAdminDto, { ...base, role: 'owner' })).failed,
    ).toContain('role');
  });

  it('store update is partial: omitted fields are not validated, present ones are', async () => {
    expect((await check(UpdateStoreDto, {})).failed).toEqual([]);
    expect((await check(UpdateStoreDto, { name: 'A' })).failed).toContain(
      'name',
    );
    expect((await check(UpdateStoreDto, { slug: 'admin' })).failed).toContain(
      'slug',
    );
    expect(
      (await check(UpdateStoreDto, { slug: 'my--shop' })).failed,
    ).toContain('slug');
    expect((await check(UpdateStoreDto, { currency: 'inr' })).failed).toEqual(
      [],
    ); // upper-cased
    expect(
      (await check(UpdateStoreDto, { currency: 'XXXX' })).failed,
    ).toContain('currency');
    expect(
      (await check(UpdateStoreDto, { timezone: 'Nowhere/Land' })).failed,
    ).toContain('timezone');
    expect((await check(UpdateStoreDto, { name: null })).failed).toContain(
      'name',
    ); // null does not clear a required field
  });

  it('inventory adjustment: whole numbers, known modes and reasons', async () => {
    const base = {
      productId: '11111111-1111-4111-8111-111111111111',
      mode: 'add',
      value: 5,
      reason: 'restock',
    };
    expect((await check(AdjustStockDto, base)).failed).toEqual([]);
    expect(
      (await check(AdjustStockDto, { ...base, value: '7' })).instance.value,
    ).toBe(7);
    for (const bad of [
      { mode: 'multiply' },
      { reason: 'theft' },
      { value: 1.5 },
      { value: 2_000_000 },
      { productId: 'x' },
    ])
      expect(
        (await check(AdjustStockDto, { ...base, ...bad })).failed.length,
        JSON.stringify(bad),
      ).toBeGreaterThan(0);
  });

  it('list queries: defaults, coercion and bounds', async () => {
    const def = await check(ProductListQueryDto, {});
    expect(def.failed).toEqual([]);
    expect(def.instance).toMatchObject({
      page: 1,
      limit: 20,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      status: 'all',
      stock: 'all',
      category: 'all',
      search: '',
    });
    expect(
      (await check(ProductListQueryDto, { page: '3', limit: '50' })).instance,
    ).toMatchObject({ page: 3, limit: 50 });
    for (const bad of [
      { page: '0' },
      { limit: '101' },
      { limit: 'many' },
      { sortBy: 'password' },
      { sortOrder: 'sideways' },
      { category: 'abc' },
    ])
      expect(
        (await check(ProductListQueryDto, bad)).failed.length,
        JSON.stringify(bad),
      ).toBeGreaterThan(0);
  });
});
