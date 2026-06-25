Restructure the Decide tab from a 2-column grid into a vertical, narrative flow.

## New order (top → bottom, full width)
1. **Chart panel** ("How each option plays out") — unchanged contents, now full width
2. **Things to keep in mind** — moved up directly under the chart
3. **Which option looks best** (ranked options + "Why does X win?" explain block)
4. **Action plan — {winning option}** (`ActionPlanReadout`)

## Changes
- **src/components/DecisionLens.tsx** (`TabsContent value="decide"` only):
  - Remove the inner `<div className="grid gap-5">` wrapper around the right column.
  - Reorder Panels: Chart → Things to keep in mind → Which option looks best → ActionPlanReadout.
  - Keep all existing props, hover/focus behavior, explain flow, and warnings intact.
- **src/styles.css**:
  - Change `.dl-decide` at the ≥sm breakpoint back to a single-column stack (drop the `1.2fr 0.8fr` rule) so every panel spans full width on all viewports.

No engine, copy, or component logic changes.