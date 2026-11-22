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
 * Maison's designed About and Contact pages. They are stored in the theme document (`settings.pages.about` and
 * `settings.pages.contact`) and shown at /about and /contact unless the store writes its own page of that name under Pages.
 *
 * Every word, number and address here is a placeholder the merchant replaces in the editor. The pictures reuse the theme's one
 * photograph; the merchant picks their own.
 */

const column = (id: string, title: string, body: string): Child => [
  id,
  node('column', { title, text: body }),
];

/** A question and its answer for the questions section. */
const faq = (id: string, question: string, answer: string): Child => [
  id,
  node('collapsible-item', { heading: question, content: answer }),
];

/** Replace with the store's own address. */
const EMAIL = 'mailto:hello@example.com';

export const maisonAboutPage = (): PageDocument =>
  page('classic', [
    [
      'hero',
      node(
        'hero',
        {
          variant: 'split',
          alignment: 'left',
          height: 'large',
          heading: 'Made with intention, kept for years',
          subheading:
            'We believe in fewer, better things. This is who we are and how we choose what we sell.',
          image: asset('maison', 'hero.jpg'),
        },
        [
          ['shop', button('Explore the collection', '/collections')],
          ['talk', button('Get in touch', '/contact', 'outline')],
        ],
      ),
    ],
    [
      'figures',
      node(
        'multicolumn',
        { columns: 4, columnAlignment: 'left', backgroundColor: '#fcfdfb' },
        [
          column('f1', '2012', 'The year we opened our doors'),
          column('f2', '40+', 'Makers and studios we work with'),
          column('f3', '12,000', 'Parcels packed and sent with care'),
          column('f4', '9 in 10', 'Customers who come back to order again'),
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
          image: asset('maison', 'hero.jpg'),
          imagePosition: 'left',
          imageWidth: 'medium',
        },
        [
          ['h', heading('It began with one well-made thing')],
          [
            'p1',
            text(
              'What started as a small table of favourite finds became a shop for people who like things that are made properly and look better with age. Tell your own story here: who you are, why you started and what you hoped to change.',
            ),
          ],
          [
            'p2',
            text(
              'Every piece we sell has been handled, tested and chosen by a person. If we would not keep it ourselves, it does not make the shelf.',
            ),
          ],
          ['cta', button('Shop the collection', '/collections')],
        ],
      ),
    ],
    [
      'values',
      node(
        'multicolumn',
        {
          eyebrow: 'What we stand for',
          heading: 'Three promises we keep',
          columns: 3,
          columnAlignment: 'left',
          backgroundColor: '#edf3ef',
        },
        [
          column(
            'v1',
            'Chosen, not collected',
            'We would rather stock fifty things we love than five hundred we do not. Each one earns its place.',
          ),
          column(
            'v2',
            'Made to last',
            'Good materials and honest construction, so a piece is still doing its job years from now.',
          ),
          column(
            'v3',
            'Honest, always',
            'Clear descriptions, fair prices and a straight answer whenever you ask us a question.',
          ),
        ],
      ),
    ],
    [
      'process',
      node(
        'image-with-text',
        {
          variant: 'panel',
          eyebrow: 'How we choose',
          image: asset('maison', 'hero.jpg'),
          imagePosition: 'right',
          imageWidth: 'medium',
        },
        [
          ['h', heading('From first sketch to your door')],
          [
            'p',
            text(
              'We visit the workshops, handle the samples and ask the awkward questions. Then we pack each order ourselves, so it reaches you the way we would want to receive it.',
            ),
          ],
          ['cta', button('See what is new', '/collections')],
          ['more', button('Talk to us', '/contact', 'outline')],
        ],
      ),
    ],
    [
      'invite',
      node('promotional-banner', {
        title: 'Find something you will keep',
        highlightText:
          'New pieces arrive every week. Come and see what has just come in.',
        link: '/collections',
        backgroundColor: '#e9d6b8',
        textColor: '#10362f',
      }),
    ],
  ]);

/**
 * There is no contact form because the platform has no way to receive one yet; email is the way in.
 */
export const maisonContactPage = (): PageDocument =>
  page('classic', [
    [
      'intro',
      node(
        'image-with-text',
        {
          variant: 'panel',
          eyebrow: 'Contact',
          image: asset('maison', 'hero.jpg'),
          imagePosition: 'right',
          imageWidth: 'medium',
        },
        [
          ['h', heading('We would love to hear from you', 'h1')],
          [
            'p',
            text(
              'A question about an order, a piece or a gift? Write to us and we will reply within one working day.',
            ),
          ],
          ['mail', button('Email us', EMAIL)],
          ['shop', button('Browse the collection', '/collections', 'outline')],
        ],
      ),
    ],
    [
      'details',
      node(
        'multicolumn',
        {
          eyebrow: 'Get in touch',
          heading: 'Ways to reach us',
          columns: 3,
          columnAlignment: 'left',
          backgroundColor: '#fcfdfb',
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
      'visit',
      node(
        'image-with-text',
        {
          variant: 'plain',
          eyebrow: 'The shop',
          image: asset('maison', 'hero.jpg'),
          imagePosition: 'left',
          imageWidth: 'medium',
        },
        [
          ['h', heading('Visit us in person')],
          [
            'p',
            text(
              'Come and see the collection, hold a piece before you decide and ask us anything. Add your opening hours here.',
            ),
          ],
          [
            'hours',
            text('Monday to Friday  9am to 6pm\n\nSaturday  10am to 4pm'),
          ],
          ['cta', button('Plan a visit', EMAIL, 'outline')],
        ],
      ),
    ],
    [
      'questions',
      node(
        'collapsible-content',
        {
          eyebrow: 'Questions',
          heading: 'Before you write',
          subheading:
            'A few answers that save you waiting. Still stuck? Email us.',
          ctaLabel: 'Email us',
          ctaLink: EMAIL,
        },
        [
          faq(
            'q1',
            'How long does delivery take?',
            'Most orders leave us within two working days. Add your own delivery times and costs here.',
          ),
          faq(
            'q2',
            'Can I return something?',
            'Yes. Tell us within 14 days and we will arrange it. Add your own returns policy here.',
          ),
          faq(
            'q3',
            'How do I look after my order?',
            'Each piece comes with simple care notes. Add any general advice you give your customers here.',
          ),
          faq(
            'q4',
            'Do you offer gift wrapping?',
            'We do. Choose it at the bag and add a note. Edit or remove this answer to suit your shop.',
          ),
        ],
      ),
    ],
    [
      'browse',
      node('promotional-banner', {
        title: 'Still browsing?',
        highlightText: 'New pieces are added every week.',
        link: '/collections',
        backgroundColor: '#10362f',
        textColor: '#fcfdfb',
      }),
    ],
  ]);
