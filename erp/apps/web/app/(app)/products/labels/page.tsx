'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { code128Modules, ean13Modules, isEan13 } from '../../../../lib/barcode-svg';
import { api, errorText } from '../../../../lib/catalog-api';
import { money } from '../../../../lib/format';

interface Label { variantId: string; copies: number; code: string; codeSource: 'barcode' | 'sku'; sku: string; name: string; price: string; mrp: string | null }

// Physical label sizes. Thermal printers print one label per page; A4 sheets are 65-up (38.1 x 21.2 mm).
const TEMPLATES = {
  '50x25': { w: 50, h: 25, page: '50mm 25mm', cols: 1, gapMm: 0, margin: '0' },
  '38x25': { w: 38, h: 25, page: '38mm 25mm', cols: 1, gapMm: 0, margin: '0' },
  'a4-65': { w: 38.1, h: 21.2, page: 'A4', cols: 5, gapMm: 2.5, margin: '10.7mm 4.65mm' },
} as const;
type Template = keyof typeof TEMPLATES;

function Bars({ code }: { code: string }) {
  const ean = isEan13(code);
  const modules = ean ? ean13Modules(code) : code128Modules(code);
  if (!modules) return <div className="ui-error">Cannot print “{code}” as a barcode</div>;
  const quiet = ean ? 9 : 10; // quiet zones in modules, required for reliable scans
  const width = modules.length + quiet * 2;
  const rects: React.ReactNode[] = [];
  for (let i = 0; i < modules.length; ) {
    if (modules[i] !== '1') { i++; continue; }
    let j = i; while (modules[j] === '1') j++;
    // EAN guard bars run longer, as on printed packaging
    const guard = ean && (i < 3 || (i >= 45 && i < 50) || i >= 92);
    rects.push(<rect key={i} x={quiet + i} y={0} width={j - i} height={guard ? 46 : 40} />);
    i = j;
  }
  return (
    <svg viewBox={`0 0 ${width} 52`} preserveAspectRatio="none" style={{ width: '100%', height: '55%', display: 'block' }} role="img" aria-label={`Barcode ${code}`} shapeRendering="crispEdges">
      <g fill="#000">{rects}</g>
      <text x={width / 2} y={51} fontSize={7} textAnchor="middle" fontFamily="monospace">{code}</text>
    </svg>
  );
}

function LabelsPage() {
  const params = useSearchParams();
  const ids = (params.get('variants') ?? '').split(',').filter(Boolean);
  const [labels, setLabels] = useState<Label[]>([]);
  const [template, setTemplate] = useState<Template>('50x25');
  const [showPrice, setShowPrice] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ids.length) return;
    api<{ labels: Label[] }>('/labels', { method: 'POST', body: { items: ids.map((variantId) => ({ variantId, copies: 1 })) } })
      .then((r) => setLabels(r.data.labels)).catch((e) => setError(errorText(e)));
  }, [params]);

  const t = TEMPLATES[template];
  const sheet = labels.flatMap((l) => Array.from({ length: l.copies }, () => l));

  return (
    <div className="ui-content">
      <style>{`
        @media print {
          @page { size: ${t.page}; margin: ${t.margin}; }
          body * { visibility: hidden; }
          #label-sheet, #label-sheet * { visibility: visible; }
          #label-sheet { position: absolute; left: 0; top: 0; }
        }
        #label-sheet { display: grid; grid-template-columns: repeat(${t.cols}, ${t.w}mm); gap: ${t.cols > 1 ? `0 ${t.gapMm}mm` : '0'}; }
        .label { width: ${t.w}mm; height: ${t.h}mm; box-sizing: border-box; padding: 1mm 2mm; overflow: hidden; break-inside: avoid;
                 display: flex; flex-direction: column; justify-content: space-between; font-family: var(--font-sans); color: #000; background: #fff; }
        @media screen { .label { outline: 1px dashed var(--border); } }
        ${t.cols === 1 ? '@media print { .label { break-after: page; } }' : ''}
      `}</style>
      <div className="ui-page-header">
        <div><Link className="ui-caption" href="/products">Products /</Link><h1 className="ui-h1">Print labels</h1></div>
        <div className="ui-actions"><button className="ui-btn ui-btn--primary" type="button" disabled={!sheet.length} onClick={() => window.print()}>Print {sheet.length || ''}</button></div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {!ids.length && <div className="ui-empty"><p>Open a product and choose Print labels.</p></div>}

      {labels.length > 0 && (
        <div className="ui-panel">
          <div className="ui-toolbar">
            <select className="ui-select" aria-label="Label size" value={template} onChange={(e) => setTemplate(e.target.value as Template)}>
              <option value="50x25">50 × 25 mm thermal</option>
              <option value="38x25">38 × 25 mm thermal</option>
              <option value="a4-65">A4 sheet, 65 per page</option>
            </select>
            <label className="ui-check"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> Show price</label>
          </div>
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Item</th><th scope="col">Code</th><th scope="col" className="ui-qty">Copies</th></tr></thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={l.variantId}>
                  <td>{l.name}</td>
                  <td className="ui-code">{l.code}{l.codeSource === 'sku' && <span className="ui-badge ui-badge--warning" style={{ marginLeft: 8 }}>No barcode, using SKU</span>}</td>
                  <td className="ui-qty"><input className="ui-input ui-input--num" style={{ width: 80 }} type="number" min={0} max={200} aria-label={`Copies of ${l.name}`}
                    value={l.copies} onChange={(e) => setLabels(labels.map((x, j) => (j === i ? { ...x, copies: Math.max(0, Math.min(200, Number(e.target.value) || 0)) } : x)))} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      <div id="label-sheet" aria-label="Label preview">
        {sheet.map((l, i) => (
          <div className="label" key={i}>
            <div style={{ fontSize: '7pt', lineHeight: 1.15, fontWeight: 600, maxHeight: '2.3em', overflow: 'hidden' }}>{l.name}</div>
            <Bars code={l.code} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '7pt' }}>
              <span>{l.sku}</span>
              {showPrice && <span style={{ fontWeight: 600 }}>{money(l.price)}{l.mrp && Number(l.mrp) !== Number(l.price) ? ` · MRP ${money(l.mrp)}` : ''}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><LabelsPage /></Suspense>;
}
