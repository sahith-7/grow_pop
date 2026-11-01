# Rolling back a release

## Automatic

`ops/deploy.sh` checks `/api/health/ready` through web after starting a release. If that fails for two minutes, it starts
the previous release again and the deploy job goes red. You get the GitHub failure email; the job log shows the last
80 lines of migrate, api and web.

## By hand

The deploy health check only proves the app starts. If a release is up but wrong (a screen broken, a wrong total):

1. GitHub → Actions → deploy → the run for the **previous good tag** → Re-run all jobs. Its images are still in ECR
   (the last 15 are kept), so the job skips the build and only re-deploys them. ("Run workflow" would deploy the
   current branch instead, which is not what you want.)
2. Or, faster, on the server (Session Manager), for a release from the last 30 days (the deploy bucket keeps 30):
   ```sh
   sudo -i && cd /opt/erp
   cat current-tag                                   # the bad one
   aws s3 cp s3://<deploy-bucket>/<good-tag>/deploy.sh . && aws s3 cp s3://<deploy-bucket>/<good-tag>/docker-compose.prod.yml .
   sh deploy.sh production <good-tag> <registry>
   ```
3. Tell affected stores what happened and whether anything they did during the bad release needs checking.

## Migrations are never rolled back

There are no down-migrations. A rollback runs the **old code against the new schema**, so every migration must keep
the previous release working:

- add columns as nullable or with a default; add tables freely
- never rename or drop a column or table in the same release that stops using it: stop using it in release N, drop it
  in release N+1 at the earliest
- never change what an existing column means
- every new table: RLS, the explicit REVOKEs (B2 lesson), and `SELECT erp_backup_grants();` (D79)

If a migration itself destroyed or corrupted data, rolling back code won't help: go to backup-restore.md "Restoring
production for real".

## Before tagging a release

- CI green on `main`, staging deployed from that commit, e2e workflow green on staging
- Read the migration diff once more against the list above
- Tag at a quiet hour (stores are least busy before 9 am and after 10 pm IST)
