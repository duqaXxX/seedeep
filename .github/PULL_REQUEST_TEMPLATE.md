<!-- Describe what changed and WHY. The why is the part a reviewer cannot reconstruct. -->

## What

## Why

## Checks

- [ ] `bun run test` and `bun run typecheck` pass (plus `bun run test:tray` if this touches `apps/tray/`, which CI does not run).
- [ ] Client code changed? `bun run build:client` was run and `apps/server/public/lib/app.js` is committed with it.
- [ ] Docs under `docs/` are updated in this same change, and a structural change has a dated entry at the top of `docs/CHANGELOG.md`.
- [ ] Nothing here comes from a real session. Fixtures, screenshots and GIFs are from a synthetic session (fake project, fake paths) and no real home path, personal address, private URL or internal identifier appears anywhere in the diff.

<!-- The last box is the one that cannot be undone: this repo is public, and anything committed
     once stays in its history. CI scans the added lines for the obvious shapes, but it only
     catches what it can recognise; the reading is yours. -->
