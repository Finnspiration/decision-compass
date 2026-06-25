Fix the unreadable red hover on lower-ranked options in the Decide tab "Which option looks best" list.

## Root cause
The non-winning option buttons use `hover:bg-accent`. In this palette `--accent` is the brand red `#A52A20` with white foreground, which makes the row text hard to read on hover (and clashes with the red used elsewhere for warnings/hurts).

## Change (src/components/DecisionLens.tsx only)
- In the ranked options list (the `ranked.map((r, i) => …)` buttons around line 2240), replace `hover:bg-accent` with a neutral hover that matches the rest of the app's surface treatment: `hover:bg-muted/70` (and keep `bg-muted`).
- Add `hover:border-primary/30` for a subtle brand cue without changing text color.
- Leave the #1 (winning) row's `border-helps/40 bg-helps/10` styling untouched.

No engine, layout, or other changes.