// After `astro build`, write dist/sw.js: a Workbox service worker that saves
// the pages, scripts, styles and images on the device, so the site and all the
// games work offline once visited or installed. The CV and resume PDFs are left
// out; they load from the network as usual.
import { generateSW } from 'workbox-build';

const { count, size, warnings } = await generateSW({
  globDirectory: 'dist',
  globPatterns: ['**/*.{html,js,css,svg,png,webp,avif,jpg,txt,webmanifest}'],
  globIgnores: ['sw.js', 'workbox-*.js'],
  swDest: 'dist/sw.js',
  // Pages are served as /path/ -> /path/index.html.
  directoryIndex: 'index.html',
  // ?debug and similar switches shouldn't miss the saved copy.
  ignoreURLParametersMatching: [/.*/],
  // Wait for the page to ask before switching to a new version (see Base.astro).
  skipWaiting: false,
  clientsClaim: false,
  cleanupOutdatedCaches: true,
  sourcemap: false,
});

for (const w of warnings) console.warn(w);
console.log(`Service worker: ${count} files, ${(size / 1024).toFixed(0)} KB saved for offline use.`);
