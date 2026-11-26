/**
 * A very small PDF writer for one-page, text-only documents (invoices). It avoids a PDF dependency: the output is plain PDF 1.4 with
 * the two standard Helvetica fonts, so every viewer opens it and nothing has to be bundled. Text is WinAnsi (Latin-1); any other
 * character becomes "?" (the rupee sign is written as "INR" by the caller).
 */
export const PAGE = { width: 595, height: 842 } as const;

type Op = string;

const latin1 = (s: string): string =>
  [...s].map((c) => (c.charCodeAt(0) < 256 ? c : '?')).join('');
const escapeText = (s: string): string =>
  latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const num = (n: number): string => (Math.round(n * 100) / 100).toString();

/** Width of `text` in points for Helvetica; a good-enough estimate (average glyph width) used only for right alignment. */
export function textWidth(text: string, size: number, bold = false): number {
  let units = 0;
  for (const ch of latin1(text)) {
    if ("il.,;:|!'".includes(ch)) units += 0.28;
    else if ('fjrt() -'.includes(ch)) units += 0.34;
    else if ('mwMW@'.includes(ch)) units += 0.85;
    else if (/[A-Z0-9]/.test(ch)) units += 0.65;
    else units += 0.54;
  }
  return units * size * (bold ? 1.06 : 1);
}

export class SimplePdf {
  private readonly ops: Op[] = [];

  /** `y` is measured from the TOP of the page, like a layout on paper. */
  text(
    x: number,
    y: number,
    value: string,
    opts: {
      size?: number;
      bold?: boolean;
      align?: 'left' | 'right';
      gray?: number;
    } = {},
  ): this {
    const size = opts.size ?? 10;
    const bold = opts.bold ?? false;
    const left = opts.align === 'right' ? x - textWidth(value, size, bold) : x;
    this.ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(opts.gray ?? 0)} g ${num(left)} ${num(PAGE.height - y)} Td (${escapeText(value)}) Tj ET`,
    );
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5): this {
    this.ops.push(
      `${num(width)} w 0 G ${num(x1)} ${num(PAGE.height - y1)} m ${num(x2)} ${num(PAGE.height - y2)} l S`,
    );
    return this;
  }

  /** A light filled band (table header). `gray` 0 = black, 1 = white. */
  band(x: number, y: number, w: number, h: number, gray = 0.93): this {
    this.ops.push(
      `${num(gray)} g ${num(x)} ${num(PAGE.height - y - h)} ${num(w)} ${num(h)} re f 0 g`,
    );
    return this;
  }

  build(): Buffer {
    const content = this.ops.join('\n');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    ];
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
