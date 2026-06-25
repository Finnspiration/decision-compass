## Goal

Make Decision Lens easier to work with by replacing the dark, tab-switching layout with a calm light **dashboard shell**: a persistent left sidebar that always shows where you are in the 4-stage flow (Frame → Model → Options → Decide), a sticky top header with the decision name + primary action, and a panelized white workspace.

Engine, types, server functions, and Monte-Carlo logic are **unchanged**. This is a presentation-layer redesign only.

## Design tokens (locked)

Defined in `src/styles.css` under `@theme inline` + `:root`:

- `--background: #FFFFFF`
- `--foreground: #3D6C87` (Primary blue — headings, structure, axes)
- `--muted / surface: #99B0C0` at 5–20% tints (panels, secondary fills)
- `--accent / destructive: #A52A20` (CTAs, highlights, key actions)
- Borders: `#99B0C0` @ 20–30%
- Fonts: Sora (headings via `--font-display`), Manrope (body via `--font-sans`), loaded via `<link>` in `src/routes/__root.tsx` head
- Remove `className="dark"` from `<html>` — app is now light

## Layout shell

New file `src/components/DecisionShell.tsx` wraps `DecisionLens` with:

```text
┌──────────┬───────────────────────────────────────┐
│          │  Decision title         Share | Export│  ← sticky header (h-16)
│ sidebar  ├───────────────────────────────────────┤
│ (#3D6C87)│                                       │
│          │   active stage panel(s)               │
│ • Frame  │   (rendered from existing DecisionLens│
│ • Model  │    stage components — Frame / Model / │
│ • Optns  │    Options / Decide)                  │
│ • Decide │                                       │
│          │                                       │
│ [CTA]    │                                       │
└──────────┴───────────────────────────────────────┘
```

- Sidebar `w-64`, `bg-[#3D6C87]`, white text. Logo block top, 4 stage links, primary CTA at bottom (`bg-[#A52A20]` — "Upload document" / context-aware label).
- Active stage: `bg-white/10 border-l-4 border-[#A52A20]`. Inactive: `opacity-70` + hover `bg-white/10`.
- Each item shows stage number + name + a small completion dot (filled when that stage has data).
- Header: white, `border-b`, shows current decision goal + Share + Export plan buttons.
- Workspace: `bg-[#FFFFFF]` with panel cards `bg-white border border-[#99B0C0]/30 rounded-lg shadow-sm` (replacing the current dark cards).

## Stage routing

Keep existing Tabs state inside `DecisionLens`, but **lift the active-stage value** so the sidebar drives it. Two options, decide during build:

- (a) Sidebar buttons call a `setStage(...)` prop on `DecisionLens` — minimal invasive change.
- (b) Switch to URL hash sub-route (`#stage=model`) — nice to have, optional.

We go with (a) for this pass.

## Component restyle pass (inside DecisionLens.tsx)

Only swap classes / tokens — no logic changes:

- All `Card` / `Panel` backgrounds → `bg-white`, border `border-[#99B0C0]/30`, text `text-[#3D6C87]`.
- Section labels → uppercase Sora 12px `text-[#99B0C0] tracking-widest font-bold` (matches prototype).
- Primary CTAs (Run, Suggest actions, Export plan, Share) → `bg-[#A52A20] text-white`.
- Secondary buttons → outline `border-[#99B0C0] text-[#3D6C87]`.
- Sliders / chips / driver pills → primary blue fills, accent red only for warnings/highlights.
- AI Critique panel → left border `border-l-4 border-[#A52A20]` + soft red tint, matching prototype.
- Trajectory chart axes & lines → `#3D6C87`; winning option line + p50 marker → `#A52A20`; confidence band → `#3D6C87`/10–20%.
- Sanity / "worth a second look" panel → red-tinted accent style.
- Onboarding `WelcomeDialog` + tour bubbles → light surface, Sora headings, accent CTA.

## Files touched

- `src/styles.css` — replace dark `--background`/`--foreground` etc. with FraimeWorks palette under `:root`, map via `@theme inline`. Remove dark-specific overrides.
- `src/routes/__root.tsx` — remove `className="dark"` from `<html>`; add Sora + Manrope `<link>` in head.
- `src/components/DecisionShell.tsx` — new shell (sidebar + header + main).
- `src/routes/index.tsx` — render `<DecisionShell><DecisionLens .../></DecisionShell>`.
- `src/components/DecisionLens.tsx` — accept optional `stage` + `onStageChange` props; replace color classes per the restyle pass above. No engine, no prompt, no type changes.

## Out of scope

- No changes to server functions, prompts, simulation engine, types, share-URL codec, templates, or action-plan logic.
- No new features. No mobile-specific redesign (mobile keeps the existing stacked layout via responsive breakpoints — sidebar collapses to a top bar under `md`).
