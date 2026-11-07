import movies from '../data/filmiPhuljhadi.json';
import { shuffle } from './logoLagaanLogos';
import { teamIcon } from './logoLagaanTeams';
import { renderTeamRace, setupTeamNames, teamColors } from './diwaliParty';

type Movie = (typeof movies)[number];
type Round = {
  movie: Movie;
  winner: number | null;
  award: number;
  hintUsed: boolean;
};
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const setup = el('setup'),
  game = el('round'),
  results = el('results');
const arena = game.closest<HTMLElement>('.logo-party')!;
const mode = el<HTMLSelectElement>('play-mode');
const getTeamNames = setupTeamNames();
let rounds: Round[] = [],
  teams: string[] = [],
  scores: number[] = [];
let index = 0,
  party = false,
  revealed = false,
  celebrationTimer = 0;
mode.addEventListener('change', () => {
  el('team-setup').hidden = mode.value !== 'party';
});
function renderScoreboard() {
  renderTeamRace(el('scoreboard'), teams, scores, rounds.length);
}
function selectWinner(team: number) {
  if (game.hidden) return;
  const round = rounds[index];
  if (revealed && round.winner !== null) scores[round.winner] -= round.award;
  round.winner = round.winner === team ? null : team;
  round.award = round.winner === null ? 0 : round.hintUsed ? 1 : 3;
  if (revealed && round.winner !== null) scores[round.winner] += round.award;
  renderTeamAnswers();
  if (revealed) {
    if (party) {
      renderScoreboard();
      announceScores();
    } else el('score').textContent = `${scores[0]} pts`;
  }
  if (party)
    el('team-answers')
      .children[team].querySelector<HTMLButtonElement>('button')!
      .focus();
}
function renderTeamAnswers() {
  const round = rounds[index];
  el('party-controls').dataset.revealed = String(revealed);
  const holder = el('team-answers');
  holder.replaceChildren();
  const solo = el<HTMLButtonElement>('solo-correct');
  solo.setAttribute('aria-pressed', String(round.winner === 0));
  solo.textContent =
    round.winner === 0
      ? `✓ Got it · ${round.award} pts`
      : `Got it · ${round.hintUsed ? 1 : 3} pts`;
  if (!party) return;
  teams.forEach((name, i) => {
    const selected = round.winner === i;
    const row = document.createElement('div');
    row.className = 'team-answer winner-choice';
    row.style.setProperty('--team-color', teamColors[i]);
    row.dataset.correct = String(selected);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'team-winner';
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute(
      'aria-label',
      `${name}: ${selected ? 'clear winner' : 'first correct answer'}`,
    );
    const title = document.createElement('strong');
    title.textContent = name;
    title.prepend(teamIcon(i));
    const badge = document.createElement('span');
    badge.className = 'answer-stake';
    badge.textContent = selected
      ? `+${round.award}`
      : revealed
        ? '0'
        : `${round.hintUsed ? 1 : 3} pts`;
    button.append(title, badge);
    button.addEventListener('click', () => selectWinner(i));
    row.append(button);
    holder.append(row);
  });
}
function announceScores() {
  el('score-announcement').textContent = teams
    .map((name, i) => `${name}: ${scores[i]} points`)
    .join('. ');
}
function celebrate() {
  clearTimeout(celebrationTimer);
  const holder = el('confetti');
  holder.replaceChildren();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let i = 0; i < 24; i++) {
    const piece = document.createElement('i');
    piece.style.cssText = `--x:${Math.random() * 100}%;--c:${['#d29835', '#bd3e56', '#71966c'][i % 3]};--delay:${Math.random() * 0.4}s`;
    holder.append(piece);
  }
  celebrationTimer = window.setTimeout(() => holder.replaceChildren(), 3200);
}
function renderRound() {
  revealed = false;
  clearTimeout(celebrationTimer);
  el('confetti').replaceChildren();
  const round = rounds[index];
  el('round-number').textContent =
    `${String(index + 1).padStart(2, '0')} / ${rounds.length}`;
  el('score').textContent = party ? '' : `${scores[0]} pts`;
  const progress = el('progress');
  progress.setAttribute('aria-valuemax', String(rounds.length));
  progress.setAttribute('aria-valuenow', String(index));
  progress.querySelector('i')!.style.width =
    `${(index / rounds.length) * 100}%`;
  el('movie-category').textContent =
    `${round.movie.industry} · ${round.movie.kind === 'Plot' ? 'the story' : 'the title'}`;
  el('emoji-clue').replaceChildren();
  round.movie.emojis.forEach((emoji, i) => {
    const span = document.createElement('span');
    span.textContent = emoji;
    span.style.setProperty('--i', String(i));
    el('emoji-clue').append(span);
  });
  el('emoji-clue').setAttribute('aria-label', round.movie.emojis.join(' '));
  const hint = el<HTMLButtonElement>('hint-toggle');
  hint.setAttribute('aria-expanded', 'false');
  hint.setAttribute('aria-pressed', 'false');
  el('movie-hint').hidden = true;
  el('movie-hint').textContent = `${round.movie.year} · ${round.movie.hint}`;
  el('movie-answer').hidden = true;
  el('feedback').replaceChildren();
  el('party-controls').hidden = !party;
  el('scoreboard').hidden = !party;
  el('solo-controls').hidden = party;
  el('score-announcement').textContent = '';
  renderTeamAnswers();
  if (party) renderScoreboard();
  el('reveal').hidden = false;
  el('next').hidden = true;
  el('next').textContent = index === rounds.length - 1 ? 'Results →' : 'Next →';
  el('question-title').focus({ preventScroll: true });
}
el<HTMLFormElement>('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  party = mode.value === 'party';
  teams = party ? getTeamNames() : ['You'];
  scores = teams.map(() => 0);
  index = 0;
  el('scoreboard').replaceChildren();
  rounds = shuffle(movies).map((movie) => ({
    movie,
    winner: null,
    award: 0,
    hintUsed: false,
  }));
  arena.classList.toggle('party-match', party);
  game.classList.toggle('party-round', party);
  setup.hidden = true;
  results.hidden = true;
  game.hidden = false;
  renderRound();
});
el('solo-correct').addEventListener('click', () => selectWinner(0));
el('hint-toggle').addEventListener('click', () => {
  if (game.hidden) return;
  const hint = el('movie-hint'),
    show = hint.hidden;
  hint.hidden = !show;
  el('hint-toggle').setAttribute('aria-expanded', String(show));
  el('hint-toggle').setAttribute('aria-pressed', String(show));
  if (show && !revealed) {
    rounds[index].hintUsed = true;
    renderTeamAnswers();
  }
});
el('reveal').addEventListener('click', () => {
  if (game.hidden || revealed) return;
  revealed = true;
  const round = rounds[index];
  if (round.winner !== null) scores[round.winner] += round.award;
  const title = el('answer-title');
  title.replaceChildren();
  round.movie.title.split(' ').forEach((word, i) => {
    if (i) title.append(document.createTextNode(' '));
    const span = document.createElement('span');
    span.textContent = word;
    span.style.setProperty('--word', String(i));
    title.append(span);
  });
  el('answer-meta').textContent =
    `${round.movie.industry} · ${round.movie.year}`;
  el('answer-explanation').textContent = round.movie.explanation;
  el('movie-answer').hidden = false;
  renderTeamAnswers();
  if (party) {
    renderScoreboard();
    announceScores();
  } else {
    el('score').textContent = `${scores[0]} pts`;
  }
  celebrate();
  el('reveal').hidden = true;
  el('next').hidden = false;
  el('next').focus({ preventScroll: true });
});
function finish() {
  game.hidden = true;
  results.hidden = false;
  arena.classList.remove('party-match');
  const best = Math.max(...scores),
    winners = teams.filter((_, i) => scores[i] === best);
  el('result-title').textContent = party
    ? best === 0
      ? 'The movies won.'
      : winners.length > 1
        ? 'A filmi tie.'
        : `${winners[0]} wins!`
    : 'That’s a wrap.';
  el('result-copy').textContent = party
    ? winners.length > 1 && best > 0
      ? winners.join(' & ')
      : ''
    : `${rounds.filter((r) => r.winner === 0).length}/${rounds.length} films`;
  el('final-scores').replaceChildren();
  teams.forEach((name, i) => {
    const card = document.createElement('div');
    card.className = 'final-score';
    if (party) card.append(teamIcon(i));
    const score = document.createElement('b');
    score.textContent = `${scores[i]} pts`;
    const label = document.createElement('span');
    label.textContent = party ? name : 'Your score';
    card.append(score, label);
    el('final-scores').append(card);
  });
  el('answer-review').replaceChildren();
  rounds.forEach((round) => {
    const row = document.createElement('div');
    row.className = 'review-row';
    const art = document.createElement('div');
    art.className = 'review-emoji';
    art.textContent = round.movie.emojis.join(' ');
    const text = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = `${round.movie.title} · ${round.movie.year}`;
    const detail = document.createElement('span');
    detail.textContent = round.movie.explanation;
    text.append(title, detail);
    row.append(art, text);
    el('answer-review').append(row);
  });
  el('result-title').focus({ preventScroll: true });
  celebrate();
}
el('next').addEventListener('click', () => {
  if (!revealed || game.hidden) return;
  index++;
  if (index === rounds.length) finish();
  else renderRound();
});
function backToSetup() {
  game.hidden = true;
  results.hidden = true;
  setup.hidden = false;
  arena.classList.remove('party-match');
  clearTimeout(celebrationTimer);
  el('confetti').replaceChildren();
  mode.focus({ preventScroll: true });
}
el('restart').addEventListener('click', () => {
  if (window.confirm('Start a new game?')) backToSetup();
});
el('play-again').addEventListener('click', backToSetup);
document.addEventListener('keydown', (event) => {
  if (
    game.hidden ||
    event.repeat ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.key !== 'Enter' ||
    event.target instanceof HTMLButtonElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  event.preventDefault();
  if (revealed) el('next').click();
  else el('reveal').click();
});
