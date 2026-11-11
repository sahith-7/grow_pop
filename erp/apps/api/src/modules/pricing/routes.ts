import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { csvLine, parseCsv } from '../../lib/csv.js';
import { fmtMoney, money } from '../../lib/decimal.js';
import { idempotent } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { appError, audit, authOf, can, requires } from '../../lib/phase1.js';

// Bulk price updates (v2 batch 2, D97). Two ways in, one way out:
//   by rule        "raise selling price 5% in Biscuits, round to ₹1"  -> POST /price-updates/preview
//   by spreadsheet download prices.csv, edit, upload                   -> POST /price-updates/preview-sheet
// Both previews return the same rows; the person checks them and POST /price-updates applies exactly those rows.
// Every run keeps each variant's old and new values (price_update_lines), so it can be checked later and undone.
// Price changes reach WooCommerce through the existing product_variants triggers (B4); nothing extra is sent here.

const MAX_ROWS = 2000;
const uuid = z.string().uuid();
const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const invalid = (fieldErrors: Record<string, string[]>, message = 'Check the highlighted fields') => appError(400, 'VALIDATION_ERROR', message, fieldErrors);

const filter = z.object({
  categoryId: uuid.optional(),
  brandId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
  productIds: z.array(uuid).min(1).max(500).optional(),
}).strict();

const ruleInput = z.object({
  filter: filter.default({}),
  field: z.enum(['price', 'mrp', 'cost']),
  method: z.enum(['increase_pct', 'decrease_pct', 'increase_amt', 'decrease_amt', 'set', 'mrp_less_pct', 'cost_plus_pct']),
  value: money,
  rounding: z.enum(['none', '1', '5', '10']).default('none'),
}).strict().superRefine((r, ctx) => {
  const pct = r.method.endsWith('_pct');
  if (pct && Number(r.value) > (r.method === 'increase_pct' || r.method === 'cost_plus_pct' ? 1000 : 100)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: r.method === 'increase_pct' || r.method === 'cost_plus_pct' ? 'At most 1000%' : 'At most 100%' });
  }
  if ((r.method === 'mrp_less_pct' || r.method === 'cost_plus_pct') && r.field !== 'price') {
    ctx.addIssue({ code: 'custom', path: ['method'], message: 'Only the selling price can be worked out from the MRP or cost' });
  }
});

const sheetInput = z.object({ csv: z.string().min(1, 'The file is empty').max(1_000_000, 'The file is too big. Split it into smaller sheets.') }).strict();

const applyInput = z.object({
  source: z.enum(['rule', 'sheet']),
  description: z.string().trim().min(1, 'Describe the change').max(300),
  lines: z.array(z.object({
    variantId: uuid,
    version: z.number().int().min(1),
    price: money.optional(),
    mrp: money.nullable().optional(),
    cost: money.nullable().optional(),
  }).strict()).min(1, 'Nothing to change').max(MAX_ROWS),
}).strict();

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(400).optional() }).strict();
const idParam = z.object({ id: uuid });

// ------------------------------------------------------------------ preview rows
interface Proposed { id: string; price?: string; mrp?: string | null; cost?: string | null; problem?: string }

/**
 * Current and proposed values for each variant, worked out in Postgres numeric so no amount passes through a JS float.
 * A row whose values do not change is counted, not returned.
 */
async function diffRows(t: Tx, proposed: Proposed[], showCost: boolean) {
  const preset = new Map(proposed.filter((p) => p.problem).map((p) => [p.id, p.problem!]));
  const { rows } = await t.query(
    `WITH i AS (SELECT * FROM unnest($1::uuid[], $2::numeric[], $3::numeric[], $4::numeric[], $5::bool[], $6::bool[], $7::bool[])
                  AS t(id, price, mrp, cost, sp, sm, sc)),
          d AS (SELECT v.id, v.product_id, v.version, v.sku, v.attributes, v.position, p.name, v.price, v.mrp, v.cost,
                       CASE WHEN i.sp THEN i.price ELSE v.price END AS n_price,
                       CASE WHEN i.sm THEN i.mrp ELSE v.mrp END AS n_mrp,
                       CASE WHEN i.sc THEN i.cost ELSE v.cost END AS n_cost
                  FROM i JOIN product_variants v ON v.id = i.id JOIN products p ON p.id = v.product_id)
     SELECT d.*, (d.n_price, d.n_mrp, d.n_cost) IS DISTINCT FROM (d.price, d.mrp, d.cost) AS changed,
            CASE WHEN d.n_price < 0 OR d.n_mrp < 0 OR d.n_cost < 0 THEN 'below_zero'
                 WHEN d.n_mrp IS NOT NULL AND d.n_price > d.n_mrp THEN 'above_mrp' END AS problem
       FROM d ORDER BY lower(d.name), d.product_id, d.position, d.id`,
    [proposed.map((p) => p.id), proposed.map((p) => p.price ?? null), proposed.map((p) => p.mrp ?? null), proposed.map((p) => p.cost ?? null),
      proposed.map((p) => p.price !== undefined), proposed.map((p) => p.mrp !== undefined), proposed.map((p) => p.cost !== undefined)]);
  const message = (r: Record<string, any>): string | null => {
    const code = preset.get(r.id) ?? r.problem;
    if (!code) return null;
    if (code === 'below_zero') return 'Would go below ₹0';
    if (code === 'above_mrp') return `Selling price ₹${fmtMoney(r.n_price)} would be above the MRP ₹${fmtMoney(r.n_mrp)}`;
    return code;
  };
  const out = rows.filter((r) => r.changed || preset.has(r.id)).map((r) => ({
    variantId: r.id as string, productId: r.product_id as string, version: r.version as number, sku: r.sku as string, name: r.name as string,
    attributes: r.attributes as Record<string, string>,
    current: { price: fmtMoney(r.price)!, mrp: fmtMoney(r.mrp), cost: showCost ? fmtMoney(r.cost) : null },
    next: { price: fmtMoney(r.n_price)!, mrp: fmtMoney(r.n_mrp), cost: showCost ? fmtMoney(r.n_cost) : null },
    problem: message(r),
  }));
  return { rows: out, unchanged: rows.length - out.length, ok: out.filter((r) => !r.problem).length };
}

/** Variants the rule applies to: active ones of products that are not archived. Categories include their sub-categories. */
async function matchVariants(t: Tx, f: z.infer<typeof filter>) {
  const params: unknown[] = [];
  const where = ["v.status = 'active'", "p.status <> 'archived'"];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.categoryId) where.push(`(p.category_id = ${p(f.categoryId)} OR p.category_id IN (SELECT id FROM categories WHERE parent_id = $${params.length}))`);
  if (f.brandId) where.push(`p.brand_id = ${p(f.brandId)}`);
  if (f.q) where.push(`(p.name ILIKE '%' || ${p(f.q.replace(/[%_\\]/g, '\\$&'))} || '%' OR v.sku ILIKE '%' || $${params.length} || '%')`);
  if (f.productIds) where.push(`p.id = ANY(${p(f.productIds)}::uuid[])`);
  params.push(MAX_ROWS + 1);
  const { rows } = await t.query(
    `SELECT v.id, v.price, v.mrp, v.cost FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE ${where.join(' AND ')} ORDER BY v.id LIMIT $${params.length}`, params);
  if (rows.length > MAX_ROWS) throw appError(400, 'TOO_MANY', `More than ${MAX_ROWS.toLocaleString('en-IN')} items match. Pick a category or brand to change them in parts.`);
  return rows.map((r) => r.id as string);
}

/** The rule's new value for each matched variant, computed by Postgres. */
async function applyRule(t: Tx, ids: string[], r: z.infer<typeof ruleInput>): Promise<Proposed[]> {
  const b = r.method === 'mrp_less_pct' ? 'v.mrp' : r.method === 'cost_plus_pct' ? 'v.cost' : `v.${r.field}`;
  const raw = {
    increase_pct: `${b} * (1 + $2::numeric / 100)`, decrease_pct: `${b} * (1 - $2::numeric / 100)`,
    increase_amt: `${b} + $2::numeric`, decrease_amt: `${b} - $2::numeric`, set: '$2::numeric',
    mrp_less_pct: `${b} * (1 - $2::numeric / 100)`, cost_plus_pct: `${b} * (1 + $2::numeric / 100)`,
  }[r.method];
  // Round to paise, or to the nearest ₹1, ₹5 or ₹10 (half up, as Postgres round() does for numeric).
  const rounded = r.rounding === 'none' ? `round(${raw}, 2)` : `round((${raw}) / ${Number(r.rounding)}) * ${Number(r.rounding)}`;
  const { rows } = await t.query(`SELECT v.id, ${b} IS NULL AS missing, ${rounded} AS n FROM product_variants v WHERE v.id = ANY($1::uuid[])`, [ids, r.value]);
  const what = r.method === 'mrp_less_pct' || r.field === 'mrp' ? 'No MRP set' : 'No cost price set';
  return rows.map((x) => (x.missing && r.method !== 'set' ? { id: x.id, problem: what } : { id: x.id, [r.field]: x.n as string }));
}

// ------------------------------------------------------------------ spreadsheet
const SHEET_COLS = ['sku', 'barcode', 'product', 'variant', 'price', 'mrp', 'cost'] as const;

/** "₹1,299.50" or " 1299.5 " -> "1299.5"; blank -> undefined (leave as is). */
function cellMoney(raw: string | undefined): string | undefined | Error {
  if (raw === undefined) return undefined;
  const v = raw.replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  if (v === '') return undefined;
  return money.safeParse(v).success ? v : new Error(`“${raw.trim()}” is not an amount`);
}

async function sheetRows(t: Tx, text: string, showCost: boolean) {
  let table: string[][];
  try { table = parseCsv(text); } catch (e) { throw invalid({ csv: [(e as Error).message] }, 'The file could not be read as CSV'); }
  if (table.length < 2) throw invalid({ csv: ['The sheet has no rows under the heading row'] });
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (k: string) => head.indexOf(k);
  if (col('sku') < 0) throw invalid({ csv: ['The heading row needs a “sku” column. Start from the downloaded price sheet.'] });
  const has = { price: col('price') >= 0, mrp: col('mrp') >= 0, cost: col('cost') >= 0 };
  if (!has.price && !has.mrp && !has.cost) throw invalid({ csv: ['Add at least one of the columns price, mrp or cost'] });
  if (has.cost && !showCost) throw appError(403, 'FORBIDDEN', 'You cannot change cost prices. Remove the cost column.');
  const data = table.slice(1);
  if (data.length > MAX_ROWS) throw appError(400, 'TOO_MANY', `The sheet has ${data.length} rows; the most at once is ${MAX_ROWS}. Split it into smaller sheets.`);

  const skus = [...new Set(data.map((r) => (r[col('sku')] ?? '').trim().toLowerCase()).filter(Boolean))];
  const { rows: found } = await t.query(
    `SELECT v.id, lower(v.sku) AS k, v.status, p.status AS product_status FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE lower(v.sku) = ANY($1::text[])`, [skus]);
  const bySku = new Map(found.map((f) => [f.k as string, f]));

  const errors: { row: number; sku: string; message: string }[] = [];
  const seen = new Set<string>();
  const proposed: Proposed[] = [];
  data.forEach((r, i) => {
    const line = i + 2; // as the spreadsheet numbers it: heading is row 1
    const sku = (r[col('sku')] ?? '').trim();
    if (!sku) { if (r.some((c) => c.trim())) errors.push({ row: line, sku: '', message: 'No SKU' }); return; }
    const v = bySku.get(sku.toLowerCase());
    if (!v) { errors.push({ row: line, sku, message: 'No item has this SKU' }); return; }
    if (v.status !== 'active' || v.product_status === 'archived') { errors.push({ row: line, sku, message: 'Archived. Restore it first.' }); return; }
    if (seen.has(v.id)) { errors.push({ row: line, sku, message: 'This SKU is in the sheet twice' }); return; }
    seen.add(v.id);
    const p: Proposed = { id: v.id };
    for (const f of ['price', 'mrp', 'cost'] as const) {
      if (!has[f]) continue;
      const m = cellMoney(r[col(f)]);
      if (m instanceof Error) { errors.push({ row: line, sku, message: `${f === 'price' ? 'Price' : f === 'mrp' ? 'MRP' : 'Cost'}: ${m.message}` }); return; }
      if (m !== undefined) p[f] = m;
    }
    if (p.price !== undefined || p.mrp !== undefined || p.cost !== undefined) proposed.push(p);
  });
  const diff = proposed.length ? await diffRows(t, proposed, showCost) : { rows: [], unchanged: 0, ok: 0 };
  return { ...diff, errors, sheetRows: data.length };
}

// ------------------------------------------------------------------ apply and undo
async function apply(t: Tx, req: FastifyRequest, input: z.infer<typeof applyInput>) {
  const showCost = can(req, 'cost.view');
  if (!showCost && input.lines.some((l) => l.cost !== undefined)) throw appError(403, 'FORBIDDEN', 'You cannot change cost prices');
  const ids = input.lines.map((l) => l.variantId);
  if (new Set(ids).size !== ids.length) throw invalid({ lines: ['The same item is in the list twice'] });

  const { rows: cur } = await t.query(
    `SELECT v.id, v.sku, v.version, v.status, p.status AS product_status FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ANY($1::uuid[]) ORDER BY v.id FOR UPDATE OF v`, [ids]);
  const byId = new Map(cur.map((r) => [r.id as string, r]));
  const errs: Record<string, string[]> = {};
  input.lines.forEach((l, i) => {
    const v = byId.get(l.variantId);
    if (!v) errs[`lines.${i}.variantId`] = ['Item not found'];
    else if (v.status !== 'active' || v.product_status === 'archived') errs[`lines.${i}.variantId`] = [`${v.sku} is archived`];
  });
  if (Object.keys(errs).length) throw invalid(errs);
  const stale = input.lines.filter((l) => byId.get(l.variantId)!.version !== l.version).map((l) => byId.get(l.variantId)!.sku as string);
  if (stale.length) {
    throw appError(409, 'STALE', `${stale.length === 1 ? `${stale[0]} was` : `${stale.length} items were`} changed by someone else after you checked. Check the changes again.`,
      { lines: [stale.slice(0, 20).join(', ')] });
  }

  const diff = await diffRows(t, input.lines.map((l) => ({ id: l.variantId, price: l.price, mrp: l.mrp, cost: l.cost })), true);
  const bad = diff.rows.filter((r) => r.problem);
  if (bad.length) throw invalid({ lines: bad.slice(0, 20).map((r) => `${r.sku}: ${r.problem}`) }, 'Some prices cannot be saved');
  if (!diff.rows.length) throw invalid({ lines: ['Every price is already what you asked for'] }, 'Nothing changes');

  const userId = authOf(req).userId;
  const { rows: [run] } = await t.query(
    `INSERT INTO price_updates (tenant_id, source, description, variant_count, created_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4) RETURNING id, created_at`,
    [input.source, input.description, diff.rows.length, userId]);
  // Old values are read again under the row locks taken above, so what is recorded is exactly what is replaced.
  const changed = diff.rows.map((r) => r.variantId);
  const line = new Map(input.lines.map((l) => [l.variantId, l]));
  const ls = changed.map((id) => line.get(id)!);
  await t.query(
    `WITH i AS (SELECT * FROM unnest($2::uuid[], $3::numeric[], $4::numeric[], $5::numeric[], $6::bool[], $7::bool[], $8::bool[])
                  AS t(id, price, mrp, cost, sp, sm, sc)),
          ins AS (
            INSERT INTO price_update_lines (tenant_id, update_id, variant_id, old_price, new_price, old_mrp, new_mrp, old_cost, new_cost)
            SELECT v.tenant_id, $1, v.id, v.price, CASE WHEN i.sp THEN i.price ELSE v.price END,
                   v.mrp, CASE WHEN i.sm THEN i.mrp ELSE v.mrp END, v.cost, CASE WHEN i.sc THEN i.cost ELSE v.cost END
              FROM i JOIN product_variants v ON v.id = i.id
            RETURNING variant_id, new_price, new_mrp, new_cost)
     UPDATE product_variants v SET price = ins.new_price, mrp = ins.new_mrp, cost = ins.new_cost, version = v.version + 1, updated_at = now()
       FROM ins WHERE v.id = ins.variant_id`,
    [run.id, changed, ls.map((l) => l.price ?? null), ls.map((l) => l.mrp ?? null), ls.map((l) => l.cost ?? null),
      ls.map((l) => l.price !== undefined), ls.map((l) => l.mrp !== undefined), ls.map((l) => l.cost !== undefined)]);
  await audit(t, { actorId: userId, action: 'price.bulk_update', entityType: 'price_update', entityId: run.id,
    summary: { source: input.source, description: input.description, variants: diff.rows.length } });
  return { id: run.id as string, variantCount: diff.rows.length, createdAt: run.created_at as Date };
}

async function undo(t: Tx, req: FastifyRequest, id: string) {
  const { rows: [run] } = await t.query('SELECT * FROM price_updates WHERE id = $1 FOR UPDATE', [id]);
  if (!run) throw appError(404, 'NOT_FOUND', 'Price update not found');
  if (run.undone_at) throw appError(409, 'ALREADY_UNDONE', 'This price update was already undone');
  await t.query(
    `SELECT v.id FROM product_variants v JOIN price_update_lines l ON l.variant_id = v.id WHERE l.update_id = $1 ORDER BY v.id FOR UPDATE OF v`, [id]);
  // Only items still at this run's new values go back. One changed again since (by hand, a later run or an import)
  // keeps its newer price: undoing must never overwrite someone else's later change.
  const { rows: back } = await t.query(
    `UPDATE product_variants v SET price = l.old_price, mrp = l.old_mrp, cost = l.old_cost, version = v.version + 1, updated_at = now()
       FROM price_update_lines l
      WHERE l.update_id = $1 AND v.id = l.variant_id AND v.status = 'active'
        AND v.price = l.new_price AND v.mrp IS NOT DISTINCT FROM l.new_mrp AND v.cost IS NOT DISTINCT FROM l.new_cost
      RETURNING v.id`, [id]);
  const { rows: kept } = await t.query(
    `SELECT v.sku FROM price_update_lines l JOIN product_variants v ON v.id = l.variant_id
      WHERE l.update_id = $1 AND NOT (v.id = ANY($2::uuid[])) ORDER BY v.sku LIMIT 50`, [id, back.map((b) => b.id)]);
  const userId = authOf(req).userId;
  await t.query('UPDATE price_updates SET undone_at = now(), undone_by = $2, undone_count = $3 WHERE id = $1', [id, userId, back.length]);
  await audit(t, { actorId: userId, action: 'price.bulk_undo', entityType: 'price_update', entityId: id,
    summary: { restored: back.length, kept: run.variant_count - back.length } });
  return { restored: back.length, kept: run.variant_count - back.length, keptSkus: kept.map((k) => k.sku as string) };
}

const runOut = (r: Record<string, any>) => ({
  id: r.id as string, source: r.source as 'rule' | 'sheet', description: r.description as string, variantCount: r.variant_count as number,
  createdAt: r.created_at as Date, createdBy: (r.created_by_name as string | null) ?? null,
  undoneAt: r.undone_at as Date | null, undoneBy: (r.undone_by_name as string | null) ?? null, undoneCount: r.undone_count as number | null,
});

export async function pricingRoutes(app: FastifyInstance) {
  const bulk = { preHandler: requires('price.bulk') };

  app.post('/price-updates/preview', bulk, async (req) => {
    const r = ruleInput.parse(req.body);
    const showCost = can(req, 'cost.view');
    if (r.field === 'cost' && !showCost) throw appError(403, 'FORBIDDEN', 'You cannot change cost prices');
    return tx(req, async (t) => {
      const ids = await matchVariants(t, r.filter);
      if (!ids.length) return { rows: [], unchanged: 0, ok: 0, matched: 0 };
      return { ...(await diffRows(t, await applyRule(t, ids, r), showCost)), matched: ids.length };
    });
  });

  app.post('/price-updates/preview-sheet', { ...bulk, bodyLimit: 1_100_000 }, async (req) => {
    const { csv } = sheetInput.parse(req.body);
    return tx(req, (t) => sheetRows(t, csv, can(req, 'cost.view')));
  });

  app.post('/price-updates', bulk, async (req, reply) => {
    if (req.headers['idempotency-key'] === undefined) throw appError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required');
    const input = applyInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], { url: req.url, body: req.body }, async () =>
      ({ status: 201, body: await apply(t, req, input) })));
    return reply.code(out.status).send(out.body);
  });

  app.get('/price-updates', bulk, async (req) => {
    const q = listQuery.parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.string(), uuid]));
    return tx(req, async (t) => {
      const params: unknown[] = [q.limit + 1];
      let cond = '';
      if (after) { params.push(after[0], after[1]); cond = 'WHERE (r.created_at, r.id) < ($2::timestamptz, $3::uuid)'; }
      const { rows } = await t.query(
        `SELECT r.*, cu.name AS created_by_name, uu.name AS undone_by_name FROM price_updates r
           LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users uu ON uu.id = r.undone_by
           ${cond} ORDER BY r.created_at DESC, r.id DESC LIMIT $1`, params);
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return { items: items.map(runOut), nextCursor: rows.length > q.limit ? encodeCursor([last.created_at.toISOString(), last.id]) : null };
    });
  });

  app.get('/price-updates/:id', bulk, async (req) => {
    const { id } = idParam.parse(req.params);
    const showCost = can(req, 'cost.view');
    return tx(req, async (t) => {
      const { rows: [r] } = await t.query(
        `SELECT r.*, cu.name AS created_by_name, uu.name AS undone_by_name FROM price_updates r
           LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users uu ON uu.id = r.undone_by WHERE r.id = $1`, [id]);
      if (!r) throw appError(404, 'NOT_FOUND', 'Price update not found');
      const { rows: lines } = await t.query(
        `SELECT l.*, v.sku, v.attributes, p.name, p.id AS product_id,
                (v.price = l.new_price AND v.mrp IS NOT DISTINCT FROM l.new_mrp AND v.cost IS NOT DISTINCT FROM l.new_cost) AS current
           FROM price_update_lines l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
          WHERE l.update_id = $1 ORDER BY lower(p.name), v.position, v.id`, [id]);
      return {
        ...runOut(r),
        lines: lines.map((l) => ({
          variantId: l.variant_id as string, productId: l.product_id as string, sku: l.sku as string, name: l.name as string, attributes: l.attributes as Record<string, string>,
          old: { price: fmtMoney(l.old_price)!, mrp: fmtMoney(l.old_mrp), cost: showCost ? fmtMoney(l.old_cost) : null },
          new: { price: fmtMoney(l.new_price)!, mrp: fmtMoney(l.new_mrp), cost: showCost ? fmtMoney(l.new_cost) : null },
          stillCurrent: l.current as boolean,
        })),
      };
    });
  });

  app.post('/price-updates/:id/undo', bulk, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, (t) => undo(t, req, id));
  });

  // The price sheet: today's prices for the chosen items, to edit in a spreadsheet and upload back.
  app.get('/exports/prices.csv', { ...bulk, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const f = z.object({ categoryId: uuid.optional(), brandId: uuid.optional(), q: z.string().trim().max(100).optional() }).strict().parse(req.query);
    const showCost = can(req, 'cost.view');
    const body = await tx(req, async (t) => {
      const ids = await matchVariants(t, f);
      const { rows } = await t.query(
        `SELECT v.sku, v.barcode, p.name, v.attributes, v.price, v.mrp, v.cost FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE v.id = ANY($1::uuid[]) ORDER BY lower(p.name), v.position, v.id`, [ids]);
      await audit(t, { actorId: authOf(req).userId, action: 'export.prices', entityType: 'export', summary: { rows: rows.length, cost: showCost } });
      const cols = SHEET_COLS.filter((c) => c !== 'cost' || showCost);
      return '﻿' + csvLine(cols) + rows.map((r) => {
        const v: Record<string, unknown> = {
          sku: r.sku, barcode: r.barcode, product: r.name, variant: Object.values(r.attributes as Record<string, string>).join(' / '),
          price: fmtMoney(r.price), mrp: fmtMoney(r.mrp), cost: fmtMoney(r.cost),
        };
        return csvLine(cols.map((c) => v[c]));
      }).join('');
    });
    return reply.headers({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="prices-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' }).send(body);
  });
}
