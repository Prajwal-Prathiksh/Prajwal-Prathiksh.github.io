export type Exclusion = readonly [number, number];

function randomIndex(upperBound: number): number {
  const limit = 0x100000000 - (0x100000000 % upperBound);
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return values[0] % upperBound;
}

function shuffled(values: number[]): number[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// A randomized augmenting-path matching finds a complete draw when one exists.
// Every participant gives once and receives once; exclusions apply both ways.
export function drawGiftExchange(count: number, exclusions: readonly Exclusion[]): number[] | null {
  if (!Number.isInteger(count) || count < 2) return null;

  const blocked = Array.from({ length: count }, () => new Set<number>());
  for (const [a, b] of exclusions) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= count || b >= count) {
      return null;
    }
    blocked[a].add(b);
    blocked[b].add(a);
  }

  const recipients = Array.from({ length: count }, (_, i) => i);
  const options = recipients.map((giver) =>
    shuffled(recipients.filter((recipient) => recipient !== giver && !blocked[giver].has(recipient))),
  );
  const recipientToGiver = Array<number>(count).fill(-1);

  function assign(giver: number, seen: Set<number>): boolean {
    for (const recipient of options[giver]) {
      if (seen.has(recipient)) continue;
      seen.add(recipient);
      const previous = recipientToGiver[recipient];
      if (previous === -1 || assign(previous, seen)) {
        recipientToGiver[recipient] = giver;
        return true;
      }
    }
    return false;
  }

  for (const giver of shuffled(recipients)) {
    if (!assign(giver, new Set())) return null;
  }

  const giverToRecipient = Array<number>(count).fill(-1);
  recipientToGiver.forEach((giver, recipient) => {
    giverToRecipient[giver] = recipient;
  });
  return giverToRecipient;
}
