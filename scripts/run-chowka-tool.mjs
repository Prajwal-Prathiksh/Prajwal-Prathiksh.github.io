import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';

const output = `/tmp/chowka-selfplay-${process.pid}.mjs`;
await build({
  entryPoints: ['scripts/chowka-selfplay.ts'],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'inline',
});
try {
  await import(pathToFileURL(output).href);
} finally {
  await rm(output, { force: true });
}
