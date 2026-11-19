// Chalk drawing of the board, shared by the server-rendered page and the
// browser, which redraws it when the board size changes. Coordinates are in
// hundredths of a board unit: the grid sits inside a one-unit margin that
// holds each player's waiting pawns, so a 5x5 board is 7 units across and a
// 7x7 board is 9.

import { boardFor, type BoardSize } from './chowkaBhara';

export const unitsOf = (size: BoardSize) => size + 2;

const petals = Array.from({ length: 8 }, (_, i) => i * 45);
const dots = Array.from({ length: 16 }, (_, i) => (i * Math.PI) / 8);

export function chalkBoard(size: BoardSize): string {
  const board = boardFor(size);
  const far = (size + 1) * 100;
  const parts: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) parts.push(`<rect x="${100 + c * 100}" y="${100 + r * 100}" width="100" height="100"/>`);
  }
  parts.push(`<rect x="94" y="94" width="${far - 88}" height="${far - 88}" rx="4"/>`);
  // Crossed safe squares, each with four chalk dots. The centre gets a kolam instead.
  for (const [r, c] of board.safe) {
    if (r === board.centre[0] && c === board.centre[1]) continue;
    const x = 100 + c * 100;
    const y = 100 + r * 100;
    parts.push(`<g><path d="M${x + 12} ${y + 12}L${x + 88} ${y + 88}M${x + 88} ${y + 12}L${x + 12} ${y + 88}"/>`
      + [[0, -36], [36, 0], [0, 36], [-36, 0]].map(([dx, dy]) =>
        `<circle class="dot" cx="${x + 50 + dx}" cy="${y + 50 + dy}" r="3"/>`).join('')
      + '</g>');
  }
  const mid = unitsOf(size) * 50;
  parts.push(`<g class="kolam" transform="translate(${mid} ${mid})">`
    + petals.map((a) => `<ellipse cx="0" cy="-21" rx="8.5" ry="20" transform="rotate(${a})"/>`).join('')
    + '<circle r="9"/>'
    + dots.map((a) => `<circle class="dot" cx="${(Math.cos(a) * 44).toFixed(2)}" cy="${(Math.sin(a) * 44).toFixed(2)}" r="2.6"/>`).join('')
    + '</g>');
  return parts.join('');
}
