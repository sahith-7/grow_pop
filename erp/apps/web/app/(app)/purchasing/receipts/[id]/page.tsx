'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { money } from '../../../../../lib/format';
import { api, dateTime, errorText, type Receipt } from '../../../../../lib/stock-api';
import { ItemCell } from '../../../stock/_components/item-picker';

function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const posted = useSearchParams().get('posted');
  const [r, setR] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Receipt>(`/goods-receipts/${id}`).then((x) => setR(x.data)).catch((e) => setError(errorText(e))); }, [id]);

  if (!r) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 200 }} />}</div>;
  const seeCost = r.lines.some((l) => l.unitCost !== undefined);
  const anyDamaged = r.lines.some((l) => l.damagedQty !== '0');

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div>
          <Link className="ui-caption" href="/purchasing?tab=receipts">Goods received /</Link>
          <h1 className="ui-h1">{r.number}</h1>
          <div className="ui-caption">
            {r.supplier.name} · {dateTime(r.postedAt)}{r.postedBy ? ` by ${r.postedBy}` : ''}
            {r.purchaseOrder && <> · order <Link href={`/purchasing/${r.purchaseOrder.id}`}>{r.purchaseOrder.number}</Link></>}
            {r.supplierInvoiceNo && ` · invoice ${r.supplierInvoiceNo}`}
          </div>
        </div>
        <div className="ui-actions">
          <Link className="ui-btn" href={`/stock/movements?sourceId=${r.id}`}>Stock movements</Link>
          <Link className="ui-btn" href={`/products/labels?receipt=${r.id}`}>Print labels</Link>
          {anyDamaged && <Link className="ui-btn" href={`/purchasing/returns/new?receipt=${r.id}`}>Return damaged to supplier</Link>}
        </div>
      </div>
      {posted && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">Received. Accepted items are in stock now{anyDamaged ? '; damaged items are held as damaged stock' : ''}.</div></div>}
      {r.note && <p className="ui-muted">{r.note}</p>}
      <div className="ui-panel"><div className="ui-table-wrap"><table className="ui-table" data-collapse>
        <thead><tr><th scope="col">Item</th><th scope="col">Put in</th><th scope="col" className="ui-num">Arrived</th><th scope="col" className="ui-num">Accepted</th><th scope="col" className="ui-num">Damaged</th>{seeCost && <th scope="col" className="ui-money">Unit cost</th>}</tr></thead>
        <tbody>{r.lines.map((l) => (
          <tr key={l.id}>
            <td data-primary><ItemCell item={l} />{!l.poLineId && r.purchaseOrder && <span className="ui-badge ui-badge--warning">not on order</span>}</td>
            <td data-label="Put in">{l.locationName}</td>
            <td className="ui-num" data-label="Arrived">{l.receivedQty}</td>
            <td className="ui-num" data-label="Accepted">{l.acceptedQty}</td>
            <td className="ui-num" data-label="Damaged">{l.damagedQty === '0' ? <span className="ui-muted">0</span> : l.damagedQty}</td>
            {seeCost && <td className="ui-money" data-label="Unit cost">{money(l.unitCost)}</td>}
          </tr>
        ))}</tbody>
      </table></div></div>
    </div>
  );
}

export default function Page() {
  return <Suspense><ReceiptPage /></Suspense>;
}
