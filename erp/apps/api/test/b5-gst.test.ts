import { describe, expect, it } from 'vitest';
import {
  amountInWords, creditNoteDeadline, financialYear, gstinProblem, lineTax, localDate, paise, pctOf, rateBp, roundOff, rupees,
  stateFromAddress, stateTaxLabel,
} from '../src/lib/gst.js';
import { gstin } from './b5-helpers.js';

// The worked examples a tax adviser signs off (D7) are in docs/design/gst-examples.md; each one is checked here.
const r = (t: ReturnType<typeof lineTax>) => ({ taxable: rupees(t.taxable), cgst: rupees(t.cgst), sgst: rupees(t.sgst), igst: rupees(t.igst), total: rupees(t.total) });

describe('B5 GST arithmetic', () => {
  it('splits a GST-inclusive price into taxable value and equal CGST/SGST halves that add back exactly', () => {
    expect(r(lineTax(paise('1180'), rateBp('18'), 'intra', true))).toEqual({ taxable: '1000.00', cgst: '90.00', sgst: '90.00', igst: '0.00', total: '1180.00' });
    expect(r(lineTax(paise('100'), rateBp('18'), 'intra', true))).toEqual({ taxable: '84.74', cgst: '7.63', sgst: '7.63', igst: '0.00', total: '100.00' });
    expect(r(lineTax(paise('100'), rateBp('5'), 'intra', true))).toEqual({ taxable: '95.24', cgst: '2.38', sgst: '2.38', igst: '0.00', total: '100.00' });
    expect(r(lineTax(paise('999'), rateBp('40'), 'intra', true))).toEqual({ taxable: '713.58', cgst: '142.71', sgst: '142.71', igst: '0.00', total: '999.00' });
    expect(r(lineTax(paise('5000'), rateBp('3'), 'intra', true))).toEqual({ taxable: '4854.36', cgst: '72.82', sgst: '72.82', igst: '0.00', total: '5000.00' });
    expect(r(lineTax(paise('10'), rateBp('0.25'), 'intra', true))).toEqual({ taxable: '9.98', cgst: '0.01', sgst: '0.01', igst: '0.00', total: '10.00' });
  });

  it('inter-state is one IGST amount; exempt goods carry no tax', () => {
    expect(r(lineTax(paise('100'), rateBp('18'), 'inter', true))).toEqual({ taxable: '84.75', cgst: '0.00', sgst: '0.00', igst: '15.25', total: '100.00' });
    expect(r(lineTax(paise('250'), 0n, 'intra', true))).toEqual({ taxable: '250.00', cgst: '0.00', sgst: '0.00', igst: '0.00', total: '250.00' });
  });

  it('adds tax on top when prices exclude GST', () => {
    expect(r(lineTax(paise('100'), rateBp('18'), 'intra', false))).toEqual({ taxable: '100.00', cgst: '9.00', sgst: '9.00', igst: '0.00', total: '118.00' });
    expect(r(lineTax(paise('33.33'), rateBp('5'), 'intra', false))).toEqual({ taxable: '33.33', cgst: '0.83', sgst: '0.83', igst: '0.00', total: '34.99' });
    expect(r(lineTax(paise('33.33'), rateBp('5'), 'inter', false))).toEqual({ taxable: '33.33', cgst: '0.00', sgst: '0.00', igst: '1.67', total: '35.00' });
  });

  it('rounds the bill to the nearest rupee only when the store chooses to', () => {
    expect([roundOff(paise('99.50'), true), roundOff(paise('99.49'), true), roundOff(paise('100'), true), roundOff(paise('99.50'), false)]).toEqual([50n, -49n, 0n, 0n]);
  });

  it('works out discounts in paise, half up', () => {
    expect(rupees(pctOf(paise('999'), '12.5'))).toBe('124.88');
    expect(rupees(pctOf(paise('0.05'), '10'))).toBe('0.01');
  });

  it('checks a GSTIN check digit and state', () => {
    expect(gstinProblem('27AAPFU0939F1ZV')).toBeNull();                 // published example
    expect(gstinProblem('27AAPFU0939F1ZA')).toMatch(/check digit/);
    expect(gstinProblem('27aapfu0939f1zv')).toMatch(/15 characters/);
    expect(gstinProblem(gstin('99'))).toMatch(/state code/);
    expect(gstinProblem(gstin('04'))).toBeNull();
  });

  it('knows the financial year and the credit-note deadline', () => {
    expect([financialYear('2026-04-01'), financialYear('2027-03-31'), financialYear('2027-04-01')]).toEqual(['2026-27', '2026-27', '2027-28']);
    expect(financialYear(localDate(new Date('2027-03-31T19:00:00Z'), 'Asia/Kolkata'))).toBe('2027-28');   // 00:30 IST on 1 April
    expect(creditNoteDeadline('2026-27')).toBe('2027-11-30');
  });

  it('maps WooCommerce states to GST state codes and labels UTGST', () => {
    expect([stateFromAddress('KA'), stateFromAddress('TS'), stateFromAddress('Tamil Nadu'), stateFromAddress('DL'), stateFromAddress('XX'), stateFromAddress('')])
      .toEqual(['29', '36', '33', '07', null, null]);
    expect([stateTaxLabel('04'), stateTaxLabel('38'), stateTaxLabel('07'), stateTaxLabel('27')]).toEqual(['UTGST', 'UTGST', 'SGST', 'SGST']);
  });

  it('writes amounts in words the Indian way', () => {
    expect(amountInWords(paise('1234567.89'))).toBe('Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only');
    expect(amountInWords(paise('1390'))).toBe('Rupees One Thousand Three Hundred Ninety Only');
    expect(amountInWords(paise('0'))).toBe('Rupees Zero Only');
  });
});
