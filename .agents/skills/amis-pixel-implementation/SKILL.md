---
name: amis-pixel-implementation
description: Implement or fix Amis Electron renderer interfaces from Figma with measured visual and interaction fidelity using TypeScript and Tailwind. Use when a Figma node must be reproduced in the Tokiie renderer, when DOM geometry, typography, icons, design tokens, hover, focus, disabled, accessibility, loading, or error states must match, or when evidence is needed to verify a visual change.
---

# Amis Pixel Implementation

Turn a Figma node into measured Amis renderer behavior. Treat generated code as
structural reference only; the Figma screenshot, node properties, variable
bindings, product behavior, and repository conventions are the contract.

## Stack Facts

- The renderer is an Electron `BrowserWindow` loading `src/renderer/index.html`
  (`titleBarStyle: 'hiddenInset'` on macOS, `contextIsolation: true`). The
  `1200x800` constructor default is only a fallback; never use it as the Figma
  target unless the inspected Figma frame is actually that size. macOS paints
  the traffic lights itself; reserve their space rather than drawing the ones
  Figma mocks.
- Views are React function components under `src/renderer/components`, bundled
  by esbuild into one local `renderer.js`. There is no dev server or HMR:
  `npm run build` then relaunch.
- Renderer evidence is captured through the bounded `npm run evidence` mode;
  it writes a PNG plus JSON containing outer window bounds, content bounds,
  viewport metrics, and stable semantic element geometry, plus a passed
  `manifest.json`, before exiting. Failed setup/capture writes a failed
  manifest and `error.txt` before exiting nonzero.
  `--width` and `--height` are required and describe the Figma renderer/content
  frame, not the OS title-bar-inclusive bounds.
- The renderer reaches the main process only through `window.tokiie`
  (`src/main/preload.ts`, typed in `src/shared/types.ts`). Never add a direct
  `ipcRenderer` call or Node API in view code.
- `index.html` sets a strict CSP (`script-src 'self'; style-src 'self'`).
  Tailwind must be compiled to a local stylesheet that ships in `dist/renderer`;
  a CDN build, an inline `<style>`, or an inline `style=` attribute will be
  blocked at runtime.
- New renderer assets need a matching copy step in the `build:assets` script in
  `package.json`, or they will not exist in `dist`. Keep that step idempotent —
  a bare `cp -R` into an existing directory nests a stale copy inside itself.

## Required Sources

- Use the official Figma read tools. Pass `clientLanguages: "typescript"` and
  `clientFrameworks: "react,tailwind"` to `get_design_context`.
- Resolve every color, spacing, radius, and font decision through the central
  Tailwind theme layer (`@theme` tokens / `tailwind.config`). If that layer does
  not exist yet, create it once and populate it from `get_variable_defs`; do not
  scatter raw hex values across markup.
- Verify with the repository scripts: `npm run typecheck`, `npm test`, and
  `npm run evidence -- --width <figma-width> --height <figma-height> --output
  <artifact-directory>`. Use `npm run dev` only for interactive inspection.

## 1. Freeze Scope

- Record the exact Figma URL, file key, node ID, visual state, and target window
  size. Record whether that size describes the Figma frame/content viewport or
  the outer OS window; do not silently substitute the app's constructor
  default.
- Record the renderer view module and its state owner in scope.
- List product exceptions that must remain even when absent from the crop.
- List required states such as default, hover, focus, pressed, disabled,
  loading, empty, error, light, or dark.
- Do not widen a visual task into unrelated architecture or product changes.

## 2. Build A Figma Ledger

Call `get_design_context` first. If the node is a page/canvas and codegen fails,
use `get_metadata` to find the concrete frame, then retry. Call
`get_variable_defs` on the concrete target.

Record before editing:

- parent and child dimensions, alignment, padding, spacing, and responsive rules;
- semantic variables, raw-value exceptions, opacity, border, radius, blur,
  backdrop filter, blend mode, and shadow;
- font family, size, weight, line height, letter spacing, truncation, and
  alignment;
- icon node, asset source, size, stroke/fill behavior, tint, and hit target;
- state-specific differences and transition behavior;
- accessibility name, title/tooltip text, keyboard behavior, and stable
  identifier;
- preserved product exceptions.

Use [references/figma-contract-checklist.md](references/figma-contract-checklist.md)
as the ledger and evidence format.

## 3. Inspect The Existing Renderer

- Find the current view module, its state owner, shared types, theme tokens,
  icon sources, and relevant tests before editing.
- Reuse existing components and utilities. Do not create one shallow wrapper per
  Figma frame.
- Keep rendering and user-intent forwarding separate from state and business
  rules; business rules that touch the filesystem, gateway, or config belong in
  the main process behind `window.tokiie`.
- Open the current app at the same window size and state as Figma. Classify
  mismatches by structure, geometry, tokens, typography, assets, effects,
  interaction, and preserved exceptions.
- Set the Electron window to the recorded target before comparing. Measure both
  `BrowserWindow.getBounds()` and the renderer viewport because title-bar and
  traffic-light insets make outer and content dimensions differ.

## 4. Implement With Tailwind

### Layout

- Express the design hierarchy with flex/grid utilities, `gap-*`, `p-*`, `w-*`,
  `min-*`, `max-*`, and explicit alignment. Let the DOM's normal flow carry the
  layout.
- Use exact pixel values (arbitrary values such as `h-[38px]`) for fixed desktop
  chrome and fixed-format controls when Figma defines them. Keep flexible
  content responsive with max widths, `flex-1`, `min-w-0`, and truncation.
- Reserve `absolute`, `translate-*`, and negative margins for genuinely anchored
  decoration or effects. Do not use them to repair normal content flow.
- Keep the hit target and the visual frame distinct when the design requires a
  small glyph inside a larger interactive control (padding on the control,
  fixed size on the glyph).

### Tokens And Effects

- Map Figma bindings to named theme tokens, then use the generated utilities.
  A one-off arbitrary value is acceptable only as a documented node exception.
- Preserve opacity, shadow, blur, and backdrop-filter as explicit node facts;
  do not fold them into a new global color without evidence.
- Implement light/dark through the `dark:` variant driven by one root class or
  attribute, not by duplicating component trees.
- Electron-specific window chrome (vibrancy, traffic-light insets, drag regions
  via `-webkit-app-region`) belongs in one shared layout shell, not repeated per
  view.

### Typography

- Match Figma's family, pixel size, weight, and line behavior. Prefer the system
  UI stack for native macOS chrome, declared once as a theme token.
- Do not copy Figma's line-height and letter-spacing mechanically. Verify the
  rendered baseline, wrapping, truncation, and box height in the running app.
- Ship a non-system font only when the project bundles it locally and the design
  requires it; the CSP blocks remote font hosts. Otherwise surface the missing
  dependency instead of silently substituting.

### Icons And Assets

- Use an existing repository icon when it represents the design; otherwise
  export the Figma node. Never infer an icon from a codepoint.
- Prefer inline SVG or a local file under `src/renderer/assets`, with the copy
  step wired into `build:assets`. Remote icon URLs are blocked by the CSP.
- Verify size, stroke width, fill rule, `currentColor` tinting, and
  active/inactive state.
- Inspect an exported asset's real dimensions and content so an active
  indicator, unrelated canvas, or extra whitespace is not shipped accidentally.
- Do not use an emoji or a text glyph as a silent substitute for a required icon.

### Desktop Interaction And Accessibility

- Implement the Figma-specified hover, focus, active, disabled, keyboard, and
  Escape behavior. Use `focus-visible` for keyboard focus rings; do not remove a
  focus indicator without replacing it.
- Use real semantic elements (`button`, `input`, `nav`, `dialog`) so keyboard and
  screen-reader behavior comes for free. A clickable `div` needs a role, a
  tabindex, and key handlers — prefer the element.
- Add a `title` for unfamiliar icon controls and English `aria-label` text for
  P0 user-facing UI.
- Use stable `data-testid` values for automation. Do not make tests depend on
  screen coordinates or translated visible copy.
- Ensure dynamic content, labels, progress, and state icons cannot resize or
  overlap fixed controls.
- Disable text selection and the default context menu only where the design
  calls for app-like chrome, never across the whole renderer by reflex.

## 5. Verify From The Highest Interface

- Test state and intent handling through the module's public surface; do not
  test private render helpers.
- Test centralized formatters, layout metrics, and state mappings when they are
  stable public behavior. Avoid brittle assertions against generated markup.
- Run `npm run typecheck` (main and renderer projects) and `npm test`
  (`node --test test/*.test.mjs`), then capture the narrowest relevant workflow
  with `npm run evidence -- --width <figma-width> --height <figma-height> --output
  <artifact-directory>`. Launch `npm run dev` separately when interactive
  inspection is needed.
- Match the recorded Figma frame/content dimensions, outer window dimensions,
  display scale, content fixture, and appearance before comparing screenshots.
- Inspect `renderer.png` and `renderer-evidence.json`, including the window,
  content, viewport, screenshot pixel dimensions, and `data-testid` geometry
  values in the ledger. A
  screenshot alone is diagnostic evidence, not a pass.
- Check the renderer console for CSP violations, failed asset loads, and IPC
  errors.
- Verify every required transition, not only the initial frame.
- Re-read the latest evidence after each visual change. Fix the implementation
  or explain why a recorded Figma fact is inapplicable; do not weaken the ledger
  silently.

## Stop Conditions

Stop and report rather than guess when the target node is ambiguous, the
required asset is unavailable, the Figma state is missing, the requested visual
conflicts with an explicit product exception, or the design depends on a
capability the CSP or Electron window configuration does not allow.

## Completion

Before reporting completion, confirm that the ledger is resolved, theme tokens
and icons are traceable to Figma, required interaction states work, typecheck
and tests pass, the app was opened and inspected at the Figma window size, and
any remaining difference has a concrete rationale.
