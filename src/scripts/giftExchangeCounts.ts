import type { Exclusion } from './giftExchange';

// Counting matchings takes exponential time in a connected group of exclusions.
// Keep the page responsive when someone enters a dense, large group.
const MAX_COMPONENT_SIZE = 18;

export function countDerangements(count: number): bigint {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('Count must be a nonnegative integer.');
  if (count === 0) return 1n;
  let twoBack = 1n;
  let oneBack = 0n;
  for (let n = 2; n <= count; n++) {
    const current = BigInt(n - 1) * (oneBack + twoBack);
    twoBack = oneBack;
    oneBack = current;
  }
  return oneBack;
}

function forbiddenComponentRooks(members: number[], exclusions: readonly Exclusion[]): bigint[] {
  const size = members.length;
  const local = new Map(members.map((member, index) => [member, index]));
  const forbidden = members.map((_, index) => new Set([index]));
  for (const [a, b] of exclusions) {
    const left = local.get(a);
    const right = local.get(b);
    if (left === undefined || right === undefined) continue;
    forbidden[left].add(right);
    forbidden[right].add(left);
  }

  const states = 1 << size;
  let ways = Array<bigint>(states).fill(0n);
  ways[0] = 1n;
  for (const choices of forbidden) {
    const next = [...ways]; // Skip this giver's forbidden cells.
    for (let used = 0; used < states; used++) {
      const count = ways[used];
      if (count === 0n) continue;
      for (const recipient of choices) {
        const bit = 1 << recipient;
        if ((used & bit) === 0) next[used | bit] += count;
      }
    }
    ways = next;
  }

  const rooks = Array<bigint>(size + 1).fill(0n);
  for (let used = 0; used < states; used++) {
    if (ways[used] === 0n) continue;
    let bits = used;
    let placed = 0;
    while (bits) {
      bits &= bits - 1;
      placed++;
    }
    rooks[placed] += ways[used];
  }
  return rooks;
}

// Inclusion-exclusion over forbidden giver/recipient cells. A null result means
// the exact count would take too long; it says nothing about whether a draw exists.
export function countGiftExchangeDraws(count: number, exclusions: readonly Exclusion[]): bigint | null {
  if (!Number.isInteger(count) || count < 0) return null;
  if (exclusions.length === 0) return countDerangements(count);

  const parent = Array.from({ length: count }, (_, index) => index);
  function root(index: number): number {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }
  for (const [a, b] of exclusions) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= count || b >= count) return null;
    parent[root(a)] = root(b);
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const key = root(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  }

  let rooks = [1n];
  for (const members of groups.values()) {
    if (members.length > MAX_COMPONENT_SIZE) return null;
    const component = forbiddenComponentRooks(members, exclusions);
    const combined = Array<bigint>(rooks.length + component.length - 1).fill(0n);
    for (let left = 0; left < rooks.length; left++) {
      for (let right = 0; right < component.length; right++) {
        combined[left + right] += rooks[left] * component[right];
      }
    }
    rooks = combined;
  }

  const factorials = [1n];
  for (let i = 1; i <= count; i++) factorials.push(factorials[i - 1] * BigInt(i));
  return rooks.reduce((total, ways, placed) =>
    total + (placed % 2 === 0 ? ways : -ways) * factorials[count - placed], 0n);
}
