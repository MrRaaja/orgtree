# View mod (fork)

Two canvas options on top of upstream Orgtree, renderer-only (no engine or
desktop-main change). Code: `apps/desktop/renderer/src/canvas/viewmod.tsx`,
hooked into `OrgCanvas.tsx`, `cards.tsx`, `projectcard.tsx`,
`canvaslayout.ts`, `moveghost.tsx`, `accounts.tsx` and `styles.css`.
Tests: `apps/desktop/renderer/tests/viewmod.test.tsx`.

## What it adds

- **Project colour and icon.** App settings → Display → *Color projects
  automatically* (on by default) gives every project its own colour and an icon
  matched to its name; agents inside a project get a thin stripe in that colour.
  Right-click a project → **Color & icon…** to pick a colour (palette or
  custom), a built-in icon, or upload any image (shrunk to 64 px). **Reset**
  returns to the automatic look.
- **Collapsible teams.** Right-click an agent or project → **Collapse team** /
  **Expand team**, **Collapse all teams below**, **Expand everything below**.
  A collapsed card shows `▸ N` (click to expand); an open team shows `▾` on
  hover. Right-click empty canvas → **Collapse teams to masters** /
  **Expand all teams**. Jumping to a hidden agent opens its branch.

Choices are stored in this machine's app localStorage, per organization
(`orgtree-collapsed-<org>`, `orgtree-project-look-<org>`).

## Install into an installed Orgtree

The installed engine serves the UI from `<install>\resources\ui`, so the mod is
installed by swapping that folder; reload the window afterwards.

```
node tools/viewmod-ui.mjs status
node tools/viewmod-ui.mjs apply      # builds, backs up the stock UI once, swaps
node tools/viewmod-ui.mjs restore    # puts the stock UI back
```

The branch must be based on the installed version's tag (`apply` checks).
An Orgtree update replaces the UI with the stock one: rebase this branch onto
the new `vX.Y.Z` tag, then `apply` again.
