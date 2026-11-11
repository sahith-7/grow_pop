import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from '../../db.js';
import { authOf, can, signedIn } from '../../lib/phase1.js';

// v2 (D91): the top bar's "Jump to anywhere" search, and (v2 Phase 1, D102) the suggestions under every list's search box.
// At most `limit` hits per kind, only kinds the user's role may open. Screens and actions are matched in the browser.

const like = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const KINDS = ['product', 'customer', 'supplier', 'invoice', 'order', 'return'] as const;
type Kind = typeof KINDS[number];
export interface Hit { kind: string; type: Kind; id: string; title: string; subtitle: string | null; href: string }

const query = z.object({
  q: z.string().trim().min(2).max(80),
  kinds: z.string().max(80).optional()
    .transform((v) => (v ? v.split(',').map((k) => k.trim()) : [...KINDS]))
    .pipe(z.array(z.enum(KINDS)).min(1)),
  limit: z.coerce.number().int().min(1).max(8).default(5),
}).strict();

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search', { preHandler: signedIn(), config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const { q, kinds, limit } = query.parse(req.query);
    const want = (k: Kind) => kinds.includes(k);
    return tenantTx(authOf(req).tenantId, async (t) => {
      const hits: Hit[] = [];
      if (want('product') && can(req, 'product.read')) {
        // Name anywhere, or a SKU / barcode that starts with what was typed.
        const { rows } = await t.query(
          `SELECT p.id, p.name, v.sku, v.variants FROM products p
             CROSS JOIN LATERAL (SELECT (array_agg(sku ORDER BY position))[1] AS sku, count(*)::int AS variants FROM product_variants WHERE product_id = p.id) v
            WHERE p.status <> 'archived' AND (lower(p.name) LIKE $1 OR EXISTS (
                  SELECT 1 FROM product_variants x WHERE x.product_id = p.id AND (lower(x.sku) LIKE $2 OR x.barcode LIKE $2)))
            ORDER BY lower(p.name) LIKE $2 DESC, lower(p.name) LIMIT $3`, [like(q), like(q).slice(1), limit]);
        hits.push(...rows.map((r) => ({ kind: 'Product', type: 'product' as const, id: r.id, title: r.name,
          subtitle: r.variants > 1 ? `${r.sku} · ${r.variants} variants` : r.sku, href: `/products/${r.id}` })));
      }
      if (want('customer') && can(req, 'contacts.view')) {
        const { rows } = await t.query(
          `SELECT id, name, phone FROM customers WHERE archived_at IS NULL
              AND (lower(name) LIKE $1 OR coalesce(phone, '') LIKE $1 OR lower(coalesce(email, '')) LIKE $1)
            ORDER BY lower(name) LIKE $2 DESC, lower(name) LIMIT $3`, [like(q), like(q).slice(1), limit]);
        hits.push(...rows.map((r) => ({ kind: 'Customer', type: 'customer' as const, id: r.id, title: r.name || r.phone || 'Customer', subtitle: r.name ? r.phone : null,
          href: `/contacts/customers/${r.id}` })));
      }
      if (want('supplier') && (can(req, 'contacts.view') || can(req, 'purchase.manage'))) {
        const { rows } = await t.query(
          `SELECT id, name, phone FROM suppliers WHERE archived_at IS NULL AND (lower(name) LIKE $1 OR coalesce(phone, '') LIKE $1)
            ORDER BY lower(name) LIKE $2 DESC, lower(name) LIMIT $3`, [like(q), like(q).slice(1), limit]);
        const contacts = can(req, 'contacts.view');
        hits.push(...rows.map((r) => ({ kind: 'Supplier', type: 'supplier' as const, id: r.id, title: r.name, subtitle: r.phone,
          href: contacts ? `/contacts/suppliers/${r.id}` : `/suppliers?q=${encodeURIComponent(r.name)}` })));
      }
      if (want('invoice') && can(req, 'invoice.read')) {
        const { rows } = await t.query(
          `SELECT i.id, i.number, i.total, i.buyer->>'name' AS buyer FROM invoices i
            WHERE lower(i.number) LIKE $1 OR lower(coalesce(i.buyer->>'name', '')) LIKE $1 OR coalesce(i.buyer->>'phone', '') LIKE $1
            ORDER BY i.issued_at DESC LIMIT $2`, [like(q), limit]);
        hits.push(...rows.map((r) => ({ kind: 'Invoice', type: 'invoice' as const, id: r.id, title: r.number, subtitle: r.buyer ? `${r.buyer} · ₹${r.total}` : `₹${r.total}`,
          href: `/invoices/${r.id}` })));
      }
      if (want('order') && can(req, 'order.read')) {
        const { rows } = await t.query(
          `SELECT id, number, customer_snapshot->>'name' AS customer FROM sales_orders
            WHERE channel = 'woocommerce' AND (lower(number) LIKE $1 OR lower(coalesce(customer_snapshot->>'name', '')) LIKE $1)
            ORDER BY placed_at DESC LIMIT $2`, [like(q), limit]);
        hits.push(...rows.map((r) => ({ kind: 'Online order', type: 'order' as const, id: r.id, title: `#${r.number}`, subtitle: r.customer, href: `/orders/${r.id}` })));
      }
      if (want('return') && can(req, 'return.manage')) {
        const { rows } = await t.query(
          `SELECT r.id, r.number, i.number AS invoice, i.buyer->>'name' AS buyer FROM customer_returns r JOIN invoices i ON i.id = r.invoice_id
            WHERE lower(r.number) LIKE $1 OR lower(i.number) LIKE $1 OR lower(coalesce(i.buyer->>'name', '')) LIKE $1
            ORDER BY r.posted_at DESC LIMIT $2`, [like(q), limit]);
        hits.push(...rows.map((r) => ({ kind: 'Return', type: 'return' as const, id: r.id, title: r.number, subtitle: [r.invoice, r.buyer].filter(Boolean).join(' · '),
          href: `/returns?q=${encodeURIComponent(r.number)}` })));
      }
      return { items: hits };
    });
  });
}
