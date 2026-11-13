import { describe, expect, it } from 'vitest';
import { TEMPLATE_KINDS } from '../../../database/schema/templates.js';
import { validateTemplateDocument } from '../validation/template-document.js';
import { THEME_CATALOGUE } from './themes.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('theme catalogue', () => {
  it('has the six required industries with unique slugs', () => {
    expect(THEME_CATALOGUE.map((t) => t.industry).sort()).toEqual([
      'beauty',
      'electronics',
      'fashion',
      'general',
      'grocery',
      'home',
    ]);
    expect(new Set(THEME_CATALOGUE.map((t) => t.slug)).size).toBe(6);
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
