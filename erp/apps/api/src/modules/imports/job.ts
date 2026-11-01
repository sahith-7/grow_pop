import { tenantTx } from '../../db.js';
import { register } from '../../jobs/runner.js';
import { markFailed, runImport } from './service.js';

register('import', async (job) => {
  try {
    await tenantTx(job.tenantId, (tx) => runImport(tx, job.resourceId));
  } catch (e) {
    // The whole import rolled back. Tell the user; keep the details in the job log.
    await tenantTx(job.tenantId, (tx) => markFailed(tx, job.resourceId, 'The import stopped because of an unexpected error. Nothing was imported. Try again, and contact support if it repeats.'));
    throw e;
  }
});
