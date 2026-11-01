// Security headers for every page (B7c, D81). Phase 1's next.config.mjs adds them in two lines:
//   import { securityHeaders } from './security-headers.mjs';
//   and inside the config object:  async headers() { return [{ source: '/:path*', headers: securityHeaders }]; },
// The policy allows nothing from other sites: no outside scripts, styles, fonts, images, frames or form targets, and
// no page may be framed (clickjacking). Next.js puts small inline scripts in every page, so scripts still allow
// 'unsafe-inline'; removing that needs per-request nonces and is the next step (docs/decisions.md D81).
const prod = process.env.NODE_ENV === 'production';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${prod ? '' : " 'unsafe-eval'"}`,   // dev only: React's dev tools need eval
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${prod ? '' : ' ws:'}`,                             // dev only: hot reload
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(prod ? ['upgrade-insecure-requests'] : []),
].join('; ');

export const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()' },
  ...(prod ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
];
