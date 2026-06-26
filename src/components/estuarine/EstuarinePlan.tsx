import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Sparkles, Waves, Sprout, Mountain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useServerFn } from "@tanstack/react-start";
import {
  estuarinePlan,
  type EstuarinePlan as EstuarinePlanType,
  type EstuarineNudge,
  type EstuarineProbe,
  type EstuarineDesignAround,
} from "@/lib/estuarine-plan.functions";

type Variable = {
  id: string;
  name: string;
  weight?: number;
  effortToChange?: "low" | "med" | "high";
  timeToChange?: "now" | "soon" | "ongoing" | "years";
};

type Option = { id?: string; name?: string; pushes?: Record<string, number> };

type Props = {
  decision?: string;
  outcomeName?: string;
  variables: Variable[];
  options?: Option[];
  /** Optional: if the parent already loaded a plan, pass it in. */
  initialPlan?: EstuarinePlanType | null;
  /** Optional callback so the parent can cache the result. */
  onPlanLoaded?: (plan: EstuarinePlanType) => void;
};

const EFFORT_LABEL: Record<NonNullable<EstuarineNudge["effort"]>, string> = {
  low: "Low effort",
  med: "Some effort",
  high: "Heavy lift",
};
const WHEN_LABEL: Record<NonNullable<EstuarineNudge["when"]>, string> = {
  now: "Now",
  soon: "Soon",
  ongoing: "Ongoing",
};

export function EstuarinePlan({
  decision,
  outcomeName,
  variables,
  options,
  initialPlan,
  onPlanLoaded,
}: Props) {
  const generate = useServerFn(estuarinePlan);
  const [plan, setPlan] = useState<EstuarinePlanType | null>(initialPlan ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameById = new Map(variables.map((v) => [v.id, v.name]));

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await generate({
        data: {
          model: {
            decision: decision ?? "",
            outcomeName: outcomeName ?? "",
            variables: variables.map((v) => ({
              id: v.id,
              name: v.name,
              weight: v.weight ?? 0,
              effortToChange: v.effortToChange,
              timeToChange: v.timeToChange,
            })),
            options: (options ?? []).map((o) => ({
              id: o.id,
              name: o.name,
              pushes: o.pushes ?? {},
            })),
          },
        },
      });
      setPlan(res);
      onPlanLoaded?.(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build a plan right now.");
    } finally {
      setLoading(false);
    }
  }, [generate, decision, outcomeName, variables, options, onPlanLoaded]);

  // Auto-generate the first time, if nothing was passed in.
  useEffect(() => {
    if (plan == null && !loading) {
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasAnything =
    plan != null &&
    (plan.nudges.length > 0 || plan.probes.length > 0 || plan.designArounds.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          A strategy built from where each driver sits on the map: quick moves, small experiments,
          and forces to work around.
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={run}
          disabled={loading}
          className="h-7 gap-1.5"
          aria-label="Regenerate plan"
        >
          {loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : plan ? (
            <RotateCcw size={12} />
          ) : (
            <Sparkles size={12} />
          )}
          {plan ? "Regenerate" : "Build plan"}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-hurts/40 bg-hurts/5 p-3 text-xs text-foreground">
          {error}
        </div>
      )}

      {loading && !plan && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> Building your strategy…
        </div>
      )}

      {plan && !hasAnything && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Nothing to plan yet. Place a few drivers on the map first, then come back.
        </div>
      )}

      {plan && plan.nudges.length > 0 && (
        <Bucket
          icon={<Waves size={14} className="text-sky-400" />}
          title="Open-water moves"
          gloss="Quick things you can do now."
          accent="sky"
        >
          {plan.nudges.map((n, i) => (
            <NudgeCard key={i} item={n} nameById={nameById} />
          ))}
        </Bucket>
      )}

      {plan && plan.probes.length > 0 && (
        <Bucket
          icon={<Sprout size={14} className="text-amber-400" />}
          title="Sandbank experiments"
          gloss="Small, safe tests — scale up or drop based on what you see."
          accent="amber"
        >
          {plan.probes.map((p, i) => (
            <ProbeCard key={i} item={p} nameById={nameById} />
          ))}
        </Bucket>
      )}

      {plan && plan.designArounds.length > 0 && (
        <Bucket
          icon={<Mountain size={14} className="text-stone-300" />}
          title="Working around the granite"
          gloss="Fixed forces to accept and design around."
          accent="stone"
        >
          {plan.designArounds.map((d, i) => (
            <DesignAroundCard key={i} item={d} nameById={nameById} />
          ))}
        </Bucket>
      )}
    </div>
  );
}

/* ---------------------------- presentational ---------------------------- */

function Bucket({
  icon,
  title,
  gloss,
  accent,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  gloss: string;
  accent: "sky" | "amber" | "stone";
  children: React.ReactNode;
}) {
  const ring =
    accent === "sky"
      ? "border-sky-500/30 bg-sky-500/5"
      : accent === "amber"
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-stone-400/30 bg-stone-400/5";
  return (
    <section className={`rounded-xl border ${ring} p-3`}>
      <header className="mb-2 flex items-baseline gap-2">
        <div className="flex items-center gap-1.5">
          {icon}
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>
        <span className="text-[11px] text-muted-foreground">— {gloss}</span>
      </header>
      <div className="grid gap-2">{children}</div>
    </section>
  );
}

function TargetChips({
  ids,
  nameById,
}: {
  ids: string[];
  nameById: Map<string, string>;
}) {
  if (!ids.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Badge key={id} variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
          {nameById.get(id) ?? id}
        </Badge>
      ))}
    </div>
  );
}

function MetaRow({
  effort,
  when,
  extra,
}: {
  effort?: EstuarineNudge["effort"];
  when?: EstuarineNudge["when"];
  extra?: React.ReactNode;
}) {
  const bits: React.ReactNode[] = [];
  if (when) bits.push(<span key="w">{WHEN_LABEL[when]}</span>);
  if (effort) bits.push(<span key="e">{EFFORT_LABEL[effort]}</span>);
  if (extra) bits.push(<span key="x">{extra}</span>);
  if (!bits.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      {bits.map((b, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden>·</span>}
          {b}
        </span>
      ))}
    </div>
  );
}

function NudgeCard({
  item,
  nameById,
}: {
  item: EstuarineNudge;
  nameById: Map<string, string>;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-2.5">
      <p className="text-xs leading-relaxed text-foreground">{item.text}</p>
      <div className="mt-2 space-y-1">
        <TargetChips ids={item.targets} nameById={nameById} />
        <MetaRow effort={item.effort} when={item.when} />
      </div>
    </div>
  );
}

function ProbeCard({
  item,
  nameById,
}: {
  item: EstuarineProbe;
  nameById: Map<string, string>;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-2.5">
      <p className="text-xs leading-relaxed text-foreground">{item.text}</p>
      <div className="mt-2 space-y-1">
        <TargetChips ids={item.targets} nameById={nameById} />
        <MetaRow
          effort={item.effort}
          when={item.when}
          extra={<span>Run for {item.duration}</span>}
        />
      </div>
      <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-[11px] leading-relaxed text-foreground">
        <span className="font-semibold text-amber-300">Watch for: </span>
        {item.watchFor}
      </div>
    </div>
  );
}

function DesignAroundCard({
  item,
  nameById,
}: {
  item: EstuarineDesignAround;
  nameById: Map<string, string>;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-2.5">
      <div className="mb-1">
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
          {nameById.get(item.driverId) ?? item.driverId}
        </Badge>
      </div>
      <p className="text-xs leading-relaxed text-foreground">{item.text}</p>
    </div>
  );
}
