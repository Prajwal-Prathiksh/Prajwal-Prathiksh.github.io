import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/scripts/giftExchangeCounts.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { countDerangements, countGiftExchangeDraws } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`
);

function bruteForce(count, exclusions) {
  const used = new Set();
  function visit(giver) {
    if (giver === count) return 1n;
    let total = 0n;
    for (let recipient = 0; recipient < count; recipient++) {
      if (recipient === giver || used.has(recipient)) continue;
      if (exclusions.some(([a, b]) => (a === giver && b === recipient) || (b === giver && a === recipient))) continue;
      used.add(recipient);
      total += visit(giver + 1);
      used.delete(recipient);
    }
    return total;
  }
  return visit(0);
}

test('ordinary draws follow the derangement sequence', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(countDerangements),
    [1n, 0n, 1n, 2n, 9n, 44n, 265n, 1854n]);
  assert.equal(countGiftExchangeDraws(100, []), countDerangements(100));
});

test('restricted counts agree with enumerated draws', () => {
  for (let count = 2; count <= 5; count++) {
    const pairs = [];
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) pairs.push([a, b]);
    }
    for (let mask = 0; mask < 1 << pairs.length; mask++) {
      const exclusions = pairs.filter((_, index) => (mask & (1 << index)) !== 0);
      assert.equal(countGiftExchangeDraws(count, exclusions), bruteForce(count, exclusions),
        `count=${count}, mask=${mask}`);
    }
  }
});

test('large sparse groups count exactly and dense ones stop at the limit', () => {
  const exclusions = [[0, 1], [2, 3], [4, 5]];
  const count = countGiftExchangeDraws(50, exclusions);
  assert.equal(typeof count, 'bigint');
  assert.ok(count > 0n && count < countDerangements(50));
  assert.equal(countGiftExchangeDraws(20, Array.from({ length: 18 }, (_, i) => [i, i + 1])), null);
});
