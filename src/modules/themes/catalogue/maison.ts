import {
  asset,
  button,
  link,
  node,
  page,
  themeSettings,
  type Child,
  type ThemeDefinition,
} from './dsl.js';
import {
  announcementGroup,
  collectionPage,
  footerGroup,
  headerGroup,
  productPage,
} from './shared.js';

const column = (id: string, title: string, body: string): Child => [
  id,
  node('column', { title, text: body }),
];

const NAV: Child[] = [
  ['nav_home', link('Home', '/')],
  ['nav_shop', link('Shop', '/#products')],
  ['nav_collections', link('Collections', '/collections')],
  ['nav_about', link('About', '/about')],
  ['nav_contact', link('Contact', '/contact')],
];

/**
 * Maison: a boutique theme for stores with several kinds of product. Ivory page, forest-green primary, bronze/gold
 * accents, Cormorant Garamond headlines with Jost body text, pill buttons and square 3:4 product cards.
 *
 * Everything written here is a neutral default the merchant replaces: no store name, no product names, no
 * prices and no reviews. Pictures, names, products and collections always come from the store being shown.
 * `brand.look: 'boutique'` makes the storefront draw the sections with the Boutique look (see the frontend's
 * `components/storefront/engine/looks`).
 */
export const maison: ThemeDefinition = {
  slug: 'maison',
  name: 'Maison',
  description:
    'Boutique theme for stores with a wide range: a forest-green hero panel, picture-led category tiles, refined serif headlines and square 3:4 product cards.',
  industry: 'general',
  version: 1,
  previewImage: '/themes/maison/preview.svg',
  documents: {
    theme_settings: themeSettings({
      brand: { look: 'boutique' },
      colors: {
        primary: '#10362f',
        secondary: '#edf3ef',
        background: '#fcfdfb',
        text: '#10362f',
        accent: '#c19a5b',
        muted: '#63706a',
        border: '#e1e8e3',
      },
      typography: {
        headingFont: 'cormorant-garamond',
        bodyFont: 'jost',
        baseSize: 15,
        headingWeight: 500,
        bodyWeight: 400,
        lineHeight: 1.6,
      },
      layout: { pageWidth: 1536, gridGap: 24 },
      buttons: { radius: 50 },
      social: {},
    }),
    index: page('classic', [
      [
        'hero',
        node(
          'hero',
          {
            variant: 'split',
            alignment: 'left',
            height: 'large',
            heading: 'Chosen with care, made to last',
            subheading:
              'A considered selection from our shelves, put together season by season.',
            image: asset('maison', 'hero.jpg'),
          },
          [
            ['shop', button('Shop the collection', '/#products')],
            ['browse', button('Browse collections', '/collections', 'outline')],
          ],
        ),
      ],
      [
        'categories',
        node('collection-list', {
          eyebrow: 'Shop by category',
          title: 'Find your piece',
          columns: 6,
          showProductCount: true,
        }),
      ],
      [
        'featured',
        node('featured-collection', {
          eyebrow: 'Handpicked',
          title: 'Featured pieces',
          productsToShow: 4,
          columns: 4,
          showViewAll: true,
          tone: 'light',
        }),
      ],
      [
        'promo',
        node('promotional-banner', {
          title: 'The new season edit',
          highlightText:
            'Fresh arrivals and favourites, gathered in one place.',
          link: '/#products',
          backgroundColor: '#e9d6b8',
          textColor: '#10362f',
        }),
      ],
      [
        'arrivals',
        node('featured-collection', {
          eyebrow: 'Just in',
          title: 'New arrivals',
          productsToShow: 4,
          columns: 4,
          showViewAll: true,
          tone: 'dark',
        }),
      ],
      [
        'promises',
        node(
          'multicolumn',
          {
            columns: 4,
            columnAlignment: 'left',
            backgroundColor: '#edf3ef',
          },
          [
            column(
              'c1',
              '01  Considered selection',
              'Every piece is chosen for quality and how long it lasts.',
            ),
            column(
              'c2',
              '02  Careful packing',
              'Wrapped with care so it arrives the way it left us.',
            ),
            column(
              'c3',
              '03  Easy returns',
              'Changed your mind? Tell us and we will make it right.',
            ),
            column(
              'c4',
              '04  Here to help',
              'Questions about an order or a piece? We are one message away.',
            ),
          ],
        ),
      ],
      [
        'reviews',
        node('testimonials', {
          eyebrow: 'Reviews',
          heading: 'What customers say',
          subheading: '',
          columns: 3,
        }),
      ],
      [
        'all',
        node('product-grid', {
          columns: 4,
          productsPerPage: 24,
          accentColor: '#10362f',
        }),
      ],
    ]),
    product: productPage({
      layout: 'classic',
      galleryLayout: 'thumbnails',
      mediaPosition: 'left',
      pickerType: 'pills',
      priceSize: 'medium',
      relatedHeading: 'You may also like',
      relatedColumns: 4,
    }),
    collection: collectionPage('classic', 4, 24, '#10362f'),
    group_header: headerGroup({
      menuAlignment: 'center',
      logoWidth: 140,
      separator: false,
      nav: NAV,
    }),
    group_footer: footerGroup({
      backgroundColor: '#10362f',
      textColor: '#fcfdfb',
      blurb: 'A considered selection, delivered with care.',
      columns: [
        {
          id: 'shop',
          title: 'Shop',
          links: [
            ['All products', '/#products'],
            ['Collections', '/collections'],
            ['Search', '/search'],
          ],
        },
        {
          id: 'help',
          title: 'Help',
          links: [
            ['About', '/about'],
            ['Contact', '/contact'],
          ],
        },
      ],
    }),
    group_announcement: announcementGroup(
      'New pieces added every week',
      '#10362f',
      '#d5e3da',
    ),
  },
};
