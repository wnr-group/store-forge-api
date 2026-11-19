// Usage (staging only): BENCH_CONFIRM_NON_SHARED=yes BENCH_API=https://<staging>/api/v1 BENCH_TOKEN=<jwt> BENCH_ORG=<org id> npx tsx scripts/bench-import.ts
// Never run against the shared hosted project. The token is read from the environment and never printed.
import { writeFileSync, mkdirSync } from 'node:fs';

if (process.env.BENCH_CONFIRM_NON_SHARED !== 'yes') throw new Error('Set BENCH_CONFIRM_NON_SHARED=yes to confirm this is a non-shared environment.');
const { BENCH_API, BENCH_TOKEN, BENCH_ORG } = process.env;
if (!BENCH_API || !BENCH_TOKEN || !BENCH_ORG) throw new Error('BENCH_API, BENCH_TOKEN and BENCH_ORG are required.');

const run = `bench-${Date.now()}`;
const rows = Array.from({ length: 500 }, (_, i) => ({ row: i + 2, name: `${run} product ${i + 1}`, price: '19.99', sku: `${run}-${i + 1}`, quantity: '5', status: 'draft' }));
const started = performance.now();
const res = await fetch(`${BENCH_API}/products/import`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${BENCH_TOKEN}`, 'x-organization-id': BENCH_ORG }, body: JSON.stringify({ rows }), signal: AbortSignal.timeout(120_000) });
const ms = Math.round(performance.now() - started);
const body = await res.text();
const out = `run=${run}\nstatus=${res.status}\nduration_ms=${ms}\ntarget_ms=30000\nresult=${ms < 30_000 && res.ok ? 'WITHIN TARGET' : 'NOT WITHIN TARGET'}\nresponse=${body.slice(0, 300)}\n`;
mkdirSync('artifacts/qa/store-forge-ticket/benchmark', { recursive: true });
writeFileSync('artifacts/qa/store-forge-ticket/benchmark/import-500-rows.txt', out);
console.log(out);
