type Theme = 'auto' | 'light' | 'dark';
const STORAGE_KEY = 'site-theme';
const asTheme = (value: string | null): Theme => value === 'light' || value === 'dark' ? value : 'auto';

export function setupTheme(): void {
  const root = document.documentElement;
  const control = document.querySelector<HTMLDetailsElement>('#theme-control');
  const trigger = control?.querySelector<HTMLElement>('summary');
  const label = document.querySelector<HTMLElement>('#theme-label');
  const options = [...document.querySelectorAll<HTMLButtonElement>('[data-theme-option]')];
  const colour = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference: Theme = asTheme(root.getAttribute('data-theme'));

  const apply = (theme: Theme) => {
    preference = theme;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.dataset.theme = theme;
    if (label) label.textContent = theme === 'auto' ? 'Automatic' : theme === 'light' ? 'Light' : 'Dark';
    options.forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.themeOption === theme)));
    const dark = theme === 'dark' || (theme === 'auto' && system.matches);
    if (colour) colour.content = dark ? '#121417' : '#fbfaf8';
  };

  apply(preference);
  options.forEach((option) => {
    option.addEventListener('click', () => {
      const theme = asTheme(option.dataset.themeOption ?? null);
      apply(theme);
      if (control) control.open = false;
      trigger?.focus();
      try {
        if (theme === 'auto') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // Theme switching still works when browser storage is unavailable.
      }
    });
  });
  control?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && control.open) {
      control.open = false;
      trigger?.focus();
      event.stopPropagation();
    }
  });
  control?.addEventListener('focusout', (event) => {
    if (!control.contains(event.relatedTarget as Node | null)) control.open = false;
  });
  document.addEventListener('pointerdown', (event) => {
    if (control && !control.contains(event.target as Node)) control.open = false;
  });
  system.addEventListener('change', () => apply(preference));
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) apply(asTheme(event.newValue));
  });
}
