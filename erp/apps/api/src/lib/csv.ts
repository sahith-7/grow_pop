/**
 * RFC 4180 CSV. Small on purpose: comma separator, double-quote escaping, CRLF or LF, optional UTF-8 BOM.
 * Excel's "CSV UTF-8" output parses as-is.
 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error('A quoted value is never closed');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  // Drop fully blank lines (Excel leaves them at the end).
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** One CSV cell. Text starting with = + - @ tab or CR is prefixed with ' so spreadsheets do not run it as a formula. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',') + '\r\n';
