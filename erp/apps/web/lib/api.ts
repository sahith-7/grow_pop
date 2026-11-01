// Browser calls to the API through the Next.js /api proxy: same origin, HttpOnly session cookie, no tokens in JS.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fieldErrors: Record<string, string[]> = {}, public correlationId?: string) {
    super(message);
  }
}

type Opts = { method?: string; body?: unknown };

export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a proxy error page */ }
  if (!res.ok) throw new ApiError(res.status, json?.code ?? 'ERROR', json?.message ?? 'Something went wrong', json?.fieldErrors ?? {}, json?.correlationId);
  return json as T;
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Check your connection and try again.');
