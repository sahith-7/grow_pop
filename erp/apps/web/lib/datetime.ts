// Dates and times always in India Standard Time (Asia/Kolkata, UTC+5:30), whatever the device's clock is set to (v2, D93).
// Andhra Pradesh, Telangana and the rest of India share one zone with no daylight saving. Day-month-year order, as on bills.

export const IST = 'Asia/Kolkata';

const date = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const time = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true });
const stamp = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });

type When = string | number | Date;
const d = (v: When) => (v instanceof Date ? v : new Date(v));

/** 08 Nov 2026 */
export const fmtDate = (v: When | null | undefined) => (v == null || v === '' ? '—' : date.format(d(v)));
/** 08 Nov 2026, 2:05 pm */
export const fmtDateTime = (v: When | null | undefined) => (v == null || v === '' ? '—' : dateTime.format(d(v)));
/** 2:05 pm */
export const fmtTime = (v: When) => time.format(d(v));
/** 08/11/2026, 14:05:09 (the dashboard's "last synced") */
export const fmtStamp = (v: When) => stamp.format(d(v));
/** A calendar day "2026-11-08" (no time zone) shown as 08 Nov 2026. */
export const fmtDay = (day: string | null | undefined) => {
  if (!day) return '—';
  const [y, m, dd] = day.split('-').map(Number);
  return date.format(new Date(Date.UTC(y, m - 1, dd, 6, 30)));   // 12:00 IST that day
};
/** Today in India as YYYY-MM-DD, for date inputs and API filters. */
export const todayIST = (now: When = Date.now()) => ymd.format(d(now));
/** YYYY-MM-DD plus n days. */
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Start of the store day as an ISO instant (for APIs that take timestamps): 2026-11-08 → 2026-11-07T18:30:00.000Z */
export const istDayStart = (day: string, plusDays = 0) => new Date(Date.parse(`${addDays(day, plusDays)}T00:00:00+05:30`)).toISOString();
