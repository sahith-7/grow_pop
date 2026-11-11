'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, dateTime, errorText, PO_STATUS, type PurchaseOrder, type StockMeta } from '../../../lib/stock-api';

type Tab = 'orders' | 'receipts' | 'returns';
type PoRow = Pick<PurchaseOrder, 'id' | 'number' | 'status' | 'createdAt' | 'expectedDate' | 'supplier'> & { lineCount: number; outstandingQty: string };
interface ReceiptRow { id: string; number: string; postedAt: string; supplierName: string; purchaseOrderNumber: string | null; supplierInvoiceNo: string | null; receivedQty: string; acceptedQty: string }
interface ReturnRow { id: string; number: string; postedAt: string; reason: string; supplierName: string; receiptNumber: string | null; qty: string }

const PATHS: Record<Tab, string> = { orders: '/purchase-orders', receipts: '/goods-receipts', returns: '/supplier-returns' };

function PurchasingPage() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (['orders', 'receipts', 'returns'].includes(params.get('tab') ?? '') ? params.get('tab') : 'orders') as Tab;
  const status = params.get('status') ?? '';
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [items, setItems] = useState<any[] | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { api<StockMeta>('/stock/meta').then((r) => setMeta(r.data)).catch(() => {}); }, []);
  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ limit: '25' });
    if (tab === 'orders' && status) qs.set('status', status);
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: any[]; nextCursor: string | null }>(`${PATHS[tab]}?${qs}`);
      setItems(data.items); setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { setItems(null); setCursors([]); load(); }, [tab, status]);

  const go = (p: Record<string, string>) => router.replace(`/purchasing?${new URLSearchParams(p)}`);
  const can = meta?.can;

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <h1 className="ui-h1">Purchasing</h1>
        <div className="ui-actions">
          {can?.purchaseManage && <Link className="ui-btn" href="/contacts?type=supplier">Suppliers</Link>}
          {can?.purchaseManage && <Link className="ui-btn" href="/purchasing/returns/new">Return to supplier</Link>}
          {can?.purchaseReceive && <Link className="ui-btn" href="/purchasing/receive">Receive without an order</Link>}
          {can?.purchaseManage && <Link className="ui-btn ui-btn--primary" href="/purchasing/new">New purchase order</Link>}
        </div>
      </div>

      <div className="ui-tabs" role="tablist">
        {(['orders', 'receipts', 'returns'] as Tab[]).map((t) => (
          <button key={t} className="ui-tab" role="tab" type="button" aria-selected={tab === t} onClick={() => go({ tab: t })}>
            {{ orders: 'Purchase orders', receipts: 'Goods received', returns: 'Supplier returns' }[t]}
          </button>
        ))}
      </div>

      <div className="ui-panel">
        {tab === 'orders' && (
          <div className="ui-toolbar">
            <select className="ui-select" aria-label="Status" value={status} onChange={(e) => go(e.target.value ? { tab, status: e.target.value } : { tab })}>
              <option value="">All orders</option>
              {Object.entries(PO_STATUS).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        )}
        {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
        {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 120 }} /></div>
          : items.length === 0 ? <div className="ui-empty"><p className="ui-h3">Nothing here yet</p></div>
          : <div className="ui-table-wrap">
              {tab === 'orders' && <table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Order</th><th scope="col">Supplier</th><th scope="col">Created</th><th scope="col">Expected</th><th scope="col" className="ui-num">Lines</th><th scope="col" className="ui-num">Still to come</th><th scope="col">Status</th></tr></thead>
                <tbody>{(items as PoRow[]).map((p) => {
                  const [tone, label] = PO_STATUS[p.status];
                  return (
                    <tr key={p.id}>
                      <td data-primary><Link className="ui-code" href={`/purchasing/${p.id}`}>{p.number}</Link></td>
                      <td data-label="Supplier">{p.supplier.name}</td>
                      <td data-label="Created" className="ui-cell-sub">{dateTime(p.createdAt)}</td>
                      <td data-label="Expected">{p.expectedDate ?? <span className="ui-muted">—</span>}</td>
                      <td data-label="Lines" className="ui-num">{p.lineCount}</td>
                      <td data-label="Still to come" className="ui-num">{p.outstandingQty === '0' ? <span className="ui-muted">0</span> : p.outstandingQty}</td>
                      <td data-label="Status"><span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span></td>
                    </tr>
                  );
                })}</tbody>
              </table>}
              {tab === 'receipts' && <table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Receipt</th><th scope="col">Supplier</th><th scope="col">When</th><th scope="col">Order</th><th scope="col">Invoice</th><th scope="col" className="ui-num">Arrived</th><th scope="col" className="ui-num">Accepted</th></tr></thead>
                <tbody>{(items as ReceiptRow[]).map((r) => (
                  <tr key={r.id}>
                    <td data-primary><Link className="ui-code" href={`/purchasing/receipts/${r.id}`}>{r.number}</Link></td>
                    <td data-label="Supplier">{r.supplierName}</td>
                    <td data-label="When" className="ui-cell-sub">{dateTime(r.postedAt)}</td>
                    <td data-label="Order" className="ui-code">{r.purchaseOrderNumber ?? <span className="ui-muted">—</span>}</td>
                    <td data-label="Invoice">{r.supplierInvoiceNo ?? <span className="ui-muted">—</span>}</td>
                    <td data-label="Arrived" className="ui-num">{r.receivedQty}</td>
                    <td data-label="Accepted" className="ui-num">{r.acceptedQty}</td>
                  </tr>
                ))}</tbody>
              </table>}
              {tab === 'returns' && <table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Return</th><th scope="col">Supplier</th><th scope="col">When</th><th scope="col">Receipt</th><th scope="col">Reason</th><th scope="col" className="ui-num">Qty</th></tr></thead>
                <tbody>{(items as ReturnRow[]).map((r) => (
                  <tr key={r.id}>
                    <td data-primary><Link className="ui-code" href={`/stock/movements?sourceId=${r.id}`}>{r.number}</Link></td>
                    <td data-label="Supplier">{r.supplierName}</td>
                    <td data-label="When" className="ui-cell-sub">{dateTime(r.postedAt)}</td>
                    <td data-label="Receipt" className="ui-code">{r.receiptNumber ?? <span className="ui-muted">—</span>}</td>
                    <td data-label="Reason">{r.reason}</td>
                    <td data-label="Qty" className="ui-num">{r.qty}</td>
                  </tr>
                ))}</tbody>
              </table>}
            </div>}
        <div className="ui-pager">
          <span />
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!cursors.length} onClick={() => { const prev = cursors.slice(0, -1); setCursors(prev); load(prev.at(-1)); }}>Newer</button>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!next} onClick={() => { setCursors([...cursors, next!]); load(next!); }}>Older</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><PurchasingPage /></Suspense>;
}
