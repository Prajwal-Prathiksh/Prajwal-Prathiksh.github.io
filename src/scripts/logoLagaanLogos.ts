export interface LogoArtwork {
  asset: string;
  width: number;
  height: number;
  correct: boolean;
  detail: string;
}

export interface HintRegion {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

// Every choice contains a standalone PNG. Hints use the same image coordinates
// in both the cards and enlarged view.
export function logoArt(
  art: LogoArtwork,
  regions: readonly HintRegion[] = [],
): string {
  const rings = regions
    .map(
      (r) =>
        `<ellipse class="hint-ring" cx="${(r.x / 100) * art.width}" cy="${(r.y / 100) * art.height}" rx="${(r.rx / 100) * art.width}" ry="${(r.ry / 100) * art.height}" vector-effect="non-scaling-stroke" />`,
    )
    .join('');
  return `<svg class="memory-art" viewBox="0 0 ${art.width} ${art.height}" aria-hidden="true" focusable="false" style="overflow:hidden"><image href="${art.asset}" width="${art.width}" height="${art.height}" /><g class="hint-rings">${rings}</g></svg>`;
}

export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
