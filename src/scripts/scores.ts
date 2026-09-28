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
