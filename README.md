# prajwal-prathiksh.github.io

Source for my personal site, <https://prajwal-prathiksh.github.io>. It is built with [Astro](https://astro.build) as plain static HTML and CSS, with a little TypeScript for the games. GitHub Actions builds and deploys it to GitHub Pages.

## Local workflow

Needs Node 22.12 or newer.

```sh
npm install        # once, or after pulling dependency updates
npm run dev        # live-reloading preview at http://localhost:4321
```

Before pushing, check that the production build works and looks right:

```sh
npm run check      # type and template errors
npm run build      # writes the static site to dist/
npm run preview    # serves dist/ at http://localhost:4321
```

Push to `main` and the [Deploy workflow](.github/workflows/deploy.yml) builds and publishes the site in about a minute. Pull requests run the same build without deploying.

## Where things live

| What | Where |
| --- | --- |
| Bio, links, experience, publications | `src/data/site.ts`, `src/pages/index.astro` |
| CV and resume PDFs | `public/documents/` (replace the files, keep the names) |
| Photo | `src/assets/prajwal.jpg` (Astro makes resized AVIF/WebP copies) |
| Colors, fonts, spacing | `src/styles/global.css` |
| Games | `src/pages/play/`, listed in `src/data/games.ts` |

Links from the old Jekyll site (`/publications/`, `/resume/`, `/assets/pdf/*.pdf`) still resolve. See `redirects` in `astro.config.mjs` and `src/pages/assets/pdf/[file].ts`.

## Adding a game

1. Create `src/pages/play/<name>.astro`, using `tic-tac-toe.astro` as a template. Game logic goes in a `<script>` tag and runs only in the browser.
2. Add an entry to `src/data/games.ts`.
3. Save high scores with `loadScores` and `saveScores` from `src/scripts/scores.ts`.

Scores stay in the visitor's `localStorage` under keys prefixed `pp-games:`. They never leave the device, and the site uses no cookies, analytics, or third-party requests. `/play/` has a button that clears them.

A game built with another tool (plain JS, a canvas engine, WebAssembly) can also go in `public/play/<name>/` as static files. Astro copies that folder into the site unchanged.

GitHub Pages only serves static files. Anything that runs in the browser works. Server code, databases, and online leaderboards do not. The limits are 1 GB per site and 100 MB per file.

## Updates

Dependabot opens a monthly pull request for npm packages and one for GitHub Actions. If the build passes, merge it.

The old Jekyll source is preserved at the `archive/jekyll-src` tag.
