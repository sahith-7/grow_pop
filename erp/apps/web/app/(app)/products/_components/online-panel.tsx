'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCan } from '@/lib/me';
import { api, errorText, type Product } from '../../../../lib/catalog-api';

const STATE: Record<string, [string, string]> = {
  not_published: ['', 'Not in the shop yet'], queued: ['warning', 'Sending to the shop'], synced: ['success', 'In the shop'],
  failed: ['danger', 'Sync failed'], needs_review: ['warning', 'Deleted in the shop'],
};

/** "Sell online" for one product (B4). Selling online needs sync.manage; stopping is a product edit (product.write). */
export function OnlinePanel({ product, canWrite, onChanged }: { product: Product & { publishError?: string | null }; canWrite: boolean; onChanged: (p: Product) => void }) {
  const canSync = useCan('sync.manage');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async () => onChanged((await api<Product>(`/products/${product.id}`)).data);
  // While the worker is sending it, refresh so the badge moves on by itself.
  useEffect(() => {
    if (!product.publishToWeb || product.publishState !== 'queued') return;
    const t = setInterval(() => { reload().catch(() => {}); }, 3000);
    return () => clearInterval(t);
  }, [product.publishToWeb, product.publishState]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await reload(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const publish = () => act(() => api(`/products/${product.id}/publish`, { method: 'POST' }));
  const stop = () => act(async () => {
    if (!window.confirm('Stop selling this online? It becomes a draft in the shop, so customers can no longer buy it. Orders already placed are not affected.')) return;
    await api(`/products/${product.id}`, { method: 'PATCH', body: { publishToWeb: false }, headers: { 'if-match': `"${product.version}"` } });
  });

  if (!product.publishToWeb && !canSync) return null;
  const [tone, label] = product.publishToWeb ? STATE[product.publishState] ?? ['', product.publishState] : ['', 'Not sold online'];

  return (
    <div className="ui-panel">
      <div className="ui-panel-head"><span className="ui-h3">Online shop</span>
        <div className="ui-actions">
          {canSync && product.status === 'active' && !product.publishToWeb && <button className="ui-btn ui-btn--sm ui-btn--primary" type="button" disabled={busy} onClick={publish}>Sell online</button>}
          {canSync && product.publishToWeb && (product.publishState === 'failed' || product.publishState === 'needs_review') && (
            <button className="ui-btn ui-btn--sm" type="button" disabled={busy} onClick={publish}>{product.publishState === 'needs_review' ? 'Put back in the shop' : 'Try again'}</button>
          )}
          {canWrite && product.publishToWeb && <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" disabled={busy} onClick={stop}>Stop selling online</button>}
        </div>
      </div>
      <div className="ui-panel-body">
        <span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span>
        {product.publishToWeb && product.publishState === 'needs_review' && <p className="ui-muted">Someone deleted it in WooCommerce. The ERP has stopped sending it; put it back or stop selling it online.</p>}
        {product.publishToWeb && product.publishError && product.publishState === 'failed' && <p className="ui-error">{product.publishError}</p>}
        {product.publishToWeb && product.publishError && product.publishState === 'synced' && <p className="ui-help" style={{ color: 'var(--warning)' }}>{product.publishError}. The rest is in the shop; images are tried again on the next change.</p>}
        {product.publishToWeb && <p className="ui-caption" style={{ marginBottom: 0 }}>The ERP sets the name, description, price, stock, category and images in the shop. Edits made in WooCommerce to these are overwritten.</p>}
        {!product.publishToWeb && product.status !== 'active' && <p className="ui-caption" style={{ marginBottom: 0 }}>Only active products can be sold online.</p>}
        {error && <div className="ui-alert ui-alert--danger" role="alert" style={{ marginTop: 'var(--space-3)' }}><div className="ui-alert-body">{error}{/match/i.test(error) && <> <Link href="/integrations/woocommerce">Open WooCommerce</Link></>}</div></div>}
      </div>
    </div>
  );
}
