#!/usr/bin/env node
// NOT in the default run (drive.sh): a helper for 72-tracing-ops.sh, by hand.
// T10 helper: N traced owner turns back to back (bash + mcp_call each), so Jaeger's footprint is measured after some load.
import { tracedTurn } from "./tracing-lib.mjs";
const n = Number(process.argv[2] ?? 40);
let ok = 0;
const started = Date.now();
for (let i = 0; i < n; i += 1) if ((await tracedTurn(`T10 부하 ${i}`)).ok) ok += 1;
console.log(`${ok}/${n} turns completed in ${Date.now() - started} ms`);
