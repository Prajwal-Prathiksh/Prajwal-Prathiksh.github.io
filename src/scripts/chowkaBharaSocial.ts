import { HOME, LAST_OUTER, WAITING, apply, finished, legalMoves, type State } from './chowkaBhara';

export interface Pact {
  a: number;
  b: number;
  target: number;
  until: number;
}

export interface SocialState {
  turn: number;
  trust: number[][]; // trust[observer][other]
  grudge: number[][]; // recent hits remembered by the victim
  cooldown: number[][]; // earliest turn an observer will trust the other again
  pacts: Pact[];
}

const ODDS: [number, number][] = [[1, 4 / 16], [2, 6 / 16], [3, 4 / 16], [4, 1 / 16], [8, 1 / 16]];
const clamp = (n: number) => Math.max(0, Math.min(1, n));

export function newSocial(players: number): SocialState {
  return {
    turn: 0,
    trust: Array.from({ length: players }, () => Array(players).fill(0.6)),
    grudge: Array.from({ length: players }, () => Array(players).fill(0)),
    cooldown: Array.from({ length: players }, () => Array(players).fill(0)),
    pacts: [],
  };
}

export const pactFor = (social: SocialState, player: number) =>
  social.pacts.find((p) => p.a === player || p.b === player);
export const allyOf = (pact: Pact, player: number) => pact.a === player ? pact.b : pact.a;

// Count pawns home and near the centre, but discount progress at the outer gate
// until that player has earned access to the inner ring with a hit.
export function threat(s: State, player: number): number {
  const p = s.players[player];
  let score = p.hasHit ? 5 : 0;
  for (const pos of p.pawns) {
    if (pos === HOME) score += 28;
    else if (pos === WAITING) score += 0;
    else if (pos > LAST_OUTER) score += 10 + (pos - LAST_OUTER) * 2.2;
    else score += (p.hasHit ? 0.45 : 0.25) * pos;
  }
  return score;
}

export function leadingTarget(s: State, a: number, b: number, active: number[]): number | null {
  const others = active.filter((i) => i !== a && i !== b);
  if (!others.length) return null;
  const target = others.reduce((best, i) => threat(s, i) > threat(s, best) ? i : best);
  return threat(s, target) >= 35 && threat(s, target) >= Math.max(threat(s, a), threat(s, b)) + 6
    ? target : null;
}

export function canOffer(social: SocialState, s: State, a: number, b: number, active: number[]): number | null {
  if (a === b || !active.includes(a) || !active.includes(b) || pactFor(social, a) || pactFor(social, b)) return null;
  const target = leadingTarget(s, a, b, active);
  if (target === null || social.cooldown[b][a] > social.turn || social.cooldown[a][b] > social.turn) return null;
  return target;
}

export function acceptsOffer(social: SocialState, s: State, a: number, b: number, target: number, style: string): boolean {
  const lead = threat(s, target) - Math.max(threat(s, a), threat(s, b));
  const needed = style === 'racer' ? 15 : style === 'cautious' ? 7 : 10;
  return social.trust[b][a] >= 0.36 && social.cooldown[b][a] <= social.turn && lead >= needed;
}

export function makePact(social: SocialState, a: number, b: number, target: number): void {
  social.pacts.push({ a, b, target, until: social.turn + social.trust.length * 3 });
}

export function declineOffer(social: SocialState, recipient: number, proposer: number): void {
  social.cooldown[recipient][proposer] = social.turn + social.trust.length;
}

export function endPact(social: SocialState, pact: Pact, by?: number): void {
  social.pacts = social.pacts.filter((p) => p !== pact);
  if (by !== undefined) {
    const other = allyOf(pact, by);
    social.trust[other][by] = clamp(social.trust[other][by] - 0.2);
    social.cooldown[other][by] = social.turn + social.trust.length;
  } else {
    social.trust[pact.a][pact.b] = clamp(social.trust[pact.a][pact.b] + 0.08);
    social.trust[pact.b][pact.a] = clamp(social.trust[pact.b][pact.a] + 0.08);
  }
}

export function recordHit(social: SocialState, actor: number, victim: number, relay: boolean): 'betrayal' | 'relay' | 'hit' {
  const pact = pactFor(social, actor);
  if (pact && allyOf(pact, actor) === victim) {
    if (relay) {
      social.trust[victim][actor] = clamp(social.trust[victim][actor] + 0.02);
      return 'relay';
    }
    social.pacts = social.pacts.filter((p) => p !== pact);
    social.trust[victim][actor] = clamp(social.trust[victim][actor] - 0.5);
    social.cooldown[victim][actor] = social.turn + social.trust.length * 3;
    social.grudge[victim][actor] = Math.min(3, social.grudge[victim][actor] + 2);
    return 'betrayal';
  }
  social.grudge[victim][actor] = Math.min(3, social.grudge[victim][actor] + 1);
  return 'hit';
}

export function advanceSocial(social: SocialState, s: State, active: number[]): Pact[] {
  social.turn++;
  social.grudge.forEach((row) => row.forEach((n, i) => { row[i] = Math.max(0, n - 0.08); }));
  const ended: Pact[] = [];
  for (const pact of [...social.pacts]) {
    const targetFell = !active.includes(pact.target) || finished(s, pact.target);
    const targetNoLongerLeads = threat(s, pact.target) + 5 < Math.max(threat(s, pact.a), threat(s, pact.b));
    if (social.turn >= pact.until || targetFell || targetNoLongerLeads || !active.includes(pact.a) || !active.includes(pact.b)) {
      endPact(social, pact);
      ended.push(pact);
    }
  }
  return ended;
}

// Value of the bonus throw after hitting a pact ally. It counts only legal
// immediate captures of the agreed target, weighted by actual cowrie odds.
export function relayValue(s: State, actor: number, target: number): number {
  if (finished(s, target)) return 0;
  const before = threat(s, target);
  let expected = 0;
  for (const [value, chance] of ODDS) {
    let best = 0;
    for (const move of legalMoves(s, actor, value)) {
      const result = apply(s, move);
      if (result.hits.some((h) => h.player === target)) {
        best = Math.max(best, before - threat(result.state, target));
      }
    }
    expected += chance * best;
  }
  const urgency = 1 + Math.max(0, before - 55) / 35;
  return expected * urgency;
}

export function relayAllowed(s: State, social: SocialState, actor: number, victim: number): boolean {
  const pact = pactFor(social, actor);
  return !!pact && allyOf(pact, actor) === victim && threat(s, pact.target) >= 55
    && relayValue(s, actor, pact.target) >= 12;
}
