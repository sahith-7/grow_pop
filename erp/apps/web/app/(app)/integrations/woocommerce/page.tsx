'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { money } from '../../../../lib/format';
import { dateTime, type Location } from '../../../../lib/stock-api';
import {
  ago, ApiError, api, errorText, JOB_KIND, JOB_STATUS, type MatchResult, type SyncJob, type TestResult, type WooStatus,
} from '../../../../lib/woo-api';

// One screen for the shop connection: connect (owner), health, the first SKU match, and anything that failed to sync.

export default function WooCommercePage() {
  const [s, setS] = useState<WooStatus | null>(null);
  const [error, setError] = useState('');
  const [replacing, setReplacing] = useState(false);

  const load = async () => {
    try { setS((await api<WooStatus>('/integrations/woocommerce')).data); } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { load(); }, []);

  // Refresh while the worker has something to do, so progress shows without reloading.
  const busy = !!s && (s.pending > 0 || s.match?.state === 'running');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [busy]);

  if (!s) return <div className="ui-content">{error ? <Alert tone="danger">{error}</Alert> : <div className="ui-skeleton" style={{ height: 240 }} />}</div>;

  const connected = s.status === 'connected' || s.status === 'error';

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><span className="ui-caption">Integrations /</span><h1 className="ui-h1">WooCommerce</h1></div>
        {connected && <Health s={s} />}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}

      {!connected || replacing ? (
        s.can.connect
          ? <ConnectForm siteUrl={s.siteUrl} replacing={replacing} onCancel={replacing ? () => setReplacing(false) : undefined}
              onConnected={(n) => { setS(n); setReplacing(false); }} />
          : <div className="ui-panel"><div className="ui-panel-body ui-muted">The online shop is not connected. Only the owner can connect it.</div></div>
      ) : (
        <>
          <Connection s={s} onChange={setS} onReplace={() => setReplacing(true)} onError={setError} reload={load} />
          <Match s={s} reload={load} />
          <Problems s={s} reload={load} />
        </>
      )}
    </div>
  );
}

function Alert({ tone, children }: { tone: 'danger' | 'warning' | 'success'; children: React.ReactNode }) {
  return <div className={`ui-alert ui-alert--${tone}`} role={tone === 'success' ? 'status' : 'alert'}><div className="ui-alert-body">{children}</div></div>;
}

function Health({ s }: { s: WooStatus }) {
  const [tone, label] = s.status === 'error' ? ['danger', 'Not syncing'] : !s.webhooksHealthy ? ['warning', 'Orders delayed'] : s.failed > 0 ? ['warning', 'Some items failed'] : ['success', 'Syncing'];
  return <span className={`ui-badge ui-badge--${tone}`}>{label}</span>;
}

// ---------------------------------------------------------------- connect / replace key

function ConnectForm({ siteUrl, replacing, onConnected, onCancel }: {
  siteUrl?: string; replacing: boolean; onConnected: (s: WooStatus) => void; onCancel?: () => void;
}) {
  const [form, setForm] = useState({ siteUrl: siteUrl ?? 'https://', consumerKey: '', consumerSecret: '' });
  const [test, setTest] = useState<TestResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'test' | 'connect'>('');

  const body = () => ({ siteUrl: form.siteUrl.trim(), consumerKey: form.consumerKey.trim(), consumerSecret: form.consumerSecret.trim() });
  const fail = (e: unknown) => { setError(errorText(e)); if (e instanceof ApiError) setErrors(e.fieldErrors); };

  const runTest = async () => {
    setBusy('test'); setError(''); setErrors({}); setTest(null);
    try { setTest((await api<TestResult>('/integrations/woocommerce/test', { method: 'POST', body: body() })).data); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('connect'); setError(''); setErrors({});
    try {
      const { data } = await api<Omit<WooStatus, 'can'>>('/integrations/woocommerce', { method: 'PUT', body: body() });
      onConnected({ ...data, can: { connect: true } });
    } catch (err) { fail(err); } finally { setBusy(''); }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => { setForm({ ...form, [k]: e.target.value }); setTest(null); };
  const err = (k: string) => errors[k]?.[0];
  const filled = form.siteUrl.trim().length > 8 && form.consumerKey.trim() && form.consumerSecret.trim();

  return (
    <form className="ui-panel" onSubmit={connect}>
      <div className="ui-panel-head"><span className="ui-h3">{replacing ? 'Replace the API key' : 'Connect your WooCommerce shop'}</span></div>
      <div className="ui-panel-body">
        <ol className="ui-muted" style={{ margin: '0 0 var(--space-4)', paddingLeft: 20 }}>
          <li>In WordPress, open WooCommerce › Settings › Advanced › REST API and choose <strong>Add key</strong>.</li>
          <li>Give it a description (for example “ERP”), pick an administrator as the user, and set Permissions to <strong>Read/Write</strong>.</li>
          <li>Copy the consumer key and secret here. WooCommerce shows the secret only once.</li>
        </ol>
        <div className="ui-form-grid">
          <label className="ui-field ui-span-all"><span className="ui-label">Shop address</span>
            <input className="ui-input" value={form.siteUrl} onChange={set('siteUrl')} required maxLength={300} inputMode="url" autoComplete="url" aria-invalid={!!err('siteUrl')} />
            {err('siteUrl') ? <span className="ui-error">{err('siteUrl')}</span> : <span className="ui-help">The address customers visit, starting with https://</span>}
          </label>
          <label className="ui-field"><span className="ui-label">Consumer key</span>
            <input className="ui-input ui-code" value={form.consumerKey} onChange={set('consumerKey')} required placeholder="ck_…" autoComplete="off" spellCheck={false} aria-invalid={!!err('consumerKey')} />
            {err('consumerKey') && <span className="ui-error">{err('consumerKey')}</span>}
          </label>
          <label className="ui-field"><span className="ui-label">Consumer secret</span>
            <input className="ui-input ui-code" type="password" value={form.consumerSecret} onChange={set('consumerSecret')} required placeholder="cs_…" autoComplete="new-password" spellCheck={false} aria-invalid={!!err('consumerSecret')} />
            {err('consumerSecret') ? <span className="ui-error">{err('consumerSecret')}</span> : <span className="ui-help">Stored encrypted. Nobody, including you, can read it back from the ERP.</span>}
          </label>
        </div>
        {test && (test.ok
          ? <Alert tone="success">Found WooCommerce {test.wooVersion}, prices in {test.currency}, weights in {test.weightUnit}. The key can read and write.</Alert>
          : <Alert tone="danger">{test.message}</Alert>)}
        {error && <Alert tone="danger">{error}</Alert>}
        {!replacing && (
          <p className="ui-caption">Connecting creates five order webhooks in the shop, imports open orders, and compares products by SKU. Nothing in the shop changes until you confirm the product match.</p>
        )}
        <div className="ui-form-footer">
          {onCancel && <button className="ui-btn ui-btn--ghost" type="button" onClick={onCancel}>Cancel</button>}
          <button className="ui-btn" type="button" disabled={!filled || !!busy} aria-busy={busy === 'test'} onClick={runTest}>Test key</button>
          <button className="ui-btn ui-btn--primary" type="submit" disabled={!filled || !!busy} aria-busy={busy === 'connect'}>{replacing ? 'Save new key' : 'Connect'}</button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- connection details and settings

function Connection({ s, onChange, onReplace, onError, reload }: {
  s: WooStatus; onChange: (s: WooStatus) => void; onReplace: () => void; onError: (m: string) => void; reload: () => void;
}) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s.can.connect) api<{ items: Location[] }>('/locations').then((r) => setLocations(r.data.items.filter((l) => l.active && l.isSellable))).catch(() => {});
  }, [s.can.connect]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); onError(''); setNotice('');
    try { await fn(); if (done) setNotice(done); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  };
  const setLocation = (id: string) => act(async () => {
    if (!window.confirm('Sell online from this location? Every product in the shop will show its stock from here.')) return;
    const { data } = await api<Omit<WooStatus, 'can'>>('/integrations/woocommerce', { method: 'PATCH', body: { onlineLocationId: id } });
    onChange({ ...data, can: s.can });
  }, 'Saved. Stock levels in the shop are being updated.');
  const reconcile = () => act(async () => { await api('/sync/reconcile', { method: 'POST' }); reload(); }, 'Checking the shop now. Missed orders, webhooks and stock differences are repaired automatically.');
  const disconnect = () => act(async () => {
    if (!window.confirm('Disconnect the shop? The ERP stops sending stock and receiving orders, and removes its webhooks from the shop. Products and orders already in the shop stay there.')) return;
    await api('/integrations/woocommerce', { method: 'DELETE' });
    reload();
  });

  return (
    <div className="ui-panel">
      <div className="ui-panel-head"><span className="ui-h3">Shop</span>
        <div className="ui-actions">
          <button className="ui-btn ui-btn--sm" type="button" disabled={busy} onClick={reconcile}>Check now</button>
          {s.can.connect && <button className="ui-btn ui-btn--sm" type="button" disabled={busy} onClick={onReplace}>Replace key</button>}
          {s.can.connect && <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" disabled={busy} onClick={disconnect}>Disconnect</button>}
        </div>
      </div>
      <div className="ui-panel-body">
        {s.status === 'error' && <Alert tone="danger">The shop refused the last request{s.lastErrorAt ? ` (${ago(s.lastErrorAt)})` : ''}: {s.lastError}. {s.can.connect ? 'If the key was deleted or changed in WordPress, use Replace key.' : 'Ask the owner to check the connection.'}</Alert>}
        {s.status === 'connected' && s.webhooksHealthy === false && <Alert tone="warning">The shop’s order webhooks are missing or disabled, so new orders arrive only at the next check-up (every 15 minutes). Check now repairs them.</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        <div className="ui-form-grid">
          <Fact label="Address"><a href={s.siteUrl} target="_blank" rel="noreferrer noopener">{s.siteUrl}</a></Fact>
          <Fact label="API key"><span className="ui-code">{s.keyHint}</span></Fact>
          <Fact label="WooCommerce">{s.wooVersion ?? '—'}{s.pricesIncludeTax !== null && s.pricesIncludeTax !== undefined ? ` · prices ${s.pricesIncludeTax ? 'include' : 'exclude'} tax` : ''}</Fact>
          <Fact label="Last good contact">{ago(s.lastSuccessAt)}</Fact>
          <Fact label="Orders checked up to">{s.ordersSyncedTo ? dateTime(s.ordersSyncedTo) : 'Not yet'}</Fact>
          <Fact label="Waiting to sync">{s.pending}{s.pending > 0 && s.oldestPendingAgeSec > 120 ? ` (oldest ${Math.round(s.oldestPendingAgeSec / 60)} min)` : ''}</Fact>
          <label className="ui-field"><span className="ui-label">Online stock comes from</span>
            {s.can.connect && locations.length > 0 ? (
              <select className="ui-select" value={s.onlineLocation?.id} disabled={busy} onChange={(e) => setLocation(e.target.value)}>
                {!locations.some((l) => l.id === s.onlineLocation?.id) && <option value={s.onlineLocation?.id}>{s.onlineLocation?.name}</option>}
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            ) : <span>{s.onlineLocation?.name}</span>}
            <span className="ui-help">Web orders hold stock here, and the shop shows what is free here.</span>
          </label>
        </div>
        {((s.orderExceptions ?? 0) > 0 || (s.ordersNeedingReview ?? 0) > 0) && (
          <p style={{ marginBottom: 0 }}><Link href="/orders?status=attention">{(s.orderExceptions ?? 0) + (s.ordersNeedingReview ?? 0)} web orders need attention</Link></p>
        )}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="ui-field"><span className="ui-label">{label}</span><span>{children}</span></div>;
}

// ---------------------------------------------------------------- first SKU match

function Match({ s, reload }: { s: WooStatus; reload: () => void }) {
  const state = s.match?.state ?? 'not_started';
  const [m, setM] = useState<MatchResult | null>(null);
  const [show, setShow] = useState<'matched' | 'erpOnly' | 'wooOnly'>('matched');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const checkedAt = s.match?.summary?.checkedAt;

  useEffect(() => {
    if (state === 'ready' || state === 'failed' || state === 'confirmed') api<MatchResult>('/integrations/woocommerce/match').then((r) => setM(r.data)).catch((e) => setError(errorText(e)));
  }, [state, checkedAt]);

  const rerun = async () => {
    setBusy(true); setError(''); setNotice('');
    try { await api('/integrations/woocommerce/match', { method: 'POST' }); reload(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!window.confirm('Put the matched products under ERP control? Their price and stock in the shop will be replaced with the ERP’s, and products marked “Sell online” in the ERP will be created in the shop.')) return;
    setBusy(true); setError('');
    try {
      const { data } = await api<{ products: number; skipped: number }>('/integrations/woocommerce/match/confirm', { method: 'POST' });
      setNotice(`${data.products} products are now synced from the ERP.${data.skipped ? ` ${data.skipped} were skipped because their type differs (see below).` : ''}`);
      reload();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const sum = m?.summary;
  return (
    <div className="ui-panel">
      <div className="ui-panel-head"><span className="ui-h3">Products in both systems</span>
        <div className="ui-actions">
          {state !== 'running' && <button className="ui-btn ui-btn--sm" type="button" disabled={busy} onClick={rerun}>Compare again</button>}
          {state === 'ready' && <button className="ui-btn ui-btn--sm ui-btn--primary" type="button" disabled={busy} onClick={confirm}>Confirm and sync</button>}
        </div>
      </div>
      <div className="ui-panel-body">
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {(state === 'running' || state === 'not_started') && <p className="ui-muted">Reading every product in the shop and comparing SKUs. This page updates by itself.</p>}
        {state === 'failed' && <Alert tone="danger">The comparison failed: {(m as { error?: string } | null)?.error ?? 'the shop did not answer'}. Try Compare again.</Alert>}
        {state === 'ready' && <p className="ui-muted" style={{ marginTop: 0 }}>Nothing in the shop has changed yet. Check the list, fix SKUs on either side if needed and compare again, then confirm. After you confirm, the ERP owns price and stock for matched products.</p>}
        {state === 'confirmed' && <p className="ui-muted" style={{ marginTop: 0 }}>Confirmed. The ERP keeps price and stock in the shop up to date for every product marked “Sell online”. {(m as { error?: string } | null)?.error ? `The last comparison failed: ${(m as { error?: string }).error}` : ''}</p>}
        {sum && (
          <>
            <div style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
              <Kpi label="Matched by SKU" value={sum.matched} />
              <Kpi label="With differences" value={sum.withDifferences} tone={sum.withDifferences ? 'var(--warning)' : undefined} />
              <Kpi label="Only in the ERP" value={sum.erpOnly} />
              <Kpi label="Only in the shop" value={sum.wooOnly} />
            </div>
            <p className="ui-caption">Compared {dateTime(sum.checkedAt)}.</p>
            <div className="ui-segmented" role="group" aria-label="Show">
              <button type="button" aria-pressed={show === 'matched'} onClick={() => setShow('matched')}>Matched</button>
              <button type="button" aria-pressed={show === 'erpOnly'} onClick={() => setShow('erpOnly')}>Only in the ERP</button>
              <button type="button" aria-pressed={show === 'wooOnly'} onClick={() => setShow('wooOnly')}>Only in the shop</button>
            </div>
          </>
        )}
      </div>
      {sum && show === 'matched' && (m?.matched?.length ? (
        <div className="ui-table-wrap"><table className="ui-table" data-collapse>
          <thead><tr><th scope="col">SKU</th><th scope="col">Name</th><th scope="col" className="ui-money">ERP price</th><th scope="col" className="ui-money">Shop price</th><th scope="col" className="ui-num">ERP free stock</th><th scope="col" className="ui-num">Shop stock</th></tr></thead>
          <tbody>{m.matched.map((r) => (
            <tr key={`${r.sku}`}>
              <td data-primary className="ui-code">{r.sku}</td>
              <td data-label="Name"><Link href={`/products/${r.productId}`}>{r.name}</Link>{r.wooName && r.wooName !== r.name && <div className="ui-cell-sub">Shop: {r.wooName}</div>}
                {r.problem && <div className="ui-error">{r.problem}. Not synced; fix the product type on one side.</div>}</td>
              <td className="ui-money" data-label="ERP price">{money(r.price)}</td>
              <td className="ui-money" data-label="Shop price" style={r.differences.includes('price') ? { color: 'var(--warning)', fontWeight: 600 } : undefined}>{r.wooPrice ? money(r.wooPrice) : '—'}</td>
              <td className="ui-num" data-label="ERP free stock">{r.stock}</td>
              <td className="ui-num" data-label="Shop stock" style={r.differences.includes('stock') ? { color: 'var(--warning)', fontWeight: 600 } : undefined}>{r.wooStock ?? 'not tracked'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <div className="ui-empty"><p className="ui-muted">No SKUs match. {state === 'confirmed' ? 'Products marked “Sell online” are created in the shop.' : 'Products marked “Sell online” will be created in the shop after you confirm.'}</p></div>)}
      {sum && show === 'erpOnly' && <SimpleList rows={(m?.erpOnly ?? []).map((r) => ({ key: r.sku, sku: r.sku, name: <Link href={`/products/${r.productId}`}>{r.name}</Link> }))} total={sum.erpOnly}
        empty="Every ERP item is in the shop." note="These are created in the shop only if their product is marked “Sell online”." />}
      {sum && show === 'wooOnly' && <SimpleList rows={(m?.wooOnly ?? []).map((r) => ({ key: `${r.wooProductId}-${r.sku}`, sku: r.sku || '(no SKU)', name: r.name }))} total={sum.wooOnly}
        empty="Every shop product has a matching ERP SKU." note="The ERP leaves these alone. Orders for them arrive with an unknown SKU until you add the product or fix its SKU." />}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className="ui-kpi"><span className="ui-caption">{label}</span><span className="ui-kpi-value" style={{ color: tone }}>{value.toLocaleString('en-IN')}</span></div>;
}

function SimpleList({ rows, total, empty, note }: { rows: { key: string; sku: string; name: React.ReactNode }[]; total: number; empty: string; note: string }) {
  if (!rows.length) return <div className="ui-empty"><p className="ui-muted">{empty}</p></div>;
  return (
    <>
      <div className="ui-panel-body ui-caption">{note}{total > rows.length ? ` Showing the first ${rows.length} of ${total}.` : ''}</div>
      <div className="ui-table-wrap"><table className="ui-table">
        <thead><tr><th scope="col">SKU</th><th scope="col">Name</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key}><td className="ui-code">{r.sku}</td><td>{r.name}</td></tr>)}</tbody>
      </table></div>
    </>
  );
}

// ---------------------------------------------------------------- sync problems

function Problems({ s, reload }: { s: WooStatus; reload: () => void }) {
  const [jobs, setJobs] = useState<SyncJob[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const failed = useRef(s.failed);

  const load = async () => {
    try { setJobs((await api<{ items: SyncJob[] }>('/sync/jobs?status=problems&limit=50')).data.items); } catch (e) { setError(errorText(e)); setJobs([]); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (failed.current !== s.failed) { failed.current = s.failed; load(); } }, [s.failed]);

  const retry = async (j: SyncJob) => {
    setBusy(j.id); setError('');
    try { await api(`/sync/jobs/${j.id}/retry`, { method: 'POST' }); await load(); reload(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };

  if (jobs && jobs.length === 0 && !error) return null;
  return (
    <div className="ui-panel">
      <div className="ui-panel-head"><span className="ui-h3">Sync problems</span></div>
      {error && <div className="ui-panel-body"><Alert tone="danger">{error}</Alert></div>}
      {jobs === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 80 }} /></div> : (
        <div className="ui-table-wrap"><table className="ui-table" data-collapse>
          <thead><tr><th scope="col">What</th><th scope="col">Problem</th><th scope="col">Status</th><th scope="col"><span className="ui-sr-only">Actions</span></th></tr></thead>
          <tbody>{jobs.map((j) => {
            const [tone, label] = JOB_STATUS[j.status] ?? ['', j.status];
            return (
              <tr key={j.id}>
                <td data-primary>
                  <span className="ui-cell-title">{j.resource.type === 'product' ? <Link href={`/products/${j.resource.id}`}>{j.resource.label}</Link> : j.resource.label}</span>
                  <div className="ui-cell-sub">{JOB_KIND[j.kind] ?? j.kind} · {dateTime(j.createdAt)}</div>
                </td>
                <td data-label="Problem">{j.lastError ?? '—'}</td>
                <td data-label="Status"><span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span>{j.status === 'failed' && <div className="ui-cell-sub">try {j.attempts} of {j.maxAttempts}</div>}</td>
                <td><button className="ui-btn ui-btn--sm" type="button" disabled={busy === j.id} onClick={() => retry(j)}>Retry now</button></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </div>
  );
}
