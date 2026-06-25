## Diagnosis

The PDF *was* attached correctly — the chip "Deep Research Brief for CPD… 0.1 MB ×" in your screenshot confirms it's queued. The phrase "Auto-draft (no sources)" you're reacting to is **the static label of the secondary button**, not a status message about your upload.

In `src/components/DecisionLens.tsx` (lines 1247–1265) the Frame stage always renders two buttons side by side:

1. **Map my decision** — primary, uses your PDFs + URLs (this is the one you want).
2. **Auto-draft (no sources)** — secondary, deliberately *ignores* sources and drafts from just the decision text.

Both are shown unconditionally, so even with a PDF attached the secondary button still reads "(no sources)". That's working as designed but reads as a bug.

## Fix

Make the secondary button context-aware so it can't be mistaken for a status indicator:

- When `pdfFiles.length === 0 && urls.length === 0`: keep the current two-button layout.
- When at least one source is attached:
  - Re-label the secondary button to **"Ignore sources & draft from text"** (or hide it entirely behind a small "Skip sources" text link under the primary button — I'll pick the button rewording for visual consistency).
  - Tighten the helper line under the buttons to: *"Sources attached — 'Map my decision' will ground the model in them. Use 'Ignore sources' to draft from the decision text only."* when sources are present; keep the existing copy otherwise.

No engine, server-function, or styling changes. Pure label/conditional-rendering tweak in the Frame stage.

## Files touched

- `src/components/DecisionLens.tsx` — lines ~1247–1268 only.
