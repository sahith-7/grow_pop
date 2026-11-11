// Label sizes and settings (v2, D98). Built-in sizes are here; a store's own sizes are saved with its label settings.
// Measurements in millimetres. A roll prints one row per page (the printer feeds one row of labels at a time);
// a sheet (A4, A5) prints as many rows as fit, page by page.

export type Paper = 'roll' | 'a4' | 'a5';
export interface Layout {
  id: string; name: string; paper: Paper; widthMm: number; heightMm: number; columns: number;
  gapXMm: number; gapYMm: number; marginTopMm: number; marginLeftMm: number;
}
export type Design = 'standard' | 'mrp' | 'compact';
export interface Show { store: boolean; name: boolean; variant: boolean; sku: boolean; price: boolean; mrp: boolean; netWeight: boolean; codeText: boolean }
export interface LabelSettings { layout: string; design: Design; show: Show; custom: Layout[] }

export const PAPER_SIZE: Record<Paper, { w: number; h: number | null }> = { roll: { w: 120, h: null }, a4: { w: 210, h: 297 }, a5: { w: 148, h: 210 } };

const L = (id: string, name: string, paper: Paper, widthMm: number, heightMm: number, columns = 1, gapXMm = 0, gapYMm = 0, marginTopMm = 0, marginLeftMm = 0): Layout =>
  ({ id, name, paper, widthMm, heightMm, columns, gapXMm, gapYMm, marginTopMm, marginLeftMm });

export const PRESETS: Layout[] = [
  L('roll-50x25', '50 × 25 mm', 'roll', 50, 25),
  L('roll-38x25', '38 × 25 mm', 'roll', 38, 25),
  L('roll-50x38', '50 × 38 mm', 'roll', 50, 38),
  L('roll-50x38-2', '50 × 38 mm, 2 across (2-up roll)', 'roll', 50, 38, 2, 2),
  L('roll-38x25-2', '38 × 25 mm, 2 across (2-up roll)', 'roll', 38, 25, 2, 2),
  L('roll-35x25-3', '35 × 25 mm, 3 across (3-up roll)', 'roll', 35, 25, 3, 2),
  L('roll-100x50', '100 × 50 mm (shelf or carton)', 'roll', 100, 50),
  L('a4-65', '65 per sheet (38.1 × 21.2 mm)', 'a4', 38.1, 21.2, 5, 2.5, 0, 10.7, 4.65),
  L('a4-40', '40 per sheet (52.5 × 29.7 mm)', 'a4', 52.5, 29.7, 4),
  L('a4-24', '24 per sheet (63.5 × 33.9 mm)', 'a4', 63.5, 33.9, 3, 2.5, 0, 12.9, 7.25),
  L('a4-21', '21 per sheet (63.5 × 38.1 mm)', 'a4', 63.5, 38.1, 3, 2.5, 0, 15.15, 7.25),
  L('a4-12', '12 per sheet (105 × 48 mm)', 'a4', 105, 48, 2, 0, 0, 4.5),
  L('a4-8', '8 per sheet (99.1 × 67.7 mm)', 'a4', 99.1, 67.7, 2, 2.5, 0, 13.1, 4.65),
  L('a4-6', '6 per sheet (105 × 99 mm)', 'a4', 105, 99, 2),
  L('a4-4', '4 per sheet (105 × 148.5 mm)', 'a4', 105, 148.5, 2),
  L('a4-2', '2 per sheet (210 × 148.5 mm)', 'a4', 210, 148.5),
  L('a4-1', '1 per sheet (200 × 287 mm)', 'a4', 200, 287, 1, 0, 0, 5, 5),
  L('a5-8', '8 per sheet (74 × 52.5 mm)', 'a5', 74, 52.5, 2),
  L('a5-4', '4 per sheet (74 × 105 mm)', 'a5', 74, 105, 2),
  L('a5-2', '2 per sheet (148 × 105 mm)', 'a5', 148, 105),
  L('a5-1', '1 per sheet (138 × 200 mm)', 'a5', 138, 200, 1, 0, 0, 5, 5),
];

export const PAPER_LABEL: Record<Paper, string> = { roll: 'Label printer roll', a4: 'A4 sheets', a5: 'A5 sheets' };

export const DEFAULTS: LabelSettings = {
  layout: 'roll-50x25', design: 'standard',
  show: { store: false, name: true, variant: true, sku: false, price: true, mrp: true, netWeight: false, codeText: true },
  custom: [],
};

/** Width of one printed row, and for sheets how many rows fit on a page. */
export function geometry(l: Layout) {
  const rowWidth = l.columns * l.widthMm + (l.columns - 1) * l.gapXMm + 2 * l.marginLeftMm;
  const paper = PAPER_SIZE[l.paper];
  const pageW = l.paper === 'roll' ? rowWidth : paper.w;
  const pageH = l.paper === 'roll' ? l.heightMm : paper.h!;
  const rows = l.paper === 'roll' ? 1 : Math.max(1, Math.floor((pageH - 2 * l.marginTopMm + l.gapYMm + 0.01) / (l.heightMm + l.gapYMm)));
  return { pageW, pageH, rows, perPage: rows * l.columns, fits: rowWidth <= PAPER_SIZE[l.paper].w + 0.01 };
}
