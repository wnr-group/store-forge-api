import { acTagsOf, layersOfMethod, layerOfTest } from './layers.js';

describe('AC tags in test names', () => {
  it('finds every acceptance-criterion id, including lettered variants, once', () => {
    expect(
      acTagsOf(
        'rejects a tampered tag (AC-ENC-03) and AC-RLS-11a, AC-ENC-03 again',
      ),
    ).toEqual(['AC-ENC-03', 'AC-RLS-11a']);
  });

  it('finds nothing in a name without an id, and ignores near-misses', () => {
    expect(acTagsOf('round-trips a secret')).toEqual([]);
    expect(acTagsOf('AC-1 and AC-ENC and ACENC-01 and AC-enc-01')).toEqual([]);
  });
});

describe('verification layer of a test', () => {
  it.each([
    ['/r/src/modules/payments/credentials-crypto.spec.ts', 'U'],
    ['C:/r/src/common/guards/organization-context.guard.spec.ts', 'U'],
    ['/r/test/payments-database.e2e-spec.ts', 'PG'],
    ['/r/test/payments.e2e-spec.ts', 'HTTP'],
    ['/r/test/platform.e2e-spec.ts', 'HTTP'],
    ['/r/src/modules/storefront/storefront.int-spec.ts', 'HTTP'],
    ['C:/sf-wt/fe/tests/unit/auth-api-mode.test.ts', 'FE'],
    ['/r/tests/unit/payments-ui.test.tsx', 'FE'],
  ])('%s is %s', (file, layer) => {
    expect(layerOfTest(file, 'any test name')).toBe(layer);
  });

  it('lets a test name override the layer with an explicit [layer:X] tag', () => {
    expect(
      layerOfTest(
        '/r/src/x/no-decrypt.spec.ts',
        'no decryption path (AC-ENC-09) [layer:STATIC]',
      ),
    ).toBe('STATIC');
  });

  it('ignores an unknown layer tag and falls back to the file', () => {
    expect(layerOfTest('/r/src/x/a.spec.ts', 'x [layer:BOGUS]')).toBe('U');
  });

  it('returns undefined for a file that is not a recognised test file', () => {
    expect(layerOfTest('/r/scripts/thing.ts', 'x')).toBeUndefined();
  });
});

describe('layers required by a plan matrix "Method / test" cell', () => {
  it.each([
    ['PG A `payments-database mig-0034-apply`', ['PG']],
    ['HTTP A `get-unconfigured`', ['HTTP']],
    ['U+PG A `regex-drift`', ['U', 'PG']],
    ['STATIC A diff scan plus PG A privilege comparison', ['PG', 'STATIC']],
    [
      'PG A `flag-update-denied`; HTTP A existing tenant-update with flag field rejected',
      ['PG', 'HTTP'],
    ],
    [
      'REAL A HTTP to `/rest/v1/tenant_razorpay_config` (select, insert, update, delete)',
      ['REAL'],
    ],
    ['PW A T-PW-01', ['PW']],
    ['FE A', ['FE']],
    ['M review', ['M']],
    ['U+STATIC A middleware review (skipped under test)', ['U', 'STATIC']],
  ])('%s', (cell, expected) => {
    expect(layersOfMethod(cell)).toEqual(expected);
  });

  it('does not mistake words or ids for layers', () => {
    expect(layersOfMethod('Update the UI; see UNIT and HTTPS notes')).toEqual(
      [],
    );
  });
});
