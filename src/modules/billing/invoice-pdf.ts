import { currencyDigits } from '../../common/utils/money.js';
import type {
  BillingInvoice,
  BillingPayment,
} from '../../database/schema/index.js';
import { SimplePdf } from './pdf-lite.js';

/** "INR 1,499.50". The rupee sign is not in the PDF base fonts, so the currency code is written instead. */
export function formatMoney(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const fixed = (minor / 10 ** digits).toFixed(digits);
  const [whole, frac] = fixed.split('.');
  const grouped = Number(whole).toLocaleString('en-IN');
  return `${currency} ${grouped}${frac ? `.${frac}` : ''}`;
}

const date = (d: Date | null): string =>
  d
    ? d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '-';

const STATUS_LABEL = { open: 'UNPAID', paid: 'PAID', void: 'VOID' } as const;

/**
 * The invoice as a PDF, built only from stored records: the invoice row (amounts, seller and period as they were at issue) and,
 * when paid, the verified payment that settled it. Nothing is computed again, so a download always matches what was billed.
 */
export function renderInvoicePdf(
  invoice: BillingInvoice,
  payments: BillingPayment[],
): Buffer {
  const pdf = new SimplePdf();
  const L = 48;
  const R = 547;
  const seller = invoice.seller;

  pdf.text(L, 70, seller.legalName, { size: 18, bold: true });
  let y = 88;
  if (seller.address) {
    pdf.text(L, y, seller.address, { size: 9, gray: 0.35 });
    y += 13;
  }
  if (seller.gstin)
    pdf.text(L, y, `GSTIN: ${seller.gstin}`, { size: 9, gray: 0.35 });

  pdf.text(R, 70, 'INVOICE', { size: 18, bold: true, align: 'right' });
  pdf.text(R, 88, invoice.number, { size: 11, bold: true, align: 'right' });
  pdf.text(R, 103, STATUS_LABEL[invoice.status], {
    size: 11,
    bold: true,
    align: 'right',
    gray: invoice.status === 'paid' ? 0.15 : 0.4,
  });

  pdf.line(L, 130, R, 130, 1);

  pdf.text(L, 152, 'BILLED TO', { size: 8, bold: true, gray: 0.4 });
  pdf.text(L, 168, invoice.tenantName, { size: 12, bold: true });

  pdf.text(R, 152, 'Issued', {
    size: 8,
    bold: true,
    gray: 0.4,
    align: 'right',
  });
  pdf.text(R, 166, date(invoice.issuedAt), { size: 10, align: 'right' });
  pdf.text(R, 184, 'Due', { size: 8, bold: true, gray: 0.4, align: 'right' });
  pdf.text(R, 198, date(invoice.dueAt), { size: 10, align: 'right' });

  // Line item
  pdf.band(L, 226, R - L, 22);
  pdf.text(L + 8, 241, 'DESCRIPTION', { size: 8, bold: true });
  pdf.text(R - 8, 241, 'AMOUNT', { size: 8, bold: true, align: 'right' });
  pdf.text(L + 8, 268, invoice.description, { size: 10 });
  pdf.text(
    L + 8,
    282,
    `Period: ${date(invoice.periodStart)} to ${date(invoice.periodEnd)}`,
    { size: 9, gray: 0.4 },
  );
  pdf.text(R - 8, 268, formatMoney(invoice.subtotalMinor, invoice.currency), {
    size: 10,
    align: 'right',
  });
  pdf.line(L, 298, R, 298);

  // Totals
  pdf.text(R - 140, 320, 'Subtotal', { size: 10, align: 'right' });
  pdf.text(R - 8, 320, formatMoney(invoice.subtotalMinor, invoice.currency), {
    size: 10,
    align: 'right',
  });
  const rate = (invoice.taxRateBps / 100).toString();
  pdf.text(R - 140, 338, `${seller.taxLabel} (${rate}%)`, {
    size: 10,
    align: 'right',
  });
  pdf.text(R - 8, 338, formatMoney(invoice.taxMinor, invoice.currency), {
    size: 10,
    align: 'right',
  });
  pdf.line(R - 230, 350, R, 350, 1);
  pdf.text(R - 140, 370, 'Total', { size: 12, bold: true, align: 'right' });
  pdf.text(R - 8, 370, formatMoney(invoice.totalMinor, invoice.currency), {
    size: 12,
    bold: true,
    align: 'right',
  });

  // Payment details, only from verified, successful payments.
  const paid = payments.filter(
    (p) =>
      p.status === 'succeeded' ||
      p.status === 'refunded' ||
      p.status === 'partially_refunded',
  );
  let py = 420;
  if (invoice.status === 'paid' && paid.length > 0) {
    pdf.text(L, py, 'PAYMENT', { size: 8, bold: true, gray: 0.4 });
    py += 16;
    for (const p of paid) {
      const how =
        p.provider === 'razorpay'
          ? `Razorpay${p.method ? ` (${p.method})` : ''}, payment ${p.razorpayPaymentId ?? '-'}`
          : `${p.method ?? 'Offline'}, reference ${p.reference ?? '-'}`;
      pdf.text(
        L,
        py,
        `${formatMoney(p.amountMinor, p.currency)} received ${date(p.capturedAt)}`,
        { size: 10 },
      );
      pdf.text(L, py + 13, how, { size: 9, gray: 0.4 });
      if (p.refundedMinor > 0)
        pdf.text(
          L,
          py + 26,
          `Refunded: ${formatMoney(p.refundedMinor, p.currency)}`,
          {
            size: 9,
            gray: 0.4,
          },
        );
      py += p.refundedMinor > 0 ? 46 : 34;
    }
  } else if (invoice.status === 'void') {
    pdf.text(
      L,
      py,
      `Voided ${date(invoice.voidedAt)}${invoice.voidReason ? `: ${invoice.voidReason}` : ''}`,
      {
        size: 10,
      },
    );
  } else {
    pdf.text(
      L,
      py,
      `Please pay by ${date(invoice.dueAt)} from your StoreForge dashboard.`,
      {
        size: 10,
      },
    );
  }

  pdf.line(L, 790, R, 790);
  pdf.text(L, 806, `${seller.legalName}  |  ${invoice.number}`, {
    size: 8,
    gray: 0.45,
  });
  return pdf.build();
}
