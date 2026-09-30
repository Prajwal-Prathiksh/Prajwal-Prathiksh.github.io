import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { chooseAction } from '../src/scripts/chowkaBharaAI';
import { chooseOriginalHardAction } from '../src/scripts/chowkaBharaOriginalAI';
import { applyKnownAction, copyTurn, playMatch, possibleActions, seededRandom, THROW_ODDS, type MatchPolicy } from '../src/scripts/chowkaBharaMatch';
import {
  CHOWKA_MODEL,
  FEATURE_NAMES,
  decisionScore,
  randomModel,
  modelScore,
  withoutTurnState,
  validateModel,
  type EvaluationModel,
} from '../src/scripts/chowkaBharaModel';
import type { Action, EntryMode, State, Turn } from '../src/scripts/chowkaBhara';
import { newGame, newTurn, recordThrow } from '../src/scripts/chowkaBhara';
import { observeAction } from '../src/scripts/chowkaBharaOpponent';
import { newSocial, styleBelief } from '../src/scripts/chowkaBharaSocial';
import { winProbabilities } from '../src/scripts/chowkaBharaWin';

interface Trial {
  id: number;
  model: EvaluationModel;
  games: number;
  players: number;
  entry: EntryMode | 'mixed';
  seed: number;
  budget: number;
  opponent: EvaluationModel;
  positionOpponent?: boolean;
  originalOpponent?: boolean;
}

interface TrialResult {
  id: number;
  score: number;
  wins: number;
  games: number;
  turns: number;
  scoreSquares: number;
  places: number[];
}

const policy = (model: EvaluationModel | null, budget: number): MatchPolicy => (context) =>
  chooseAction(
    context.state,
    context.player,
    context.turn,
    'hard',
    'balanced',
    context.turnStart,
    context.nextPlayer,
    context.social,
    { model, nodeBudget: budget },
  ).action;

const originalHardPolicy: MatchPolicy = (context) =>
  chooseOriginalHardAction(
    context.state,
    context.player,
    context.turn,
    'hard',
    'balanced',
    context.turnStart,
    context.nextPlayer,
    context.social,
  ).action;

const positionalPolicy = (model: EvaluationModel): MatchPolicy => (context) => {
  const actions = possibleActions(context.state, context.player, context.turn);
  const moves = actions.filter((action): action is Extract<Action, { kind: 'move' }> => action.kind === 'move');
  if (!moves.length) return actions.find((action) => action.kind === 'skip')
    ?? actions.find((action) => action.kind === 'throw') ?? null;
  // Build a modest bank before committing it, while avoiding the third risky
  // bonus throw. The position model chooses the actual move.
  if (context.turn.owed > 0 && context.turn.streak < 2 && context.turn.bank.length < 2) return { kind: 'throw' };
  if (context.turn.streak >= 2 && context.turn.owed > 0) return actions.find((action) => action.kind === 'skip') ?? moves[0];
  let best = moves[0];
  let bestScore = -Infinity;
  for (const action of moves) {
    const after = applyKnownAction(context.state, context.turn, action);
    const score = modelScore(after.state, context.player, model) + after.hits.length * 5;
    if (score > bestScore) { best = action; bestScore = score; }
  }
  return best;
};

const selfPlayPolicy = (model: EvaluationModel): MatchPolicy => (context) => {
  const actions = possibleActions(context.state, context.player, context.turn);
  let best = actions[0] ?? null;
  let bestScore = -Infinity;
  for (const action of actions) {
    let score = -Infinity;
    if (action.kind === 'throw') {
      score = 0;
      for (const [value, count] of THROW_ODDS) {
        const after = copyTurn(context.turn);
        recordThrow(after, value);
        score += count / 16 * decisionScore(context.state, context.player, after, context.turnStart, model);
      }
    } else {
      const after = applyKnownAction(context.state, context.turn, action);
      score = decisionScore(after.state, context.player, after.turn, context.turnStart, model) + after.hits.length * 5;
    }
    if (score > bestScore) { best = action; bestScore = score; }
  }
  return best;
};

function runTrial(trial: Trial): TrialResult {
  let score = 0;
  let wins = 0;
  let turns = 0;
  let scoreSquares = 0;
  const places = Array(trial.players).fill(0);
  for (let game = 0; game < trial.games; game++) {
    const candidateSeat = game % trial.players;
    const entries: EntryMode[] = ['home', 'all', 'each'];
    const entry = trial.entry === 'mixed' ? entries[Math.floor(game / trial.players) % entries.length] : trial.entry;
    const policies = Array.from({ length: trial.players }, (_, seat) => {
      const candidate = seat === candidateSeat;
      if (!candidate && trial.originalOpponent) return originalHardPolicy;
      if (trial.budget > 0) return policy(candidate ? trial.model : trial.opponent, trial.budget);
      if (!candidate && trial.positionOpponent) return positionalPolicy(trial.opponent);
      return selfPlayPolicy(candidate ? trial.model : trial.opponent);
    });
    const result = playMatch({
      policies,
      styles: Array(trial.players).fill('balanced'),
      entry,
      seed: trial.seed + Math.floor(game / trial.players) * 0x9e3779b1,
      observeBehaviour: trial.budget > 0 || trial.originalOpponent,
    });
    const place = result.places.indexOf(candidateSeat);
    const placementScore = (trial.players - 1 - place) / (trial.players - 1);
    score += placementScore;
    scoreSquares += placementScore * placementScore;
    places[place]++;
    if (place === 0) wins++;
    turns += result.turns;
  }
  return { id: trial.id, score: score / trial.games, wins, games: trial.games, turns, scoreSquares, places };
}

if (!isMainThread) {
  parentPort!.postMessage(runTrial(workerData as Trial));
} else {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }));
  const command = process.argv[2]?.startsWith('--') ? 'train' : (process.argv[2] ?? 'train');
  const numberArg = (name: string, fallback: number) => Number(args.get(name) ?? fallback);
  const seed = numberArg('seed', 20260930);
  const workers = Math.max(1, Math.min(numberArg('workers', availableParallelism() - 1), availableParallelism()));
  const games = numberArg('games', command === 'tournament' ? 96 : 16);
  const budget = numberArg('budget', 0);
  const players = Math.max(2, Math.min(4, numberArg('players', 4)));
  const entry = (args.get('entry') ?? 'mixed') as EntryMode | 'mixed';

  const runParallel = async (trials: Trial[]): Promise<TrialResult[]> => {
    const results: TrialResult[] = [];
    let cursor = 0;
    const next = async (): Promise<void> => {
      const trial = trials[cursor++];
      if (!trial) return;
      const result = await new Promise<TrialResult>((done, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: trial });
        worker.once('message', done);
        worker.once('error', reject);
        worker.once('exit', (code) => { if (code) reject(new Error(`Self-play worker exited with ${code}.`)); });
      });
      results.push(result);
      await next();
    };
    await Promise.all(Array.from({ length: Math.min(workers, trials.length) }, next));
    return results.sort((a, b) => a.id - b.id);
  };

  if (command === 'benchmark') {
    const repeats = numberArg('repeats', 8);
    const state = newGame(players === 2 ? [0, 2] : players === 3 ? [0, 1, 2] : [0, 1, 2, 3], entry === 'mixed' ? 'home' : entry);
    const turn = newTurn();
    const social = newSocial(players);
    const started = performance.now();
    for (let i = 0; i < repeats; i++) {
      chooseAction(state, 0, turn, 'hard', 'balanced', state, 1, social, { nodeBudget: budget || 240 });
    }
    const elapsed = performance.now() - started;
    console.log(`${repeats} Hard decisions at budget ${budget || 240}: ${elapsed.toFixed(1)} ms total, ${(elapsed / repeats).toFixed(1)} ms each.`);
  } else if (command === 'smoke') {
    const trial = { id: 0, model: CHOWKA_MODEL, opponent: CHOWKA_MODEL, games: 4, players: 2, entry: 'home' as const, seed, budget: 0 };
    const result = runTrial(trial);
    const repeated = runTrial(trial);
    if (result.games !== 4 || result.turns <= 0) throw new Error('Headless matches did not finish.');
    if (JSON.stringify(result) !== JSON.stringify(repeated)) throw new Error('Seeded self-play was not reproducible.');
    for (const mode of ['home', 'all', 'each'] as const) {
      const varied = runTrial({ ...trial, games: 3, players: 3, entry: mode, seed: seed + mode.length });
      if (varied.games !== 3 || varied.turns <= 0) throw new Error(`${mode} entry simulation failed.`);
    }
    // With 4 + 2 held, spending 2 captures, keeps 4, and earns another throw.
    // Spending 4 merely advances. This guards the turn-state behaviour that
    // the learned evaluator is intended to preserve.
    const tacticalState: State = {
      entry: 'home',
      players: [
        { seat: 0, pawns: [0, 24, 24, 24], partner: [-1, -1, -1, -1], hasHit: false },
        { seat: 2, pawns: [10, 24, 24, 24], partner: [-1, -1, -1, -1], hasHit: true },
      ],
    };
    const tacticalTurn: Turn = { bank: [4, 2], owed: 0, streak: 0, run: [] };
    const tacticalChoice = chooseAction(
      tacticalState, 0, tacticalTurn, 'hard', 'balanced', tacticalState, 1, newSocial(2), { nodeBudget: 24 },
    ).action;
    if (tacticalChoice?.kind !== 'move' || tacticalChoice.move.value !== 2) {
      throw new Error('Turn-state evaluator did not preserve the capturing 2 before the held 4.');
    }
    const profile = newSocial(2);
    for (let i = 0; i < 8; i++) observeAction(profile, tacticalState, 0, tacticalTurn, tacticalChoice);
    if (styleBelief(profile, 1, 0)[1] <= 0.15) {
      throw new Error('Opponent profile did not learn from repeated aggressive choices.');
    }
    const outlookState: State = {
      entry: 'home',
      players: [
        { seat: 0, pawns: [1, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
        { seat: 2, pawns: [1, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
        { seat: 1, pawns: [0, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
        { seat: 3, pawns: [0, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
      ],
    };
    const beforeRoll: Turn = { bank: [], owed: 1, streak: 0, run: [] };
    const afterEight = copyTurn(beforeRoll);
    recordThrow(afterEight, 8);
    const beforeChances = winProbabilities(outlookState, 0, beforeRoll, outlookState);
    const afterChances = winProbabilities(outlookState, 0, afterEight, outlookState);
    if (Math.abs(afterChances.reduce((sum, chance) => sum + chance, 0) - 1) > 1e-9) {
      throw new Error('Win probabilities do not sum to one.');
    }
    if (afterChances[0] <= beforeChances[0]) {
      throw new Error('Win model did not react to a rolled 8 with an immediate capture available.');
    }
    console.log(`Self-play smoke test passed: rules, turn sequencing, opponent learning, and roll-aware win probabilities.`);
  } else if (command === 'baseline') {
    if (players !== 4) throw new Error('The original baseline comparison is defined for four players.');
    const modes = entry === 'mixed' ? ['home', 'all', 'each'] as const : [entry] as EntryMode[];
    for (const mode of modes) {
      const shards = Math.min(workers, games);
      const results = await runParallel(Array.from({ length: shards }, (_, id) => ({
        id,
        model: CHOWKA_MODEL,
        opponent: CHOWKA_MODEL,
        games: Math.floor(games / shards) + (id < games % shards ? 1 : 0),
        players: 4,
        entry: mode,
        seed: seed + id * 100003 + modes.indexOf(mode) * 10000019,
        budget: budget || 96,
        originalOpponent: true,
      })));
      const totalGames = results.reduce((sum, result) => sum + result.games, 0);
      const scoreSum = results.reduce((sum, result) => sum + result.score * result.games, 0);
      const scoreSquares = results.reduce((sum, result) => sum + result.scoreSquares, 0);
      const score = scoreSum / totalGames;
      const variance = Math.max(0, scoreSquares / totalGames - score * score);
      const scoreMargin = 1.96 * Math.sqrt(variance / totalGames);
      const wins = results.reduce((sum, result) => sum + result.wins, 0);
      const winRate = wins / totalGames;
      const winMargin = 1.96 * Math.sqrt(winRate * (1 - winRate) / totalGames);
      const places = Array.from({ length: 4 }, (_, place) =>
        results.reduce((sum, result) => sum + result.places[place], 0));
      const turns = results.reduce((sum, result) => sum + result.turns, 0);
      console.log(`${mode}: final AI vs three original Hard opponents`);
      console.log(`  placement ${(score * 100).toFixed(1)}% ± ${(scoreMargin * 100).toFixed(1)}%; wins ${wins}/${totalGames} (${(winRate * 100).toFixed(1)}% ± ${(winMargin * 100).toFixed(1)}%)`);
      console.log(`  places ${places.join('/')} (1st/2nd/3rd/4th); ${turns} turns; ${shards} workers`);
    }
  } else if (command === 'tournament') {
    const shards = Math.min(workers, games);
    const initial = withoutTurnState(CHOWKA_MODEL);
    const results = await runParallel(Array.from({ length: shards }, (_, id) => ({
      id,
      model: CHOWKA_MODEL,
      opponent: initial,
      games: Math.floor(games / shards) + (id < games % shards ? 1 : 0),
      players,
      entry,
      seed: seed + id * 100003,
      budget,
      positionOpponent: true,
    })));
    const totalGames = results.reduce((sum, result) => sum + result.games, 0);
    const score = results.reduce((sum, result) => sum + result.score * result.games, 0) / totalGames;
    const wins = results.reduce((sum, result) => sum + result.wins, 0);
    const turns = results.reduce((sum, result) => sum + result.turns, 0);
    console.log(`Learned evaluator vs initial evaluator: ${(score * 100).toFixed(1)}% placement score, ${wins}/${totalGames} wins.`);
    console.log(`Seed ${seed}; ${players} players; ${entry} entry; ${turns} turns; ${shards} workers.`);
  } else {
    const generations = numberArg('generations', 6);
    const population = Math.max(4, numberArg('population', Math.min(16, workers * 2)));
    let sigma = numberArg('sigma', 18);
    let model: EvaluationModel = { ...CHOWKA_MODEL, weights: [...CHOWKA_MODEL.weights], seed };
    let trainedGames = model.trainedGames;
    const random = seededRandom(seed);

    console.log(`Training ${FEATURE_NAMES.length} weights with ${workers} workers (${population} candidates × ${generations} generations).`);
    for (let generation = 0; generation < generations; generation++) {
      const candidates = [model, ...Array.from({ length: population - 1 }, () => randomModel(model, random, sigma))];
      const trials = candidates.map((candidate, id) => ({
        id, model: candidate, opponent: model, games, players, entry, seed: seed + generation * 100003, budget,
      }));
      const results = await runParallel(trials);
      trainedGames += population * games;
      const ranked = results.map((result) => ({ result, model: candidates[result.id] }))
        .sort((a, b) => b.result.score - a.result.score);
      const champion = ranked[0];
      model = {
        version: 2,
        weights: [...champion.model.weights],
        trainedGames,
        seed,
      };
      sigma *= 0.78;
      const best = champion.result;
      console.log(`Generation ${generation + 1}: best ${(best.score * 100).toFixed(1)}%, ${best.wins}/${best.games} wins; sigma ${sigma.toFixed(2)}.`);
    }

    if (!validateModel(model)) throw new Error('Training produced an invalid model.');
    const destination = resolve('src/data/chowka-bhara-model.json');
    await writeFile(destination, `${JSON.stringify(model, null, 2)}\n`);
    console.log(`Saved ${trainedGames}-game model to ${destination}.`);
    FEATURE_NAMES.forEach((name, index) => console.log(`  ${name.padEnd(18)} ${model.weights[index].toFixed(3)}`));
  }
}
