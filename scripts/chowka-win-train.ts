import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { CHECKPOINT_ROOT, fingerprint, readBinary, readJson, removeCheckpoint, writeBinaryAtomic, writeJsonAtomic } from './training-checkpoint';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { BOARD_SIZES, boardFor, boardOf, finished, recordThrow, throwOdds, type BoardSize } from '../src/scripts/chowkaBhara';
import { applyKnownAction, copyTurn, playMatch, possibleActions, seededRandom, type MatchPolicy } from '../src/scripts/chowkaBharaMatch';
import { CHOWKA_MODELS, decisionScore } from '../src/scripts/chowkaBharaModel';
import { chooseAction, type Style } from '../src/scripts/chowkaBharaAI';
import {
  CHOWKA_WIN_MODELS,
  WIN_FEATURE_NAMES,
  WIN_MODEL_FILES,
  validateWinModel,
  winFeatures,
  type WinModel,
} from '../src/scripts/chowkaBharaWin';

interface DataJob {
  id: number;
  size: BoardSize;
  games: number;
  seed: number;
  sampleEvery: number;
}

interface DataResult {
  id: number;
  games: number;
  samples: number;
  features: Float32Array;
  winners: Uint8Array;
  held: Uint8Array;
  stages: Uint8Array;
  activeMasks: Uint8Array;
}

const styles: Style[] = ['balanced', 'aggressive', 'cautious', 'racer'];
const policy = (style: Style, hard: boolean): MatchPolicy => (context) => {
  if (hard) return chooseAction(context.state, context.player, context.turn, 'hard', style,
    context.turnStart, context.nextPlayer, context.social, { nodeBudget: 32 }).action;
  const actions = possibleActions(context.state, context.player, context.turn);
  let best = actions[0] ?? null;
  let bestScore = -Infinity;
  for (const action of actions) {
    let score = -Infinity;
    if (action.kind === 'throw') {
      score = 0;
      for (const [value, chance] of throwOdds(boardOf(context.state))) {
        const after = copyTurn(context.turn);
        recordThrow(boardOf(context.state), after, value);
        score += chance * decisionScore(context.state, context.player, after, context.turnStart);
      }
    } else {
      const after = applyKnownAction(context.state, context.turn, action);
      score = decisionScore(after.state, context.player, after.turn, context.turnStart)
        + after.hits.length * (style === 'aggressive' ? 16 : style === 'cautious' ? 2 : 5)
        + (action.kind === 'move' && action.move.to === boardFor(context.state.size).home && style === 'racer' ? 12 : 0);
    }
    if (score > bestScore) { best = action; bestScore = score; }
  }
  return best;
};

function generate(job: DataJob): DataResult {
  const rows: number[] = [];
  const winners: number[] = [];
  const held: number[] = [];
  const stages: number[] = [];
  const activeMasks: number[] = [];
  for (let game = 0; game < job.games; game++) {
    const snapshots: { features: number[][]; held: number; stage: number; activeMask: number }[] = [];
    const offset = (game * 7 + job.id * 3) % job.sampleEvery;
    let turn = 0;
    const orderedStyles = styles.map((_, seat) => styles[(seat + game + job.id) % 4]);
    const hardSeat = game % 20 === 0 ? (game + job.id) % 4 : -1;
    const result = playMatch({
      policies: orderedStyles.map((style, seat) => policy(style, seat === hardSeat)),
      styles: orderedStyles,
      entry: 'home',
      size: job.size,
      seed: job.seed + game * 0x9e3779b1,
      observeBehaviour: false,
      onDecision: ({ state, player: current, turn: liveTurn, turnStart }) => {
        const stage = state.players.filter((_, player) => finished(state, player)).length;
        if (stage < 3 && turn++ % job.sampleEvery === offset) {
          snapshots.push({
            features: state.players.map((_, player) =>
              winFeatures(state, player, current, liveTurn, turnStart)),
            held: Number(liveTurn.bank.length > 0),
            stage,
            activeMask: state.players.reduce((mask, _, player) =>
              mask | (finished(state, player) ? 0 : 1 << player), 0),
          });
        }
      },
    });
    for (const snapshot of snapshots) {
      const winner = result.places[snapshot.stage];
      if (!finished(result.state, winner)) continue;
      snapshot.features.forEach((features) => rows.push(...features));
      winners.push(winner);
      held.push(snapshot.held);
      stages.push(snapshot.stage);
      activeMasks.push(snapshot.activeMask);
    }
  }
  return {
    id: job.id,
    games: job.games,
    samples: winners.length,
    features: Float32Array.from(rows),
    winners: Uint8Array.from(winners),
    held: Uint8Array.from(held),
    stages: Uint8Array.from(stages),
    activeMasks: Uint8Array.from(activeMasks),
  };
}

if (!isMainThread) {
  const result = generate(workerData as DataJob);
  parentPort!.postMessage(result, [result.features.buffer as ArrayBuffer, result.winners.buffer as ArrayBuffer,
    result.held.buffer as ArrayBuffer, result.stages.buffer as ArrayBuffer, result.activeMasks.buffer as ArrayBuffer]);
} else {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }));
  const numberArg = (name: string, fallback: number) => Number(args.get(name) ?? fallback);
  const seed = numberArg('seed', 20260930);
  const games = numberArg('games', 1500);
  const validationGames = numberArg('validation-games', 300);
  const testGames = numberArg('test-games', 300);
  // Training stops at --epochs, or sooner once calibration log loss has not
  // improved for --patience epochs; the best epoch's weights are kept.
  const epochs = numberArg('epochs', 100);
  const patience = Math.max(1, numberArg('patience', 8));
  const shardGames = Math.max(1, numberArg('shard-games', 25));
  const sampleEvery = Math.max(4, numberArg('sample-every', 14));
  const workers = Math.max(1, Math.min(numberArg('workers', Math.min(8, availableParallelism() - 1)), availableParallelism()));
  const featureCount = WIN_FEATURE_NAMES.length;
  // --board=5 (default) or --board=7 picks the board to sample and the file to replace.
  const size = numberArg('board', 5) as BoardSize;
  if (!BOARD_SIZES.includes(size)) throw new Error(`--board must be one of ${BOARD_SIZES.join(', ')}.`);
  const CHOWKA_WIN_MODEL = CHOWKA_WIN_MODELS[size];
  const destination = resolve(args.get('output') ?? WIN_MODEL_FILES[size]);

  // Generated games are cached shard by shard and the weights are saved after
  // every epoch in .training/, so rerunning the same command carries on where
  // it stopped. --fresh discards a saved run.
  const checkpointDir = resolve(CHECKPOINT_ROOT, `chowka-win-${size}x${size}`);
  const runPath = resolve(checkpointDir, 'run.json');
  // The sampled games depend on the evaluator that plays them, so it is part of the key.
  const key = fingerprint({ size, seed, games, validationGames, testGames, sampleEvery, shardGames, epochs, patience,
    evaluator: CHOWKA_MODELS[size].weights, destination });
  interface RunCheckpoint {
    key: string;
    epoch: number;
    step: number;
    weights: number[];
    firstMoment: number[];
    secondMoment: number[];
    bestLogLoss: number;
    bestWeights: number[];
    bestEpoch: number;
    stale: number;
    done: boolean;
  }
  if (args.has('fresh')) await removeCheckpoint(checkpointDir);
  // key.json guards the cached games too, which exist before the first epoch is saved.
  const keyPath = resolve(checkpointDir, 'key.json');
  const savedKey = await readJson<{ key: string }>(keyPath);
  if (savedKey && savedKey.key !== key) {
    throw new Error(`${checkpointDir} was made with different settings. Rerun with the same ones, or add --fresh to start over.`);
  }
  const saved = await readJson<RunCheckpoint>(runPath);
  if (saved?.done) {
    console.log(`The ${size}x${size} win-model run in ${checkpointDir} already finished. Add --fresh to train again.`);
    process.exit(0);
  }
  await writeJsonAtomic(keyPath, { key });

  let cachedShards = 0;
  const generateParallel = async (split: string, totalGames: number, baseSeed: number): Promise<DataResult[]> => {
    const shards = Math.ceil(totalGames / shardGames);
    const jobs = Array.from({ length: shards }, (_, id) => ({
      id,
      size,
      games: Math.floor(totalGames / shards) + (id < totalGames % shards ? 1 : 0),
      seed: baseSeed + id * 100003,
      sampleEvery,
    }));
    const results: DataResult[] = [];
    let cursor = 0;
    const next = async (): Promise<void> => {
      const job = jobs[cursor++];
      if (!job) return;
      const shardPath = resolve(checkpointDir, 'data', `${split}-${job.id}.bin`);
      let result = await readBinary<DataResult>(shardPath);
      if (result) cachedShards++;
      else {
        result = await new Promise<DataResult>((done, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: job });
          worker.once('message', done);
          worker.once('error', reject);
          worker.once('exit', (code) => { if (code) reject(new Error(`Win-model worker exited with ${code}.`)); });
        });
        await writeBinaryAtomic(shardPath, result);
      }
      results.push(result);
      await next();
    };
    await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, next));
    return results.sort((a, b) => a.id - b.id);
  };

  console.log(`Generating four-player home-entry ${size}x${size} positions from ${games} training, ${validationGames} calibration and ${testGames} test games on ${workers} workers.`);
  const generationStarted = performance.now();
  const trainingParts = await generateParallel('training', games, seed);
  const validationParts = await generateParallel('validation', validationGames, seed ^ 0x5f3759df);
  const testParts = await generateParallel('test', testGames, seed ^ 0x3c6ef372);
  console.log(`Game data ready in ${((performance.now() - generationStarted) / 1000).toFixed(0)} s (${cachedShards} shards reused from the checkpoint).`);

  const combine = (parts: DataResult[]) => {
    const samples = parts.reduce((sum, part) => sum + part.samples, 0);
    const features = new Float32Array(samples * 4 * featureCount);
    const winners = new Uint8Array(samples);
    const held = new Uint8Array(samples);
    const stages = new Uint8Array(samples);
    const activeMasks = new Uint8Array(samples);
    let sampleOffset = 0;
    for (const part of parts) {
      features.set(part.features, sampleOffset * 4 * featureCount);
      winners.set(part.winners, sampleOffset);
      held.set(part.held, sampleOffset);
      stages.set(part.stages, sampleOffset);
      activeMasks.set(part.activeMasks, sampleOffset);
      sampleOffset += part.samples;
    }
    return { samples, features, winners, held, stages, activeMasks };
  };
  const training = combine(trainingParts);
  const validation = combine(validationParts);
  const test = combine(testParts);
  if (!training.samples || !validation.samples || !test.samples) throw new Error('No decided games were sampled in a data split.');
  console.log(`Collected ${training.samples} training, ${validation.samples} calibration and ${test.samples} test positions.`);
  const stageCounts = [0, 1, 2].map((stage) => training.stages.reduce((sum, value) => sum + Number(value === stage), 0));
  if (stageCounts.some((count) => count === 0)) throw new Error('Training is missing a placing stage.');
  const stageWeights = stageCounts.map((count) => Math.min(4, training.samples / (3 * count)));
  console.log(`Training positions by place: ${stageCounts.join('/')} (1st/2nd/3rd).`);

  const weights = new Float64Array(featureCount);
  const firstMoment = new Float64Array(featureCount);
  const secondMoment = new Float64Array(featureCount);
  const order = new Uint32Array(training.samples);
  let step = 0;
  const batchSize = 256;
  const learningRate = 0.025;

  const probabilitiesAt = (data: typeof training, sample: number, temperature: number, coefficients: ArrayLike<number> = weights) => {
    const logits = [0, 0, 0, 0];
    const base = sample * 4 * featureCount;
    for (let player = 0; player < 4; player++) {
      if (!(data.activeMasks[sample] & (1 << player))) { logits[player] = -Infinity; continue; }
      const offset = base + player * featureCount;
      for (let feature = 0; feature < featureCount; feature++) {
        logits[player] += data.features[offset + feature] * (coefficients[feature] ?? 0);
      }
      logits[player] /= temperature;
    }
    const peak = Math.max(...logits);
    const exp = logits.map((logit) => Math.exp(logit - peak));
    const total = exp.reduce((sum, value) => sum + value, 0);
    return exp.map((value) => value / total);
  };

  const metricsAt = (
    data: typeof validation, temperature: number, heldFilter?: number,
    coefficients?: ArrayLike<number>, stageFilter?: number,
  ) => {
    let logLoss = 0;
    let brier = 0;
    let correct = 0;
    let sampleCount = 0;
    let activeCount = 0;
    let uniformLogLoss = 0;
    const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
    for (let sample = 0; sample < data.samples; sample++) {
      if (heldFilter !== undefined && data.held[sample] !== heldFilter) continue;
      if (stageFilter !== undefined && data.stages[sample] !== stageFilter) continue;
      sampleCount++;
      const probabilities = probabilitiesAt(data, sample, temperature, coefficients);
      const winner = data.winners[sample];
      uniformLogLoss += Math.log(4 - data.stages[sample]);
      logLoss -= Math.log(Math.max(1e-9, probabilities[winner]));
      for (let player = 0; player < 4; player++) {
        const error = probabilities[player] - Number(player === winner);
        brier += error * error;
      }
      const predicted = probabilities.indexOf(Math.max(...probabilities));
      const hit = Number(predicted === winner);
      correct += hit;
      for (let player = 0; player < 4; player++) {
        if (!(data.activeMasks[sample] & (1 << player))) continue;
        activeCount++;
        const probability = probabilities[player];
        const bin = bins[Math.min(9, Math.floor(probability * 10))];
        bin.count++;
        bin.confidence += probability;
        bin.correct += Number(player === winner);
      }
    }
    if (!sampleCount) throw new Error('No positions for the requested roll phase.');
    const calibrationError = bins.reduce((sum, bin) => bin.count
      ? sum + bin.count / activeCount * Math.abs(bin.correct / bin.count - bin.confidence / bin.count)
      : sum, 0);
    return {
      samples: sampleCount,
      logLoss: logLoss / sampleCount,
      uniformLogLoss: uniformLogLoss / sampleCount,
      brier: brier / sampleCount,
      accuracy: correct / sampleCount,
      calibrationError,
    };
  };

  let bestLogLoss = Infinity;
  let bestWeights = Array.from(weights);
  let bestEpoch = 0;
  let stale = 0;
  let epoch = 0;
  if (saved) {
    weights.set(saved.weights);
    firstMoment.set(saved.firstMoment);
    secondMoment.set(saved.secondMoment);
    ({ step, bestLogLoss, bestWeights, bestEpoch, stale, epoch } = saved);
    console.log(`Resuming after epoch ${epoch} (best calibration log loss ${bestLogLoss.toFixed(4)} at epoch ${bestEpoch}).`);
  }
  while (epoch < epochs && stale < patience) {
    // Each epoch shuffles with its own seed, so a resumed run matches an uninterrupted one.
    const random = seededRandom((seed ^ 0xa511e9b3) + epoch * 0x9e3779b1);
    for (let i = 0; i < order.length; i++) order[i] = i;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let start = 0; start < order.length; start += batchSize) {
      const end = Math.min(order.length, start + batchSize);
      const gradient = new Float64Array(featureCount);
      for (let position = start; position < end; position++) {
        const sample = order[position];
        const probabilities = probabilitiesAt(training, sample, 1);
        const base = sample * 4 * featureCount;
        for (let player = 0; player < 4; player++) {
          const error = probabilities[player] - Number(training.winners[sample] === player);
          const offset = base + player * featureCount;
          for (let feature = 0; feature < featureCount; feature++) {
            gradient[feature] += error * training.features[offset + feature] * stageWeights[training.stages[sample]];
          }
        }
      }
      step++;
      for (let feature = 0; feature < featureCount; feature++) {
        const value = gradient[feature] / (end - start) + weights[feature] * 0.0004;
        firstMoment[feature] = 0.9 * firstMoment[feature] + 0.1 * value;
        secondMoment[feature] = 0.999 * secondMoment[feature] + 0.001 * value * value;
        const correctedFirst = firstMoment[feature] / (1 - 0.9 ** step);
        const correctedSecond = secondMoment[feature] / (1 - 0.999 ** step);
        weights[feature] -= learningRate * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8);
      }
    }
    epoch++;
    const logLoss = metricsAt(validation, 1).logLoss;
    if (logLoss < bestLogLoss - 1e-4) {
      bestLogLoss = logLoss;
      bestWeights = Array.from(weights);
      bestEpoch = epoch;
      stale = 0;
    } else stale++;
    await writeJsonAtomic(runPath, {
      key, epoch, step, weights: Array.from(weights), firstMoment: Array.from(firstMoment),
      secondMoment: Array.from(secondMoment), bestLogLoss, bestWeights, bestEpoch, stale, done: false,
    } satisfies RunCheckpoint);
    if (epoch % 5 === 0 || epoch === 1) console.log(`Epoch ${epoch}/${epochs}: calibration log loss ${logLoss.toFixed(4)} (best ${bestLogLoss.toFixed(4)} at epoch ${bestEpoch}).`);
  }
  console.log(stale >= patience
    ? `Plateau: no calibration gain for ${patience} epochs; keeping epoch ${bestEpoch}.`
    : `Reached ${epochs} epochs; keeping epoch ${bestEpoch}.`);
  weights.set(bestWeights);

  let temperature = 1;
  let validationMetrics = metricsAt(validation, temperature);
  for (let candidate = 0.55; candidate <= 2.5; candidate += 0.025) {
    const metrics = metricsAt(validation, candidate);
    if (metrics.logLoss < validationMetrics.logLoss) {
      temperature = candidate;
      validationMetrics = metrics;
    }
  }
  const testMetrics = metricsAt(test, temperature);
  const previousMetrics = metricsAt(test, CHOWKA_WIN_MODEL.temperature, undefined, CHOWKA_WIN_MODEL.weights);
  const testByPlace = [0, 1, 2].map((stage) => ({ place: stage + 1, ...metricsAt(test, temperature, undefined, undefined, stage) }));
  const previousByPlace = [0, 1, 2].map((stage) => ({ place: stage + 1,
    ...metricsAt(test, CHOWKA_WIN_MODEL.temperature, undefined, CHOWKA_WIN_MODEL.weights, stage) }));

  const model: WinModel = {
    version: 3,
    board: size,
    weights: Array.from(weights),
    temperature,
    trainedGames: games,
    validationGames,
    testGames,
    seed,
    validation: validationMetrics,
    test: testMetrics,
    testByPlace,
  };
  if (!validateWinModel(model)) throw new Error('Training produced an invalid win model.');
  await writeJsonAtomic(destination, model);
  const lastEpoch = await readJson<RunCheckpoint>(runPath);
  if (lastEpoch) await writeJsonAtomic(runPath, { ...lastEpoch, done: true });
  console.log(`Saved win model to ${destination}.`);
  console.log(`Validation: log loss ${validationMetrics.logLoss.toFixed(4)} (uniform ${validationMetrics.uniformLogLoss.toFixed(4)}), Brier ${validationMetrics.brier.toFixed(4)}, accuracy ${(validationMetrics.accuracy * 100).toFixed(1)}%, calibration error ${(validationMetrics.calibrationError * 100).toFixed(1)}%.`);
  console.log(`Untouched test: log loss ${testMetrics.logLoss.toFixed(4)}, Brier ${testMetrics.brier.toFixed(4)}, accuracy ${(testMetrics.accuracy * 100).toFixed(1)}%, player calibration error ${(testMetrics.calibrationError * 100).toFixed(1)}%.`);
  console.log(`Previous model on same test: log loss ${previousMetrics.logLoss.toFixed(4)}, Brier ${previousMetrics.brier.toFixed(4)}, accuracy ${(previousMetrics.accuracy * 100).toFixed(1)}%, player calibration error ${(previousMetrics.calibrationError * 100).toFixed(1)}%.`);
  for (let stage = 0; stage < 3; stage++) {
    const latest = testByPlace[stage];
    const previous = previousByPlace[stage];
    console.log(`  ${stage + 1}${stage === 0 ? 'st' : stage === 1 ? 'nd' : 'rd'} place (${latest.samples} positions): log loss ${latest.logLoss.toFixed(4)} vs previous ${previous.logLoss.toFixed(4)}; accuracy ${(latest.accuracy * 100).toFixed(1)}% vs ${(previous.accuracy * 100).toFixed(1)}%.`);
  }
  for (const [name, phase] of [['before a held roll', 0], ['with held rolls', 1]] as const) {
    const metrics = metricsAt(test, temperature, phase);
    console.log(`  ${name}: log loss ${metrics.logLoss.toFixed(4)}, Brier ${metrics.brier.toFixed(4)}, accuracy ${(metrics.accuracy * 100).toFixed(1)}%, calibration error ${(metrics.calibrationError * 100).toFixed(1)}%.`);
  }
  console.log(`Temperature ${temperature.toFixed(3)}; weights:`);
  WIN_FEATURE_NAMES.forEach((name, index) => console.log(`  ${name.padEnd(18)} ${weights[index].toFixed(4)}`));
}
