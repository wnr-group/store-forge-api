import { describe, expect, it } from 'vitest';
import { TEMPLATE_KINDS } from '../../../database/schema/templates.js';
import { validateTemplateDocument } from '../validation/template-document.js';
import { THEME_CATALOGUE } from './themes.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('theme catalogue', () => {
  it('covers the six required industries with unique slugs', () => {
    expect([...new Set(THEME_CATALOGUE.map((t) => t.industry))].sort()).toEqual(
      ['beauty', 'electronics', 'fashion', 'general', 'grocery', 'home'],
    );
    const slugs = THEME_CATALOGUE.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('Stride asks the storefront for the sport look and uses its own fonts', () => {
    const stride = THEME_CATALOGUE.find((t) => t.slug === 'stride')!;
    const settings = (
      stride.documents.theme_settings as unknown as {
        settings: {
          brand: { look: string };
          typography: { headingFont: string; bodyFont: string };
        };
      }
    ).settings;
    expect(settings.brand.look).toBe('sport');
    expect(settings.typography.headingFont).toBe('archivo');
    expect(settings.typography.bodyFont).toBe('plus-jakarta-sans');
  });

  it('Marketplace asks the storefront for the market look and uses its own fonts', () => {
    const marketplace = THEME_CATALOGUE.find((t) => t.slug === 'marketplace')!;
    const settings = (
      marketplace.documents.theme_settings as unknown as {
        settings: {
          brand: { look: string };
          typography: { headingFont: string; bodyFont: string };
        };
      }
    ).settings;
    expect(settings.brand.look).toBe('market');
    expect(settings.typography.headingFont).toBe('plus-jakarta-sans');
    expect(settings.typography.bodyFont).toBe('inter');
  });

  it('Maison asks the storefront for the boutique look and uses its own fonts', () => {
    const maison = THEME_CATALOGUE.find((t) => t.slug === 'maison')!;
    const settings = (
      maison.documents.theme_settings as unknown as {
        settings: {
          brand: { look: string };
          typography: { headingFont: string; bodyFont: string };
        };
      }
    ).settings;
    expect(settings.brand.look).toBe('boutique');
    expect(settings.typography.headingFont).toBe('cormorant-garamond');
    expect(settings.typography.bodyFont).toBe('jost');
  });

  for (const theme of THEME_CATALOGUE) {
    describe(theme.name, () => {
      it('defines every template kind', () => {
        expect(Object.keys(theme.documents).sort()).toEqual(
          [...TEMPLATE_KINDS].sort(),
        );
      });

      for (const kind of TEMPLATE_KINDS) {
        it(`${kind} passes server validation`, () => {
          expect(
            validateTemplateDocument(theme.documents[kind], {
              kind,
              tenantId: TENANT,
            }),
          ).toEqual([]);
        });
      }
    });
  }

  it('gives each theme a distinct design, not a recoloured copy', () => {
    const signature = (t: (typeof THEME_CATALOGUE)[number]) =>
      JSON.stringify(
        (t.documents.index as { order: string[] }).order.map(
          (id) =>
            (
              t.documents.index as {
                sections: Record<string, { type: string }>;
              }
            ).sections[id]!.type,
        ),
      );
    expect(new Set(THEME_CATALOGUE.map(signature)).size).toBe(
      THEME_CATALOGUE.length,
    );
    const fonts = new Set(
      THEME_CATALOGUE.map((t) =>
        JSON.stringify(
          (
            t.documents.theme_settings as unknown as {
              settings: { typography: { headingFont: string } };
            }
          ).settings.typography,
        ),
      ),
    );
    expect(fonts.size).toBeGreaterThanOrEqual(4);
  });
});
