import { securityHeaders } from './security-headers.mjs';

// The browser only ever talks to this origin. /api/* is proxied to the API on the private network, so there is no CORS
// and the session cookie stays first-party. API_URL is read at build time (Docker build arg).
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() { return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }]; },
  async headers() { return [{ source: '/:path*', headers: securityHeaders }]; },
};

export default nextConfig;
