import {
  asset,
  button,
  heading,
  node,
  page,
  text,
  type Child,
  type PageDocument,
} from './dsl.js';

/**
 * Stride's designed About and Contact pages. They are stored in the theme document (`settings.pages.about` and
 * `settings.pages.contact`) and shown at /about and /contact unless the store writes its own page of that name under Pages.
 *
 * Every word, number and address is a placeholder the merchant replaces in the editor. The pictures are the theme's own
 * stripes. The text uses the conventions the Sport look understands: "Value | text" is a big-number row, "Title :: text" is a
 * row with an icon, and {{words}} in a heading are coloured.
 */

const column = (id: string, title: string, body: string): Child => [
  id,
  node('column', { title, text: body }),
];

const faq = (id: string, question: string, answer: string): Child => [
  id,
  node('collapsible-item', { heading: question, content: answer }),
];

/** Replace with the store's own address. */
const EMAIL = 'mailto:hello@example.com';

export const strideAboutPage = (): PageDocument =>
  page('classic', [
    [
      'intro',
      node(
        'image-with-text',
        {
          variant: 'panel',
          eyebrow: 'About us',
          image: asset('stride', 'art-1.svg'),
          imagePosition: 'right',
          imageWidth: 'medium',
          uppercaseHeading: true,
        },
        [
          ['h', heading('Made for people who {{keep moving.}}')],
          [
            'p',
            text(
              'We make everyday activewear for training, travel and time off. Tell your own story here: who you are, why you started and who you make it for.',
            ),
          ],
          ['shop', button('Shop the range', '/products', 'primary')],
          ['talk', button('Contact us', '/contact', 'outline')],
        ],
      ),
    ],
    [
      'numbers',
      node(
        'image-with-text',
        {
          variant: 'plain',
          eyebrow: 'By the numbers',
          image: asset('stride', 'art-2.svg'),
          imagePosition: 'left',
          imageWidth: 'medium',
          uppercaseHeading: true,
        },
        [
          ['h', heading('A few things we are {{proud of.}}')],
          ['n1', text('2012 | The year we started')],
          ['n2', text('40+ | Fabrics tested every season')],
          ['n3', text('12,000 | Orders packed by hand')],
          ['n4', text('9 in 10 | Customers who come back')],
        ],
      ),
    ],
    [
      'values',
      node(
        'multicolumn',
        {
          eyebrow: 'What we stand for',
          heading: 'Three rules\nwe train by.',
          columns: 3,
          columnAlignment: 'left',
        },
        [
          column(
            'v1',
            'Built to move',
            'Cuts and cloth that keep up with you, from the first rep to the last mile.',
          ),
          column(
            'v2',
            'Made to last',
            'Strong seams and fabrics that hold their shape, wash after wash.',
          ),
          column(
            'v3',
            'Checked with care',
            'We look closely at every piece before it ships, so it arrives the way it should.',
          ),
        ],
      ),
    ],
    [
      'story',
      node(
        'image-with-text',
        {
          variant: 'plain',
          eyebrow: 'Our story',
          image: asset('stride', 'art-3.svg'),
          imagePosition: 'right',
          imageWidth: 'medium',
          uppercaseHeading: false,
        },
        [
          ['h', heading('Good-quality wearables, built {{around real life.}}')],
          [
            'p',
            text(
              'What began with one training top became a full range. Add a few lines here about how it grew and what has stayed the same.',
            ),
          ],
          ['f1', text('Fabric :: Soft, breathable and made to last')],
          ['f2', text('Fit :: Easy cuts that move with you')],
          ['f3', text('Care :: Washes well and keeps its shape')],
          ['cta', button('Shop the range', '/products', 'outline')],
        ],
      ),
    ],
    [
      'teams',
      node(
        'promotional-banner',
        {
          title: 'Teams and clubs',
          highlightText: '',
          link: '/contact',
          backgroundColor: '#272f86',
          textColor: '#ffffff',
        },
        [
          ['h', heading('Kit out the whole squad.')],
          [
            't',
            text(
              'Ordering for a team, a shop or a club? Tell us what you need and we will come back with a quotation.',
            ),
          ],
          ['cta', button('Request a quote', '/contact', 'primary')],
          column('s1', 'Browse', 'Pick the products you are interested in.'),
          column('s2', 'Specify', 'Share quantities, sizes and colours.'),
          column('s3', 'Quotation', 'We reply with pricing and delivery.'),
        ],
      ),
    ],
  ]);

/**
 * There is no contact form because the platform has no way to receive one yet; email is the way in.
 */
export const strideContactPage = (): PageDocument =>
  page('classic', [
    [
      'intro',
      node(
        'image-with-text',
        {
          variant: 'panel',
          eyebrow: 'Contact',
          image: asset('stride', 'art-1.svg'),
          imagePosition: 'right',
          imageWidth: 'medium',
          uppercaseHeading: true,
        },
        [
          ['h', heading("Let's {{talk.}}")],
          [
            'p',
            text(
              'A question about an order, a size or a bulk quote? Write to us and we will reply within one working day.',
            ),
          ],
          ['mail', button('Email us', EMAIL, 'primary')],
          ['shop', button('Browse the range', '/products', 'outline')],
        ],
      ),
    ],
    [
      'details',
      node(
        'multicolumn',
        {
          eyebrow: 'Get in touch',
          heading: 'Ways to\nreach us.',
          columns: 3,
          columnAlignment: 'left',
        },
        [
          column(
            'visit',
            'Visit',
            '12 Placeholder Street\n\nYour City, 000000',
          ),
          column(
            'write',
            'Write',
            'hello@example.com\n\nWe reply within one working day.',
          ),
          column(
            'call',
            'Call',
            '+00 000 000 0000\n\nMonday to Friday, 9am to 6pm.',
          ),
        ],
      ),
    ],
    [
      'hours',
      node(
        'image-with-text',
        {
          variant: 'plain',
          eyebrow: 'Opening hours',
          image: asset('stride', 'art-2.svg'),
          imagePosition: 'left',
          imageWidth: 'medium',
          uppercaseHeading: true,
        },
        [
          ['h', heading('Come and {{see it.}}')],
          [
            'p',
            text(
              'Drop in to try things on and ask us anything. Add your own opening hours here.',
            ),
          ],
          ['h1', text('Mon to Fri | 9am to 6pm')],
          ['h2', text('Saturday | 10am to 4pm')],
          ['h3', text('Sunday | Closed')],
          ['cta', button('Plan a visit', EMAIL, 'outline')],
        ],
      ),
    ],
    [
      'faq',
      node(
        'collapsible-content',
        {
          eyebrow: 'Good to know',
          heading: 'Questions, answered.',
          subheading: '',
          ctaLabel: 'Email us',
          ctaLink: EMAIL,
          openFirstItem: false,
        },
        [
          faq(
            'q1',
            'How long does delivery take?',
            'Most orders leave us within two working days. Add your own delivery times and costs here.',
          ),
          faq(
            'q2',
            'How do I choose my size?',
            'Open a product to see its sizes, or email us and we will help you pick.',
          ),
          faq(
            'q3',
            'What if something is not right?',
            'Tell us within 14 days and we will make it right. Add your own returns policy here.',
          ),
          faq(
            'q4',
            'Do you take bulk orders?',
            'Yes. Tell us quantities, sizes and colours and we will send a quotation.',
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
          ['cta', button('Request a quote', EMAIL, 'primary')],
          column('s1', 'Browse', 'Pick the products you are interested in.'),
          column('s2', 'Specify', 'Share quantities, sizes and colours.'),
          column('s3', 'Quotation', 'We reply with pricing and delivery.'),
        ],
      ),
    ],
  ]);
