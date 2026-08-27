# Amis Electron Tailwind Figma Contract Checklist

Use this ledger before editing and update it with verification evidence.

## Design Ledger

| Area | Figma node and fact | Renderer surface | Token or asset | State | Verification |
| --- | --- | --- | --- | --- | --- |
| Root | node, target frame/content size, crop | window/layout shell | background token | light/dark | screenshot at recorded content size |
| Container | width, height, radius, border | named component | theme token | default/focus | screenshot and box model |
| Text | family, size, weight, line behavior | element/`textarea` | text token | placeholder/content | fixture screenshot |
| Icon | node, asset, size | `svg`/`button` | icon token | default/hover/disabled | keyboard action and screenshot |
| Interaction | trigger and terminal state | state owner intent | n/a | hover/focus/Escape/etc. | unit test and manual run |
| Exception | product UI retained | owning component | existing token | all relevant states | visibility and behavior |

## Figma Extraction

- [ ] Exact URL, file key, node ID, state, mode, and target window size recorded.
- [ ] Figma frame/content dimensions are distinguished from the outer Electron window dimensions.
- [ ] `get_design_context` read with TypeScript/Tailwind client metadata.
- [ ] Concrete frame found through `get_metadata` when the URL points at a page.
- [ ] `get_variable_defs` read for the concrete target.
- [ ] Screenshot inspected in addition to generated structural code.
- [ ] Parent and child dimensions, padding, spacing, alignment, and constraints recorded.
- [ ] Typography, icons, effects, opacity, radius, borders, and shadows recorded.
- [ ] Default, hover, focus, pressed, disabled, loading, and feature-specific states mapped.
- [ ] Product exceptions listed explicitly.

## Renderer Review

- [ ] Existing view module, state owner, shared types, theme tokens, assets, and tests inspected.
- [ ] View renders from state and forwards user intents only; no direct `ipcRenderer` or Node API.
- [ ] No shallow wrapper was added solely to mirror a Figma frame name.
- [ ] Fixed chrome uses stable pixel geometry; flexible content has responsive constraints.
- [ ] Text wrapping, truncation, baseline, and longest localized English fixture fit.
- [ ] Colors and spacing come from the central Tailwind theme layer.
- [ ] Arbitrary values are documented node exceptions rather than duplicated globals.
- [ ] Icons are inline SVG or local assets with a `build:assets` copy step; no remote URLs.
- [ ] Semantic elements used; hover, `focus-visible`, disabled, Escape, pointer target, `title`, and `aria-label` behavior covered.
- [ ] Stable `data-testid` values exist for automated interactions.
- [ ] Light and dark handled through the `dark:` variant from one root switch.

## Verification Route

```bash
npm run typecheck
npm test
npm run evidence -- --width <figma-width> --height <figma-height> --output <artifact-directory>
```

Set the outer Electron window and renderer viewport to the recorded target
dimensions and appearance, compare against the Figma screenshot, and read the
retained `renderer.png` and `renderer-evidence.json` for the geometry in the
ledger. Check the renderer console during `npm run dev` for CSP violations,
missing assets, and IPC errors. This repository has no retained screenshot-diff
harness, so a screenshot is diagnostic evidence, not an automatic pixel-golden
assertion.

## Evidence Review

- [ ] `typecheck` and `test` exit status and complete referenced logs inspected.
- [ ] Outer window and renderer viewport opened at the expected dimensions and appearance.
- [ ] `renderer.png` and `renderer-evidence.json` retained for the inspected state.
- [ ] `manifest.json` records a passed evidence run and artifact paths.
- [ ] Failed evidence runs retain `manifest.json` and `error.txt` diagnostics.
- [ ] Evidence records stable semantic element bounds and accessibility names.
- [ ] Evidence records the PNG's native pixel dimensions separately from CSS viewport dimensions.
- [ ] Renderer console clean of CSP, asset, and IPC errors.
- [ ] Box-model values checked against the ledger for the disputed nodes.
- [ ] Initial and transition states both checked.
- [ ] No coordinate clicks or translated-copy selectors were introduced.
- [ ] Remaining differences are listed with their Figma fact and rationale.
