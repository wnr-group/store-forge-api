import {
  button,
  heading,
  link,
  node,
  page,
  text,
  type Child,
  type PageDocument,
} from './dsl.js';

const NAV: Child[] = [
  ['nav_home', link('Home', '/')],
  ['nav_shop', link('Shop', '/#products')],
  ['nav_about', link('About', '/about')],
  ['nav_contact', link('Contact', '/contact')],
];

export interface HeaderOptions {
  menuAlignment: 'left' | 'center' | 'right';
  logoWidth: number;
  sticky?: boolean;
  separator?: boolean;
  nav?: Child[];
}

/** The store-wide header group: the main header only; the announcement bar is its own shared document. */
export function headerGroup(o: HeaderOptions): PageDocument {
  return page('classic', [
    [
      'header',
      node(
        'header',
        {
          logoWidth: o.logoWidth,
          menuAlignment: o.menuAlignment,
          sticky: o.sticky ?? true,
          showSeparator: o.separator ?? true,
        },
        o.nav ?? NAV,
      ),
    ],
  ]);
}

export interface FooterOptions {
  backgroundColor: string;
  textColor: string;
  blurb: string;
  columns: { id: string; title: string; links: [string, string][] }[];
  payments?: boolean;
}

export function footerGroup(o: FooterOptions): PageDocument {
  const children: Child[] = [
    ['about', text(o.blurb)],
    ...o.columns.map((c): Child => [
      c.id,
      node(
        'link-column',
        { title: c.title },
        c.links.map(([label, url], i): Child => [
          `${c.id}_${i}`,
          link(label, url),
        ]),
      ),
    ]),
  ];
  return page('classic', [
    [
      'footer',
      node(
        'footer',
        {
          backgroundColor: o.backgroundColor,
          textColor: o.textColor,
          copyrightText: '',
          showPaymentIcons: o.payments ?? false,
          showSocial: true,
        },
        children,
      ),
    ],
  ]);
}

export function announcementGroup(
  message: string,
  bg: string,
  fg: string,
): PageDocument {
  return page('classic', [
    [
      'announcement',
      node('announcement-bar', {
        text: message,
        link: '',
        backgroundColor: bg,
        textColor: fg,
        showSocial: false,
        alignment: 'center',
      }),
    ],
  ]);
}

export interface ProductPageOptions {
  layout: 'classic' | 'spotlight';
  galleryLayout: 'thumbnails' | 'stacked';
  mediaPosition: 'left' | 'right';
  pickerType: 'pills' | 'dropdown';
  priceSize: 'small' | 'medium' | 'large';
  relatedHeading: string;
  relatedColumns: number;
  truncateDescription?: boolean;
}

/** The product page every theme needs; the options give each theme its own gallery, picker and price treatment. */
export function productPage(o: ProductPageOptions): PageDocument {
  return page(o.layout, [
    [
      'main',
      node(
        'main-product',
        { galleryLayout: o.galleryLayout, mediaPosition: o.mediaPosition },
        [
          ['title', node('product-title', { level: 'h1', alignment: 'left' })],
          [
            'price',
            node('product-price', {
              showCompareAt: true,
              textSize: o.priceSize,
            }),
          ],
          [
            'variants',
            node('variant-picker', {
              pickerType: o.pickerType,
              showSku: true,
              showInventory: false,
            }),
          ],
          [
            'description',
            node('product-description', {
              truncate: o.truncateDescription ?? false,
              maxLines: 5,
            }),
          ],
        ],
      ),
    ],
    [
      'related',
      node('related-products', {
        heading: o.relatedHeading,
        productsToShow: o.relatedColumns,
        columns: o.relatedColumns,
      }),
    ],
  ]);
}

export function collectionPage(
  layout: 'classic' | 'spotlight',
  columns: number,
  perPage: number,
  accent: string,
): PageDocument {
  return page(layout, [
    [
      'banner',
      node('collection-banner', {
        showCollectionDescription: true,
        showCollectionImage: true,
      }),
    ],
    [
      'products',
      node('product-grid', {
        columns,
        productsPerPage: perPage,
        accentColor: accent,
      }),
    ],
  ]);
}

export { button, heading, text };
