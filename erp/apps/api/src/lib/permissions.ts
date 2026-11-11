export type Permission =
  | 'users.read' | 'users.manage' | 'settings.read' | 'settings.manage' | 'audit.read'
  // B2 · catalog
  | 'product.read' | 'product.write' | 'cost.view' | 'report.export'
  // B3 · inventory and purchasing (docs/design/04-tenancy-and-permissions.md §2)
  | 'stock.read' | 'stock.adjust' | 'stock.writeoff' | 'stock.transfer' | 'stock.override_negative'
  | 'stocktake.count' | 'stocktake.approve' | 'purchase.manage' | 'purchase.receive'
  // B4 · web orders and WooCommerce sync
  | 'order.read' | 'order.fulfil' | 'sync.manage' | 'woo.connect'
  // B5 · POS, GST invoices and returns
  | 'pos.sell' | 'pos.discount' | 'pos.price_override' | 'return.manage' | 'invoice.read' | 'invoice.void'
  // B6 · reports (valuation columns also need cost.view; CSV needs report.export)
  | 'report.view'
  // B7 · the store's account: plan and payments, data export, support access (owner only)
  | 'account.manage'
  // v2 batch 2 · the Contacts page (customers and suppliers with their history), bulk price updates (D96, D97)
  | 'contacts.view' | 'price.bulk'
  // v2 phase 2 · approve a discount above the cashier's limit, by PIN at the till or from the Approvals page (D107)
  | 'pos.discount_approve'
  // v2 phase 3 · cash control: every till's register and cash book, cash taken out, till expenses approved, payment methods and tills (D110–D112)
  | 'cash.manage';
export const ROLES = ['owner', 'manager', 'inventory', 'cashier', 'fulfillment'] as const;
export type Role = (typeof ROLES)[number];
export const ASSIGNABLE_ROLES = ['manager', 'inventory', 'cashier', 'fulfillment'] as const;

const grants: Record<Role, readonly Permission[]> = {
  owner: ['users.read', 'users.manage', 'settings.read', 'settings.manage', 'audit.read',
    'product.read', 'product.write', 'cost.view', 'report.export',
    'stock.read', 'stock.adjust', 'stock.writeoff', 'stock.transfer', 'stock.override_negative',
    'stocktake.count', 'stocktake.approve', 'purchase.manage', 'purchase.receive',
    'order.read', 'order.fulfil', 'sync.manage', 'woo.connect',
    'pos.sell', 'pos.discount', 'pos.price_override', 'return.manage', 'invoice.read', 'invoice.void', 'report.view',
    'account.manage', 'contacts.view', 'price.bulk', 'pos.discount_approve', 'cash.manage'],
  // Manager runs the sync (retry, reconcile, publish) but cannot change the shop's credentials or void a tax invoice.
  manager: ['users.read', 'settings.read', 'audit.read', 'product.read', 'product.write', 'cost.view', 'report.export',
    'stock.read', 'stock.adjust', 'stock.writeoff', 'stock.transfer', 'stocktake.count', 'stocktake.approve',
    'purchase.manage', 'purchase.receive', 'order.read', 'order.fulfil', 'sync.manage',
    'pos.sell', 'pos.discount', 'pos.price_override', 'return.manage', 'invoice.read', 'report.view',
    'contacts.view', 'price.bulk', 'pos.discount_approve', 'cash.manage'],
  // Counts but cannot approve its own count; receives goods but does not raise POs.
  inventory: ['product.read', 'product.write', 'cost.view',
    'stock.read', 'stock.adjust', 'stock.transfer', 'stocktake.count', 'purchase.receive', 'report.view'],
  // Sells, discounts up to the store's cashier limit, takes returns and reprints; no price changes, no stock screens.
  cashier: ['product.read', 'order.read', 'pos.sell', 'pos.discount', 'return.manage', 'invoice.read'],
  fulfillment: ['product.read', 'stock.read', 'order.read', 'order.fulfil'],
};
export const permissionsOf = (role: Role) => grants[role];
export const can = (role: Role, p: Permission) => grants[role].includes(p);
