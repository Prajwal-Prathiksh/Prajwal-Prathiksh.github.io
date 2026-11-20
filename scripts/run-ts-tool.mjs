// Bundles a TypeScript tool in scripts/ with esbuild and runs it, passing
// the remaining arguments through: node scripts/run-ts-tool.mjs <file> [...args]
import { build } from 'esbuild';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';

const entry = process.argv[2];
process.argv.splice(2, 1);
const output = `/tmp/${basename(entry, '.ts')}-${process.pid}.mjs`;
await build({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'node', target: 'node22', sourcemap: 'inline' });
try {
  await import(pathToFileURL(output).href);
} finally {
  await rm(output, { force: true });
}
