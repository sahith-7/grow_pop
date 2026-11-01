/**
 * When a store owner loses the phone with their authenticator app (D83). Runs with the migration role, so only you
 * (the operator) can do it, after checking who is asking (call them on the store's registered number).
 *
 *   docker compose run --rm migrate node dist/scripts/owner-totp.js reset owner@store.com "Lost phone, verified by call"
 *
 * Clears the owner's authenticator app and signs them out everywhere. At their next sign-in they set up a new one.
 * The store's audit log records it.
 */
import pg from 'pg';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) { console.error('MIGRATION_DATABASE_URL is required'); process.exit(1); }
const [cmd, email, reason] = process.argv.slice(2);
if (cmd !== 'reset' || !email || !reason || reason.trim().length < 3) {
  console.error('Usage: owner-totp.js reset <owner e-mail> "<reason>"');
  process.exit(1);
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query('BEGIN');
  const { rows: [u] } = await c.query("SELECT id, tenant_id FROM users WHERE email = $1 AND role = 'owner' FOR UPDATE", [email.toLowerCase()]);
  if (!u) throw new Error(`No store owner with e-mail ${email}`);
  await c.query('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL WHERE id = $1', [u.id]);
  await c.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  await c.query(`INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, summary)
                 VALUES ($1, NULL, 'user.totp_reset_by_operator', 'user', $2, $3)`, [u.tenant_id, u.id, JSON.stringify({ reason: reason.trim() })]);
  await c.query('COMMIT');
  console.log(`Done. ${email} sets up a new authenticator app at their next sign-in.`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await c.end();
}
