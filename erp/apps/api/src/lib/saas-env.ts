import { z } from 'zod';

// B7's own settings, read once at start-up. Kept out of Phase 1's config.ts so B7 does not replace that file.
// None of these hold legal details: the business name, address and GSTIN of the company running the service go on the
// public website (site/site.config.json), not into the app.
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'db', 'postgres']);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().optional(),
    // Manual payments (D69): the UPI ID and payee name shown to store owners on the Account page. Empty = "contact us".
    BILLING_UPI_ID: z.string().regex(/^[\w.-]{2,256}@[\w.-]{2,64}$/, 'looks like name@bank').optional(),
    BILLING_UPI_NAME: z.string().max(60).optional(),
    // GST you add to subscription prices, in percent. Leave unset while you are not registered for GST: then no GST is
    // mentioned anywhere. Your CA decides the rate once you register.
    BILLING_GST_PERCENT: z.coerce.number().int().min(1).max(28).optional(),
    // Where stores reach you. Shown in the app and in e-mails.
    SUPPORT_EMAIL: z.string().email().optional(),
    SUPPORT_WHATSAPP: z.string().regex(/^\+?[0-9 ]{8,16}$/).optional(),
    // You: lifecycle changes (a store went past due, was suspended) are e-mailed here once a day.
    PLATFORM_ALERT_EMAIL: z.string().email().optional(),
  })
  .superRefine((v, ctx) => {
    // T4 / 06 §3: in production the API talks to a remote database over TLS with the certificate checked.
    if (v.NODE_ENV === 'production' && v.DATABASE_URL) {
      let url: URL | null = null;
      try { url = new URL(v.DATABASE_URL); } catch { /* config.ts reports a bad URL */ }
      if (url && !LOCAL_DB_HOSTS.has(url.hostname) && url.searchParams.get('sslmode') !== 'verify-full')
        ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'a remote database needs ?sslmode=verify-full&sslrootcert=<CA file> in production' });
    }
  });

export const saasEnv = schema.parse(process.env);
