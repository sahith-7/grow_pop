import './lib/zod-config.js';
import pino from 'pino';
import { config } from './config.js';
import { pool } from './db.js';
import { startRunner } from './jobs/runner.js';
import './modules/account/export-job.js'; // registers the 'export' handler (B7)
import './modules/imports/job.js'; // registers the 'import' handler
import './modules/cash/mail-job.js'; // registers the 'mail.register' handler (v2, D112)
import { startSaasTicker } from './modules/saas/ticker.js'; // store states, reminders, alert e-mails (B7)
import { startSweeper } from './modules/woocommerce/jobs.js'; // registers the woo.* handlers

const log = pino({ level: config.NODE_ENV === 'test' ? 'silent' : 'info' });
const runner = startRunner(log);
const sweeper = startSweeper(log);
const saas = startSaasTicker(log);
log.info('worker started');
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, async () => { sweeper.stop(); saas.stop(); await runner.stop(); await pool.end(); process.exit(0); });
