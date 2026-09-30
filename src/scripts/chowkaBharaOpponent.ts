import {
  HOME,
  apply,
  isPotentialPair,
  isSafe,
  legalMoves,
  square,
  type Action,
  type Move,
  type State,
  type Turn,
} from './chowkaBhara';
import {
  BEHAVIOUR_STYLES,
  styleBelief,
  threat,
  type BehaviourStyle,
  type SocialState,
} from './chowkaBharaSocial';

// These preferences describe visible choice tendencies. They deliberately use
// only cheap move-local facts so profiles can be updated after every move in a
// browser without adding noticeable work.
const TENDENCY: Record<BehaviourStyle, readonly number[]> = {
  balanced:   [1.0, 1.2, 0.7, 0.7, 1.0, -0.7],
  aggressive: [0.8, 2.7, 0.1, 0.2, 0.8, -0.2],
  cautious:   [0.7, 0.8, 2.1, 0.6, 0.9, -2.1],
  builder:    [0.7, 1.0, 0.5, 2.8, 0.8, -0.7],
  racer:      [1.9, 0.6, 0.1, 0.1, 2.2, -0.4],
};

function exposed(state: State, player: number): number {
  let count = 0;
  for (let opponent = 0; opponent < state.players.length; opponent++) {
    if (opponent === player) continue;
    for (const value of [1, 2, 3, 4, 8]) {
      if (legalMoves(state, opponent, value).some((move) =>
        apply(state, move).hits.some((hit) => hit.player === player))) count++;
    }
  }
  return count;
}

function moveFeatures(state: State, move: Move): number[] {
  const before = state.players[move.player];
  const result = apply(state, move);
  const after = result.state.players[move.player];
  const pawn = move.pawns[0];
  const progress = move.to === HOME ? 4 : Math.min(4, move.steps) / 2;
  const captures = new Set(result.hits.map((hit) => hit.player)).size;
  const safe = move.to !== HOME && isSafe(square(before.seat, move.to)) ? 1 : 0;
  const madePair = !isPotentialPair(state, move.player, pawn)
    && isPotentialPair(result.state, move.player, pawn) ? 1 : 0;
  const finish = after.pawns.filter((pos) => pos === HOME).length
    - before.pawns.filter((pos) => pos === HOME).length;
  return [progress, captures, safe, madePair, finish, exposed(result.state, move.player)];
}

function utility(style: BehaviourStyle, features: number[]): number {
  return features.reduce((sum, value, index) => sum + value * TENDENCY[style][index], 0);
}

/** Update every other player's estimate of the actor after a meaningful choice. */
export function observeAction(
  social: SocialState,
  state: State,
  actor: number,
  turn: Turn,
  action: Action,
): void {
  if (action.kind !== 'move') return;
  const alternatives = [...new Set(turn.bank)].flatMap((value) => legalMoves(state, actor, value));
  if (alternatives.length < 2) return;
  const alternativeFeatures = alternatives.map((move) => moveFeatures(state, move));
  const chosenFeatures = moveFeatures(state, action.move);

  const likelihoods = BEHAVIOUR_STYLES.map((style) => {
    const scores = alternativeFeatures.map((features) => utility(style, features));
    const peak = Math.max(...scores);
    const temperature = 2.5;
    const total = scores.reduce((sum, score) => sum + Math.exp((score - peak) / temperature), 0);
    const chosen = utility(style, chosenFeatures);
    return Math.max(0.015, Math.exp((chosen - peak) / temperature) / total);
  });

  for (let observer = 0; observer < state.players.length; observer++) {
    if (observer === actor) continue;
    const prior = styleBelief(social, observer, actor);
    // A tempered Bayesian update prevents one unusual move from defining a
    // player, while repeated choices still produce a clear profile.
    const posterior = prior.map((probability, i) => probability * Math.pow(likelihoods[i], 0.55));
    const total = posterior.reduce((sum, probability) => sum + probability, 0);
    social.behaviour[observer][actor] = posterior.map((probability) => probability / total);
  }
}

export function inferredStyleWeights(social: SocialState, observer: number, player: number) {
  return BEHAVIOUR_STYLES.map((style, index) => ({
    style,
    probability: styleBelief(social, observer, player)[index],
  }));
}

export function predictedAcceptance(
  social: SocialState,
  state: State,
  proposer: number,
  recipient: number,
  target: number,
): number {
  if (social.trust[recipient][proposer] < 0.36 || social.cooldown[recipient][proposer] > social.turn) return 0;
  const lead = threat(state, target) - Math.max(threat(state, proposer), threat(state, recipient));
  return inferredStyleWeights(social, proposer, recipient).reduce((chance, belief) => {
    const needed = belief.style === 'racer' ? 15 : belief.style === 'cautious' ? 7 : 10;
    return chance + (lead >= needed ? belief.probability : 0);
  }, 0);
}
