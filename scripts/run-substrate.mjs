import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) &&
        !/\.[a-z]+$/i.test(specifier)) specifier += '.ts';
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context);
    const source = ts.transpileModule(
      readFileSync(new URL(url), 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
    return { format: 'module', source, shortCircuit: true };
  },
});

await import('../tests/substrate/probe.ts');
await import('../tests/substrate/action-continuity-probe.ts');
await import('../tests/substrate/action-vertical-probe.ts');
await import('../tests/substrate/agent-independence-probe.ts');
await import('../tests/substrate/beast-spatial-carrier-probe.ts');
await import('../tests/substrate/current-stance-action-probe.ts');
await import('../tests/substrate/damage-mediation-probe.ts');
await import('../tests/substrate/encounter-causality-probe.ts');
await import('../tests/substrate/planted-support-probe.ts');
await import('../tests/substrate/spatial-carrier-probe.ts');
await import('../tests/substrate/committed-catch-step-probe.ts');
await import('../tests/substrate/kinetic-fight-flow-probe.ts');
await import('../tests/substrate/local-social-evidence-probe.ts');
await import('../tests/substrate/reactive-balance-probe.ts');
await import('../tests/substrate/social-incident-probe.ts');
await import('../tests/substrate/boxing-combinations-probe.ts');
await import('../tests/substrate/boxing-integration-probe.ts');
console.log('SUBSTRATE PASS');
