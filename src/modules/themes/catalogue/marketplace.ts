import {
  button,
  heading,
  link,
  node,
  page,
  text,
  themeSettings,
  type Child,
  type ThemeDefinition,
} from './dsl.js';
import {
  announcementGroup,
  collectionPage,
  footerGroup,
  headerGroup,
} from './shared.js';
import {
  marketplaceAboutPage,
  marketplaceContactPage,
} from './marketplace-pages.js';

const column = (id: string, title: string, body: string): Child => [
  id,
  node('column', { title, text: body }),
];

const slide = (
  id: string,
  title: string,
  sub: string,
  label: string,
  to: string,
): Child => [
  id,
  node('hero-slide', {
    mediaType: 'image',
    heading: title,
    subheading: sub,
    buttonLabel: label,
    link: to,
  }),
];

const NAV: Child[] = [
  ['nav_shop', link('Shop', '/products')],
  ['nav_collections', link('Categories', '/collections')],
  ['nav_about', link('About', '/about')],
  ['nav_contact', link('Contact', '/contact')],
  [
    'nav_cta',
    node('button', {
      label: "Today's picks",
      link: '/products',
      style: 'primary',
    }),
  ],
];

/**
 * Marketplace: a dense, shop-first theme. Light grey page, dark ink header and footer, a teal primary action and an orange
 * "buy" action, small corners, white bordered panels, horizontally scrolling product shelves, a filter panel on listings and
 * a three-column product page with a buy box.
 *
 * Everything written here is a neutral default the merchant replaces: no store name, no product names, no prices, no
 * reviews and no business facts. The hero is drawn in the theme colours when a slide has no picture. Pictures, names,
 * products and collections always come from the store being shown. `brand.look: 'market'` makes the storefront draw it
 * with the Market look.
 */
export const marketplace: ThemeDefinition = {
  slug: 'marketplace',
  name: 'Marketplace',
  description:
    'Shop-first marketplace theme: a dark header with a wide search bar, a banner hero, category shortcuts, scrolling product shelves, a filter panel on listings and a three-column product page with a buy box.',
  industry: 'general',
  version: 2,
  previewImage: '/themes/marketplace/preview.svg',
  documents: {
    theme_settings: themeSettings({
      brand: { look: 'market' },
      colors: {
        primary: '#0d1420',
        secondary: '#106762',
        background: '#f6f7f9',
        text: '#1b2435',
        accent: '#ff5a17',
        muted: '#65738d',
        border: '#d5dae3',
      },
      typography: {
        headingFont: 'plus-jakarta-sans',
        bodyFont: 'inter',
        baseSize: 15,
        headingWeight: 700,
        bodyWeight: 400,
        lineHeight: 1.5,
      },
      layout: { pageWidth: 1560, gridGap: 12 },
      buttons: { radius: 8 },
      social: {},
      // Designed About and Contact pages, shown at /about and /contact unless the store writes its own under Pages.
      pages: {
        about: { ...marketplaceAboutPage() },
        contact: { ...marketplaceContactPage() },
      },
    }),
    index: page('classic', [
      [
        'hero',
        node(
          'hero',
          {
            variant: 'banner',
            alignment: 'left',
            height: 'medium',
            eyebrow: 'Just in',
          },
          [
            slide(
              'slide1',
              'Everything you need, in one place',
              'Browse the full range, compare prices and check out in a few taps.',
              'Shop now',
              '/products',
            ),
            slide(
              'slide2',
              'New arrivals, added every week',
              'Fresh products from every category, ready to order.',
              'See what is new',
              '/products',
            ),
            ['cta', button('Browse categories', '/collections', 'outline')],
          ],
        ),
      ],
      [
        'shortcuts',
        node('collection-list', {
          title: '',
          layout: 'auto',
          columns: 6,
          showViewAll: false,
          showProductCount: false,
        }),
      ],
      [
        'deals',
        node('featured-collection', {
          title: 'Top picks',
          eyebrow: 'Handpicked for you',
          productsToShow: 10,
          columns: 5,
          showViewAll: true,
          tone: 'dark',
        }),
      ],
      [
        'arrivals',
        node('featured-collection', {
          title: 'New arrivals',
          productsToShow: 10,
          columns: 5,
          showViewAll: true,
          tone: 'light',
        }),
      ],
      [
        'categories',
        node('collection-list', {
          title: 'Shop by category',
          eyebrow: 'Find what you are looking for',
          layout: 'grid',
          columns: 4,
          showViewAll: true,
          showProductCount: true,
        }),
      ],
      [
        'trending',
        node('featured-collection', {
          title: 'Trending this week',
          eyebrow: 'Most looked at right now',
          productsToShow: 10,
          columns: 5,
          showViewAll: true,
          tone: 'light',
        }),
      ],
      [
        'bulk',
        node(
          'promotional-banner',
          {
            title: 'Buying in bulk',
            highlightText: '',
            link: '/contact',
            backgroundColor: '#106762',
            textColor: '#ffffff',
          },
          [
            ['h', heading('Supplying shops, teams and businesses.')],
            [
              't',
              text(
                'Tell us what you need, with quantities and any details, and we will come back to you with a quotation.',
              ),
            ],
            ['cta', button('Request a quote', '/contact', 'primary')],
            column('s1', 'Browse', 'Pick the products you are interested in.'),
            column('s2', 'Specify', 'Share quantities and any details.'),
            column('s3', 'Review', 'Our team looks over your request.'),
            column('s4', 'Quotation', 'We reply with pricing and delivery.'),
          ],
        ),
      ],
    ]),
    product: page('classic', [
      [
        'main',
        node(
          'main-product',
          { galleryLayout: 'thumbnails', mediaPosition: 'left' },
          [
            [
              'title',
              node('product-title', { level: 'h1', alignment: 'left' }),
            ],
            [
              'price',
              node('product-price', { showCompareAt: true, textSize: 'large' }),
            ],
            [
              'variants',
              node('variant-picker', {
                pickerType: 'pills',
                showSku: true,
                showInventory: false,
              }),
            ],
            [
              'description',
              node('product-description', { truncate: false, maxLines: 5 }),
            ],
            [
              'delivery',
              node('collapsible-info', {
                title: 'Delivery and returns',
                content:
                  'Delivery details are confirmed at checkout. If something is not right, contact us and we will make it right.',
                icon: 'truck',
              }),
            ],
            [
              'support',
              node('collapsible-info', {
                title: 'Questions?',
                content:
                  'Use the contact page and we will get back to you as soon as we can.',
                icon: 'help',
              }),
            ],
          ],
        ),
      ],
      [
        'related',
        node('related-products', {
          heading: 'More to explore',
          productsToShow: 10,
          columns: 5,
        }),
      ],
    ]),
    collection: collectionPage('classic', 4, 24, '#106762'),
    group_header: headerGroup({
      menuAlignment: 'left',
      logoWidth: 140,
      nav: NAV,
    }),
    group_footer: footerGroup({
      backgroundColor: '#0d1420',
      textColor: '#ffffff',
      blurb: 'Everything you need, in one place.',
      columns: [
        {
          id: 'shop',
          title: 'Shop',
          links: [
            ['All products', '/products'],
            ['All categories', '/collections'],
            ['Search', '/search'],
            ['Wishlist', '/wishlist'],
          ],
        },
        {
          id: 'help',
          title: 'Support',
          links: [
            ['About', '/about'],
            ['Contact', '/contact'],
            ['Your cart', '/cart'],
          ],
        },
      ],
    }),
    group_announcement: announcementGroup(
      'New products added every week',
      '#106762',
      '#ffffff',
    ),
  },
};
