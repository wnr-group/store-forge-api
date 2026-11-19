import {
  button,
  heading,
  node,
  page,
  text,
  type Child,
  type PageDocument,
} from './dsl.js';

/**
 * Marketplace's designed About and Contact pages. They are stored in the theme document (`settings.pages.about` and
 * `settings.pages.contact`) and shown at /about and /contact unless the store writes its own page of that name under Pages.
 *
 * Every word, number and address is a placeholder the merchant replaces in the editor. The theme ships no photographs, so
 * picture slots show the theme's tinted panel until the merchant chooses a picture.
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
const EMAIL = 'mailto:support@example.com';

export const marketplaceAboutPage = (): PageDocument =>
  page('classic', [
    [
      'hero',
      node(
        'hero',
        {
          variant: 'banner',
          alignment: 'left',
          height: 'medium',
          eyebrow: 'About us',
        },
        [
          [
            'slide1',
            node('hero-slide', {
              mediaType: 'image',
              heading: 'Shopping made simple, by people who care',
              subheading:
                'Learn who we are, how we choose our range and what you can count on when you order.',
              buttonLabel: 'Shop now',
              link: '/products',
            }),
          ],
          ['cta', button('Contact us', '/contact', 'outline')],
        ],
      ),
    ],
    [
      'figures',
      node('multicolumn', { columns: 4, columnAlignment: 'left' }, [
        column('f1', '2012', 'The year we opened'),
        column('f2', '40,000+', 'Products in the range'),
        column('f3', '120,000', 'Orders delivered'),
        column('f4', '4.8 / 5', 'Average customer rating'),
      ]),
    ],
    [
      'story',
      node(
        'image-with-text',
        {
          variant: 'plain',
          eyebrow: 'Our story',
          imagePosition: 'left',
          imageWidth: 'medium',
        },
        [
          ['h', heading('Built to make shopping easier')],
          [
            'p1',
            text(
              'We started with a simple idea: put a wide range in one place, price it fairly and get it to you quickly. Tell your own story here: who you are, why you started and what you want to be known for.',
            ),
          ],
          [
            'p2',
            text(
              'Today we work with trusted suppliers and check every listing, so what you see is what arrives.',
            ),
          ],
          ['shop', button('Shop now', '/products', 'primary')],
          ['talk', button('Contact us', '/contact', 'outline')],
        ],
      ),
    ],
    [
      'why',
      node(
        'multicolumn',
        {
          eyebrow: 'Why shop with us',
          heading: 'What you can count on',
          columns: 3,
          columnAlignment: 'left',
        },
        [
          column(
            'w1',
            'A wide range',
            'Everyday essentials and special finds, across every category, in one place.',
          ),
          column(
            'w2',
            'Fair prices',
            'Clear prices with the discount shown, so you can compare with confidence.',
          ),
          column(
            'w3',
            'Support that answers',
            'A real person replies to your questions, usually within one working day.',
          ),
        ],
      ),
    ],
    [
      'how',
      node(
        'promotional-banner',
        {
          title: 'How it works',
          highlightText: '',
          link: '/products',
        },
        [
          ['h', heading('From browsing to your door in four steps.')],
          [
            't',
            text(
              'Ordering is quick. Find what you want, add it to your cart and we take care of the rest.',
            ),
          ],
          ['cta', button('Start shopping', '/products', 'primary')],
          column('s1', 'Browse', 'Search or explore the categories.'),
          column('s2', 'Add to cart', 'Pick your options and quantity.'),
          column('s3', 'Check out', 'Review your cart and place the order.'),
          column('s4', 'Delivered', 'We pack it and send it your way.'),
        ],
      ),
    ],
  ]);

/**
 * There is no contact form because the platform has no way to receive one yet; email is the way in.
 */
export const marketplaceContactPage = (): PageDocument =>
  page('classic', [
    [
      'intro',
      node(
        'image-with-text',
        {
          variant: 'panel',
          eyebrow: 'Contact',
          imagePosition: 'right',
          imageWidth: 'medium',
        },
        [
          ['h', heading('We are here to help', 'h1')],
          [
            'p',
            text(
              'A question about an order, a product or a return? Write to us and a real person will reply within one working day.',
            ),
          ],
          ['mail', button('Email support', EMAIL, 'primary')],
          ['shop', button('Browse categories', '/collections', 'outline')],
        ],
      ),
    ],
    [
      'details',
      node(
        'multicolumn',
        {
          eyebrow: 'Get in touch',
          heading: 'Choose the right team',
          columns: 3,
          columnAlignment: 'left',
        },
        [
          column(
            'support',
            'Customer support',
            'support@example.com\n\nMonday to Friday, 9am to 6pm.',
          ),
          column(
            'orders',
            'Orders and returns',
            'orders@example.com\n\nInclude your order number so we can find it quickly.',
          ),
          column(
            'partners',
            'Sellers and partners',
            'partners@example.com\n\nTell us about your products and how you would like to work together.',
          ),
        ],
      ),
    ],
    [
      'office',
      node(
        'image-with-text',
        {
          variant: 'plain',
          eyebrow: 'Find us',
          imagePosition: 'left',
          imageWidth: 'medium',
        },
        [
          ['h', heading('Our office')],
          ['p', text('12 Placeholder Street\n\nYour City, 000000')],
          [
            'hours',
            text(
              'Monday to Friday  9am to 6pm\n\nSaturday  10am to 4pm\n\nSunday  Closed',
            ),
          ],
          ['cta', button('Email to arrange a visit', EMAIL, 'outline')],
        ],
      ),
    ],
    [
      'faq',
      node(
        'collapsible-content',
        {
          eyebrow: 'Help centre',
          heading: 'Quick answers',
          subheading:
            'The questions we hear most. Still stuck? Email us and we will help.',
          ctaLabel: 'Email support',
          ctaLink: EMAIL,
        },
        [
          faq(
            'q1',
            'Where is my order?',
            'You will get an update when your order ships. Add your own tracking instructions here.',
          ),
          faq(
            'q2',
            'How do I return something?',
            'Email us within 14 days with your order number. Add your own returns policy here.',
          ),
          faq(
            'q3',
            'Which payment methods do you accept?',
            'Add the payment methods your store accepts here.',
          ),
          faq(
            'q4',
            'Can I change or cancel an order?',
            'Email us as soon as you can. If it has not shipped yet, we will update it for you.',
          ),
        ],
      ),
    ],
  ]);
