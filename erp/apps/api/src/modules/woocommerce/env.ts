import { z } from 'zod';

// B4's own settings, read once at start-up. Kept out of Phase 1's config.ts so B4 does not replace that file.
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Shown in WooCommerce (webhook names), e-mails and authenticator apps. Keep in step with web lib/brand.ts.
    APP_NAME: z.string().min(1).max(40).default('GroPop'),
    // 32 random bytes, base64: `openssl rand -base64 32`. Encrypts Woo credentials and authenticator secrets at rest (T4, D83).
    WOO_ENC_KEY: z.string().optional(),
    // The previous key during a rotation: still decrypts, never encrypts.
    WOO_ENC_KEY_PREVIOUS: z.string().optional(),
    // Public base URL WooCommerce posts webhooks to, e.g. https://app.example.com/api (the web app proxies /api to the API).
    WOO_WEBHOOK_BASE_URL: z.string().url().optional(),
    // DEVELOPMENT ONLY: allow http:// shop URLs and private addresses (a WooCommerce container on the Docker network),
    // and trust the extra CA in WOO_DEV_CA_FILE. Refused in production.
    WOO_DEV_ALLOW_PRIVATE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    WOO_DEV_CA_FILE: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    // Owners need an authenticator app in production (D83), and its secret is sealed with this key.
    if (v.NODE_ENV === 'production' && !v.WOO_ENC_KEY)
      ctx.addIssue({ code: 'custom', path: ['WOO_ENC_KEY'], message: 'required in production (openssl rand -base64 32)' });
    if (v.NODE_ENV === 'production' && v.WOO_DEV_ALLOW_PRIVATE)
      ctx.addIssue({ code: 'custom', path: ['WOO_DEV_ALLOW_PRIVATE'], message: 'must not be set in production' });
    if (v.NODE_ENV === 'production' && v.WOO_WEBHOOK_BASE_URL && !v.WOO_WEBHOOK_BASE_URL.startsWith('https://'))
      ctx.addIssue({ code: 'custom', path: ['WOO_WEBHOOK_BASE_URL'], message: 'must be https in production' });
  });

export const wooEnv = schema.parse(process.env);
