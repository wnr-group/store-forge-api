import {
  asset,
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
import { strideAboutPage, strideContactPage } from './stride-pages.js';

const column = (id: string, title: string, body: string): Child => [
  id,
  node('column', { title, text: body }),
];

const slide = (
  id: string,
  file: string,
  title: string,
  sub: string,
  label: string,
  to: string,
): Child => [
  id,
  node('hero-slide', {
    mediaType: 'image',
    image: asset('stride', file),
    heading: title,
    subheading: sub,
    buttonLabel: label,
    link: to,
  }),
];

const faq = (id: string, question: string, answer: string): Child => [
  id,
  node('collapsible-item', { heading: question, content: answer }),
];

const NAV: Child[] = [
  ['nav_shop', link('Shop', '/products')],
  ['nav_collections', link('Collections', '/collections')],
  ['nav_about', link('About', '/about')],
  ['nav_contact', link('Contact', '/contact')],
  [
    'nav_cta',
    node('button', { label: 'Enquiry', link: '/contact', style: 'primary' }),
  ],
];

/**
 * Stride: a sportswear and activewear theme. White page, navy primary, yellow accent, indigo secondary, heavy slanted capitals,
 * pill controls, rounded 4:5 product cards, a sliding hero, a hover mega menu and a filter sidebar on listings.
 *
 * Everything written here is a neutral default the merchant replaces: no store name, no product names, no prices, no
 * reviews and no business facts. The hero art is original (stripes in the theme colours). Pictures, names, products and
 * collections always come from the store being shown. `brand.look: 'sport'` makes the storefront draw it with the Sport look.
 *
 * Text conventions the Sport look understands in an "image with text" section: a line starting with "• " is a ruled bullet,
 * "Value | text" is a big-number row, "Title :: text" is a row with an icon, and {{words}} in a heading are coloured.
 */
export const stride: ThemeDefinition = {
  slug: 'stride',
  name: 'Stride',
  description:
    'Sportswear and activewear theme: a sliding full-screen hero, slanted capital headlines, rounded product cards, a hover mega menu and a filter sidebar on product listings.',
  industry: 'fashion',
  version: 2,
  previewImage: '/themes/stride/preview.svg',
  documents: {
    theme_settings: themeSettings({
      brand: { look: 'sport' },
      colors: {
        primary: '#0d1033',
        secondary: '#272f86',
        background: '#ffffff',
        text: '#0d1033',
        accent: '#fbc826',
        muted: '#5d627d',
        border: '#e3e5ef',
      },
      typography: {
        headingFont: 'archivo',
        bodyFont: 'plus-jakarta-sans',
        baseSize: 16,
        headingWeight: 800,
        bodyWeight: 400,
        lineHeight: 1.6,
      },
      layout: { pageWidth: 1720, gridGap: 24 },
      buttons: { radius: 50 },
      social: {},
      // Designed About and Contact pages, shown at /about and /contact unless the store writes its own under Pages.
      pages: {
        about: { ...strideAboutPage() },
        contact: { ...strideContactPage() },
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
            height: 'fullscreen',
            eyebrow: '',
          },
          [
            slide(
              'slide1',
              'hero-1.svg',
              'Built to move. Made to last.',
              'Everyday activewear for training, travel and time off.',
              'Shop the range',
              '/products',
            ),
            slide(
              'slide2',
              'hero-2.svg',
              'Train hard. Rest easy.',
              'Comfortable cuts and fabrics that keep up with you.',
              'See what is new',
              '/products',
            ),
            slide(
              'slide3',
              'hero-3.svg',
              'Find your fit. Own your day.',
              'Sizes and styles for the whole family.',
              'Browse collections',
              '/collections',
            ),
            ['cta', button('Get in touch', '/contact', 'outline')],
          ],
        ),
      ],
      [
        'range',
        node('collection-list', {
          title: 'Explore the range',
          layout: 'auto',
          columns: 6,
          showViewAll: true,
          showProductCount: false,
        }),
      ],
      [
        'categories',
        node('collection-list', {
          title: 'Shop by category',
          layout: 'grid',
          columns: 4,
          showViewAll: false,
          showProductCount: false,
        }),
      ],
      [
        'launches',
        node('featured-collection', {
          title: 'Our new launches',
          productsToShow: 4,
          columns: 4,
          showViewAll: true,
          tone: 'light',
        }),
      ],
      [
        'promise',
        node(
          'image-with-text',
          {
            variant: 'panel',
            image: asset('stride', 'art-1.svg'),
            eyebrow: 'Our promise',
            imagePosition: 'right',
            imageWidth: 'medium',
            uppercaseHeading: true,
          },
          [
            ['h', heading('Accomplish great things')],
            ['b1', text('• Activewear for every day')],
            ['b2', text('• Fabrics chosen for comfort and durability')],
            ['b3', text('• Checked with care before it ships')],
            ['cta', button('Shop the range', '/products', 'primary')],
          ],
        ),
      ],
      [
        'story',
        node(
          'image-with-text',
          {
            variant: 'plain',
            image: asset('stride', 'art-2.svg'),
            eyebrow: 'Our story',
            imagePosition: 'left',
            imageWidth: 'medium',
            uppercaseHeading: true,
          },
          [
            ['h', heading('Made with care, worn with pride')],
            [
              'p',
              text(
                'We make everyday clothing for people who keep moving, and we look closely at every piece before it leaves us.',
              ),
            ],
            ['s1', text('Fabric | Soft, breathable and made to last')],
            ['s2', text('Fit | Easy cuts that move with you')],
            ['s3', text('Care | Washes well and keeps its shape')],
            ['cta', button('Read our story', '/about', 'primary')],
          ],
        ),
      ],
      [
        'closer',
        node(
          'multicolumn',
          {
            eyebrow: 'In detail',
            heading: 'Look closer\nat the cloth.',
            columns: 3,
            columnAlignment: 'left',
          },
          [
            column(
              'c1',
              'Drawcord waistband',
              'A soft waist with a drawcord, set in for a secure fit.',
            ),
            column(
              'c2',
              'Textured knit',
              'A raised surface knitted into the cloth, with a soft hand.',
            ),
            column(
              'c3',
              'Contrast trim',
              'Trimmed at the collar and cuffs for a clean finish.',
            ),
          ],
        ),
      ],
      [
        'quality',
        node(
          'image-with-text',
          {
            variant: 'plain',
            image: asset('stride', 'art-3.svg'),
            imagePosition: 'right',
            imageWidth: 'medium',
            uppercaseHeading: false,
          },
          [
            [
              'h',
              heading(
                'Good-quality wearables, and an {{unforgettable wearing experience.}}',
              ),
            ],
            [
              'f1',
              text(
                'Quality policy :: We check every piece before it ships so it arrives the way it should.',
              ),
            ],
            [
              'f2',
              text(
                'Replacement policy :: If something is not right, tell us and we will make it right.',
              ),
            ],
            ['cta', button('About us', '/about', 'outline')],
          ],
        ),
      ],
      [
        'edit',
        node('collection-list', {
          title: 'The studio edit',
          layout: 'editorial',
          columns: 4,
          showViewAll: true,
          showProductCount: false,
        }),
      ],
      [
        'faq',
        node(
          'collapsible-content',
          {
            eyebrow: 'Good to know',
            heading: 'Questions, answered.',
            subheading: '',
            ctaLabel: 'Ask us directly',
            ctaLink: '/contact',
            openFirstItem: false,
          },
          [
            faq(
              'q1',
              'Can I buy a single piece online?',
              'Yes. Add it to your bag and check out when you are ready.',
            ),
            faq(
              'q2',
              'How do I choose my size?',
              'Open a product to see its sizes and options, or contact us and we will help you pick.',
            ),
            faq(
              'q3',
              'What if something is not right?',
              'Tell us and we will make it right.',
            ),
            faq(
              'q4',
              'How can I reach you?',
              'Use the contact page and we will get back to you.',
            ),
          ],
        ),
      ],
      [
        'bulk',
        node(
          'promotional-banner',
          {
            title: 'Bulk orders',
            highlightText: '',
            link: '/contact',
            backgroundColor: '#272f86',
            textColor: '#ffffff',
          },
          [
            ['h', heading('Supplying teams, shops and clubs.')],
            [
              't',
              text(
                'Tell us what you need, with quantities, sizes and colours, and we will come back to you with a quotation.',
              ),
            ],
            ['cta', button('Request a quote', '/contact', 'primary')],
            column('s1', 'Browse', 'Pick the products you are interested in.'),
            column('s2', 'Specify', 'Share quantities, sizes and colours.'),
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
              'quality',
              node('collapsible-info', {
                title: 'Quality promise',
                content: 'We look closely at every piece before it ships.',
                icon: 'shield',
              }),
            ],
          ],
        ),
      ],
      [
        'related',
        node('related-products', {
          heading: 'More to explore',
          productsToShow: 4,
          columns: 4,
        }),
      ],
    ]),
    collection: collectionPage('classic', 4, 24, '#0d1033'),
    group_header: headerGroup({
      menuAlignment: 'center',
      logoWidth: 150,
      nav: NAV,
    }),
    group_footer: footerGroup({
      backgroundColor: '#0d1033',
      textColor: '#ffffff',
      blurb: 'Activewear for every day.',
      columns: [
        {
          id: 'shop',
          title: 'Shop',
          links: [
            ['All products', '/products'],
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
      'New styles added every week',
      '#0d1033',
      '#ffffff',
    ),
  },
};
