import type { FastifyRequest } from 'fastify';
import type { Tx } from '../../db.js';
import { appError, authOf } from '../../lib/phase1.js';
import type { Role } from '../../lib/permissions.js';
import { mainOutletId } from '../billing/profile.js';

// The outlet in view (v2, D115). The owner's outlet switcher saves one outlet, or "all", in the `gp_outlet` cookie; every
// back-office read that belongs to an outlet (dashboard, bills, returns, orders, stock, receipts, stocktakes, reports,
// cash) shows only that outlet. The cookie is a choice, not a permission: it is checked against the outlets this person
// may see on every request, and one they may not see is ignored.
//
// Who sees what: owners, managers and staff assigned to no outlet see every outlet (closed ones too, for their history).
// Staff assigned to outlets (Users → outlet) see only those, whatever the cookie says.
//
// What belongs to an outlet: a stock room (locations.outlet_id), so stock, movements, stocktakes and receipt lines; a bill
// or credit note through its series (invoice_series.outlet_id); a counter order through the stock room it sold from.
// Website orders have no stock room on the order and are billed from the main outlet's series, so they count there.

export const SCOPE_COOKIE = 'gp_outlet';

export interface VisibleOutlet { id: string; name: string; isMain: boolean; active: boolean }

export interface Scope {
  /** The one outlet chosen, or null for every outlet this person may see. */
  outlet: VisibleOutlet | null;
  /** Outlets in view; null = every outlet in the store (no filter needed). */
  ids: string[] | null;
  /** Stock rooms in view; null = all. */
  locs: string[] | null;
  /** Whether the main outlet is in view (website orders count there). */
  main: boolean;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The outlets this person may look at, main first, closed last; `everywhere` when not tied to any. */
export async function visibleOutlets(tx: Tx, userId: string, role: Role) {
  await mainOutletId(tx);
  const { rows: [u] } = await tx.query('SELECT EXISTS (SELECT 1 FROM user_outlets WHERE user_id = $1) AS tied', [userId]);
  const everywhere = role === 'owner' || role === 'manager' || !u.tied;
  const { rows } = await tx.query(
    `SELECT o.id, o.name, o.is_main, o.active FROM outlets o
      WHERE $2::boolean OR EXISTS (SELECT 1 FROM user_outlets x WHERE x.user_id = $1 AND x.outlet_id = o.id)
      ORDER BY NOT o.is_main, NOT o.active, o.created_at`, [userId, everywhere]);
  return {
    everywhere,
    items: rows.map((r): VisibleOutlet => ({ id: r.id, name: r.name, isMain: r.is_main, active: r.active })),
  };
}

/** The cookie's outlet id, if it looks like one ('' or anything else means all). */
export const scopeCookie = (req: FastifyRequest) => {
  const v = req.cookies?.[SCOPE_COOKIE];
  return v && uuid.test(v) ? v : null;
};

/**
 * The outlet scope for this request. `explicit` is an outlet named in the request itself (a page's own outlet filter):
 * it wins over the cookie and is refused, not ignored, when this person may not see it.
 */
export async function outletScope(tx: Tx, req: FastifyRequest, explicit?: string | null): Promise<Scope> {
  const a = authOf(req);
  const { everywhere, items } = await visibleOutlets(tx, a.userId, a.role);
  let pick: VisibleOutlet | null = null;
  if (explicit) {
    pick = items.find((o) => o.id === explicit) ?? null;
    if (!pick) throw appError(403, 'OUTLET_NOT_ALLOWED', 'You can’t see this outlet: you are not assigned to it.');
  } else {
    const c = scopeCookie(req);
    pick = (c && items.find((o) => o.id === c)) || null;
    // Tied to a single outlet: that is the only view there is.
    if (!pick && !everywhere && items.length === 1) pick = items[0];
  }
  const ids = pick ? [pick.id] : everywhere ? null : items.map((o) => o.id);
  if (!ids) return { outlet: null, ids: null, locs: null, main: true };
  const { rows } = await tx.query('SELECT id FROM locations WHERE outlet_id = ANY($1::uuid[])', [ids]);
  const main = items.some((o) => o.isMain && ids.includes(o.id));
  return { outlet: pick, ids, locs: rows.map((r) => r.id as string), main };
}

/** No outlet filter: the whole store (the owner's e-mail digests). */
export const ALL_OUTLETS: Scope = { outlet: null, ids: null, locs: null, main: true };

type P = (v: unknown) => string;

/** `col` (a stock room id) is in view. */
export const locIn = (s: Scope, col: string, p: P) => (s.locs ? `${col} = ANY(${p(s.locs)}::uuid[])` : 'true');

/** `col` (an invoice_series id, as on invoices and credit notes) is in view. */
export const seriesIn = (s: Scope, col: string, p: P) =>
  (s.ids ? `${col} IN (SELECT ss.id FROM invoice_series ss WHERE ss.outlet_id = ANY(${p(s.ids)}::uuid[]))` : 'true');

/** The sales order `o` is in view: a counter order by its stock room, a website order (no room) with the main outlet. */
export const orderIn = (s: Scope, o: string, p: P) =>
  (s.locs ? `(${o}.location_id = ANY(${p(s.locs)}::uuid[]) OR (${o}.location_id IS NULL AND ${s.main ? 'true' : 'false'}))` : 'true');

/** For SQL built with positional params: a `p` that appends to `params`. */
export const pusher = (params: unknown[]): P => (v) => { params.push(v); return `$${params.length}`; };

/** Scope as the API reports it to the screens. */
export const scopeOut = (s: Scope) => ({ outletId: s.outlet?.id ?? null, outletName: s.outlet?.name ?? null });
