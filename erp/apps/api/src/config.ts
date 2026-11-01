import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(4000),
    WEB_ORIGIN: z.string().url().transform((s) => new URL(s).origin),
    DATABASE_URL: z.string().min(1),
    MIGRATION_DATABASE_URL: z.string().optional(),
    // 'true' trusts every X-Forwarded-For hop, so a client can choose its own IP (and dodge rate limits). Give the number
    // of proxies that connect to the api instead: 1 for web (B7, D76). web passes X-Forwarded-For through unchanged, so
    // behind Cloudflare that is still 1. 'false' when nothing is in front.
    TRUST_PROXY: z.string().regex(/^(true|false|[1-9])$/, "'true', 'false' or a hop count 1–9").default('false')
      .transform((v) => (v === 'true' ? true : v === 'false' ? false : Number(v))),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default('no-reply@localhost'),
    // D83: owners sign in with a password and an authenticator code. 'required' in production; 'optional' lets an owner
    // work without one (development, tests). Staff sign in with a password.
    OWNER_TOTP: z.enum(['required', 'optional']).optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('ap-south-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production' && !v.SMTP_URL)
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'required in production' });
  });

const parsed = schema.parse(process.env);
export const config = { ...parsed, OWNER_TOTP: parsed.OWNER_TOTP ?? (parsed.NODE_ENV === 'production' ? 'required' : 'optional') };
export const isProd = config.NODE_ENV === 'production';
