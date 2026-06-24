import { createFileRoute } from "@tanstack/react-router";
import DecisionLens from "@/components/DecisionLens.jsx";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Decision Lens" },
      { name: "description", content: "Model a decision as a small system of variables, feedback loops, and options — then simulate and compare outcomes." },
      { property: "og:title", content: "Decision Lens" },
      { property: "og:description", content: "Model a decision as a small system of variables, feedback loops, and options — then simulate and compare outcomes." },
    ],
  }),
  component: DecisionLens,
});
