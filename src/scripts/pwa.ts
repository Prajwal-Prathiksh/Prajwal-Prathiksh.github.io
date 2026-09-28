// Registers the service worker (dist/sw.js, built by scripts/build-sw.mjs) so
// the site works offline. When a new version has downloaded, a small notice
// offers to switch to it; otherwise it takes over on the next visit.

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  const notice = document.getElementById('update-notice');
  const reload = document.getElementById('update-reload');
  let refreshing = false;

  const offer = (worker: ServiceWorker) => {
    if (!notice || !reload) return;
    notice.hidden = false;
    reload.onclick = () => worker.postMessage({ type: 'SKIP_WAITING' });
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        incoming?.addEventListener('statechange', () => {
          // Only an update, not the first install, needs a notice.
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) offer(incoming);
        });
      });
    } catch {
      // Offline support is a bonus; the site works without it.
    }
  });
}
