import { escapeCell, unescapeCell } from './spreadsheet.js';

describe('spreadsheet cell safety', () => {
  it.each(['=SUM(A1)', '+1', '-2+3', '@cmd', '\tx', '\rx'])(
    'prefixes %j so it is read as text',
    (value) => {
      expect(escapeCell(value)).toBe(`'${value}`);
    },
  );

  it.each(['Toyota', '12.50', 'a=b', '', "'quoted", ' =x'])(
    'leaves %j alone',
    (value) => {
      expect(escapeCell(value)).toBe(value);
    },
  );

  it('is undone on the way back in, and only for what it added', () => {
    for (const v of ['=SUM(A1)', '+1', '-5V relay', '@x'])
      expect(unescapeCell(escapeCell(v))).toBe(v);
    expect(unescapeCell("'hello")).toBe("'hello");
    expect(unescapeCell("'")).toBe("'");
    expect(unescapeCell('plain')).toBe('plain');
  });
});
