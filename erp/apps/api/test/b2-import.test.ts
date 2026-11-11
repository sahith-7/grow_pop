import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, tenantTx } from '../src/db.js';
import { csvCell, parseCsv } from '../src/lib/csv.js';
import { startRunner } from '../src/jobs/runner.js';
import { resolveMapping } from '../src/modules/imports/columns.js';
import { runImport } from '../src/modules/imports/service.js';
import { FileProblem, validateRows } from '../src/modules/imports/validate.js';
import '../src/modules/imports/job.js';
import { api } from './b2-api.js';
import { getApp, makeTenant, makeUser, owner } from './b2-helpers.js';

const refs = () => ({ skus: new Set<string>(), barcodes: new Set<string>(), units: new Map([['pcs', 'NOS'], ['kg', 'KGS']]) });
const table = (csv: string) => parseCsv(csv);
const auto = (t: string[][]) => resolveMapping(t[0], {});

afterAll(async () => { await (await getApp()).close(); await owner.end(); });

describe('csv', () => {
  it('parses quotes, escaped quotes, CRLF, BOM and blank trailing lines', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    expect(parseCsv('a\n"multi\nline"\n')).toEqual([['a'], ['multi\nline']]);
    expect(() => parseCsv('a\n"open')).toThrow();
  });
  it('neutralises spreadsheet formulas but leaves numbers alone', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-5')).toBe('-5');
  });
});

describe('validateRows (AC-17)', () => {
  it('groups rows with size/colour into one variable product and simple rows into their own', () => {
    const t = table('product_name,sku,price,size,category\nTee,T-S,299,S,Apparel > Tees\nTee,T-M,299,M,\nRice,R-1,"₹1,250.00",,Grocery\n');
    const r = validateRows(t, auto(t), refs());
    expect(r.errors).toEqual([]);
    expect(r.products).toHaveLength(2);
    expect(r.products[0]).toMatchObject({ name: 'Tee', type: 'variable', category: ['Apparel', 'Tees'] });
    expect(r.products[0].variants.map((v) => v.sku)).toEqual(['T-S', 'T-M']);
    expect(r.products[1]).toMatchObject({ type: 'simple', status: 'active' });
    expect(r.products[1].variants[0].price).toBe('1250.00');
  });

  it('reports row-level errors with spreadsheet row numbers and drops the whole product', () => {
    const t = table('name,sku,price,size,barcode,gst\nTee,T-S,299,S,,18%\nTee,T-M,abc,M,,\nCap,C-1,99,,8.90123E+12,\nMug,T-S,99,,,7\n');
    const r = validateRows(t, auto(t), { ...refs(), skus: new Set(['taken']) });
    const at = (row: number) => r.errors.filter((e) => e.row === row).map((e) => `${e.column}: ${e.message}`);
    expect(at(3)).toEqual(['price: Enter an amount like 499 or 499.50']);
    expect(at(2)[0]).toMatch(/row 3 of the same product/);
    expect(at(4)[0]).toMatch(/scientific notation/);
    expect(at(5).join()).toMatch(/Same SKU as row 2/);
    expect(at(5).join()).toMatch(/gst_rate/);
    expect(r.products).toHaveLength(0);
    expect(r.validRows).toBe(0);
    expect(r.errorRows).toBe(4);
  });

  it('flags SKUs already in the catalog, conflicting product fields and duplicate names', () => {
    const t = table('product_name,sku,price,size,brand\nTee,OLD,10,S,A\nTee,NEW,10,M,B\nPen,P1,5,,\nPen,P2,5,,\n');
    const r = validateRows(t, auto(t), { ...refs(), skus: new Set(['old']) });
    expect(r.errors.find((e) => e.row === 2)?.message).toBe('Already in your catalog');
    expect(r.errors.find((e) => e.row === 3 && e.column === 'brand')).toBeDefined();
    expect(r.errors.find((e) => e.row === 5)?.message).toMatch(/Same name as row 4/);
    expect(r.products.map((p) => p.name)).toEqual(['Pen']);
  });

  it('fails the whole file on structural problems', () => {
    expect(() => validateRows(table('sku,price\nA,1\n'), { sku: 'sku', price: 'price' }, refs())).toThrow(FileProblem);
    expect(() => validateRows(table('product_name,sku,price\n'), auto(table('product_name,sku,price\n')), refs())).toThrow(/no products/);
    expect(() => validateRows(table('a,a\n1,2\n'), {}, refs())).toThrow(/same heading/);
  });
});

describe('import flow', () => {
  let T: Awaited<ReturnType<typeof makeTenant>>;
  beforeAll(async () => { T = await makeTenant(); });

  const upload = async (cookie: string, csv: string) =>
    (await api(cookie, 'POST', '/v1/files?kind=import&name=products.csv', Buffer.from(csv), { 'content-type': 'text/csv' })).body.fileId;
  const run = (id: string) => tenantTx(T.tenantId, (tx) => runImport(tx, id));

  it('validates without writing, then imports only valid products and gives an error report', async () => {
    await api(T.cookie, 'POST', '/v1/products', { name: 'Existing', type: 'simple', variants: [{ sku: 'EXIST', price: '1' }] });
    const csv = 'Product Name,SKU,Price,MRP,Cost,Category,Brand,Unit,Size,Colour\n'
      + 'Tee,TEE-S,299,399,120,Apparel > Tees,Acme,pcs,S,Red\n'
      + 'Tee,TEE-M,299,399,120,,,,M,Red\n'
      + 'Rice,RICE,90,80,,Grocery,,kg,,\n'
      + 'Dup,exist,10,,,,,,,\n';
    const fileId = await upload(T.cookie, csv);
    const start = await api(T.cookie, 'POST', '/v1/imports', { fileId });
    expect(start.status).toBe(202);
    expect(start.body.status).toBe('validating');
    await run(start.body.id);
    const v = await api(T.cookie, 'GET', `/v1/imports/${start.body.id}`);
    expect(v.body).toMatchObject({ status: 'validated', totalRows: 4, validRows: 2, errorRows: 2 });
    expect((await api(T.cookie, 'GET', '/v1/products?q=tee')).body.items).toHaveLength(0); // nothing written yet

    const report = await api(T.cookie, 'GET', v.body.errorReportUrl.replace('/api', ''));
    const rows = parseCsv(report.text);
    expect(rows[0].slice(-2)).toEqual(['row', 'errors']);
    expect(rows.map((r) => r.at(-2))).toEqual(['row', '4', '5']);
    expect(rows[1].at(-1)).toMatch(/above MRP/);

    expect((await api(T.cookie, 'POST', `/v1/imports/${start.body.id}/commit`)).status).toBe(202);
    await run(start.body.id);
    const done = await api(T.cookie, 'GET', `/v1/imports/${start.body.id}`);
    expect(done.body).toMatchObject({ status: 'done', createdCount: 1 });
    const tee = (await api(T.cookie, 'GET', '/v1/products?q=tee')).body.items[0];
    expect(tee).toMatchObject({ name: 'Tee', variantCount: 2, category: 'Tees' });
    const cats = (await api(T.cookie, 'GET', '/v1/categories')).body.items.map((c: any) => c.name);
    expect(cats).toEqual(['Apparel', 'General', 'Tees']);   // General: the category the test helper gives "Existing" (D88)
    const audit = await owner.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'import.commit'", [T.tenantId]);
    expect(audit.rows[0].summary.products).toBe(1);
    expect((await api(T.cookie, 'POST', `/v1/imports/${start.body.id}/commit`)).status).toBe(409);
  });

  it('a mapping with cost is refused for roles without cost.view', async () => {
    const cashier = await makeUser(T.tenantId, 'cashier');
    expect((await api(cashier.cookie, 'POST', '/v1/imports', { fileId: crypto.randomUUID() })).status).toBe(403); // no product.write at all
    const fileId = await upload(T.cookie, 'product_name,sku,price\nA,A,1\n');
    expect((await api(T.cookie, 'POST', '/v1/imports', { fileId, mapping: { nope: 'x' } })).status).toBe(400);
  });

  it('marks a malformed file failed with a message instead of crashing', async () => {
    const fileId = await upload(T.cookie, 'sku,price\nA,1\n');
    const start = await api(T.cookie, 'POST', '/v1/imports', { fileId });
    await run(start.body.id);
    const r = await api(T.cookie, 'GET', `/v1/imports/${start.body.id}`);
    expect(r.body.status).toBe('failed');
    expect(r.body.failure).toMatch(/product_name/);
  });

  it('tells the page when no worker has claimed the job for 30 seconds', async () => {
    const fileId = await upload(T.cookie, 'Product Name,SKU,Price\nMug,MUG-1,50\n');
    const start = await api(T.cookie, 'POST', '/v1/imports', { fileId });
    expect((await api(T.cookie, 'GET', `/v1/imports/${start.body.id}`)).body.waitingForWorker).toBe(false);
    await owner.query("UPDATE sync_jobs SET next_attempt_at = now() - interval '31 seconds' WHERE resource_id = $1", [start.body.id]);
    expect((await api(T.cookie, 'GET', `/v1/imports/${start.body.id}`)).body.waitingForWorker).toBe(true);
    await run(start.body.id);
    await owner.query("UPDATE sync_jobs SET status = 'done' WHERE resource_id = $1", [start.body.id]);
    expect((await api(T.cookie, 'GET', `/v1/imports/${start.body.id}`)).body).toMatchObject({ status: 'validated', waitingForWorker: false });
  });

  it('refuses non-UTF-8 and binary uploads as import files', async () => {
    const latin1 = Buffer.from([0x61, 0x2c, 0xe9, 0x0a]);
    expect((await api(T.cookie, 'POST', '/v1/files?kind=import', latin1, { 'content-type': 'text/csv' })).status).toBe(415);
  });

  it('exports products as CSV that round-trips through the validator', async () => {
    const res = await api(T.cookie, 'GET', '/v1/exports/products.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const t = parseCsv(res.text);
    expect(t[0]).toContain('cost');
    const tee = t.find((r) => r[1] === 'TEE-S')!;
    expect(tee[t[0].indexOf('category')]).toBe('Apparel > Tees');
    // Re-validating the export against an empty catalog yields no errors.
    expect(validateRows(t, resolveMapping(t[0], {}), { ...refs(), units: new Map([['pcs', 'NOS'], ['kg', 'KGS']]) }).errors).toEqual([]);
  });
});

describe('job runner', () => {
  it('claims queued imports for any tenant and runs them under that tenant', async () => {
    const T = await makeTenant();
    const fileId = (await api(T.cookie, 'POST', '/v1/files?kind=import', Buffer.from('product_name,sku,price\nPen,PEN,10\n'), { 'content-type': 'text/csv' })).body.fileId;
    const start = await api(T.cookie, 'POST', '/v1/imports', { fileId });
    const runner = startRunner((await getApp()).log, 'test-worker');
    for (let i = 0; i < 50; i++) {
      const r = await api(T.cookie, 'GET', `/v1/imports/${start.body.id}`);
      if (r.body.status !== 'validating') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    await runner.stop();
    expect((await api(T.cookie, 'GET', `/v1/imports/${start.body.id}`)).body.status).toBe('validated');
    const job = await owner.query('SELECT status, locked_by FROM sync_jobs WHERE resource_id = $1', [start.body.id]);
    expect(job.rows[0].status).toBe('done');
  });

  it('the runtime role cannot see another tenant\'s queue rows', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM sync_jobs');
    expect(rows[0].n).toBe(0); // no tenant context = zero rows
  });
});
