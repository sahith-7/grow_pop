import { z } from 'zod';
import type { Tx } from '../../db.js';

// In-app notifications (v2, D112): the bell in the top bar. Written in the same transaction as what they report, so a
// notification never describes something that didn't happen. Only "register closed" for now; e-mail goes by the job
// queue and SMS waits for DLT registration.

export const readInput = z.object({ ids: z.array(z.string().uuid()).max(100).optional() }).strict();

/** One notification per active owner. */
export async function notifyOwners(tx: Tx, n: { kind: 'register_closed'; title: string; body: string; link: string }) {
  await tx.query(
    `INSERT INTO notifications (tenant_id, user_id, kind, title, body, link)
     SELECT current_setting('app.tenant_id')::uuid, u.id, $1, $2, $3, $4 FROM users u WHERE u.role = 'owner' AND u.status = 'active'`,
    [n.kind, n.title.slice(0, 120), n.body.slice(0, 1000), n.link]);
}

export async function listNotifications(tx: Tx, userId: string) {
  const { rows } = await tx.query(
    'SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [userId]);
  const { rows: [c] } = await tx.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return {
    unread: c.n as number,
    items: rows.map((r) => ({ id: r.id as string, kind: r.kind as string, title: r.title as string, body: r.body as string, link: r.link as string | null, createdAt: r.created_at as Date, read: !!r.read_at })),
  };
}

export async function unreadCount(tx: Tx, userId: string) {
  const { rows: [c] } = await tx.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return { unread: c.n as number };
}

/** Mark some (or all) of one's own notifications read. */
export async function markRead(tx: Tx, userId: string, ids?: string[]) {
  await tx.query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`, [userId, ids ?? null]);
  return unreadCount(tx, userId);
}
