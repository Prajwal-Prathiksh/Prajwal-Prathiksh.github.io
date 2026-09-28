// Game scores live in this browser's localStorage and never leave the device.
// Every key uses one prefix so "clear all" removes exactly what the site wrote.
const PREFIX = 'pp-games:';

export function loadScores<T extends object>(game: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + game);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveScores(game: string, scores: object): void {
  try {
    localStorage.setItem(PREFIX + game, JSON.stringify(scores));
  } catch {
    // Storage can be full or disabled (private mode). The game still works.
  }
}

export function clearAllScores(): void {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(PREFIX))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    // Nothing stored.
  }
}

export type GameRecord = { wins: number; losses: number; draws: number; streak: number; bestStreak: number };
const EMPTY_RECORD: GameRecord = { wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 };

export const loadRecord = (game: string) => loadScores<GameRecord>(game, EMPTY_RECORD);

export function recordResult(game: string, result: 'win' | 'loss' | 'draw'): void {
  const r = loadRecord(game);
  if (result === 'win') {
    r.wins++;
    r.streak++;
    r.bestStreak = Math.max(r.bestStreak, r.streak);
  } else if (result === 'loss') {
    r.losses++;
    r.streak = 0;
  } else {
    r.draws++;
  }
  saveScores(game, r);
}

// Fills a <dl class="stats"> with the record, or empties it when game is null.
export function renderRecord(el: HTMLElement, game: string | null): void {
  if (!game) {
    el.innerHTML = '';
    return;
  }
  const r = loadRecord(game);
  el.innerHTML = [
    ['Wins', r.wins],
    ['Losses', r.losses],
    ['Draws', r.draws],
    ['Best streak', r.bestStreak],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
}
