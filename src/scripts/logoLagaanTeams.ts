// Slot identities stay fixed when players rename their teams.
export const teamMascots = [
  {
    id: 'ladoo',
    name: 'Ladoo',
    art: '<circle cx="20" cy="22" r="13" fill="#efa832"/><path d="M9 26q11 13 23-1" fill="#dc8123"/><g fill="#bb6527"><circle cx="13" cy="18" r="1.2"/><circle cx="23" cy="15" r="1.3"/><circle cx="27" cy="24" r="1.2"/><circle cx="16" cy="28" r="1"/><circle cx="19" cy="21" r="1.1"/></g><path d="m17 11 3-3 3 3" fill="#739259"/>',
  },
  {
    id: 'jalebi',
    name: 'Jalebi',
    art: '<path d="M12 29c-11-10 1-24 14-18 13 6 8 23-4 22-12 0-15-14-5-17 10-4 15 10 6 11-6 1-8-5-3-6" fill="none" stroke="#c57226" stroke-width="6" stroke-linecap="round"/><path d="M12 28c-9-10 2-21 13-16 11 5 7 20-3 19-10 0-12-11-4-14 8-3 12 8 5 9" fill="none" stroke="#f3ac3e" stroke-width="3" stroke-linecap="round"/>',
  },
  {
    id: 'phuljhadi',
    name: 'Phuljhadi',
    art: '<path d="m9 36 12-19" stroke="#907668" stroke-width="3" stroke-linecap="round"/><g stroke="#e4a338" stroke-width="2" stroke-linecap="round"><path d="M23 3v5m13 9h-5M10 16H5m26-11-4 5M13 5l4 5m16 18-5-5M9 28l6-6"/></g><path d="m23 10 2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#c64a68"/><circle cx="23" cy="17" r="2" fill="#ffd878"/>',
  },
  {
    id: 'rangoli',
    name: 'Rangoli',
    art: '<g fill="#bd557a"><ellipse cx="20" cy="11" rx="5" ry="8"/><ellipse cx="20" cy="29" rx="5" ry="8"/><ellipse cx="11" cy="20" rx="8" ry="5"/><ellipse cx="29" cy="20" rx="8" ry="5"/></g><g fill="#e5a63b"><path d="m9 8 8 8-10 1zm23 1-8 8-1-10zM8 32l8-8 1 10zm24 0-8-8 10-1z"/></g><circle cx="20" cy="20" r="6" fill="#698b70"/><circle cx="20" cy="20" r="2.5" fill="#fff0c6"/>',
  },
  {
    id: 'diya',
    name: 'Diya',
    art: '<path d="M20 3c-2 7-7 9-5 15 1 5 8 5 10 0 2-5-3-9-5-15" fill="#f5b63e"/><path d="M20 12c-3 4-4 8 0 9 4-1 3-5 0-9" fill="#ffdf80"/><path d="M5 25h30c-1 9-7 12-15 12S6 34 5 25" fill="#b95d3c"/><ellipse cx="20" cy="25" rx="15" ry="3" fill="#e69b49"/><path d="m20 25 2-5" stroke="#5d3d36" stroke-width="1.5" stroke-linecap="round"/>',
  },
  {
    id: 'katli',
    name: 'Kaju Katli',
    art: '<path d="m3 22 16-16 18 12-16 17z" fill="#cebba0"/><path d="m3 18 16-16 18 12-16 17z" fill="#f0dfbb"/><path d="m6 18 13-13 14 9-13 13z" fill="#e5e5dd"/><path d="m10 16 9-8 3 2-9 8zm7 5 9-9 4 2-10 10z" fill="#fffdf2" opacity=".85"/>',
  },
] as const;

export function teamIcon(index: number): HTMLSpanElement {
  const mascot = teamMascots[index];
  const icon = document.createElement('span');
  icon.className = 'team-mascot';
  icon.dataset.mascot = mascot.id;
  icon.title = mascot.name;
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<svg viewBox="0 0 40 40" focusable="false">${mascot.art}</svg>`;
  return icon;
}
