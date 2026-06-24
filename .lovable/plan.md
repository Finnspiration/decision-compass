## Plan: Mount Decision Lens at `/`

1. Copy the uploaded `DecisionLens.jsx` into the project as `src/components/DecisionLens.jsx` (kept as JSX, unchanged — the project allows JS alongside TS, and keeping it as-is satisfies the "exactly as provided" constraint).
2. Replace `src/routes/index.tsx` placeholder with a route that imports and renders `<DecisionLens />`. Update `head()` meta to "Decision Lens" with a one-sentence description.
3. Verify `lucide-react` is already installed (it ships with the shadcn template — no install needed). If missing, add it.
4. Let the dev server rebuild and confirm the page renders without errors.

No refactors to `simulate`, `outcomeOf`, `autoDraftModel`, or any styling. No new dependencies beyond `lucide-react`.

### Technical notes
- File stays `.jsx` to preserve the component byte-for-byte; Vite handles JSX in this project.
- Root layout (`__root.tsx`) already provides the shell; the component renders its own full-screen dark theme inside.
