import { useCallback, useMemo, useRef, useState } from "react";
import { Loader2, MapPin, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { classifyZone, isMonster, type Zone } from "@/lib/estuarine";

type Effort = "low" | "med" | "high";
type Time = "now" | "soon" | "ongoing" | "years";

type MapVariable = {
  id: string;
  name: string;
  weight: number;
  effortToChange?: Effort;
  timeToChange?: Time;
};

type Props = {
  variables: MapVariable[];
  onUpdate: (id: string, patch: { effortToChange: Effort; timeToChange: Time }) => void;
  onPlace?: () => void;
  placing?: boolean;
};

const TIMES: Time[] = ["now", "soon", "ongoing", "years"];
const EFFORTS: Effort[] = ["low", "med", "high"];

const TIME_LABEL: Record<Time, string> = {
  now: "Days",
  soon: "Weeks",
  ongoing: "Months",
  years: "Years",
};
const EFFORT_LABEL: Record<Effort, string> = {
  low: "Low effort",
  med: "Some effort",
  high: "Heavy lift",
};

const ZONE_META: Record<
  Zone,
  { name: string; gloss: string; fill: string; ring: string; chip: string; text: string }
> = {
  openWater: {
    name: "Open water",
    gloss: "easy to shift now",
    fill: "rgba(56, 189, 248, 0.14)",
    ring: "rgba(56, 189, 248, 0.45)",
    chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
    text: "Quick to nudge — try moving this first.",
  },
  sandbank: {
    name: "Sandbanks",
    gloss: "shifting; worth a small test",
    fill: "rgba(234, 179, 8, 0.10)",
    ring: "rgba(234, 179, 8, 0.40)",
    chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
    text: "Movable, but not certain — run a small test before betting big.",
  },
  granite: {
    name: "Granite",
    gloss: "fixed; hard to move",
    fill: "rgba(120, 113, 108, 0.18)",
    ring: "rgba(120, 113, 108, 0.50)",
    chip: "bg-stone-500/15 text-stone-700 dark:text-stone-300 border-stone-500/40",
    text: "Hard to budge — design around it instead of fighting it.",
  },
};

function nearestCell(xRatio: number, yRatio: number): { time: Time; effort: Effort } {
  const ti = Math.max(0, Math.min(TIMES.length - 1, Math.round(xRatio * (TIMES.length - 1))));
  const ei = Math.max(0, Math.min(EFFORTS.length - 1, Math.round(yRatio * (EFFORTS.length - 1))));
  return { time: TIMES[ti], effort: EFFORTS[ei] };
}

export function EstuarineMap({ variables, onUpdate, onPlace, placing }: Props) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const positioned = useMemo(
    () => variables.filter((v) => v.effortToChange && v.timeToChange),
    [variables],
  );
  const hasAny = positioned.length > 0;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDraggingId(id);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingId || !plotRef.current) return;
      const r = plotRef.current.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width);
      const y = (e.clientY - r.top) / Math.max(1, r.height);
      const { time, effort } = nearestCell(
        Math.min(1, Math.max(0, x)),
        Math.min(1, Math.max(0, y)),
      );
      const v = variables.find((vv) => vv.id === draggingId);
      if (!v) return;
      if (v.timeToChange !== time || v.effortToChange !== effort) {
        onUpdate(draggingId, { timeToChange: time, effortToChange: effort });
      }
    },
    [draggingId, onUpdate, variables],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    setDraggingId(null);
  }, []);

  if (!hasAny) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/40 p-6 text-center">
        <MapPin className="mx-auto mb-2 text-muted-foreground" size={22} />
        <p className="text-sm font-medium text-foreground">No map yet</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          Place each driver on a map by how much effort it takes to change and how long that
          change usually takes. This shows you where to nudge, where to experiment, and what to
          design around.
        </p>
        {onPlace && (
          <Button
            type="button"
            size="sm"
            onClick={onPlace}
            disabled={placing}
            className="mt-3 gap-1.5"
          >
            {placing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            Place drivers on the map
          </Button>
        )}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          <b className="text-foreground">How to read this map:</b> left = quick to change, right =
          slow; bottom = easy, top = hard. Drag a dot to a different cell if your judgement
          differs.
        </p>

        <div className="flex gap-3">
          {/* Y-axis label */}
          <div className="hidden sm:flex w-6 shrink-0 items-center justify-center">
            <span className="-rotate-90 whitespace-nowrap text-[11px] uppercase tracking-wide text-muted-foreground">
              Effort to change ↑
            </span>
          </div>

          <div className="flex-1">
            {/* Plot */}
            <div
              ref={plotRef}
              role="application"
              aria-label="Driver map by effort and time"
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className="relative w-full touch-none select-none rounded-xl border border-border bg-background"
              style={{ aspectRatio: "4 / 3", minHeight: 260 }}
            >
              {/* Cell grid (zone shading) */}
              <div
                className="absolute inset-0 grid"
                style={{
                  gridTemplateColumns: `repeat(${TIMES.length}, 1fr)`,
                  gridTemplateRows: `repeat(${EFFORTS.length}, 1fr)`,
                }}
                aria-hidden
              >
                {EFFORTS.map((eff) =>
                  TIMES.map((t) => {
                    const zone = classifyZone({ effortToChange: eff, timeToChange: t });
                    const meta = ZONE_META[zone];
                    return (
                      <div
                        key={`${eff}-${t}`}
                        className="border border-border/60"
                        style={{ background: meta.fill }}
                      />
                    );
                  }),
                )}
              </div>

              {/* Zone name labels (subtle, on top of the shading) */}
              <div className="pointer-events-none absolute inset-0" aria-hidden>
                <span className="absolute left-2 bottom-2 text-[10px] font-semibold uppercase tracking-wide text-sky-700/70 dark:text-sky-300/70">
                  Open water
                </span>
                <span className="absolute right-2 top-2 text-[10px] font-semibold uppercase tracking-wide text-stone-700/70 dark:text-stone-300/70">
                  Granite
                </span>
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide text-amber-700/60 dark:text-amber-300/60">
                  Sandbanks
                </span>
              </div>

              {/* Dots */}
              {positioned.map((v) => {
                const ti = TIMES.indexOf(v.timeToChange as Time);
                const ei = EFFORTS.indexOf(v.effortToChange as Effort);
                if (ti < 0 || ei < 0) return null;
                // center of cell
                const xPct = ((ti + 0.5) / TIMES.length) * 100;
                const yPct = ((ei + 0.5) / EFFORTS.length) * 100;
                const zone = classifyZone(v);
                const meta = ZONE_META[zone];
                const monster = isMonster({
                  weight: v.weight,
                  effortToChange: v.effortToChange,
                  timeToChange: v.timeToChange,
                });
                const dragging = draggingId === v.id;
                return (
                  <Tooltip key={v.id} open={dragging ? true : undefined}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onPointerDown={(e) => handlePointerDown(e, v.id)}
                        onFocus={() => setHoverId(v.id)}
                        onBlur={() => setHoverId(null)}
                        aria-label={`${v.name} — ${meta.name}${monster ? " — Monster" : ""}`}
                        className={
                          "absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-background shadow-sm transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                          (dragging ? "scale-110 cursor-grabbing" : "cursor-grab hover:scale-105") +
                          (hoverId === v.id ? " z-20" : " z-10")
                        }
                        style={{
                          left: `${xPct}%`,
                          top: `${yPct}%`,
                          width: monster ? 30 : 22,
                          height: monster ? 30 : 22,
                          borderColor: meta.ring,
                          boxShadow: monster
                            ? `0 0 0 3px ${meta.ring}, 0 0 0 6px rgba(239,68,68,0.35)`
                            : undefined,
                        }}
                      >
                        {monster && (
                          <span
                            className="pointer-events-none absolute -top-2 -right-2 grid h-4 w-4 place-items-center rounded-full bg-red-500 text-[9px] font-bold text-white"
                            aria-hidden
                          >
                            !
                          </span>
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[220px] text-xs">
                      <div className="font-semibold">{v.name}</div>
                      <div className="mt-0.5 text-muted-foreground">
                        {meta.name} — {meta.gloss}
                      </div>
                      <div className="mt-1 leading-snug">{meta.text}</div>
                      {monster && (
                        <div className="mt-1 leading-snug text-red-600 dark:text-red-400">
                          Monster — looks stable, could shift suddenly. Watch it.
                        </div>
                      )}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>

            {/* X-axis labels */}
            <div
              className="mt-1 grid text-center text-[11px] text-muted-foreground"
              style={{ gridTemplateColumns: `repeat(${TIMES.length}, 1fr)` }}
              aria-hidden
            >
              {TIMES.map((t) => (
                <span key={t}>{TIME_LABEL[t]}</span>
              ))}
            </div>
            <div className="mt-0.5 text-center text-[11px] uppercase tracking-wide text-muted-foreground">
              Time to change →
            </div>
          </div>

          {/* Y-axis tick labels */}
          <div
            className="hidden sm:grid w-16 shrink-0 text-right text-[11px] text-muted-foreground"
            style={{ gridTemplateRows: `repeat(${EFFORTS.length}, 1fr)` }}
            aria-hidden
          >
            {EFFORTS.map((e) => (
              <span key={e} className="flex items-center justify-end">
                {EFFORT_LABEL[e]}
              </span>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="grid gap-2 sm:grid-cols-2">
          {(["openWater", "sandbank", "granite"] as Zone[]).map((z) => {
            const meta = ZONE_META[z];
            return (
              <div
                key={z}
                className={
                  "flex items-start gap-2 rounded-lg border p-2 text-xs " + meta.chip
                }
              >
                <span
                  className="mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full border-2"
                  style={{ background: meta.fill, borderColor: meta.ring }}
                  aria-hidden
                />
                <span>
                  <b>{meta.name}</b> — {meta.gloss}
                </span>
              </div>
            );
          })}
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
            <span
              className="relative mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-stone-500/60 bg-stone-500/20"
              aria-hidden
            >
              <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-red-500" />
            </span>
            <span>
              <b>Monster</b> — looks stable, could shift suddenly — watch it.
            </span>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

export default EstuarineMap;
