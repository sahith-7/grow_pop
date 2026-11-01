'use client';

import Link from 'next/link';
import { ProductForm } from '../_components/product-form';
import { useMeta } from '../_components/use-meta';

export default function NewProductPage() {
  const { meta, error } = useMeta();
  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><Link className="ui-caption" href="/products">Products /</Link><h1 className="ui-h1">New product</h1></div></div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {meta && !meta.can.write && <div className="ui-alert ui-alert--warning"><div className="ui-alert-body">Your role cannot add products.</div></div>}
      {meta?.can.write && <ProductForm meta={meta} />}
    </div>
  );
}
