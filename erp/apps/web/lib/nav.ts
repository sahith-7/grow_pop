import type { IconName } from './icons';

// The app's screens, grouped as the side menu shows them (v2, D92). The top-bar search jumps to the same list.
// `perm` lists permissions; any one shows the item. The API enforces the same rules: this is convenience, not security.

export interface NavLink { href: string; label: string; perm: string[] | null; keywords?: string }
export interface NavGroup { key: string; label: string; icon: IconName; href?: string; perm?: string[] | null; items?: NavLink[]; keywords?: string }

export const NAV: NavGroup[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', href: '/dashboard', perm: null },
  { key: 'items', label: 'Items', icon: 'items', items: [
    { href: '/products', label: 'Products', perm: ['product.read'], keywords: 'items catalog' },
    { href: '/products/new', label: 'Add product', perm: ['product.write'], keywords: 'new item create' },
    { href: '/products/categories', label: 'Categories & brands', perm: ['product.read'] },
    { href: '/products/prices', label: 'Bulk price update', perm: ['price.bulk'], keywords: 'change prices mrp rate list increase' },
    { href: '/products/labels', label: 'Barcode labels', perm: ['product.read'], keywords: 'print stickers' },
    { href: '/products/import', label: 'Import products', perm: ['product.write'], keywords: 'csv upload' },
  ] },
  { key: 'stock', label: 'Stock', icon: 'stock', items: [
    { href: '/stock', label: 'Stock on hand', perm: ['stock.read'], keywords: 'inventory' },
    { href: '/stock/movements', label: 'Stock movements', perm: ['stock.read'], keywords: 'ledger history' },
    { href: '/stock/adjust', label: 'Adjust stock', perm: ['stock.adjust', 'stock.writeoff'], keywords: 'damage write off' },
    { href: '/stock/transfer', label: 'Transfer stock', perm: ['stock.transfer'], keywords: 'move' },
    { href: '/stock/opening', label: 'Opening stock', perm: ['stock.adjust'], keywords: 'import' },
    { href: '/stocktakes', label: 'Stocktakes', perm: ['stocktake.count'], keywords: 'count audit' },
    { href: '/stock/locations', label: 'Locations', perm: ['stock.read'], keywords: 'godown stock room store branch outlet' },
  ] },
  { key: 'purchase', label: 'Purchase', icon: 'purchase', items: [
    { href: '/purchasing', label: 'Purchase orders', perm: ['purchase.manage', 'purchase.receive'], keywords: 'po' },
    { href: '/purchasing/new', label: 'New purchase order', perm: ['purchase.manage'] },
    { href: '/purchasing/receive', label: 'Receive goods', perm: ['purchase.receive'], keywords: 'grn bill inward' },
    { href: '/contacts?type=supplier', label: 'Suppliers', perm: ['contacts.view'], keywords: 'vendors' },
  ] },
  { key: 'sales', label: 'Sales', icon: 'sales', items: [
    { href: '/invoices', label: 'Invoices', perm: ['invoice.read'], keywords: 'bills gst' },
    { href: '/returns', label: 'Returns', perm: ['return.manage'], keywords: 'credit note refund' },
    { href: '/approvals', label: 'Approvals', perm: ['pos.discount_approve'], keywords: 'approve discount expense request permission salesman' },
    { href: '/orders', label: 'Online orders', perm: ['order.read'], keywords: 'woocommerce web' },
    { href: '/fulfilment', label: 'Fulfilment', perm: ['order.fulfil'], keywords: 'pick pack dispatch' },
  ] },
  { key: 'cash', label: 'Cash control', icon: 'cash', items: [
    { href: '/cash', label: 'Registers', perm: ['cash.manage'], keywords: 'till drawer shift closing short excess counter' },
    { href: '/cash/book', label: 'Cash book', perm: ['cash.manage'], keywords: 'daily cash expenses petty' },
    { href: '/cash/tills', label: 'Tills', perm: ['cash.manage'], keywords: 'counter register drawer' },
    { href: '/cash/methods', label: 'Payment methods', perm: ['cash.manage'], keywords: 'upi card paytm phonepe gpay modes' },
  ] },
  { key: 'contacts', label: 'Contacts', icon: 'contacts', href: '/contacts', perm: ['contacts.view'], keywords: 'customers suppliers parties vendors' },
  { key: 'reports', label: 'Reports', icon: 'reports', href: '/reports', perm: ['report.view'] },
  { key: 'users', label: 'Users', icon: 'users', href: '/team', perm: ['users.read'] },
  { key: 'settings', label: 'Settings', icon: 'settings', items: [
    { href: '/settings', label: 'Store settings', perm: ['settings.read'], keywords: 'address gstin timezone' },
    { href: '/billing', label: 'Billing & GST', perm: ['settings.read'], keywords: 'invoice series tax' },
    { href: '/account', label: 'Account & plan', perm: ['account.manage'], keywords: 'subscription export' },
    { href: '/security', label: 'Password & sign-in', perm: null, keywords: 'authenticator 2fa' },
  ] },
  { key: 'apps', label: 'Apps & integrations', icon: 'apps', items: [
    { href: '/integrations/woocommerce', label: 'WooCommerce', perm: ['sync.manage'], keywords: 'online shop website' },
  ] },
  { key: 'logs', label: 'Logs', icon: 'logs', href: '/audit', perm: ['audit.read'], keywords: 'audit' },
];

/** Things the "+ New" button creates. */
export const CREATE: NavLink[] = [
  { href: '/products/new', label: 'Product', perm: ['product.write'] },
  { href: '/purchasing/new', label: 'Purchase order', perm: ['purchase.manage'] },
  { href: '/purchasing/receive', label: 'Goods receipt', perm: ['purchase.receive'] },
  { href: '/stock/adjust', label: 'Stock adjustment', perm: ['stock.adjust'] },
  { href: '/stock/transfer', label: 'Stock transfer', perm: ['stock.transfer'] },
  { href: '/returns/new', label: 'Sales return', perm: ['return.manage'] },
  { href: '/stocktakes', label: 'Stocktake', perm: ['stocktake.count'] },
];

export const allowed = (perm: string[] | null | undefined, permissions: string[]) => !perm || perm.some((p) => permissions.includes(p));

/** Every screen the user may open, flattened, for the search box. */
export function screens(permissions: string[]) {
  return NAV.flatMap((g) => (g.items
    ? g.items.filter((i) => allowed(i.perm, permissions)).map((i) => ({ ...i, group: g.label }))
    : allowed(g.perm, permissions) && g.href ? [{ href: g.href, label: g.label, perm: g.perm ?? null, group: '', keywords: g.keywords }] : []));
}
