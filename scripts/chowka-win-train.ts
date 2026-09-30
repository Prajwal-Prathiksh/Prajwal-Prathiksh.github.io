import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { finished, recordThrow } from '../src/scripts/chowkaBhara';
import { applyKnownAction, copyTurn, playMatch, possibleActions, seededRandom, THROW_ODDS, type MatchPolicy } from '../src/scripts/chowkaBharaMatch';
import { CHOWKA_MODEL, decisionScore } from '../src/scripts/chowkaBharaModel';
import { chooseAction, type Style } from '../src/scripts/chowkaBharaAI';
import {
  CHOWKA_WIN_MODEL,
  WIN_FEATURE_NAMES,
  validateWinModel,
  winFeatures,
  type WinModel,
} from '../src/scripts/chowkaBharaWin';

interface DataJob {
  id: number;
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
      for (const [value, count] of THROW_ODDS) {
        const after = copyTurn(context.turn);
        recordThrow(after, value);
        score += count / 16 * decisionScore(context.state, context.player, after, context.turnStart, CHOWKA_MODEL);
      }
    } else {
      const after = applyKnownAction(context.state, context.turn, action);
      score = decisionScore(after.state, context.player, after.turn, context.turnStart, CHOWKA_MODEL)
        + after.hits.length * (style === 'aggressive' ? 16 : style === 'cautious' ? 2 : 5)
        + (action.kind === 'move' && action.move.to === 24 && style === 'racer' ? 12 : 0);
    }
    if (score > bestScore) { best = action; bestScore = score; }
  }
  return best;
};

function generate(job: DataJob): DataResult {
  const rows: number[] = [];
  const winners: number[] = [];
  const held: number[] = [];
  for (let game = 0; game < job.games; game++) {
    const snapshots: { features: number[][]; held: number }[] = [];
    const offset = (game * 7 + job.id * 3) % job.sampleEvery;
    let turn = 0;
    const orderedStyles = styles.map((_, seat) => styles[(seat + game + job.id) % 4]);
    const hardSeat = game % 20 === 0 ? (game + job.id) % 4 : -1;
    const result = playMatch({
      policies: orderedStyles.map((style, seat) => policy(style, seat === hardSeat)),
      styles: orderedStyles,
      entry: 'home',
      seed: job.seed + game * 0x9e3779b1,
      observeBehaviour: false,
      onDecision: ({ state, player: current, turn: liveTurn, turnStart }) => {
        if (!state.players.some((_, player) => finished(state, player)) && turn++ % job.sampleEvery === offset) {
          snapshots.push({
            features: state.players.map((_, player) =>
              winFeatures(state, player, current, liveTurn, turnStart)),
            held: Number(liveTurn.bank.length > 0),
          });
        }
      },
    });
    const winner = result.places[0];
    if (!finished(result.state, winner)) continue;
    for (const snapshot of snapshots) {
      snapshot.features.forEach((features) => rows.push(...features));
      winners.push(winner);
      held.push(snapshot.held);
    }
  }
  return {
    id: job.id,
    games: job.games,
    samples: winners.length,
    features: Float32Array.from(rows),
    winners: Uint8Array.from(winners),
    held: Uint8Array.from(held),
  };
}

if (!isMainThread) {
  const result = generate(workerData as DataJob);
  parentPort!.postMessage(result, [result.features.buffer as ArrayBuffer, result.winners.buffer as ArrayBuffer, result.held.buffer as ArrayBuffer]);
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
  const epochs = numberArg('epochs', 40);
  const sampleEvery = Math.max(4, numberArg('sample-every', 14));
  const workers = Math.max(1, Math.min(numberArg('workers', Math.min(8, availableParallelism() - 1)), availableParallelism()));
  const featureCount = WIN_FEATURE_NAMES.length;

  const generateParallel = async (totalGames: number, baseSeed: number): Promise<DataResult[]> => {
    const shards = Math.min(workers, totalGames);
    const jobs = Array.from({ length: shards }, (_, id) => ({
      id,
      games: Math.floor(totalGames / shards) + (id < totalGames % shards ? 1 : 0),
      seed: baseSeed + id * 100003,
      sampleEvery,
    }));
    const results: DataResult[] = [];
    let cursor = 0;
    const next = async (): Promise<void> => {
      const job = jobs[cursor++];
      if (!job) return;
      const result = await new Promise<DataResult>((done, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: job });
        worker.once('message', done);
        worker.once('error', reject);
        worker.once('exit', (code) => { if (code) reject(new Error(`Win-model worker exited with ${code}.`)); });
      });
      results.push(result);
      await next();
    };
    await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, next));
    return results.sort((a, b) => a.id - b.id);
  };

  console.log(`Generating four-player home-entry positions from ${games} training, ${validationGames} calibration and ${testGames} test games on ${workers} workers.`);
  const trainingParts = await generateParallel(games, seed);
  const validationParts = await generateParallel(validationGames, seed ^ 0x5f3759df);
  const testParts = await generateParallel(testGames, seed ^ 0x3c6ef372);

  const combine = (parts: DataResult[]) => {
    const samples = parts.reduce((sum, part) => sum + part.samples, 0);
    const features = new Float32Array(samples * 4 * featureCount);
    const winners = new Uint8Array(samples);
    const held = new Uint8Array(samples);
    let sampleOffset = 0;
    for (const part of parts) {
      features.set(part.features, sampleOffset * 4 * featureCount);
      winners.set(part.winners, sampleOffset);
      held.set(part.held, sampleOffset);
      sampleOffset += part.samples;
    }
    return { samples, features, winners, held };
  };
  const training = combine(trainingParts);
  const validation = combine(validationParts);
  const test = combine(testParts);
  if (!training.samples || !validation.samples || !test.samples) throw new Error('No decided games were sampled in a data split.');
  console.log(`Collected ${training.samples} training, ${validation.samples} calibration and ${test.samples} test positions.`);

  const weights = new Float64Array(featureCount);
  const firstMoment = new Float64Array(featureCount);
  const secondMoment = new Float64Array(featureCount);
  const random = seededRandom(seed ^ 0xa511e9b3);
  const order = Uint32Array.from({ length: training.samples }, (_, index) => index);
  let step = 0;
  const batchSize = 256;
  const learningRate = 0.025;

  const probabilitiesAt = (data: typeof training, sample: number, temperature: number, coefficients: ArrayLike<number> = weights) => {
    const logits = [0, 0, 0, 0];
    const base = sample * 4 * featureCount;
    for (let player = 0; player < 4; player++) {
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

  for (let epoch = 0; epoch < epochs; epoch++) {
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
            gradient[feature] += error * training.features[offset + feature];
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
    if ((epoch + 1) % 10 === 0 || epoch === 0) console.log(`Epoch ${epoch + 1}/${epochs}`);
  }

  const metricsAt = (data: typeof validation, temperature: number, heldFilter?: number, coefficients?: ArrayLike<number>) => {
    let logLoss = 0;
    let brier = 0;
    let correct = 0;
    let sampleCount = 0;
    const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
    for (let sample = 0; sample < data.samples; sample++) {
      if (heldFilter !== undefined && data.held[sample] !== heldFilter) continue;
      sampleCount++;
      const probabilities = probabilitiesAt(data, sample, temperature, coefficients);
      const winner = data.winners[sample];
      logLoss -= Math.log(Math.max(1e-9, probabilities[winner]));
      for (let player = 0; player < 4; player++) {
        const error = probabilities[player] - Number(player === winner);
        brier += error * error;
      }
      const predicted = probabilities.indexOf(Math.max(...probabilities));
      const hit = Number(predicted === winner);
      correct += hit;
      for (let player = 0; player < 4; player++) {
        const probability = probabilities[player];
        const bin = bins[Math.min(9, Math.floor(probability * 10))];
        bin.count++;
        bin.confidence += probability;
        bin.correct += Number(player === winner);
      }
    }
    if (!sampleCount) throw new Error('No positions for the requested roll phase.');
    const calibrationError = bins.reduce((sum, bin) => bin.count
      ? sum + bin.count / (sampleCount * 4) * Math.abs(bin.correct / bin.count - bin.confidence / bin.count)
      : sum, 0);
    return {
      logLoss: logLoss / sampleCount,
      brier: brier / sampleCount,
      accuracy: correct / sampleCount,
      calibrationError,
    };
  };

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

  const model: WinModel = {
    version: 2,
    weights: Array.from(weights),
    temperature,
    trainedGames: games,
    validationGames,
    testGames,
    seed,
    validation: validationMetrics,
    test: testMetrics,
  };
  if (!validateWinModel(model)) throw new Error('Training produced an invalid win model.');
  const destination = resolve('src/data/chowka-bhara-win-model.json');
  await writeFile(destination, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`Saved win model to ${destination}.`);
  console.log(`Validation: log loss ${validationMetrics.logLoss.toFixed(4)} (uniform 1.3863), Brier ${validationMetrics.brier.toFixed(4)} (uniform 0.7500), accuracy ${(validationMetrics.accuracy * 100).toFixed(1)}%, calibration error ${(validationMetrics.calibrationError * 100).toFixed(1)}%.`);
  console.log(`Untouched test: log loss ${testMetrics.logLoss.toFixed(4)}, Brier ${testMetrics.brier.toFixed(4)}, accuracy ${(testMetrics.accuracy * 100).toFixed(1)}%, player calibration error ${(testMetrics.calibrationError * 100).toFixed(1)}%.`);
  console.log(`Previous model on same test: log loss ${previousMetrics.logLoss.toFixed(4)}, Brier ${previousMetrics.brier.toFixed(4)}, accuracy ${(previousMetrics.accuracy * 100).toFixed(1)}%, player calibration error ${(previousMetrics.calibrationError * 100).toFixed(1)}%.`);
  for (const [name, phase] of [['before a held roll', 0], ['with held rolls', 1]] as const) {
    const metrics = metricsAt(test, temperature, phase);
    console.log(`  ${name}: log loss ${metrics.logLoss.toFixed(4)}, Brier ${metrics.brier.toFixed(4)}, accuracy ${(metrics.accuracy * 100).toFixed(1)}%, calibration error ${(metrics.calibrationError * 100).toFixed(1)}%.`);
  }
  console.log(`Temperature ${temperature.toFixed(3)}; weights:`);
  WIN_FEATURE_NAMES.forEach((name, index) => console.log(`  ${name.padEnd(18)} ${weights[index].toFixed(4)}`));
}
