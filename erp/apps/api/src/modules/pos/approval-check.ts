import type { Tx } from '../../db.js';
import type { PriceOptions, Seat } from './pricing.js';

// Using an approved discount request on a quote or a sale (v2, D107). Only the person who asked, at the same outlet, within
// 15 minutes of the approval, once, and only for the cart that was approved (priceCart compares the cart's hash).

export interface ApprovalUse { opts: PriceOptions; id: string | null; approverId: string | null; approverName: string | null; via: string | null }

export async function approvalFor(tx: Tx, seat: Seat, outletId: string, approvalId: string | undefined, lock = false): Promise<ApprovalUse> {
  const none = { id: null, approverId: null, approverName: null, via: null };
  if (!approvalId) return { opts: {}, ...none };
  const { rows: [a] } = await tx.query(
    `SELECT r.id, r.requested_by, r.outlet_id, r.status, r.cart_hash, r.reason, r.decided_by, r.decided_via, r.expires_at > now() AS live, u.name AS approver
       FROM discount_requests r LEFT JOIN users u ON u.id = r.decided_by WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [approvalId]);
  const problem = !a || a.requested_by !== seat.userId || a.outlet_id !== outletId ? 'That approval is not for this till.'
    : a.status === 'pending' ? 'The request is still waiting for an answer.'
    : a.status === 'rejected' ? 'The discount was not approved.'
    : a.status === 'cancelled' ? 'That request was cancelled.'
    : a.status === 'used' ? 'That approval was already used on a bill.'
    : !a.live ? 'The approval has expired: ask again.' : null;
  if (problem) return { opts: { approvalProblem: problem }, ...none };
  return { opts: { approval: { hash: a.cart_hash, reason: a.reason } }, id: a.id, approverId: a.decided_by, approverName: a.approver, via: a.decided_via };
}

/** In the sale's transaction: the approval is spent on this invoice. A second sale with it finds it used and rolls back. */
export async function spendApproval(tx: Tx, approvalId: string, invoiceId: string) {
  const { rowCount } = await tx.query(
    `UPDATE discount_requests SET status = 'used', invoice_id = $2 WHERE id = $1 AND status = 'approved' AND expires_at > now()`, [approvalId, invoiceId]);
  return rowCount === 1;
}
