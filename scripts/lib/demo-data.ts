/**
 * Pure demo-data builder: no database access, no clock reads other than the `now` argument.
 * Everything is derived from the tenant id (deterministic UUIDs) and a fixed PRNG seed, so the
 * same tenant always yields the same ids and the same structure. That is what makes the seed
 * idempotent: re-running it hits the same primary keys and skips them.
 */
import { createHash } from 'node:crypto';
import type {
  InventoryReason,
  OrderStatus,
} from '../../src/database/schema/enums.js';

export const DEMO_STORE_SLUG = 'urban-nest-demo';
export const DEMO_TENANT_NAME = 'Urban Nest Trading Co';
export const DEMO_STORE = {
  name: 'Urban Nest',
  slug: DEMO_STORE_SLUG,
  description:
    'Everyday clothing, footwear, electronics and home goods. Demo store with sample data.',
  contactEmail: 'hello@urbannest.example.com',
  contactPhone: '+91 80 5550 0142',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
} as const;

const DAY = 86_400_000;

/** RFC 4122 version-5 style UUID from a namespace uuid and a name. */
export function detId(namespace: string, name: string): string {
  const h = createHash('sha1')
    .update(namespace.replace(/-/g, ''), 'hex')
    .update(name)
    .digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type CategoryDef = {
  key: string;
  name: string;
  description: string;
  parent?: string;
};
const CATEGORIES: CategoryDef[] = [
  {
    key: 'clothing',
    name: 'Clothing',
    description: 'Shirts, jackets and everyday wear.',
  },
  {
    key: 't-shirts',
    name: 'T-Shirts',
    description: 'Basic and printed tees.',
    parent: 'clothing',
  },
  {
    key: 'electronics',
    name: 'Electronics',
    description: 'Audio, wearables and accessories.',
  },
  {
    key: 'audio',
    name: 'Audio',
    description: 'Headphones and speakers.',
    parent: 'electronics',
  },
  {
    key: 'home-living',
    name: 'Home & Living',
    description: 'Lighting, kitchenware and decor.',
  },
  {
    key: 'accessories',
    name: 'Accessories',
    description: 'Bags, wallets and eyewear.',
  },
  {
    key: 'footwear',
    name: 'Footwear',
    description: 'Running shoes, sneakers and sandals.',
  },
  {
    key: 'sports',
    name: 'Sports',
    description: 'Training gear and hydration.',
  },
];

type ProductDef = {
  key: string;
  name: string;
  cat: string;
  price: number;
  compare?: number;
  cost: number;
  type: string;
  short: string;
  status?: 'draft';
  /** Simple product stock. */
  stock?: number;
  /** Variant options; stock cycles through `stocks`. */
  options?: Record<string, string[]>;
  stocks?: number[];
  threshold?: number;
};

const SIZES = ['S', 'M', 'L', 'XL'];
const SHOE = ['6', '7', '8', '9', '10'];
const COLORS3 = ['Black', 'White', 'Blue'];
const R = (n: number) => n * 100;

const PRODUCTS: ProductDef[] = [
  {
    key: 'premium-cotton-t-shirt',
    name: 'Premium Cotton T-Shirt',
    cat: 't-shirts',
    price: R(799),
    compare: R(999),
    cost: R(320),
    type: 'T-Shirt',
    short: 'Soft 180 GSM combed cotton tee with a relaxed fit.',
    options: { Size: SIZES, Color: ['Black', 'White'] },
    stocks: [24, 30, 18, 12, 26, 4, 0, 15],
  },
  {
    key: 'graphic-print-tee',
    name: 'Graphic Print Tee',
    cat: 't-shirts',
    price: R(699),
    cost: R(260),
    type: 'T-Shirt',
    short: 'Screen-printed cotton tee in limited artwork.',
    options: { Size: SIZES },
    stocks: [14, 22, 9, 3],
  },
  {
    key: 'classic-denim-jacket',
    name: 'Classic Denim Jacket',
    cat: 'clothing',
    price: R(2899),
    compare: R(3499),
    cost: R(1450),
    type: 'Jacket',
    short: 'Mid-weight washed denim jacket with a timeless cut.',
    options: { Size: SIZES },
    stocks: [8, 11, 6, 2],
  },
  {
    key: 'hooded-fleece-sweatshirt',
    name: 'Hooded Fleece Sweatshirt',
    cat: 'clothing',
    price: R(1499),
    cost: R(640),
    type: 'Sweatshirt',
    short: 'Brushed fleece hoodie for cooler evenings.',
    options: { Size: SIZES },
    stocks: [20, 17, 13, 10],
  },
  {
    key: 'linen-summer-shirt',
    name: 'Linen Summer Shirt',
    cat: 'clothing',
    price: R(1199),
    compare: R(1499),
    cost: R(520),
    type: 'Shirt',
    short: 'Breathable linen-blend shirt for warm days.',
    options: { Size: ['S', 'M', 'L'] },
    stocks: [16, 5, 0],
  },
  {
    key: 'wool-blend-overcoat',
    name: 'Wool Blend Overcoat',
    cat: 'clothing',
    price: R(4599),
    cost: R(2300),
    type: 'Coat',
    short: 'Tailored winter overcoat. Not yet launched.',
    status: 'draft',
    options: { Size: ['S', 'M', 'L'] },
    stocks: [5, 5, 5],
  },
  {
    key: 'wireless-bluetooth-headphones',
    name: 'Wireless Bluetooth Headphones',
    cat: 'audio',
    price: R(3499),
    compare: R(4499),
    cost: R(1750),
    type: 'Headphones',
    short: 'Over-ear ANC headphones with 40-hour battery.',
    options: { Color: COLORS3 },
    stocks: [32, 21, 6],
  },
  {
    key: 'smart-watch',
    name: 'Smart Watch',
    cat: 'electronics',
    price: R(4999),
    cost: R(2600),
    type: 'Wearable',
    short: 'AMOLED display, heart-rate and sleep tracking.',
    options: { Color: ['Black', 'Silver'] },
    stocks: [14, 2],
  },
  {
    key: 'portable-bluetooth-speaker',
    name: 'Portable Bluetooth Speaker',
    cat: 'audio',
    price: R(1999),
    cost: R(900),
    type: 'Speaker',
    short: 'Water-resistant speaker with 12-hour playtime.',
    stock: 34,
  },
  {
    key: 'usb-c-fast-charger',
    name: 'USB-C Fast Charger 65W',
    cat: 'electronics',
    price: R(699),
    cost: R(260),
    type: 'Charger',
    short: 'Compact GaN charger for phones and laptops.',
    stock: 3,
  },
  {
    key: 'mechanical-keyboard',
    name: 'Mechanical Keyboard',
    cat: 'electronics',
    price: R(4499),
    cost: R(2200),
    type: 'Keyboard',
    short: 'Hot-swappable 75% keyboard with tactile switches.',
    stock: 0,
  },
  {
    key: 'minimalist-desk-lamp',
    name: 'Minimalist Desk Lamp',
    cat: 'home-living',
    price: R(1299),
    cost: R(520),
    type: 'Lamp',
    short: 'Dimmable LED lamp with a touch control.',
    stock: 27,
  },
  {
    key: 'ceramic-coffee-mug',
    name: 'Ceramic Coffee Mug',
    cat: 'home-living',
    price: R(399),
    cost: R(130),
    type: 'Mug',
    short: '350 ml glazed stoneware mug.',
    options: { Color: COLORS3 },
    stocks: [60, 44, 38],
  },
  {
    key: 'scented-soy-candle',
    name: 'Scented Soy Candle',
    cat: 'home-living',
    price: R(549),
    cost: R(190),
    type: 'Candle',
    short: 'Hand-poured soy wax candle, 40-hour burn.',
    stock: 4,
  },
  {
    key: 'cotton-throw-blanket',
    name: 'Cotton Throw Blanket',
    cat: 'home-living',
    price: R(1799),
    compare: R(2199),
    cost: R(800),
    type: 'Blanket',
    short: 'Woven cotton throw in a herringbone pattern.',
    stock: 0,
  },
  {
    key: 'leather-wallet',
    name: 'Leather Wallet',
    cat: 'accessories',
    price: R(999),
    cost: R(380),
    type: 'Wallet',
    short: 'Slim bifold wallet in full-grain leather.',
    options: { Color: ['Black', 'Brown'] },
    stocks: [28, 19],
  },
  {
    key: 'laptop-backpack',
    name: 'Laptop Backpack',
    cat: 'accessories',
    price: R(2499),
    compare: R(2999),
    cost: R(1100),
    type: 'Backpack',
    short: 'Water-resistant 25 L backpack with padded laptop sleeve.',
    options: { Color: ['Black', 'Blue', 'Grey'] },
    stocks: [19, 12, 4],
  },
  {
    key: 'polarized-sunglasses',
    name: 'Polarized Sunglasses',
    cat: 'accessories',
    price: R(1499),
    cost: R(520),
    type: 'Sunglasses',
    short: 'UV400 polarized lenses in a lightweight frame.',
    stock: 18,
  },
  {
    key: 'canvas-tote-bag',
    name: 'Canvas Tote Bag',
    cat: 'accessories',
    price: R(499),
    cost: R(160),
    type: 'Bag',
    short: 'Heavy canvas tote with inner pocket.',
    status: 'draft',
    stock: 52,
  },
  {
    key: 'running-shoes',
    name: 'Running Shoes',
    cat: 'footwear',
    price: R(3999),
    compare: R(4999),
    cost: R(1900),
    type: 'Shoes',
    short: 'Cushioned road-running shoes with breathable mesh.',
    options: { Size: SHOE },
    stocks: [10, 14, 16, 12, 7],
  },
  {
    key: 'leather-sneakers',
    name: 'Leather Sneakers',
    cat: 'footwear',
    price: R(3499),
    cost: R(1650),
    type: 'Shoes',
    short: 'Minimal low-top sneakers in smooth leather.',
    options: { Size: SHOE },
    stocks: [6, 9, 11, 5, 0],
  },
  {
    key: 'comfort-sandals',
    name: 'Comfort Sandals',
    cat: 'footwear',
    price: R(999),
    cost: R(380),
    type: 'Sandals',
    short: 'Contoured footbed sandals for all-day wear.',
    options: { Size: SHOE },
    stocks: [13, 15, 18, 9, 3],
  },
  {
    key: 'stainless-steel-water-bottle',
    name: 'Stainless Steel Water Bottle',
    cat: 'sports',
    price: R(599),
    cost: R(210),
    type: 'Bottle',
    short: '750 ml vacuum-insulated bottle, cold 24 hours.',
    options: { Color: COLORS3 },
    stocks: [48, 36, 5],
  },
  {
    key: 'yoga-mat',
    name: 'Yoga Mat',
    cat: 'sports',
    price: R(899),
    cost: R(330),
    type: 'Mat',
    short: '6 mm non-slip TPE yoga mat.',
    stock: 41,
  },
  {
    key: 'resistance-bands-set',
    name: 'Resistance Bands Set',
    cat: 'sports',
    price: R(449),
    cost: R(150),
    type: 'Bands',
    short: 'Five-band set with carry pouch.',
    stock: 2,
  },
  {
    key: 'adjustable-dumbbell-set',
    name: 'Adjustable Dumbbell Set',
    cat: 'sports',
    price: R(3299),
    cost: R(1700),
    type: 'Weights',
    short: 'Pair of adjustable dumbbells up to 20 kg each.',
    status: 'draft',
    stock: 12,
  },
];

const COLLECTIONS: {
  key: string;
  name: string;
  description: string;
  status: 'active' | 'draft';
  products: string[];
}[] = [
  {
    key: 'best-sellers',
    name: 'Best Sellers',
    description: 'What our customers buy most.',
    status: 'active',
    products: [
      'premium-cotton-t-shirt',
      'wireless-bluetooth-headphones',
      'running-shoes',
      'stainless-steel-water-bottle',
      'ceramic-coffee-mug',
      'laptop-backpack',
      'leather-wallet',
    ],
  },
  {
    key: 'new-arrivals',
    name: 'New Arrivals',
    description: 'Fresh in this season.',
    status: 'active',
    products: [
      'smart-watch',
      'linen-summer-shirt',
      'leather-sneakers',
      'portable-bluetooth-speaker',
      'mechanical-keyboard',
      'yoga-mat',
    ],
  },
  {
    key: 'summer-collection',
    name: 'Summer Collection',
    description: 'Light layers and warm-weather gear.',
    status: 'active',
    products: [
      'linen-summer-shirt',
      'premium-cotton-t-shirt',
      'graphic-print-tee',
      'comfort-sandals',
      'polarized-sunglasses',
      'stainless-steel-water-bottle',
    ],
  },
  {
    key: 'featured-products',
    name: 'Featured Products',
    description: 'Hand-picked by the team.',
    status: 'active',
    products: [
      'classic-denim-jacket',
      'minimalist-desk-lamp',
      'smart-watch',
      'running-shoes',
      'laptop-backpack',
    ],
  },
  {
    key: 'discounted-products',
    name: 'Discounted Products',
    description: 'Marked down from the original price.',
    status: 'active',
    products: [
      'premium-cotton-t-shirt',
      'classic-denim-jacket',
      'wireless-bluetooth-headphones',
      'running-shoes',
      'cotton-throw-blanket',
      'linen-summer-shirt',
    ],
  },
  {
    key: 'winter-edit',
    name: 'Winter Edit',
    description: 'Coming soon.',
    status: 'draft',
    products: [
      'wool-blend-overcoat',
      'hooded-fleece-sweatshirt',
      'cotton-throw-blanket',
    ],
  },
];

const FIRST = [
  'Aarav',
  'Diya',
  'Kabir',
  'Meera',
  'Rohan',
  'Ananya',
  'Vikram',
  'Isha',
  'Arjun',
  'Neha',
  'Sameer',
  'Priya',
  'Karan',
  'Tara',
  'Nikhil',
  'Riya',
  'Aditya',
  'Sana',
  'Dev',
  'Pooja',
  'Manish',
  'Zoya',
  'Harsh',
  'Kiara',
  'Yash',
  'Naina',
  'Omar',
  'Leela',
];
const LAST = [
  'Sharma',
  'Iyer',
  'Mehta',
  'Nair',
  'Kapoor',
  'Reddy',
  'Bose',
  'Singh',
  'Patel',
  'Menon',
  'Joshi',
  'Rao',
  'Das',
  'Gupta',
  'Khan',
  'Verma',
  'Pillai',
  'Shah',
  'Malhotra',
  'Chopra',
  'Bhatt',
  'Sethi',
  'Ghosh',
  'Desai',
  'Kulkarni',
  'Banerjee',
  'Saxena',
  'Thakur',
];
const CITIES = [
  'Bengaluru',
  'Mumbai',
  'Delhi',
  'Chennai',
  'Pune',
  'Hyderabad',
  'Kolkata',
  'Jaipur',
];

export const COUNTS = { customers: 28, orders: 46 } as const;

export type DemoPlan = ReturnType<typeof buildDemoPlan>;

export function buildDemoPlan(tenantId: string, userId: string, now: Date) {
  const id = (name: string) => detId(tenantId, name);
  const rand = rng(20260211);
  const t0 = now.getTime();
  const at = (daysAgo: number) => new Date(t0 - daysAgo * DAY);

  const categories = CATEGORIES.map((c, i) => ({
    id: id(`category:${c.key}`),
    tenantId,
    parentId: c.parent ? id(`category:${c.parent}`) : null,
    name: c.name,
    slug: c.key,
    description: c.description,
    createdAt: at(100 - i),
    updatedAt: at(100 - i),
  }));

  const products: Array<Record<string, unknown>> = [];
  const options: Array<Record<string, unknown>> = [];
  const variants: Array<
    Record<string, unknown> & {
      id: string;
      productKey: string;
      quantity: number;
    }
  > = [];
  const catPrefix = (c: string) =>
    c
      .replace(/[^a-z]/g, '')
      .slice(0, 3)
      .toUpperCase();
  PRODUCTS.forEach((p, i) => {
    const productId = id(`product:${p.key}`);
    const created = at(96 - i * 1.5);
    const hasVariants = !!p.options;
    const base = `SF-${catPrefix(p.cat)}-${String(i + 1).padStart(3, '0')}`;
    products.push({
      id: productId,
      tenantId,
      categoryId: id(`category:${p.cat}`),
      name: p.name,
      slug: p.key,
      description: `${p.short}\n\nPart of the Urban Nest everyday range. Demo product with sample data.`,
      shortDescription: p.short,
      productType: p.type,
      sku: hasVariants ? null : base,
      priceMinor: p.price,
      compareAtPriceMinor: p.compare ?? null,
      costMinor: p.cost,
      hasVariants,
      trackInventory: true,
      quantity: hasVariants ? 0 : (p.stock ?? 0),
      lowStockThreshold: p.threshold ?? 5,
      status: p.status ?? 'active',
      createdAt: created,
      updatedAt: new Date(
        Math.min(t0, created.getTime() + (5 + (i % 20)) * DAY),
      ),
    });
    if (!p.options) return;
    Object.entries(p.options).forEach(([name, values], pos) =>
      options.push({
        id: id(`option:${p.key}:${name}`),
        tenantId,
        productId,
        name,
        position: pos,
        values,
      }),
    );
    // Cartesian product of the option values, first option varying slowest.
    let combos: Record<string, string>[] = [{}];
    for (const [name, values] of Object.entries(p.options))
      combos = combos.flatMap((c) => values.map((v) => ({ ...c, [name]: v })));
    combos.forEach((opts, pos) => {
      const title = Object.values(opts).join(' / ');
      variants.push({
        id: id(`variant:${p.key}:${title}`),
        productKey: p.key,
        tenantId,
        productId,
        title,
        options: opts,
        sku: `${base}-${Object.values(opts)
          .join('-')
          .toUpperCase()
          .replace(/[^A-Z0-9-]/g, '')}`,
        priceMinor: p.price,
        compareAtPriceMinor: p.compare ?? null,
        quantity: (p.stocks ?? [10])[pos % (p.stocks ?? [10]).length],
        imageId: null,
        isActive: true,
        position: pos,
        createdAt: created,
        updatedAt: created,
      });
    });
  });

  const collections = COLLECTIONS.map((c, i) => ({
    id: id(`collection:${c.key}`),
    tenantId,
    name: c.name,
    slug: c.key,
    description: c.description,
    imagePath: null,
    status: c.status,
    createdAt: at(80 - i),
    updatedAt: at(80 - i),
  }));
  const collectionProducts = COLLECTIONS.flatMap((c) =>
    c.products.map((pk, position) => ({
      tenantId,
      collectionId: id(`collection:${c.key}`),
      productId: id(`product:${pk}`),
      position,
      createdAt: at(75),
    })),
  );

  // ---- Orders: 46 over the previous 90 days -------------------------------------------------
  type Unit = {
    productKey: string;
    productId: string;
    variantId: string | null;
    name: string;
    sku: string;
    price: number;
  };
  const activeKeys = PRODUCTS.filter((p) => p.status !== 'draft').map(
    (p) => p.key,
  );
  const unitsByProduct = new Map<string, Unit[]>();
  for (const key of activeKeys) {
    const pr = products.find((x) => x.slug === key)!;
    const vs = variants.filter((v) => v.productKey === key);
    unitsByProduct.set(
      key,
      vs.length
        ? vs.map((v) => ({
            productKey: key,
            productId: pr.id as string,
            variantId: v.id,
            name: pr.name as string,
            sku: v.sku as string,
            price: v.priceMinor as number,
          }))
        : [
            {
              productKey: key,
              productId: pr.id as string,
              variantId: null,
              name: pr.name as string,
              sku: pr.sku as string,
              price: pr.priceMinor as number,
            },
          ],
    );
  }
  const weights = activeKeys.map((_, i) => 1 / Math.pow(i + 1, 0.7));
  const wTotal = weights.reduce((a, b) => a + b, 0);
  const pickProduct = () => {
    let r = rand() * wTotal;
    for (let i = 0; i < activeKeys.length; i++)
      if ((r -= weights[i]) <= 0) return activeKeys[i];
    return activeKeys[0];
  };

  const customerNames = FIRST.slice(0, COUNTS.customers).map((f, i) => ({
    first: f,
    last: LAST[(i * 7 + 3) % LAST.length],
  }));
  const orderRows: Array<
    Record<string, unknown> & {
      id: string;
      customerKey: number;
      placedAt: Date;
      status: OrderStatus;
    }
  > = [];
  const items: Array<
    Record<string, unknown> & { orderId: string; unit: Unit; quantity: number }
  > = [];
  for (let n = 1; n <= COUNTS.orders; n++) {
    // Oldest first; the newest order is ~3 hours old so "recent orders" and the 7-day range are populated.
    const daysAgo = Math.max(
      0.1,
      89.5 * (1 - (n - 1) / (COUNTS.orders - 1)) + (rand() - 0.5) * 1.6,
    );
    const placedAt = at(daysAgo);
    const r = rand();
    const status: OrderStatus =
      daysAgo > 14
        ? r < 0.74
          ? 'fulfilled'
          : r < 0.82
            ? 'paid'
            : r < 0.9
              ? 'cancelled'
              : 'refunded'
        : r < 0.35
          ? 'paid'
          : r < 0.62
            ? 'pending'
            : r < 0.92
              ? 'fulfilled'
              : 'cancelled';
    const orderId = id(`order:${n}`);
    const picked = new Set<string>();
    const lines: typeof items = [];
    const lineCount = 1 + Math.floor(rand() * 3);
    for (let l = 0; l < lineCount; l++) {
      const pk = pickProduct();
      const us = unitsByProduct.get(pk)!;
      const unit = us[Math.floor(rand() * us.length)];
      const key = unit.variantId ?? unit.productId;
      if (picked.has(key)) continue;
      picked.add(key);
      const quantity = 1 + Math.floor(rand() * rand() * 3);
      lines.push({
        id: id(`order-item:${n}:${l}`),
        tenantId,
        orderId,
        productId: unit.productId,
        variantId: unit.variantId,
        name: unit.name,
        sku: unit.sku,
        quantity,
        unitPriceMinor: unit.price,
        totalMinor: unit.price * quantity,
        unit,
      });
    }
    const subtotal = lines.reduce((s, l) => s + (l.totalMinor as number), 0);
    orderRows.push({
      id: orderId,
      tenantId,
      customerKey: Math.floor(rand() * COUNTS.customers),
      orderNumber: 1000 + n,
      status,
      currency: DEMO_STORE.currency,
      subtotalMinor: subtotal,
      totalMinor: subtotal,
      placedAt,
      createdAt: placedAt,
    });
    items.push(...lines);
  }

  const firstOrderAt = new Map<number, number>();
  for (const o of orderRows)
    firstOrderAt.set(
      o.customerKey,
      Math.min(
        firstOrderAt.get(o.customerKey) ?? Infinity,
        o.placedAt.getTime(),
      ),
    );
  const customers = customerNames.map((c, i) => {
    const created = new Date(
      Math.min(
        firstOrderAt.get(i) ?? Infinity,
        t0 - (1 + Math.floor(rand() * 85)) * DAY,
      ) -
        Math.floor(rand() * 6) * DAY,
    );
    return {
      id: id(`customer:${i}`),
      tenantId,
      email: `${c.first}.${c.last}@example.com`.toLowerCase(),
      fullName: `${c.first} ${c.last}`,
      phone: `+91 98${String(10000000 + Math.floor(rand() * 89999999))}`,
      notes:
        i % 5 === 0
          ? `Prefers delivery to ${CITIES[i % CITIES.length]}.`
          : null,
      createdAt: created,
      updatedAt: created,
    };
  });

  const orders = orderRows.map(({ customerKey, ...o }) => ({
    ...o,
    customerId: customers[customerKey].id,
  }));

  // ---- Inventory ledger ---------------------------------------------------------------------
  // Per sellable unit: opening restock, a sale per non-cancelled order line, a return per refunded
  // order, then (only if needed) a correction so the ledger ends exactly on the unit's quantity.
  type Ev = {
    at: number;
    delta: number;
    reason: InventoryReason;
    note: string | null;
  };
  const orderById = new Map(orderRows.map((o) => [o.id, o]));
  const unitsAll: {
    productId: string;
    variantId: string | null;
    target: number;
  }[] = [];
  for (const p of products) {
    if (!p.hasVariants)
      unitsAll.push({
        productId: p.id as string,
        variantId: null,
        target: p.quantity as number,
      });
  }
  for (const v of variants)
    unitsAll.push({
      productId: v.productId as string,
      variantId: v.id,
      target: v.quantity,
    });

  const adjustments: Array<Record<string, unknown>> = [];
  for (const u of unitsAll) {
    const evs: Ev[] = [];
    for (const it of items) {
      if (
        (it.variantId ?? null) !== u.variantId ||
        it.productId !== u.productId
      )
        continue;
      const o = orderById.get(it.orderId as string)!;
      if (o.status === 'cancelled') continue;
      evs.push({
        at: o.placedAt.getTime(),
        delta: -it.quantity,
        reason: 'sale',
        note: `Order #${o.orderNumber}`,
      });
      if (o.status === 'refunded')
        evs.push({
          at: Math.min(t0 - 3_600_000, o.placedAt.getTime() + 4 * DAY),
          delta: it.quantity,
          reason: 'return',
          note: `Return for order #${o.orderNumber}`,
        });
    }
    evs.sort((a, b) => a.at - b.at);
    let run = 0;
    let low = 0;
    for (const e of evs) {
      run += e.delta;
      low = Math.min(low, run);
    }
    const opening = Math.max(u.target - run, -low, 1);
    const timeline: Ev[] = [
      {
        at: t0 - 92 * DAY,
        delta: opening,
        reason: 'restock',
        note: 'Opening stock',
      },
      ...evs,
    ];
    let q = 0;
    const rows = timeline.map((e) => ({ ...e, quantityAfter: (q += e.delta) }));
    if (q !== u.target) {
      const delta = u.target - q;
      rows.push({
        at: t0,
        delta,
        reason: 'correction',
        note: 'Cycle count',
        quantityAfter: u.target,
      });
    }
    rows.forEach((e, k) =>
      adjustments.push({
        id: id(`adjustment:${u.variantId ?? u.productId}:${k}`),
        tenantId,
        productId: u.productId,
        variantId: u.variantId,
        delta: e.delta,
        quantityAfter: e.quantityAfter,
        reason: e.reason,
        note: e.note,
        createdBy: userId,
        createdAt: new Date(e.at),
      }),
    );
  }

  return {
    categories,
    collections,
    products,
    options,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip planning-only fields
    variants: variants.map(({ productKey: _k, ...v }) => v),
    collectionProducts,
    customers,
    orders,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip planning-only fields
    orderItems: items.map(({ unit: _u, ...i }) => i),
    adjustments,
  };
}
