// The end-of-game race replay: how each player's outlook for the next open
// place moved from the first throw to the last finish. The page samples the
// live outlook once per history step; this module turns those samples into
// one race per place and draws them as a scrubbable chalk chart.

export interface OutlookSample {
  step: number; // index into the board history
  place: number; // 0-based place being contested
  chances: number[]; // per player; placed players are 0
}

export interface Race {
  place: number;
  winner: number | null; // null if the game stopped before anyone took it
  points: OutlookSample[]; // ends with a one-hot point at the finish when decided
  start: number;
  end: number;
}

export interface TrajectoryPlayer {
  name: string;
  colour: string; // pawn symbol id, e.g. 'blue'
  ink: string; // chalk colour for the line
  you: boolean;
}

export interface TrajectoryData {
  trail: OutlookSample[];
  placings: number[];
  lastStep: number;
  players: TrajectoryPlayer[];
  descriptions: string[];
}

export const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n] ?? 'th'}`;
const percent = (p: number) => (p > 0 && p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);

export function buildRaces({ trail, placings, lastStep }: Pick<TrajectoryData, 'trail' | 'placings' | 'lastStep'>): Race[] {
  const races: Race[] = [];
  const places = [...new Set(trail.map((sample) => sample.place))].sort((a, b) => a - b);
  for (const place of places) {
    const points = trail.filter((sample) => sample.place === place);
    const winner = placings[place] ?? null;
    if (winner === null && points.length < 2) continue;
    const following = trail.find((sample) => sample.place > place);
    const end = winner === null ? points.at(-1)!.step : Math.max(points.at(-1)!.step, following?.step ?? lastStep);
    if (winner !== null) {
      points.push({ step: end, place, chances: points[0].chances.map((_, i) => (i === winner ? 1 : 0)) });
    }
    races.push({ place, winner, points, start: points[0].step, end });
  }
  return races;
}

export interface Moment {
  value: string;
  label: string;
  detail?: string;
  colour?: string;
}

export function moments(races: Race[], data: TrajectoryData): Moment[] {
  const found: Moment[] = [];
  const name = (i: number) => data.players[i].name;
  const whose = (i: number) => (data.players[i].you ? 'Your' : `${name(i)}'s`);
  const first = races.find((race) => race.place === 0);
  if (first && first.winner !== null) {
    const live = first.points.slice(0, -1);
    const low = Math.min(...live.map((sample) => sample.chances[first.winner!]));
    const peakRival = Math.max(...live.map((sample) =>
      Math.max(...sample.chances.filter((_, i) => i !== first.winner))));
    found.push(low < 0.3
      ? { value: percent(low), label: `${whose(first.winner)} lowest chance before winning 1st`, colour: data.players[first.winner].colour }
      : { value: percent(peakRival), label: `Best chance any rival had of 1st`, colour: data.players[first.winner].colour });
    // Count a change only when the new leader is clearly ahead, so two
    // players trading fractions of a percent do not inflate it.
    let changes = 0;
    let leader = -1;
    for (const sample of live) {
      const top = sample.chances.indexOf(Math.max(...sample.chances));
      if (leader < 0) leader = top;
      else if (top !== leader && sample.chances[top] - sample.chances[leader] >= 0.03) {
        changes++;
        leader = top;
      }
    }
    found.push({ value: String(changes), label: changes === 1 ? 'lead change in the race for 1st' : 'lead changes in the race for 1st' });
  }

  let swing = { delta: 0, player: -1, step: -1 };
  for (const race of races) {
    const live = race.points.slice(0, race.winner === null ? undefined : -1);
    for (let i = 1; i < live.length; i++) {
      live[i].chances.forEach((chance, player) => {
        const delta = chance - live[i - 1].chances[player];
        if (Math.abs(delta) > Math.abs(swing.delta)) swing = { delta, player, step: live[i].step };
      });
    }
  }
  if (swing.player >= 0 && Math.abs(swing.delta) >= 0.05) {
    const points = Math.round(swing.delta * 100);
    found.push({
      value: `${points > 0 ? '+' : '−'}${Math.abs(points)}`,
      label: `biggest single swing, for ${data.players[swing.player].you ? 'you' : name(swing.player)}`,
      detail: data.descriptions[swing.step],
      colour: data.players[swing.player].colour,
    });
  }
  return found;
}

interface Geometry {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  x: (step: number) => number;
  y: (chance: number) => number;
  stepAt: (x: number) => number;
}

function geometry(width: number, races: Race[]): Geometry {
  const height = width < 460 ? 230 : 290;
  const left = 38;
  const right = width - 16;
  const top = 34;
  const bottom = height - 26;
  const first = races[0]?.start ?? 0;
  const last = Math.max(first + 1, races.at(-1)?.end ?? 1);
  return {
    width, height, left, right, top, bottom,
    x: (step) => left + ((step - first) / (last - first)) * (right - left),
    y: (chance) => top + (1 - chance) * (bottom - top),
    stepAt: (x) => first + ((Math.min(right, Math.max(left, x)) - left) / (right - left)) * (last - first),
  };
}

function chartSvg(races: Race[], data: TrajectoryData, g: Geometry, animate: boolean): string {
  const parts: string[] = [];
  const raceLabel = (race: Race, room: number) =>
    room > 96 ? `Race for ${ordinal(race.place + 1)}` : room > 26 ? ordinal(race.place + 1) : '';

  races.forEach((race, n) => {
    const x0 = g.x(race.start);
    const x1 = g.x(race.end);
    parts.push(`<rect class="tj-band${n % 2 ? ' alt' : ''}" x="${x0}" y="${g.top - 22}" width="${Math.max(0, x1 - x0)}" height="${g.bottom - g.top + 22}" rx="6"/>`);
    const label = raceLabel(race, x1 - x0);
    if (label) parts.push(`<text class="tj-race" x="${x0 + 7}" y="${g.top - 8}">${label}</text>`);
  });

  for (const chance of [0, 0.25, 0.5, 0.75, 1]) {
    const y = g.y(chance);
    parts.push(`<line class="tj-grid${chance === 0 ? ' base' : ''}" x1="${g.left}" x2="${g.right}" y1="${y}" y2="${y}"/>`);
    if (chance % 0.5 === 0) parts.push(`<text class="tj-axis" x="${g.left - 6}" y="${y + 4}" text-anchor="end">${chance * 100}%</text>`);
  }
  parts.push(`<text class="tj-axis" x="${g.left}" y="${g.height - 6}">Start</text>`);
  parts.push(`<text class="tj-axis" x="${g.right}" y="${g.height - 6}" text-anchor="end">${races.at(-1)?.winner === null ? 'Stuck' : 'Finish'} · step ${races.at(-1)?.end ?? 0}</text>`);

  const lines: string[] = [];
  const order = data.players.map((_, i) => i).sort((a, b) => Number(data.players[a].you) - Number(data.players[b].you));
  for (const race of races) {
    for (const player of order) {
      if (race.points.every((sample) => sample.chances[player] === 0)) continue;
      const d = race.points.map((sample, i) =>
        `${i ? 'L' : 'M'}${g.x(sample.step).toFixed(1)} ${g.y(sample.chances[player]).toFixed(1)}`).join('');
      const you = data.players[player].you ? ' you' : '';
      if (you) lines.push(`<path class="tj-glow" d="${d}" style="--ink:${data.players[player].ink}"/>`);
      lines.push(`<path class="tj-line${you}" d="${d}" style="--ink:${data.players[player].ink}"/>`);
    }
  }
  parts.push(`<g class="tj-lines${animate ? ' draw' : ''}">${lines.join('')}</g>`);

  for (const race of races) {
    if (race.winner === null) continue;
    const x = g.x(race.end);
    parts.push(`<line class="tj-finish" x1="${x}" x2="${x}" y1="${g.top - 22}" y2="${g.bottom}"/>`);
    parts.push(`<use class="tj-pawn${animate ? ' pop' : ''}" href="#pawn-${data.players[race.winner].colour}" x="${x - 10}" y="${g.y(1) - 10}" width="20" height="20" style="--delay:${animate ? 1.1 + race.place * 0.15 : 0}s"/>`);
  }

  parts.push(`<g class="tj-cursor" visibility="hidden"><line class="tj-cursor-line" y1="${g.top - 22}" y2="${g.bottom}"/>${data.players.map((p, i) => `<circle data-player="${i}" r="4.5" style="--ink:${p.ink}"/>`).join('')}</g>`);
  parts.push(`<rect class="tj-hit" x="${g.left}" y="0" width="${g.right - g.left}" height="${g.height}"/>`);
  return `<svg class="tj-svg" viewBox="0 0 ${g.width} ${g.height}" width="${g.width}" height="${g.height}" role="img" aria-label="Line chart of each player's chance of taking each place, step by step">${parts.join('')}</svg>`;
}

// Renders into a container holding [data-tj=chart|readout|moments] elements.
// Returns a cleanup function for the resize observer.
export function mountTrajectory(root: HTMLElement, data: TrajectoryData): () => void {
  const chartEl = root.querySelector<HTMLElement>('[data-tj=chart]')!;
  const readoutEl = root.querySelector<HTMLElement>('[data-tj=readout]')!;
  const momentsEl = root.querySelector<HTMLElement>('[data-tj=moments]')!;
  const races = buildRaces(data);
  const samples = races.flatMap((race) => race.points.map((sample, i) => ({
    ...sample, closing: race.winner !== null && i === race.points.length - 1, race,
  })));

  momentsEl.innerHTML = moments(races, data).map((m) => `<li${m.colour ? ` style="--moment-ink:var(--tj-${m.colour})"` : ''}>
    <strong>${escapeHtml(m.value)}</strong><span>${escapeHtml(m.label)}</span>${m.detail ? `<small>${escapeHtml(m.detail)}</small>` : ''}</li>`).join('');
  momentsEl.hidden = !momentsEl.children.length;

  if (!samples.length) {
    chartEl.innerHTML = '<p class="tj-empty">The game ended before the outlook had anything to show.</p>';
    readoutEl.innerHTML = '';
    return () => {};
  }

  let g = geometry(chartEl.clientWidth || 600, races);
  let index = samples.length - 1;
  let animate = !matchMedia('(prefers-reduced-motion: reduce)').matches;

  const readout = (active: boolean) => {
    const sample = samples[index];
    const placeName = ordinal(sample.place + 1);
    const heading = sample.closing
      ? `${escapeHtml(data.players[sample.race.winner!].name)} ${data.players[sample.race.winner!].you ? 'take' : 'takes'} ${placeName}`
      : `Race for ${placeName}`;
    const note = sample.closing ? '' : data.descriptions[sample.step] ?? '';
    const players = data.players.map((p, i) => ({ p, i, chance: sample.chances[i] }))
      .filter(({ i }) => sample.race.points.some((point) => point.chances[i] > 0))
      .sort((a, b) => b.chance - a.chance);
    readoutEl.innerHTML = `<p class="tj-where"><span class="tj-step">${active ? `Step ${sample.step}` : 'Final'}</span><strong>${heading}</strong>${note ? `<span class="tj-note">${escapeHtml(note)}</span>` : ''}</p>
      <ul class="tj-chips">${players.map(({ p, chance }) => `<li class="${p.you ? 'you' : ''}" style="--ink:${p.ink}"><svg viewBox="0 0 40 40" aria-hidden="true"><use href="#pawn-${p.colour}"/></svg>${escapeHtml(p.name)}<b>${percent(chance)}</b></li>`).join('')}</ul>`;
  };

  const moveCursor = (active: boolean) => {
    const cursor = chartEl.querySelector<SVGGElement>('.tj-cursor');
    if (!cursor) return;
    const sample = samples[index];
    cursor.setAttribute('visibility', active ? 'visible' : 'hidden');
    const x = g.x(sample.step);
    cursor.querySelector('line')!.setAttribute('x1', String(x));
    cursor.querySelector('line')!.setAttribute('x2', String(x));
    cursor.querySelectorAll('circle').forEach((circle) => {
      const player = Number(circle.dataset.player);
      const inRace = sample.race.points.some((point) => point.chances[player] > 0);
      circle.setAttribute('visibility', inRace ? 'inherit' : 'hidden');
      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(g.y(sample.chances[player])));
    });
    readout(active);
  };

  let lastWidth = 0;
  const draw = () => {
    lastWidth = chartEl.clientWidth;
    g = geometry(lastWidth || 600, races);
    chartEl.innerHTML = chartSvg(races, data, g, animate);
    animate = false;
    moveCursor(false);
  };

  const nearest = (step: number) => {
    let best = 0;
    samples.forEach((sample, i) => {
      if (Math.abs(sample.step - step) < Math.abs(samples[best].step - step)) best = i;
    });
    return best;
  };

  const onPointer = (event: PointerEvent) => {
    const svg = chartEl.querySelector('svg');
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    index = nearest(g.stepAt(((event.clientX - box.left) / box.width) * g.width));
    moveCursor(true);
  };
  const onLeave = () => {
    index = samples.length - 1;
    moveCursor(false);
  };
  const onKey = (event: KeyboardEvent) => {
    const jump = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowLeft') index = Math.max(0, index - jump);
    else if (event.key === 'ArrowRight') index = Math.min(samples.length - 1, index + jump);
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = samples.length - 1;
    else return;
    event.preventDefault();
    moveCursor(true);
  };

  chartEl.addEventListener('pointermove', onPointer);
  chartEl.addEventListener('pointerdown', onPointer);
  chartEl.addEventListener('pointerleave', onLeave);
  chartEl.addEventListener('keydown', onKey);
  chartEl.addEventListener('blur', onLeave);
  const resize = new ResizeObserver(() => {
    if (chartEl.clientWidth && chartEl.clientWidth !== lastWidth) draw();
  });
  resize.observe(chartEl);
  draw();

  return () => {
    resize.disconnect();
    chartEl.removeEventListener('pointermove', onPointer);
    chartEl.removeEventListener('pointerdown', onPointer);
    chartEl.removeEventListener('pointerleave', onLeave);
    chartEl.removeEventListener('keydown', onKey);
    chartEl.removeEventListener('blur', onLeave);
  };
}
