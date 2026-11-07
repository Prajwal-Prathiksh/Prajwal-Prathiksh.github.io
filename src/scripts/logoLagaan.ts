import { renderTeamRace, teamColors, setupTeamNames } from './diwaliParty';
import { teamIcon } from './logoLagaanTeams';
import { logoArt, shuffle, type LogoArtwork } from './logoLagaanLogos';
import logos from '../data/logoLagaan.json';

type Logo = (typeof logos)[number];
type TeamAnswer = { choice: number | null; locked: boolean; stake: number };
type Round = {
  logo: Logo;
  options: LogoArtwork[];
  selected: number | null;
  answers: TeamAnswer[];
  hintUsed: boolean;
};
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const setup = el('setup');
const game = el('round');
const results = el('results');
const arena = game.closest<HTMLElement>('.logo-party')!;
const mode = el<HTMLSelectElement>('play-mode');
const reveal = el<HTMLButtonElement>('reveal');
const next = el<HTMLButtonElement>('next');
const zoom = el<HTMLDialogElement>('art-zoom');
const letters = ['A', 'B', 'C'];
const choices = letters.map((letter) =>
  el<HTMLButtonElement>(`choice-${letter.toLowerCase()}`),
);
let rounds: Round[] = [];
let index = 0;
let revealed = false;
let hintVisible = false;
let party = false;
let teams: string[] = [];
let scores: number[] = [];
let soloScore = 0;
let celebrationTimer = 0;

const getTeamNames = setupTeamNames();

mode.addEventListener('change', () => {
  el('team-setup').hidden = mode.value !== 'party';
});

function choose(n: number) {
  if (party || revealed || game.hidden || n < 0 || n >= choices.length) return;
  const selected = rounds[index].selected === n ? null : n;
  rounds[index].selected = selected;
  choices.forEach((button, i) => {
    button.setAttribute('aria-pressed', String(selected === i));
    button.querySelector('.choice-state')!.textContent =
      selected === i ? 'Selected' : '';
  });
  reveal.disabled = selected === null;
}
choices.forEach((button, i) =>
  button.addEventListener('click', () => choose(i)),
);

function renderArtwork() {
  const round = rounds[index];
  round.options.forEach((art, i) => {
    el(`logo-${letters[i].toLowerCase()}`).innerHTML = logoArt(
      art,
      hintVisible ? round.logo.hintRegions : [],
    );
  });
}

el('hint-toggle').addEventListener('click', () => {
  hintVisible = !hintVisible;
  if (party && !revealed && hintVisible) {
    rounds[index].hintUsed = true;
    renderTeamAnswers();
  }
  el('hint-toggle').setAttribute('aria-pressed', String(hintVisible));
  el('hint-status').textContent = hintVisible
    ? 'Compare the details inside the rings.'
    : '';
  renderArtwork();
});

function renderRound() {
  revealed = false;
  hintVisible = false;
  el('hint-toggle').setAttribute('aria-pressed', 'false');
  el('hint-status').textContent = '';
  el('revealed-brand').hidden = true;
  el('revealed-brand-name').textContent = '';
  clearTimeout(celebrationTimer);
  el('confetti').replaceChildren();
  const round = rounds[index];
  el('round-number').textContent =
    `${String(index + 1).padStart(2, '0')} / ${rounds.length}`;
  el('score').textContent = party ? '' : `${soloScore} correct`;
  const progress = el('progress');
  progress.setAttribute('aria-valuemax', String(rounds.length));
  progress.setAttribute('aria-valuenow', String(index));
  progress.querySelector('i')!.style.width =
    `${(index / rounds.length) * 100}%`;
  // A spelling question must not have its answer written in the heading.
  el('brand-name').textContent = round.logo.prompt;
  choices.forEach((button, i) => {
    button.disabled = party;
    button.setAttribute('aria-pressed', 'false');
    delete button.dataset.result;
    button.setAttribute('aria-label', `Option ${letters[i]}`);
    button.querySelector('.choice-state')!.textContent = '';
    button.querySelector('.result-stamp')!.textContent = '';
    el(`logo-${letters[i].toLowerCase()}`).innerHTML = logoArt(
      round.options[i],
    );
  });
  el('feedback').replaceChildren();
  el('reveal-detail').hidden = true;
  el<HTMLDetailsElement>('reveal-detail').open = false;
  el('party-controls').hidden = !party;
  el('scoreboard').hidden = !party;
  el('score-announcement').textContent = '';
  if (party) {
    renderTeamAnswers();
    renderScoreboard();
  }
  reveal.hidden = false;
  reveal.disabled = true;
  next.hidden = true;
  next.textContent = index === rounds.length - 1 ? 'Results →' : 'Next →';
  el('brand-name').focus({ preventScroll: true });
  // Warm only the following round's three images.
  rounds[index + 1]?.options.forEach((art) => {
    const img = new Image();
    img.src = art.asset;
  });
}

el<HTMLFormElement>('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  party = mode.value === 'party';
  game.classList.toggle('party-round', party);
  arena.classList.toggle('party-match', party);
  teams = party ? getTeamNames() : [];
  scores = teams.map(() => 0);
  el('scoreboard').replaceChildren();
  soloScore = 0;
  index = 0;
  rounds = shuffle(logos).map((logo) => ({
    logo,
    options: shuffle(logo.options),
    selected: null,
    answers: teams.map(() => ({ choice: null, locked: false, stake: 0 })),
    hintUsed: false,
  }));
  setup.hidden = true;
  results.hidden = true;
  game.hidden = false;
  renderRound();
});

function celebrate() {
  clearTimeout(celebrationTimer);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const holder = el('confetti');
  holder.replaceChildren();
  for (let i = 0; i < 30; i++) {
    const piece = document.createElement('i');
    piece.style.cssText = `--x:${Math.random() * 100}%;--c:${['#d29835', '#bd3e56', '#71966c', '#f1b6bd'][i % 4]};--delay:${Math.random() * 0.4}s`;
    holder.append(piece);
  }
  celebrationTimer = window.setTimeout(() => holder.replaceChildren(), 3200);
}

function renderScoreboard() {
  renderTeamRace(el('scoreboard'), teams, scores, rounds.length);
}

function renderTeamAnswers() {
  el('party-controls').dataset.revealed = String(revealed);
  const round = rounds[index];
  const holder = el('team-answers');
  holder.replaceChildren();
  const locked = round.answers.filter((a) => a.locked).length;
  el('team-lock-status').textContent = revealed
    ? ''
    : `${locked}/${teams.length}`;
  reveal.disabled = !round.answers.every((a) => a.locked);
  teams.forEach((name, i) => {
    const answer = round.answers[i];
    const row = document.createElement('div');
    row.className = 'team-answer';
    row.style.setProperty('--team-color', teamColors[i]);
    row.dataset.locked = String(answer.locked);
    const heading = document.createElement('div');
    heading.className = 'team-answer-heading';
    const title = document.createElement('strong');
    title.textContent = name;
    title.prepend(teamIcon(i));
    const badge = document.createElement('span');
    badge.className = 'answer-stake';
    const earned =
      answer.choice !== null && round.options[answer.choice].correct
        ? answer.stake
        : 0;
    badge.textContent = revealed
      ? `${answer.choice === null ? '' : letters[answer.choice] + ' · '}+${earned}`
      : `${answer.locked ? answer.stake : round.hintUsed ? 1 : 3} pts`;
    if (revealed) row.dataset.earned = String(earned > 0);
    heading.append(title, badge);
    const picks = document.createElement('div');
    picks.className = 'team-picks';
    picks.setAttribute('role', 'group');
    picks.setAttribute('aria-label', `${name}'s answer`);
    letters.forEach((letter, n) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = letter;
      button.setAttribute('aria-label', `${name}: option ${letter}`);
      button.setAttribute('aria-pressed', String(answer.choice === n));
      button.disabled = revealed;
      button.addEventListener('click', () => {
        if (revealed) return;
        answer.choice = answer.choice === n ? null : n;
        answer.locked = answer.choice !== null;
        answer.stake = answer.locked ? (round.hintUsed ? 1 : 3) : 0;
        renderTeamAnswers();
        el('team-answers')
          .children[i].querySelectorAll<HTMLButtonElement>('.team-picks button')
          [n].focus();
      });
      picks.append(button);
    });
    row.append(heading, picks);
    holder.append(row);
  });
}
reveal.addEventListener('click', () => {
  if (
    game.hidden ||
    revealed ||
    (party
      ? !rounds[index].answers.every((a) => a.locked)
      : rounds[index].selected === null)
  )
    return;
  revealed = true;
  const round = rounds[index];
  const correctIndex = round.options.findIndex((art) => art.correct);
  const correct = round.selected === correctIndex;
  if (!party && correct) soloScore++;
  choices.forEach((button, i) => {
    button.disabled = true;
    const original = round.options[i].correct;
    button.dataset.result = original ? 'correct' : 'incorrect';
    button.querySelector('.choice-state')!.textContent = original
      ? 'Original'
      : 'Altered';
    button.querySelector('.result-stamp')!.textContent = original ? '✓' : '×';
  });
  el('revealed-brand-name').textContent = round.logo.name;
  el('revealed-brand').hidden = false;
  const title = document.createElement('strong');
  title.textContent = party
    ? `${letters[correctIndex]} is correct`
    : correct
      ? 'Nailed it!'
      : `It's ${letters[correctIndex]}!`;
  el('feedback').replaceChildren(title);
  el('difference').textContent = round.options
    .map((art, i) => `${letters[i]}: ${art.detail}`)
    .join(' ');
  const source = el<HTMLAnchorElement>('round-source');
  source.href = round.logo.source;
  source.textContent = round.logo.generated
    ? 'Reference · recreated quiz artwork'
    : 'Reference artwork';
  el('reveal-detail').hidden = false;
  el('score').textContent = party ? '' : `${soloScore} correct`;
  if (party) {
    const gained = round.answers.map((answer) =>
      answer.choice === correctIndex ? answer.stake : 0,
    );
    gained.forEach((points, i) => {
      scores[i] += points;
    });
    renderTeamAnswers();
    renderScoreboard();
    el('score-announcement').textContent = teams
      .map((name, i) => `${name}: +${gained[i]}, total ${scores[i]}`)
      .join('. ');
  }
  if (party || correct) celebrate();
  reveal.hidden = true;
  next.hidden = false;
  next.focus({ preventScroll: true });
});

function finish() {
  arena.classList.remove('party-match');
  game.hidden = true;
  results.hidden = false;
  const best = Math.max(0, ...scores);
  const winners = teams.filter((_, i) => scores[i] === best);
  el('result-title').textContent = party
    ? best === 0
      ? 'The logos won.'
      : winners.length > 1
        ? 'A sweet tie.'
        : `${winners[0]} wins!`
    : soloScore >= rounds.length * 0.8
      ? 'Sharp eyes.'
      : soloScore >= rounds.length * 0.5
        ? 'Nicely spotted.'
        : 'Sneaky, right?';
  el('result-copy').textContent =
    party && best > 0 && winners.length > 1 ? winners.join(' & ') : '';
  const final = el('final-scores');
  final.replaceChildren();
  (party ? teams : ['Correct']).forEach((name, i) => {
    const card = document.createElement('div');
    card.className = 'final-score';
    const value = document.createElement('b');
    value.textContent = party
      ? `${scores[i]} pts`
      : `${soloScore}/${rounds.length}`;
    const label = document.createElement('span');
    label.textContent = name;
    if (party) card.append(teamIcon(i));
    card.append(value, label);
    final.append(card);
  });
  const review = el('answer-review');
  review.replaceChildren();
  rounds.forEach((round) => {
    const row = document.createElement('div');
    row.className = 'review-row';
    const art = document.createElement('div');
    art.className = 'review-art';
    art.innerHTML = logoArt(round.options.find((a) => a.correct)!);
    const text = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = `${round.logo.name}${party ? '' : round.options[round.selected!]?.correct ? ' · Correct' : ' · Missed'}`;
    const detail = document.createElement('span');
    detail.textContent = round.options.find((a) => a.correct)!.detail;
    text.append(title, detail);
    row.append(art, text);
    review.append(row);
  });
  el('result-title').focus({ preventScroll: true });
  celebrate();
}
next.addEventListener('click', () => {
  if (!revealed || game.hidden) return;
  index++;
  if (index === rounds.length) finish();
  else renderRound();
});
function backToSetup() {
  arena.classList.remove('party-match');
  game.hidden = true;
  results.hidden = true;
  setup.hidden = false;
  clearTimeout(celebrationTimer);
  el('confetti').replaceChildren();
  mode.focus({ preventScroll: true });
}
el('restart').addEventListener('click', () => {
  if (window.confirm('End this game and start a new one?')) backToSetup();
});
el('play-again').addEventListener('click', backToSetup);

el('zoom-open').addEventListener('click', () => {
  const holder = el('zoom-options');
  holder.replaceChildren();
  el('zoom-title').textContent = revealed
    ? rounds[index].logo.name
    : rounds[index].logo.prompt;
  rounds[index].options.forEach((art, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zoom-choice';
    button.setAttribute('aria-label', `Choose ${letters[i]}`);
    const label = document.createElement('b');
    label.textContent =
      letters[i] +
      (revealed ? (art.correct ? ' · Original' : ' · Altered') : '');
    const picture = document.createElement('span');
    picture.innerHTML = logoArt(
      art,
      hintVisible ? rounds[index].logo.hintRegions : [],
    );
    button.append(label, picture);
    button.addEventListener('click', () => {
      if (!revealed) {
        choose(i);
        zoom.close();
      }
    });
    holder.append(button);
  });
  zoom.showModal();
});
el('zoom-close').addEventListener('click', () => zoom.close());
zoom.addEventListener('click', (event) => {
  if (event.target === zoom) zoom.close();
});

document.addEventListener('keydown', (event) => {
  if (
    game.hidden ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.repeat
  )
    return;
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  const letter = event.key.toUpperCase();
  if (!revealed && letters.includes(letter)) {
    event.preventDefault();
    choose(letters.indexOf(letter));
    if (zoom.open) zoom.close();
  } else if (
    !zoom.open &&
    event.key === 'Enter' &&
    (!(event.target instanceof HTMLButtonElement) ||
      choices.includes(event.target))
  ) {
    event.preventDefault();
    if (revealed) next.click();
    else if (!reveal.disabled) reveal.click();
  }
});
