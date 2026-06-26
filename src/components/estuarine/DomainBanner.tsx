import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SenseDomain } from "@/lib/sense-domain.functions";

type Props = {
  reading: SenseDomain;
  activeView: "ranking" | "map";
  onSwitch: (view: "ranking" | "map") => void;
  loading?: boolean;
};

function otherView(v: "ranking" | "map"): "ranking" | "map" {
  return v === "ranking" ? "map" : "ranking";
}

function viewLabel(v: "ranking" | "map"): string {
  return v === "map" ? "action map" : "ranked options";
}

export function DomainBanner({ reading, activeView, onSwitch, loading }: Props) {
  const recommended = reading.leadView;
  const showing = activeView;
  const other = otherView(showing);
  const isRecommended = showing === recommended;

  // Tone by domain (still plain language)
  const tone =
    reading.domain === "complex"
      ? "border-amber-300/60 bg-amber-50 text-amber-900"
      : reading.domain === "chaotic"
        ? "border-rose-300/60 bg-rose-50 text-rose-900"
        : reading.domain === "clear"
          ? "border-emerald-300/60 bg-emerald-50 text-emerald-900"
          : "border-sky-300/60 bg-sky-50 text-sky-900";

  return (
    <div
      role="status"
      className={`mb-3 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between ${tone}`}
    >
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 opacity-80" aria-hidden />
        <div className="leading-snug">
          <span className="font-medium">
            {loading ? "Reading the situation…" : reading.plainWhy}
          </span>{" "}
          {!loading && (
            <span className="opacity-80">
              {isRecommended
                ? `Leading with the ${viewLabel(showing)}.`
                : `Recommended view: ${viewLabel(recommended)}.`}
            </span>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 bg-white/70 hover:bg-white"
        onClick={() => onSwitch(other)}
        aria-label={`Switch to ${viewLabel(other)}`}
      >
        See the {viewLabel(other)}
        <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}
