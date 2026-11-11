import Link from 'next/link';
import { PoForm } from '../_components/po-form';

// ?supplierId= comes from a supplier's page in Contacts (v2, D96).
export default async function NewPurchaseOrderPage({ searchParams }: { searchParams: Promise<{ supplierId?: string }> }) {
  const { supplierId } = await searchParams;
  const initial = supplierId && /^[0-9a-f-]{36}$/i.test(supplierId) ? supplierId : undefined;
  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><Link className="ui-caption" href="/purchasing">Purchasing /</Link><h1 className="ui-h1">New purchase order</h1></div></div>
      <PoForm initialSupplierId={initial} />
    </div>
  );
}
