import { teamIcon } from './logoLagaanTeams';
export const teamColors = [
  '#b94b65',
  '#bc8229',
  '#5d8861',
  '#776097',
  '#39878a',
  '#ba643e',
];
export function renderTeamRace(
  holder: HTMLElement,
  teams: readonly string[],
  scores: readonly number[],
  roundCount: number,
) {
  const maximum = roundCount * 3;
  if (!holder.childElementCount) {
    const race = document.createElement('div');
    race.className = 'score-race';
    teams.forEach((name, i) => {
      const lane = document.createElement('div');
      lane.className = 'race-lane';
      lane.style.setProperty('--team-color', teamColors[i]);
      const label = document.createElement('span');
      label.className = 'race-name';
      label.textContent = name;
      label.title = name;
      const rail = document.createElement('div');
      rail.className = 'race-rail';
      const runner = document.createElement('div');
      runner.className = 'race-runner';
      runner.style.left = '0%';
      const mascot = teamIcon(i);
      mascot.classList.add('race-mascot');
      const score = document.createElement('strong');
      score.className = 'race-score';
      score.textContent = '0';
      runner.append(mascot, score);
      rail.append(runner);
      lane.append(label, rail);
      race.append(lane);
    });
    const scale = document.createElement('div');
    scale.className = 'race-scale';
    scale.setAttribute('aria-hidden', 'true');
    scale.innerHTML = `<span>0</span><span>${maximum / 2}</span><span>${maximum} ✧</span>`;
    holder.append(race, scale);
  }
  const best = Math.max(0, ...scores);
  teams.forEach((name, i) => {
    const lane = holder.querySelectorAll<HTMLElement>('.race-lane')[i];
    const runner = lane.querySelector<HTMLElement>('.race-runner')!;
    const score = lane.querySelector<HTMLElement>('.race-score')!;
    const previous = Number(score.textContent);
    lane.setAttribute(
      'aria-label',
      `${name}: ${scores[i]} points out of ${maximum}`,
    );
    lane.dataset.leading = String(best > 0 && scores[i] === best);
    runner.dataset.moving = String(scores[i] > previous);
    runner.style.left = `${(scores[i] / maximum) * 100}%`;
    score.textContent = String(scores[i]);
  });
}

export function setupTeamNames(): () => string[] {
  const teamDefaults = [
    'Team Ladoo',
    'Team Jalebi',
    'Team Phuljhadi',
    'Team Rangoli',
    'Team Diya',
    'Team Kaju Katli',
  ];
  const teamDrafts = teamDefaults.map(() => '');
  const teamCount = document.getElementById('team-count') as HTMLSelectElement;
  function renderTeamNames() {
    const holder = document.getElementById('team-name-fields')!;
    holder.replaceChildren();
    for (let i = 0; i < Number(teamCount.value); i++) {
      const label = document.createElement('label');
      label.className = 'team-name-pill';
      const number = document.createElement('span');
      number.append(teamIcon(i));
      number.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 24;
      input.setAttribute('aria-label', `Team ${i + 1} name`);
      input.placeholder = teamDefaults[i];
      input.value = teamDrafts[i];
      input.addEventListener('input', () => {
        teamDrafts[i] = input.value;
      });
      label.append(number, input);
      holder.append(label);
    }
  }
  teamCount.addEventListener('change', renderTeamNames);
  renderTeamNames();

  return () =>
    teamDrafts
      .slice(0, Number(teamCount.value))
      .map((name, i) => name.trim() || teamDefaults[i]);
}
