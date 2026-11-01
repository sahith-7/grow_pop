import nodemailer from 'nodemailer';
import { config } from '../config.js';

// Plain-text e-mail for alerts and account notices (B7). Phase 1's mailer sends sign-in mail; this one is separate so B7
// does not depend on its API. Same SMTP_URL and MAIL_FROM.

export interface Mail { to: string[]; subject: string; text: string }

/** Tests read what would have been sent. */
export const testOutbox: Mail[] = [];

const transport = config.SMTP_URL && config.NODE_ENV !== 'test' ? nodemailer.createTransport(config.SMTP_URL) : null;

export async function sendMail(m: Mail, log?: { warn: (o: object, msg: string) => void }) {
  const to = [...new Set(m.to.filter(Boolean))];
  if (!to.length) return;
  if (config.NODE_ENV === 'test') { testOutbox.push({ ...m, to }); return; }
  if (!transport) { log?.warn({ subject: m.subject, recipients: to.length }, 'SMTP_URL not set; e-mail not sent'); return; }
  await transport.sendMail({ from: config.MAIL_FROM, to, subject: m.subject, text: m.text });
}
