import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';

const winTraining = process.argv[2] === 'win-train';
const output = `/tmp/${winTraining ? 'chowka-win-train' : 'chowka-selfplay'}-${process.pid}.mjs`;
await build({
  entryPoints: [winTraining ? 'scripts/chowka-win-train.ts' : 'scripts/chowka-selfplay.ts'],
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
