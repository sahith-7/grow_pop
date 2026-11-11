// GST rules B5 relies on, as pure functions (no database), so each one is unit-tested on its own.
// Money is whole paise in a BigInt and tax rates are hundredths of a percent (18% = 1800n): nothing passes through a float.
// Sources: CGST Act s.31, s.34; CGST Rules 46, 46A, 49, 53; IGST Act s.10. To be confirmed by the store's tax adviser (D7).

// ------------------------------------------------------------------ money

const MONEY = /^(-)?(\d{1,12})(?:\.(\d{1,4}))?$/;

/** '1299.5' -> 129950n. More than 2 decimals rounds half-up to paise ('0.125' -> 13n). */
export function paise(v: string): bigint {
  const m = MONEY.exec(v.trim());
  if (!m) throw new Error(`not an amount: ${v}`);
  const f = (m[3] ?? '').padEnd(4, '0');
  const tenThousandths = BigInt(m[2]) * 10000n + BigInt(f);
  const p = (tenThousandths + 50n) / 100n;
  return m[1] ? -p : p;
}

/** 129950n -> '1299.50', -5n -> '-0.05'. */
export function rupees(p: bigint): string {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** Paise, or a rupees string ('1139.00'), as text for people: Indian grouping, two decimals ('1,139.00', '12,34,567.50'). */
export function inr(v: bigint | string): string {
  const p = typeof v === 'bigint' ? v : paise(v);
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${(a / 100n).toLocaleString('en-IN')}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** a / b rounded half away from zero. b > 0. */
export function divRound(a: bigint, b: bigint): bigint {
  return a >= 0n ? (2n * a + b) / (2n * b) : -((-2n * a + b) / (2n * b));
}

/** '18' -> 1800n, '0.25' -> 25n. */
export function rateBp(rate: string): bigint {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(rate.trim());
  if (!m) throw new Error(`not a rate: ${rate}`);
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

/** 1800n -> '18', 25n -> '0.25'. */
export function rateText(bp: bigint): string {
  const f = (bp % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${bp / 100n}${f ? `.${f}` : ''}`;
}

/** Percentage of an amount, half-up: pct('12.5', 10000n) = 1250n. */
export function pctOf(amountPaise: bigint, pct: string): bigint {
  return divRound(amountPaise * rateBp(pct), 10000n);
}

// ------------------------------------------------------------------ tax on one line

export interface LineTax { taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; total: bigint }

/**
 * Splits one line into taxable value and tax.
 * - `inclusive`: `amount` already contains the tax (shelf prices in India usually do). The tax is worked out from the
 *   amount, and the taxable value is what is left, so the line still adds up to exactly what the customer pays.
 * - otherwise `amount` is the taxable value and tax is added on top.
 * Intra-state supplies split the rate into equal CGST and SGST/UTGST halves, each rounded to paise; inter-state is IGST.
 */
export function lineTax(amount: bigint, rate: bigint, supply: 'intra' | 'inter', inclusive: boolean): LineTax {
  if (rate === 0n) return { taxable: amount, cgst: 0n, sgst: 0n, igst: 0n, total: amount };
  if (supply === 'intra') {
    const half = inclusive ? divRound(amount * rate, 2n * (10000n + rate)) : divRound(amount * rate, 20000n);
    const taxable = inclusive ? amount - 2n * half : amount;
    return { taxable, cgst: half, sgst: half, igst: 0n, total: taxable + 2n * half };
  }
  const igst = inclusive ? divRound(amount * rate, 10000n + rate) : divRound(amount * rate, 10000n);
  const taxable = inclusive ? amount - igst : amount;
  return { taxable, cgst: 0n, sgst: 0n, igst, total: taxable + igst };
}

/** Rounds a document total to the nearest rupee (half up). Returns the round-off (−49 … +50 paise). */
export function roundOff(total: bigint, enabled: boolean): bigint {
  if (!enabled) return 0n;
  const r = total % 100n;
  return r >= 50n ? 100n - r : -r;
}

// ------------------------------------------------------------------ states (GST state codes)

export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

/** Union territories without a legislature levy UTGST instead of SGST (UTGST Act s.7). */
const UTGST = new Set(['04', '26', '31', '35', '38', '97']);
export const stateTaxLabel = (stateCode: string) => (UTGST.has(stateCode) ? 'UTGST' : 'SGST');

// WooCommerce's codes for Indian states (woocommerce/i18n/states.php), including older spellings.
const WOO_STATES: Record<string, string> = {
  AP: '37', AR: '12', AS: '18', BR: '10', CT: '22', CG: '22', GA: '30', GJ: '24', HR: '06', HP: '02', JK: '01', JH: '20',
  KA: '29', KL: '32', LA: '38', LD: '31', MP: '23', MH: '27', MN: '14', ML: '17', MZ: '15', NL: '13', OR: '21', OD: '21',
  PB: '03', RJ: '08', SK: '11', TN: '33', TS: '36', TG: '36', TR: '16', UK: '05', UT: '05', UP: '09', WB: '19', AN: '35',
  CH: '04', DN: '26', DD: '26', DL: '07', PY: '34',
};

/** A WooCommerce address state ('KA', 'Karnataka', '29') to a GST state code, or null when it isn't one. */
export function stateFromAddress(state: string | undefined | null): string | null {
  const s = (state ?? '').trim();
  if (!s) return null;
  if (/^\d{2}$/.test(s)) return STATES[s] ? s : null;
  const byCode = WOO_STATES[s.toUpperCase()];
  if (byCode) return byCode;
  const lower = s.toLowerCase().replace(/&/g, 'and');
  return Object.entries(STATES).find(([, n]) => n.toLowerCase() === lower)?.[0] ?? null;
}

// ------------------------------------------------------------------ GSTIN

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Shape, state code and check digit (the 15th character, mod-36 checksum). Catches most typing mistakes. */
export function gstinProblem(gstin: string): string | null {
  if (!GSTIN_SHAPE.test(gstin)) return 'A GSTIN is 15 characters, like 29ABCDE1234F1Z5';
  if (!STATES[gstin.slice(0, 2)] && gstin.slice(0, 2) !== '25' && gstin.slice(0, 2) !== '28') return 'The first two digits are not a GST state code';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = B36.indexOf(gstin[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  if (B36[(36 - (sum % 36)) % 36] !== gstin[14]) return 'This GSTIN has a typing mistake (its check digit does not match)';
  return null;
}

// ------------------------------------------------------------------ dates

/** Calendar date of an instant in the store's time zone: '2027-03-31'. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Indian financial year (April–March) of a local date: '2026-10-20' -> '2026-27', '2027-03-31' -> '2026-27'. */
export function financialYear(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Last day a GST credit note can still be issued for an invoice of financial year `fy` (s.34(2) as amended in 2022):
 * 30 November after the end of that year. Earlier filing of the annual return also closes it; that date isn't known here.
 */
export function creditNoteDeadline(fy: string): string {
  return `${Number(fy.slice(0, 4)) + 1}-11-30`;
}

/** Default prefix for a year's series: ('INV', '2026-27') -> 'INV/26-27/'. */
export function seriesPrefix(base: string, fy: string): string {
  return `${base}/${fy.slice(2)}/`;
}

// ------------------------------------------------------------------ amount in words (Indian system)

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function upTo99(n: number) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`; }
function upTo999(n: number) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? upTo99(r) : ''].filter(Boolean).join(' ');
}

/** 123456789n paise -> 'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only'. */
export function amountInWords(p: bigint): string {
  let r = Number(p / 100n);
  const ps = Number(p % 100n);
  const parts: string[] = [];
  const crore = Math.floor(r / 10000000); r %= 10000000;
  const lakh = Math.floor(r / 100000); r %= 100000;
  const thousand = Math.floor(r / 1000); r %= 1000;
  if (crore) parts.push(`${crore >= 100 ? upTo999(crore) : upTo99(crore)} Crore`);
  if (lakh) parts.push(`${upTo99(lakh)} Lakh`);
  if (thousand) parts.push(`${upTo99(thousand)} Thousand`);
  if (r) parts.push(upTo999(r));
  const words = parts.join(' ') || 'Zero';
  return `Rupees ${words}${ps ? ` and ${upTo99(ps)} Paise` : ''} Only`;
}
