import { config } from './config.js';
import { pool } from './db.js';
import { buildApp } from './server.js';

const app = await buildApp();
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, async () => { await app.close(); await pool.end(); process.exit(0); });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
