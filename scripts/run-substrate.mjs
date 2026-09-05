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
await import('../tests/substrate/punch-launch-diagnostic.ts');
