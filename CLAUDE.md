# Waypoint

VEX V5 autonomous simulator (LemLib motions, path editor, chassis / aligner models). Static web app: `index.html`,
`js/`, `css/`. Runs locally with `start.bat` / `serve.py`, and under Rack via `rack.json`.

## Branches
- **All work goes on `beta`.** Base your work on the latest `origin/beta` and push to `beta`, even if this session
  was started on another branch (for example a `claude/...` branch).
- **Only push or merge to `main` when the owner explicitly says so.**
- Don't open pull requests unless asked.

## Before you push
- `node tests/engine.test.js` and `node tests/editor.test.js` must pass.
- After editing `CHANGELOG.md`, run `node tools/make-changelog.js` to refresh the in-app copy (`js/changelog.js`);
  the engine test fails if it is out of date. Add a changelog entry for user-facing changes.

## Design
- Rack Suite design system: every colour, radius, space and font comes from `css/tokens.css`. No raw colours
  elsewhere. Accent is violet; status colours are shared across the suite and never change with the accent.
- App icon: Rack Suite VEX "field grid" family (3x3 tiles on a dark tile; Waypoint's mark is a violet route).
  `assets/icon/icon.svg` is the source; the PNGs and `favicon.ico` are rendered from it at each exact size.
- Wordmark: inline SVG in `index.html` (header and splash), Rack Suite VEX lettering with a waypoint node for the O,
  styled in `css/brand.css`. `assets/waypoint-logo.webp` (README banner, link preview) is a render of the splash art.
- The drawn field was removed on purpose: only the match and skills field photos exist. Don't bring it back.
