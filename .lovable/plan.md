Add an "Expand" affordance to the trajectory chart in the Decide tab, mirroring the Decision Map expand pattern.

## Changes (src/components/DecisionLens.tsx only)

1. **State**: Add `chartOpen` useState alongside existing `mapOpen`.
2. **Chart panel header**: Add a `Maximize2` icon button (min-h-11 min-w-11, ghost variant, aria-label "Expand chart") next to the "How each option plays out…" title. Make the chart container itself clickable (button role, keyboard accessible) to open the dialog.
3. **Dialog**: Add a shadcn `Dialog` rendering `TrajectoryChart` at 90vw × 85vh with the same caption, delta chips, and "Universal Decline" warning currently shown below the small chart, plus a short legend (shaded band = range of possible futures, line = median).
4. **TrajectoryChartImpl**: Already supports responsive sizing via SVG viewBox from the map work — confirm it scales; if it uses a fixed width/height, add a `fill` prop (like SystemMap) so the dialog version fills its container.

No engine, simulation, or data changes. Keyboard accessible, branded toasts unchanged.