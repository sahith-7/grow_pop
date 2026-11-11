'use client';

import { type Me, useMe } from './me';

// The outlet in view (v2, D115). The switcher in the top bar saves one outlet, or "all", in the `gp_outlet` cookie, and
// every back-office read that belongs to an outlet follows it on the server: dashboard, bills, returns, orders, stock,
// receipts, stocktakes, reports and cash. The cookie is a choice, not a permission: the API checks it against the outlets
// this person may see on every request and ignores one they may not. Staff tied to outlets (Users → outlet) see only theirs.
//
// This file is the screens' side: writing the cookie, reading what the API said is in view (/auth/me → outlets), and
// narrowing stock-room pickers to the rooms in view.

export const SCOPE_COOKIE = 'gp_outlet';

/** Saves the choice for this browser ('' = all outlets). The caller reloads what is on screen. */
export function writeOutletCookie(id: string) {
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = id
    ? `${SCOPE_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax${secure}`
    : `${SCOPE_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
}

/** The cookie as this browser holds it now (another tab may have changed it). */
export function readOutletCookie(): string {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${SCOPE_COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

/** The outlet in view: its id, or '' for every outlet this person may see. */
export function useOutletScope(): string {
  return useMe().outlets.current ?? '';
}

/** The outlet in view, with its name; null for all. */
export function useOutletInView() {
  const o = useMe().outlets;
  return o.current ? o.items.find((x) => x.id === o.current) ?? null : null;
}

/**
 * Stock rooms in view, for pickers on pages that work in one place (adjust, count, receive, reports): the chosen
 * outlet's rooms, or for staff tied to outlets, theirs. Rooms without an outlet id (older API) are kept.
 */
export function roomsInView<T extends { outletId?: string }>(o: Me['outlets'], rooms: T[]): T[] {
  if (o.current) return rooms.filter((r) => !r.outletId || r.outletId === o.current);
  if (!o.all) { const mine = new Set(o.items.map((x) => x.id)); return rooms.filter((r) => !r.outletId || mine.has(r.outletId)); }
  return rooms;
}

/** The same, for a hook-friendly call in a component body. */
export function useRoomsInView<T extends { outletId?: string }>(rooms: T[] | undefined): T[] {
  const o = useMe().outlets;
  return rooms ? roomsInView(o, rooms) : [];
}

/** Stock meta with only the rooms in view, for pages that post stock in one place. */
export const metaInView = <M extends { locations: { outletId?: string }[] }>(o: Me['outlets'], m: M): M => ({ ...m, locations: roomsInView(o, m.locations) });
