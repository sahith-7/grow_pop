/** GS1 check digit for EAN-8, UPC-A (12), EAN-13 and GTIN-14: weights 3,1,3,1… from the right, excluding the check digit. */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

/** Null when the code is acceptable; otherwise the reason. Numeric codes of GS1 lengths must carry a valid check digit. */
export function barcodeProblem(code: string): string | null {
  if (!/^[0-9A-Za-z-]{4,64}$/.test(code)) return 'Use 4–64 letters, digits or hyphens';
  if (/^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length)) {
    if (gs1CheckDigit(code.slice(0, -1)) !== Number(code.at(-1))) return 'Check digit is wrong; re-scan or re-type the barcode';
  }
  return null;
}

export function ean13(prefix: string, seq: number): string {
  const body = prefix + String(seq).padStart(9, '0');
  return body + gs1CheckDigit(body);
}
