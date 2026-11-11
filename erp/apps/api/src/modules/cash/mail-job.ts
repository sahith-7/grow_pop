import { tenantTx } from '../../db.js';
import { register } from '../../jobs/runner.js';
import { sendMail } from '../../lib/notify.js';
import { inr } from '../../lib/gst.js';
import { config } from '../../config.js';

// The owner's e-mail when a register closes (v2, D112). Queued in the closing's transaction, so it goes only if the
// closing was saved, and retried by the queue if the mail server is down. SMS needs DLT registration first (D112).

type Summary = Record<string, any>;

export function registerMail(storeName: string, s: Summary, link: string) {
  const diff = Number(s.difference);
  const lines = [
    `${s.till} at ${s.outlet} was closed by ${s.closedBy}.`,
    '',
    `Bills: ${s.bills}, sales ₹${inr(s.sales)}`,
    ...(s.methods as { name: string; received: string; refunded: string }[]).map((m) => `  ${m.name}: ₹${inr(m.received)} taken${Number(m.refunded) > 0 ? `, ₹${inr(m.refunded)} given back` : ''}`),
    '',
    `Cash at opening:   ₹${inr(s.opening)}`,
    `Cash sales:        ₹${inr(s.cashSales)}`,
    `Cash given back:   ₹${inr(s.cashRefunds)}`,
    `Cash added:        ₹${inr(s.cashIn)}`,
    `Cash taken out:    ₹${inr(s.cashOut)}`,
    `Expenses:          ₹${inr(s.expenses)}`,
    `Should be in drawer: ₹${inr(s.expected)}`,
    `Counted:           ₹${inr(s.counted)}`,
    diff === 0 ? 'The cash matched.' : `${diff < 0 ? 'SHORT' : 'OVER'} by ₹${inr(Math.abs(diff).toFixed(2))}${s.note ? `: "${s.note}"` : ''}`,
    `Left in the drawer: ₹${inr(s.kept)}; taken out: ₹${inr(s.takenOut)}`,
    '',
    `Details: ${link}`,
  ];
  return {
    subject: `${storeName}: ${s.till} closed${diff === 0 ? '' : diff < 0 ? ` (short ₹${inr(Math.abs(diff).toFixed(2))})` : ` (over ₹${inr(diff.toFixed(2))})`}`,
    text: lines.join('\n'),
  };
}

/** The job: read the closed register's summary and send it to every active owner. */
export async function sendRegisterMail(job: { tenantId: string; resourceId: string }) {
  const m = await tenantTx(job.tenantId, async (tx) => {
    const { rows: [s] } = await tx.query('SELECT summary, close_note FROM register_sessions WHERE id = $1 AND status = $2', [job.resourceId, 'closed']);
    if (!s) return null;
    const { rows: [t] } = await tx.query("SELECT name FROM tenants WHERE id = current_setting('app.tenant_id')::uuid");
    const { rows: owners } = await tx.query("SELECT email FROM users WHERE role = 'owner' AND status = 'active'");
    return { to: owners.map((o) => o.email as string), ...registerMail(t.name, { ...s.summary, note: s.close_note }, `${config.WEB_ORIGIN}/cash/registers/${job.resourceId}`) };
  });
  if (m) await sendMail(m);
}

register('mail.register', sendRegisterMail);
