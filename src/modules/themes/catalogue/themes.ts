import {
  asset,
  button,
  heading,
  node,
  text,
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

const testimonial = (
  id: string,
  quote: string,
  author: string,
  role: string,
): Child => [id, node('testimonial', { quote, author, role })];

const column = (id: string, title: string, body: string): Child => [
  id,
  node('column', { title, text: body }),
];

const social = {};

// ---------------------------------------------------------------------------------------------------------------
// 1. Fashion & Apparel: editorial, serif headings, full-bleed campaign hero, square corners.
// ---------------------------------------------------------------------------------------------------------------
export const fashion: ThemeDefinition = {
  slug: 'atelier',
  name: 'Atelier',
  description:
    'Editorial fashion theme with a full-bleed campaign hero, serif headlines, square corners and a brand story.',
  industry: 'fashion',
  version: 2,
  previewImage: '/themes/atelier/preview.svg',
  documents: {
    theme_settings: themeSettings({
      colors: {
        primary: '#171717',
        secondary: '#6b6258',
        background: '#faf7f2',
        text: '#1c1917',
        accent: '#9a3412',
        muted: '#a8a29e',
        border: '#e7e0d6',
      },
      typography: {
        headingFont: 'manrope',
        bodyFont: 'dm-sans',
        baseSize: 16,
        headingWeight: 600,
        bodyWeight: 400,
        lineHeight: 1.6,
      },
      layout: { pageWidth: 1440, gridGap: 20 },
      buttons: { radius: 0 },
      social,
    }),
    index: page('spotlight', [
      [
        'campaign',
        node(
          'hero',
          {
            variant: 'banner',
            alignment: 'left',
            height: 'large',
            overlay: 30,
            heading: 'The Autumn Edit',
            subheading:
              'Considered pieces in natural fabrics, made to be worn for years.',
            accentColor: '#9a3412',
            image: asset('atelier', 'hero.jpg'),
          },
          [['cta', button('Shop the edit', '/#products')]],
        ),
      ],
      [
        'categories',
        node('collection-list', {
          title: 'Shop by category',
          layout: 'editorial',
          columns: 3,
          showProductCount: false,
        }),
      ],
      [
        'arrivals',
        node('featured-collection', {
          title: 'New arrivals',
          productsToShow: 8,
          columns: 4,
          showViewAll: true,
        }),
      ],
      [
        'story',
        node(
          'image-with-text',
          {
            image: asset('atelier', 'story.svg'),
            imagePosition: 'left',
            imageWidth: 'medium',
          },
          [
            ['h', heading('Made slowly, worn often', 'h2')],
            [
              't',
              text(
                'We work with small workshops and keep every run short, so each piece is made with care and nothing is wasted.',
              ),
            ],
            ['b', button('Our story', '/about', 'outline')],
          ],
        ),
      ],
      [
        'sale',
        node('promotional-banner', {
          title: 'Season sale',
          highlightText: 'Up to 30% off',
          link: '/#products',
          backgroundColor: '#1c1917',
          textColor: '#faf7f2',
        }),
      ],
      [
        'press',
        node(
          'testimonials',
          { heading: 'In their words', subheading: '', columns: 3 },
          [
            testimonial(
              't1',
              'The fit and the fabric are exactly what I had hoped for.',
              'Meera K.',
              'Customer',
            ),
            testimonial(
              't2',
              'Arrived beautifully packed and has already become a favourite.',
              'Rohan S.',
              'Customer',
            ),
            testimonial(
              't3',
              'Quality that feels honest. I keep coming back.',
              'Anika D.',
              'Customer',
            ),
          ],
        ),
      ],
    ]),
    product: productPage({
      layout: 'spotlight',
      galleryLayout: 'stacked',
      mediaPosition: 'left',
      pickerType: 'pills',
      priceSize: 'medium',
      relatedHeading: 'Complete the look',
      relatedColumns: 4,
    }),
    collection: collectionPage('spotlight', 4, 12, '#9a3412'),
    group_header: headerGroup({
      menuAlignment: 'center',
      logoWidth: 140,
    }),
    group_footer: footerGroup({
      backgroundColor: '#1c1917',
      textColor: '#faf7f2',
      blurb: 'Considered clothing, made slowly.',
      columns: [
        {
          id: 'shop',
          title: 'Shop',
          links: [
            ['New arrivals', '/#products'],
            ['All products', '/#products'],
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
      'Complimentary shipping on orders above ₹1,999',
      '#1c1917',
      '#faf7f2',
    ),
  },
};

// ---------------------------------------------------------------------------------------------------------------
// 2. Electronics & Gadgets: product-first, spec columns, best sellers, brand strip.
// ---------------------------------------------------------------------------------------------------------------
export const electronics: ThemeDefinition = {
  slug: 'voltage',
  name: 'Voltage',
  description:
    'Technology-focused theme: product hero, spec highlights, best sellers, promo banners and a brand strip.',
  industry: 'electronics',
  version: 2,
  previewImage: '/themes/voltage/preview.svg',
  documents: {
    theme_settings: themeSettings({
      colors: {
        primary: '#2563eb',
        secondary: '#475569',
        background: '#f8fafc',
        text: '#0f172a',
        accent: '#0891b2',
        muted: '#94a3b8',
        border: '#dbe3ee',
      },
      typography: {
        headingFont: 'manrope',
        bodyFont: 'inter',
        baseSize: 16,
        headingWeight: 800,
        bodyWeight: 400,
        lineHeight: 1.5,
      },
      layout: { pageWidth: 1360, gridGap: 24 },
      buttons: { radius: 8 },
      social,
    }),
    index: page('classic', [
      [
        'hero',
        node(
          'hero',
          {
            variant: 'split',
            alignment: 'left',
            height: 'medium',
            heading: 'Built for what is next',
            subheading:
              'Phones, audio and smart-home essentials, tested and ready to ship.',
            accentColor: '#2563eb',
            image: asset('voltage', 'hero.svg'),
          },
          [['cta', button('Shop devices', '/#products')]],
        ),
      ],
      [
        'why',
        node(
          'multicolumn',
          { columns: 4, columnAlignment: 'left', backgroundColor: '#ffffff' },
          [
            column(
              'c1',
              'Genuine products',
              'Sourced from authorised distributors.',
            ),
            column('c2', 'Warranty included', 'Every device is covered.'),
            column('c3', 'Fast dispatch', 'Orders leave within 24 hours.'),
            column('c4', 'Easy returns', 'Seven days, no questions.'),
          ],
        ),
      ],
      [
        'best',
        node('featured-collection', {
          title: 'Best sellers',
          productsToShow: 8,
          columns: 4,
          showViewAll: true,
        }),
      ],
      [
        'promo',
        node('promotional-banner', {
          title: 'Trade-in offer',
          highlightText: 'Save up to ₹10,000',
          link: '/#products',
          backgroundColor: '#0f172a',
          textColor: '#f8fafc',
        }),
      ],
      [
        'spotlight',
        node(
          'image-with-text',
          {
            image: asset('voltage', 'spotlight.svg'),
            imagePosition: 'right',
            imageWidth: 'medium',
          },
          [
            ['h', heading('Studio-grade sound', 'h2')],
            [
              't',
              text(
                'Active noise cancelling, 40-hour battery and multipoint pairing in one pair of headphones.',
              ),
            ],
            ['b', button('See specs', '/#products', 'secondary')],
          ],
        ),
      ],
      [
        'faq',
        node(
          'collapsible-content',
          { heading: 'Questions', subheading: '', openFirstItem: true },
          [
            [
              'q1',
              node('collapsible-item', {
                heading: 'Is there a warranty?',
                content: 'Yes. Every device carries the manufacturer warranty.',
              }),
            ],
            [
              'q2',
              node('collapsible-item', {
                heading: 'How fast is delivery?',
                content:
                  'Most orders arrive within three to five working days.',
              }),
            ],
          ],
        ),
      ],
    ]),
    product: productPage({
      layout: 'classic',
      galleryLayout: 'thumbnails',
      mediaPosition: 'left',
      pickerType: 'pills',
      priceSize: 'large',
      relatedHeading: 'Works well with',
      relatedColumns: 4,
    }),
    collection: collectionPage('classic', 4, 16, '#2563eb'),
    group_header: headerGroup({
      menuAlignment: 'left',
      logoWidth: 120,
    }),
    group_footer: footerGroup({
      backgroundColor: '#0f172a',
      textColor: '#e2e8f0',
      blurb: 'Genuine electronics with warranty and fast delivery.',
      payments: true,
      columns: [
        {
          id: 'shop',
          title: 'Shop',
          links: [
            ['All products', '/#products'],
            ['Best sellers', '/#products'],
          ],
        },
        {
          id: 'support',
          title: 'Support',
          links: [
            ['Contact', '/contact'],
            ['About', '/about'],
          ],
        },
      ],
    }),
    group_announcement: announcementGroup(
      'Free delivery on orders over ₹999 · 7-day returns',
      '#0f172a',
      '#f8fafc',
    ),
  },
};

// ---------------------------------------------------------------------------------------------------------------
// 3. Beauty & Cosmetics: soft palette, rounded buttons, category tiles, rituals and reviews.
// ---------------------------------------------------------------------------------------------------------------
export const beauty: ThemeDefinition = {
  slug: 'lumiere',
  name: 'Lumière',
  description:
    'Premium beauty theme with soft tones, rounded buttons, category tiles, a ritual story and reviews.',
  industry: 'beauty',
  version: 2,
  previewImage: '/themes/lumiere/preview.svg',
  documents: {
    theme_settings: themeSettings({
      colors: {
        primary: '#9d4a5b',
        secondary: '#7a6262',
        background: '#fdf8f6',
        text: '#3b2a2a',
        accent: '#b9855a',
        muted: '#b8a5a5',
        border: '#f0e2dd',
      },
      typography: {
        headingFont: 'system-serif',
        bodyFont: 'inter',
        baseSize: 16,
        headingWeight: 400,
        bodyWeight: 400,
        lineHeight: 1.7,
      },
      layout: { pageWidth: 1280, gridGap: 28 },
      buttons: { radius: 50 },
      social,
    }),
    index: page('spotlight', [
      [
        'hero',
        node(
          'hero',
          {
            variant: 'banner',
            alignment: 'center',
            height: 'medium',
            textTone: 'dark',
            overlay: 0,
            heading: 'Skin that feels like you',
            subheading: 'Gentle formulas for a calm, glowing routine.',
            accentColor: '#9d4a5b',
            image: asset('lumiere', 'hero.svg'),
          },
          [['cta', button('Discover skincare', '/#products')]],
        ),
      ],
      [
        'ritual',
        node(
          'image-with-text',
          {
            image: asset('lumiere', 'ritual.svg'),
            imagePosition: 'right',
            imageWidth: 'medium',
          },
          [
            ['h', heading('A ritual in three steps', 'h2')],
            [
              't',
              text(
                'Cleanse, treat and protect. Simple steps, proven ingredients.',
              ),
            ],
            ['b', button('Build your routine', '/#products', 'outline')],
          ],
        ),
      ],
      [
        'categories',
        node('collection-list', {
          title: 'Shop by concern',
          columns: 4,
          showProductCount: false,
        }),
      ],
      [
        'best',
        node('featured-collection', {
          title: 'Bestsellers',
          productsToShow: 8,
          columns: 4,
          showViewAll: true,
        }),
      ],
      [
        'reviews',
        node(
          'testimonials',
          { heading: 'Loved by our customers', subheading: '', columns: 3 },
          [
            testimonial(
              't1',
              'My skin has never felt so calm.',
              'Ishita R.',
              'Verified buyer',
            ),
            testimonial(
              't2',
              'Gentle, lightweight and it really works.',
              'Neha P.',
              'Verified buyer',
            ),
            testimonial(
              't3',
              'The packaging is lovely and the results are better.',
              'Tara M.',
              'Verified buyer',
            ),
          ],
        ),
      ],
      [
        'offer',
        node('promotional-banner', {
          title: 'Welcome gift',
          highlightText: 'Free mini with your first order',
          link: '/#products',
          backgroundColor: '#9d4a5b',
          textColor: '#ffffff',
        }),
      ],
    ]),
    product: productPage({
      layout: 'spotlight',
      galleryLayout: 'thumbnails',
      mediaPosition: 'right',
      pickerType: 'pills',
      priceSize: 'medium',
      relatedHeading: 'Pairs beautifully with',
      relatedColumns: 4,
    }),
    collection: collectionPage('spotlight', 3, 12, '#9d4a5b'),
    group_header: headerGroup({
      menuAlignment: 'center',
      logoWidth: 130,
      separator: false,
    }),
    group_footer: footerGroup({
      backgroundColor: '#9d4a5b',
      textColor: '#3b2a2a',
      blurb: 'Gentle skincare and cosmetics, made with care.',
      columns: [
        {
          id: 'shop',
          title: 'Shop',
          links: [
            ['Skincare', '/#products'],
            ['Makeup', '/#products'],
          ],
        },
        {
          id: 'care',
          title: 'Care',
          links: [
            ['About', '/about'],
            ['Contact', '/contact'],
          ],
        },
      ],
    }),
    group_announcement: announcementGroup(
      'Free shipping over ₹799 · Free samples with every order',
      '#f3dfd9',
      '#3b2a2a',
    ),
  },
};

// ---------------------------------------------------------------------------------------------------------------
// 4. Home & Furniture: lifestyle banners, rooms, alternating image and text.
// ---------------------------------------------------------------------------------------------------------------
export const furniture: ThemeDefinition = {
  slug: 'haven',
  name: 'Haven',
  description:
    'Lifestyle furniture theme with a large room banner, shop-by-room tiles and alternating editorial blocks.',
  industry: 'home',
  version: 3,
  previewImage: '/themes/haven/preview.svg',
  documents: {
    theme_settings: themeSettings({
      colors: {
        primary: '#3f5d45',
        secondary: '#6f6a60',
        background: '#f6f3ee',
        text: '#2b2a28',
        accent: '#c08552',
        muted: '#a39e92',
        border: '#e4ded3',
      },
      typography: {
        headingFont: 'manrope',
        bodyFont: 'inter',
        baseSize: 17,
        headingWeight: 600,
        bodyWeight: 400,
        lineHeight: 1.65,
      },
      layout: { pageWidth: 1360, gridGap: 32 },
      buttons: { radius: 4 },
      social,
    }),
    index: page('classic', [
      [
        'banner',
        node(
          'hero',
          {
            variant: 'banner',
            alignment: 'left',
            height: 'large',
            overlay: 35,
            heading: 'Rooms made to be lived in',
            subheading: 'Solid wood furniture, delivered and assembled.',
            accentColor: '#c08552',
            image: asset('haven', 'hero-1.jpg'),
          },
          [
            [
              'slide1',
              node('hero-slide', {
                mediaType: 'image',
                image: asset('haven', 'hero-1.jpg'),
                heading: 'Rooms made to be lived in',
                subheading: 'Solid wood furniture, delivered and assembled.',
                buttonLabel: 'Shop the collection',
                link: '/#products',
              }),
            ],
            [
              'slide2',
              node('hero-slide', {
                mediaType: 'image',
                image: asset('haven', 'hero-2.jpg'),
                heading: 'Natural materials, calm spaces',
                subheading: 'Oak, linen and stone, chosen to age beautifully.',
                buttonLabel: 'Explore the rooms',
                link: '/collections',
              }),
            ],
            [
              'slide3',
              node('hero-slide', {
                mediaType: 'image',
                image: asset('haven', 'hero-3.jpg'),
                heading: 'Furniture with room to breathe',
                subheading: 'Considered pieces for every corner of the home.',
                buttonLabel: 'Browse everything',
                link: '/products',
              }),
            ],
          ],
        ),
      ],
      [
        'rooms',
        node('collection-list', {
          title: 'Shop by room',
          columns: 4,
          showProductCount: false,
        }),
      ],
      [
        'craft',
        node(
          'image-with-text',
          {
            image: asset('haven', 'craft.svg'),
            imagePosition: 'left',
            imageWidth: 'large',
          },
          [
            ['h', heading('Built to last a lifetime', 'h2')],
            [
              't',
              text(
                'Kiln-dried hardwood, hand-finished joinery and a ten-year guarantee.',
              ),
            ],
          ],
        ),
      ],
      [
        'new',
        node('featured-collection', {
          title: 'New in',
          productsToShow: 6,
          columns: 3,
          showViewAll: true,
        }),
      ],
      [
        'design',
        node(
          'image-with-text',
          {
            image: asset('haven', 'studio.svg'),
            imagePosition: 'right',
            imageWidth: 'large',
          },
          [
            ['h', heading('Free design advice', 'h2')],
            [
              't',
              text(
                'Send us your floor plan and our designers will suggest a layout.',
              ),
            ],
            ['b', button('Book a call', '/contact', 'outline')],
          ],
        ),
      ],
      [
        'services',
        node(
          'multicolumn',
          { columns: 3, columnAlignment: 'center', backgroundColor: '#ebe5d9' },
          [
            column(
              'c1',
              'Free delivery',
              'Across the city, in your chosen slot.',
            ),
            column('c2', 'Assembly included', 'Our team sets everything up.'),
            column('c3', '10-year guarantee', 'On every frame we make.'),
          ],
        ),
      ],
      [
        'reviews',
        node(
          'testimonials',
          { heading: 'Homes we have furnished', subheading: '', columns: 2 },
          [
            testimonial(
              't1',
              'The sofa is gorgeous and arrived exactly on time.',
              'Priya & Arjun',
              'Customer',
            ),
            testimonial(
              't2',
              'Real wood, real craftsmanship. Worth every rupee.',
              'Kabir N.',
              'Customer',
            ),
          ],
        ),
      ],
    ]),
    product: productPage({
      layout: 'classic',
      galleryLayout: 'stacked',
      mediaPosition: 'right',
      pickerType: 'dropdown',
      priceSize: 'large',
      relatedHeading: 'More for this room',
      relatedColumns: 3,
    }),
    collection: collectionPage('classic', 3, 12, '#3f5d45'),
    group_header: headerGroup({
      menuAlignment: 'right',
      logoWidth: 150,
    }),
    group_footer: footerGroup({
      backgroundColor: '#2b2a28',
      textColor: '#f6f3ee',
      blurb: 'Furniture for the way you live.',
      columns: [
        {
          id: 'rooms',
          title: 'Rooms',
          links: [
            ['Living', '/#products'],
            ['Bedroom', '/#products'],
            ['Dining', '/#products'],
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
      'Free delivery and assembly on orders over ₹15,000',
      '#3f5d45',
      '#f6f3ee',
    ),
  },
};

// ---------------------------------------------------------------------------------------------------------------
// 5. Grocery & Lifestyle: dense, easy to scan, many categories, offers, six-column grids.
// ---------------------------------------------------------------------------------------------------------------
export const grocery: ThemeDefinition = {
  slug: 'freshly',
  name: 'Freshly',
  description:
    'Fast-scanning grocery theme: many category tiles, offers up front, dense product grids and delivery promises.',
  industry: 'grocery',
  version: 2,
  previewImage: '/themes/freshly/preview.svg',
  documents: {
    theme_settings: themeSettings({
      colors: {
        primary: '#15803d',
        secondary: '#4d7c0f',
        background: '#ffffff',
        text: '#14231a',
        accent: '#ea580c',
        muted: '#86a08f',
        border: '#dcebe0',
      },
      typography: {
        headingFont: 'manrope',
        bodyFont: 'inter',
        baseSize: 15,
        headingWeight: 700,
        bodyWeight: 400,
        lineHeight: 1.45,
      },
      layout: { pageWidth: 1280, gridGap: 16 },
      buttons: { radius: 12 },
      social,
    }),
    index: page('classic', [
      [
        'hero',
        node(
          'hero',
          {
            variant: 'split',
            alignment: 'left',
            height: 'medium',
            heading: 'Groceries, delivered fresh',
            subheading: 'Order before 6pm and get it the same evening.',
            accentColor: '#15803d',
            image: asset('freshly', 'hero.jpg'),
          },
          [['cta', button('Start shopping', '/#products')]],
        ),
      ],
      [
        'offers',
        node('promotional-banner', {
          title: 'Fresh deals today',
          highlightText: 'Flat 15% off fruit and vegetables',
          link: '/#products',
          backgroundColor: '#ea580c',
          textColor: '#ffffff',
        }),
      ],
      [
        'categories',
        node('collection-list', {
          title: 'Shop by category',
          columns: 6,
          showProductCount: true,
        }),
      ],
      [
        'popular',
        node('featured-collection', {
          title: 'Popular this week',
          productsToShow: 12,
          columns: 6,
          showViewAll: true,
        }),
      ],
      [
        'promises',
        node(
          'multicolumn',
          { columns: 4, columnAlignment: 'center', backgroundColor: '#f0fdf4' },
          [
            column('c1', 'Farm fresh', 'Picked and packed the same day.'),
            column('c2', 'Same-day delivery', 'Order by 6pm.'),
            column('c3', 'Easy refunds', 'Not happy? We make it right.'),
            column('c4', 'Local suppliers', 'We buy from nearby farms.'),
          ],
        ),
      ],
      [
        'all',
        node('product-grid', {
          columns: 6,
          productsPerPage: 24,
          accentColor: '#15803d',
        }),
      ],
    ]),
    product: productPage({
      layout: 'classic',
      galleryLayout: 'thumbnails',
      mediaPosition: 'left',
      pickerType: 'dropdown',
      priceSize: 'large',
      relatedHeading: 'Customers also bought',
      relatedColumns: 4,
      truncateDescription: true,
    }),
    collection: collectionPage('classic', 5, 30, '#15803d'),
    group_header: headerGroup({
      menuAlignment: 'left',
      logoWidth: 110,
    }),
    group_footer: footerGroup({
      backgroundColor: '#14231a',
      textColor: '#ecfdf3',
      blurb: 'Fresh groceries from local suppliers.',
      payments: true,
      columns: [
        {
          id: 'shop',
          title: 'Shop',
          links: [
            ['Fruit & vegetables', '/#products'],
            ['Dairy', '/#products'],
            ['Pantry', '/#products'],
          ],
        },
        {
          id: 'help',
          title: 'Help',
          links: [
            ['Delivery', '/contact'],
            ['About', '/about'],
          ],
        },
      ],
    }),
    group_announcement: announcementGroup(
      'Free delivery over ₹499 · Same-day slots available',
      '#15803d',
      '#ffffff',
    ),
  },
};

// ---------------------------------------------------------------------------------------------------------------
// 6. Minimal General Store: quiet, flexible, nothing decorative.
// ---------------------------------------------------------------------------------------------------------------
export const minimal: ThemeDefinition = {
  slug: 'plain',
  name: 'Plain',
  description:
    'A quiet, flexible store: a short intro, a clean product grid and room for your own sections.',
  industry: 'general',
  version: 1,
  previewImage: '/themes/plain/preview.svg',
  documents: {
    theme_settings: themeSettings({
      colors: {
        primary: '#111827',
        secondary: '#4b5563',
        background: '#ffffff',
        text: '#111827',
        accent: '#0369a1',
        muted: '#9ca3af',
        border: '#e5e7eb',
      },
      typography: {
        headingFont: 'inter',
        bodyFont: 'inter',
        baseSize: 16,
        headingWeight: 600,
        bodyWeight: 400,
        lineHeight: 1.5,
      },
      layout: { pageWidth: 1200, gridGap: 24 },
      buttons: { radius: 6 },
      social,
    }),
    index: page('classic', [
      [
        'intro',
        node(
          'rich-text',
          {
            alignment: 'center',
            maxWidth: 'normal',
            backgroundColor: '#ffffff',
          },
          [
            ['h', heading('Welcome', 'h1', 'center')],
            ['t', text('Everything we make, in one place.', 'center')],
            ['b', button('Browse the shop', '/#products')],
          ],
        ),
      ],
      [
        'products',
        node('product-grid', {
          columns: 4,
          productsPerPage: 12,
          accentColor: '#111827',
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
    collection: collectionPage('classic', 4, 12, '#111827'),
    group_header: headerGroup({
      menuAlignment: 'left',
      logoWidth: 120,
    }),
    group_footer: footerGroup({
      backgroundColor: '#f9fafb',
      textColor: '#111827',
      blurb: 'Thanks for shopping with us.',
      columns: [
        {
          id: 'links',
          title: 'Links',
          links: [
            ['About', '/about'],
            ['Contact', '/contact'],
          ],
        },
      ],
    }),
    group_announcement: announcementGroup(
      'Welcome to our store',
      '#111827',
      '#ffffff',
    ),
  },
};

export const THEME_CATALOGUE: readonly ThemeDefinition[] = [
  fashion,
  electronics,
  beauty,
  furniture,
  grocery,
  minimal,
];
