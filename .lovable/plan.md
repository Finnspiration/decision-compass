## Goal

Keep the current Model-tab layout (drivers left, map right rail) but let the user pop the Decision Map open into a large dialog when they want to read or work with it at full size.

## Changes (all in `src/components/DecisionLens.tsx`)

1. **Add an "Expand" button to the Decision Map panel header**
   - Small ghost icon button (`Maximize2` from lucide) next to the "DECISION MAP" title in the right-rail panel on the Model tab.
   - `aria-label="Open larger decision map"`, `min-h-11 min-w-11` to stay accessibility-consistent with the rest of the app.

2. **Add a shadcn `Dialog` that hosts a large `SystemMap`**
   - Width/height: `max-w-[90vw] w-[90vw] h-[85vh]` with the SVG filling the body (`flex-1`, `min-h-0`).
   - Reuse the existing memoized `SystemMap` component — pass the same `vars`/`edges` props, just render at the larger size. No engine or data changes.
   - Header shows decision title + a one-line legend ("Green = helps your goal · Red = hurts · Arrows = knock-on effects") so the modal is self-explanatory.
   - Dismiss: ESC, backdrop click, and an explicit "Close" button. Branded close toast is not needed (no state change).

3. **Make `SystemMap` size-responsive**
   - Currently the SVG uses fixed viewBox dimensions tuned for the small rail. Switch its outer wrapper to `w-full h-full` and let the SVG use `viewBox` with `preserveAspectRatio="xMidYMid meet"` so it scales cleanly into both the rail (small) and the dialog (large) without code-splitting two variants.
   - No changes to node layout math, labels, or glyphs — only the container sizing.

4. **Tiny in-rail affordance**
   - Make the small map in the rail clickable too (whole map opens the dialog), with `cursor-zoom-in` and the same `aria-label`. Keeps the discovery path obvious without adding chrome.

## Out of scope

- No pan/zoom inside the dialog (can add later if needed).
- No layout swap of the Model tab columns.
- No changes to the Frame, Options, or Decide tabs.
- No changes to simulation, types, share-URL codec, or AI prompts.

## Technical notes

- Uses existing shadcn `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogClose` — already in the project.
- New icon: `Maximize2` from `lucide-react` (already a dependency).
- Local `useState<boolean>` for open/close inside the Model tab section; no global state.
- Keep the existing `React.memo` on `SystemMap`; the dialog mount/unmount handles re-render cost.

## Acceptance

- Clicking "Expand" (or the small map) opens a near-fullscreen dialog showing the same map, with all node labels readable.
- Closing returns focus to the expand button.
- Small map in the rail is unchanged in size/position.
- Typecheck and build pass.
