// Zen mode: the game area covers the whole screen. Where the browser allows
// it (desktop, Android, iPad) it also goes truly full screen. iPhone Safari
// only allows that for video, so there the CSS overlay does the job alone.

export function setupZen(): void {
  const area = document.querySelector<HTMLElement>('[data-zen]');
  if (!area) return;
  // A page may show the toggle in more than one place (e.g. setup and match bar).
  const opens = [...area.querySelectorAll<HTMLButtonElement>('[data-zen-open]')];
  const exits = [...area.querySelectorAll<HTMLButtonElement>('[data-zen-exit]')];
  const visible = (els: HTMLElement[]) => els.find((el) => el.getClientRects().length > 0);

  const on = () => area.classList.contains('zen-on');

  const leave = () => {
    if (!on()) return;
    area.classList.remove('zen-on');
    document.documentElement.classList.remove('zen');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    visible(opens)?.focus();
  };

  const enter = async () => {
    area.classList.add('zen-on');
    document.documentElement.classList.add('zen');
    visible(exits)?.focus();
    try {
      await area.requestFullscreen?.({ navigationUI: 'hide' });
    } catch {
      // Not allowed here; the overlay alone still works.
    }
  };

  opens.forEach((el) => el.addEventListener('click', enter));
  exits.forEach((el) => el.addEventListener('click', leave));
  // Esc in native full screen only fires this event, so keep the two in step.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) leave();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') leave();
  });
}
