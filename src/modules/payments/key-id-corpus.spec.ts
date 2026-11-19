import { KEY_ID_CORPUS } from '../../../test/support/key-id-corpus.js';
import { isValidKeyId } from './key-id.js';

describe('Key ID corpus shared with the database check (AC-DB-06)', () => {
  it('AC-DB-06: the API pattern gives the expected verdict for every corpus entry', () => {
    const wrong = KEY_ID_CORPUS.filter(
      ([value, expected]) => isValidKeyId(value) !== expected,
    ).map(([value]) => JSON.stringify(value));
    expect(KEY_ID_CORPUS.length).toBeGreaterThanOrEqual(14);
    expect(wrong).toEqual([]);
  });
});
