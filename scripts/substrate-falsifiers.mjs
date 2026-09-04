#!/usr/bin/env node
/**
 * Runs the physical-substrate falsifiers (src/game/probe.ts) against the real
 * simulation modules, loaded through Vite's SSR loader so the production import
 * graph and resolution are exactly what the browser build uses.
 *
 * Exit code 0 when every supported check passes, 1 otherwise. Checks the
 * environment cannot support report `pass: null` and do not fail the run, but
 * they are never counted as passes.
 */
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  logLevel: "error",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
  appType: "custom",
});

let results;
try {
  const mod = await server.ssrLoadModule("/src/game/probe.ts");
  const t0 = performance.now();
  results = mod.runFalsifiers();
  const ms = performance.now() - t0;
  process.stdout.write(`substrate falsifiers (${ms.toFixed(0)} ms)\n\n`);
} finally {
  await server.close();
}

let failed = 0;
let skipped = 0;
for (const r of results) {
  const tag = r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "SKIP";
  if (r.pass === false) failed++;
  if (r.pass === null) skipped++;
  process.stdout.write(`  ${tag}  ${r.name}\n        ${r.detail}\n`);
}
process.stdout.write(
  `\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} unsupported\n`,
);
process.exit(failed > 0 ? 1 : 0);
