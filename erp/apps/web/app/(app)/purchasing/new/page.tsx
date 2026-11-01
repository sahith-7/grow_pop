import Link from 'next/link';
import { PoForm } from '../_components/po-form';

export default function NewPurchaseOrderPage() {
  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><Link className="ui-caption" href="/purchasing">Purchasing /</Link><h1 className="ui-h1">New purchase order</h1></div></div>
      <PoForm />
    </div>
  );
}
