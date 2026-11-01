'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, errorText, type Product } from '../../../../lib/catalog-api';
import { OnlinePanel } from '../_components/online-panel';
import { ProductForm } from '../_components/product-form';
import { useMeta } from '../_components/use-meta';

const STATUS: Record<string, [string, string]> = { active: ['success', 'Active'], draft: ['', 'Draft'], archived: ['warning', 'Archived'] };

export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { meta, error: metaError } = useMeta();
  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState('');
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    api<Product>(`/products/${id}`).then((r) => setProduct(r.data)).catch((e) => setError(errorText(e)));
  }, [id]);

  const [notice, setNotice] = useState('');
  const saved = (p: Product) => { setProduct(p); setFormKey((k) => k + 1); setNotice('Saved'); };

  const archive = async () => {
    if (!product) return;
    const restoring = product.status === 'archived';
    if (!restoring && !confirm('Archive this product? It disappears from search and POS; history is kept. You can restore it later.')) return;
    try { saved((await api<Product>(`/products/${id}/${restoring ? 'restore' : 'archive'}`, { method: 'POST' })).data); }
    catch (e) { setError(errorText(e)); }
  };

  if (error || metaError) return <div className="ui-content"><div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error || metaError}</div></div></div>;
  if (!product || !meta) return <div className="ui-content"><div className="ui-skeleton" style={{ height: 240 }} /></div>;
  const [tone, label] = STATUS[product.status];
  const activeIds = product.variants.filter((v) => v.status === 'active').map((v) => v.id);

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><Link className="ui-caption" href="/products">Products /</Link><h1 className="ui-h1">{product.name}</h1></div>
        <span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span>
        <div className="ui-actions">
          <button className="ui-btn" type="button" onClick={() => router.push(`/products/labels?variants=${activeIds.join(',')}`)}>Print labels</button>
          {meta.can.write && <button className="ui-btn" type="button" onClick={archive}>{product.status === 'archived' ? 'Restore' : 'Archive'}</button>}
        </div>
      </div>
      {product.status === 'archived' && <div className="ui-alert ui-alert--warning"><div className="ui-alert-body">This product is archived. Restore it to edit.</div></div>}
      {notice && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">{notice}</div></div>}
      <OnlinePanel product={product} canWrite={meta.can.write} onChanged={(p) => { if (p.version !== product.version) setFormKey((k) => k + 1); setProduct(p); }} />
      <ProductForm key={formKey} product={product} meta={meta} onSaved={saved} onImagesChanged={setProduct} />
    </div>
  );
}
