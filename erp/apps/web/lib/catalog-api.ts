// Browser-side calls to the API through the Next.js /api proxy (same origin, session cookie, no tokens in JS).

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fieldErrors: Record<string, string[]> = {}, public correlationId?: string) {
    super(message);
  }
}

type Opts = { method?: string; body?: unknown; headers?: Record<string, string>; raw?: Blob | File };

export async function api<T = any>(path: string, opts: Opts = {}): Promise<{ data: T; etag: string | null }> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.raw) { body = opts.raw; headers['content-type'] ??= opts.raw.type; }
  else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] = 'application/json'; }
  const res = await fetch(`/api/v1${path}`, { method: opts.method ?? 'GET', headers, body, credentials: 'same-origin', cache: 'no-store' });
  // Session expired: reload so the app layout sends the user to sign in.
  if (res.status === 401) { window.location.reload(); throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again'); }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.code ?? 'ERROR', json?.message ?? 'Something went wrong', json?.fieldErrors ?? {}, json?.correlationId);
  return { data: json as T, etag: res.headers.get('etag') };
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Check your connection and try again.');

// ---- shapes returned by the API (subset the screens use)
export interface Ref { id: string; name: string; parentId: string | null; archivedAt: string | null }
export interface Unit { code: string; name: string; abbr: string; allowFraction: boolean }
export interface Variant {
  id: string; sku: string; barcode: string | null; attributes: Record<string, string>; price: string; mrp: string | null;
  cost?: string | null; weightG: number | null; reorderLevel: string | null; status: 'active' | 'archived'; version: number;
}
export interface Image { id: string; url: string; thumbnailUrl: string; isPrimary: boolean; altText: string; sortOrder: number }
export interface Product {
  id: string; name: string; description: string; categoryId: string | null; brandId: string | null; unitCode: string;
  type: 'simple' | 'variable'; status: 'draft' | 'active' | 'archived'; hsnCode: string | null; gstRate: string | null;
  publishToWeb: boolean; publishState: string; version: number; variants: Variant[]; images: Image[];
}
export interface ProductSummary {
  id: string; name: string; status: string; category: string | null; variantCount: number; skus: string[];
  priceRange: { min: string; max: string } | null; thumbnailUrl: string | null; publishState: string;
}
export const ATTRIBUTE_KEYS = ['size', 'colour', 'model', 'material'] as const;
export const GST_RATES = ['0', '0.1', '0.25', '1', '1.5', '3', '5', '12', '18', '28', '40'] as const;
