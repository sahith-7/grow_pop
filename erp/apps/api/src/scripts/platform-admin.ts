/**
 * Platform console accounts (B7). The only way to create one: the app's database role cannot write these tables.
 * Runs with the migration role. With Docker:
 *
 *   docker compose run --rm migrate node dist/scripts/platform-admin.js add you@example.com "Your Name"
 *   docker compose run --rm migrate node dist/scripts/platform-admin.js reset-code you@example.com
 *   docker compose run --rm migrate node dist/scripts/platform-admin.js password you@example.com
 *   docker compose run --rm migrate node dist/scripts/platform-admin.js disable you@example.com
 *   docker compose run --rm migrate node dist/scripts/platform-admin.js list
 *
 * `add` and `reset-code` print a setup key and an otpauth:// link for an authenticator app (Google Authenticator,
 * Microsoft Authenticator, 1Password, Aegis). Nothing is stored in plain text.
 */
import { createInterface } from 'node:readline';
import argon2 from 'argon2';
import pg from 'pg';
import { seal } from '../lib/secret-box.js';
import { newSecret, otpauthUri } from '../lib/totp.js';
import { wooEnv } from '../modules/woocommerce/env.js';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) { console.error('MIGRATION_DATABASE_URL is required'); process.exit(1); }
const [cmd, emailArg, nameArg] = process.argv.slice(2);

function askHidden(question: string): Promise<string> {
  if (process.env.PLATFORM_ADMIN_PASSWORD) return Promise.resolve(process.env.PLATFORM_ADMIN_PASSWORD);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => { if (!muted) out.output.write(s); };
  return new Promise((resolve) => {
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
    muted = true;
  });
}

async function newPassword() {
  const p1 = await askHidden('New password (at least 14 characters): ');
  if (p1.length < 14) throw new Error('Password must be at least 14 characters');
  if (!process.env.PLATFORM_ADMIN_PASSWORD && p1 !== await askHidden('Same password again: ')) throw new Error('Passwords do not match');
  return argon2.hash(p1, { type: argon2.argon2id });
}

function showCode(email: string, secret: string) {
  console.log('\nAdd this to your authenticator app now. It is not shown again.');
  console.log(`  Setup key: ${secret.match(/.{1,4}/g)!.join(' ')}`);
  console.log(`  Or open:   ${otpauthUri(`${wooEnv.APP_NAME} console`, email, secret)}\n`);
}

const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  const email = emailArg?.toLowerCase();
  if (cmd !== 'list' && (!email || !email.includes('@'))) throw new Error('Usage: platform-admin <add|reset-code|password|disable|enable|list> <email> ["Name"]');
  if (cmd === 'add') {
    if (!nameArg) throw new Error('Give a name: add you@example.com "Your Name"');
    const hash = await newPassword();
    const secret = newSecret();
    await db.query('BEGIN');
    const { rows: [a] } = await db.query(
      "INSERT INTO platform_admins (email, name, password_hash, totp_secret_enc) VALUES ($1, $2, $3, '\\x00') RETURNING id", [email, nameArg, hash]);
    await db.query('UPDATE platform_admins SET totp_secret_enc = $2 WHERE id = $1', [a.id, seal(secret, 'platform', `platform-totp:${a.id}`)]);
    await db.query("INSERT INTO platform_audit (admin_email, action, detail) VALUES ('script', 'platform.admin_added', $1)", [{ email }]);
    await db.query('COMMIT');
    showCode(email!, secret);
    console.log(`Added ${email}. Sign in at <your app address>/platform/login.`);
  } else if (cmd === 'reset-code') {
    const { rows: [a] } = await db.query('SELECT id FROM platform_admins WHERE email = $1', [email]);
    if (!a) throw new Error(`No console account for ${email}`);
    const secret = newSecret();
    await db.query('UPDATE platform_admins SET totp_secret_enc = $2, totp_last_step = 0 WHERE id = $1', [a.id, seal(secret, 'platform', `platform-totp:${a.id}`)]);
    await db.query('DELETE FROM platform_sessions WHERE admin_id = $1', [a.id]);
    await db.query("INSERT INTO platform_audit (admin_email, action, detail) VALUES ('script', 'platform.code_reset', $1)", [{ email }]);
    showCode(email!, secret);
  } else if (cmd === 'password') {
    const hash = await newPassword();
    const { rowCount } = await db.query('UPDATE platform_admins SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE email = $1', [email, hash]);
    if (!rowCount) throw new Error(`No console account for ${email}`);
    await db.query('DELETE FROM platform_sessions WHERE admin_id = (SELECT id FROM platform_admins WHERE email = $1)', [email]);
    await db.query("INSERT INTO platform_audit (admin_email, action, detail) VALUES ('script', 'platform.password_changed', $1)", [{ email }]);
    console.log('Password changed; existing console sessions were signed out.');
  } else if (cmd === 'disable' || cmd === 'enable') {
    const { rowCount } = await db.query('UPDATE platform_admins SET status = $2 WHERE email = $1', [email, cmd === 'disable' ? 'disabled' : 'active']);
    if (!rowCount) throw new Error(`No console account for ${email}`);
    if (cmd === 'disable') await db.query('DELETE FROM platform_sessions WHERE admin_id = (SELECT id FROM platform_admins WHERE email = $1)', [email]);
    await db.query("INSERT INTO platform_audit (admin_email, action, detail) VALUES ('script', $2, $1)", [{ email }, `platform.admin_${cmd}d`]);
    console.log(`${cmd === 'disable' ? 'Disabled' : 'Enabled'} ${email}.`);
  } else if (cmd === 'list') {
    const { rows } = await db.query('SELECT email, name, status, created_at FROM platform_admins ORDER BY created_at');
    for (const r of rows) console.log(`${r.email}\t${r.name}\t${r.status}\t${r.created_at.toISOString()}`);
  } else {
    throw new Error('Commands: add, reset-code, password, disable, enable, list');
  }
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
