"use client";

/**
 * Playground tab — a non-destructive resolver/classifier probe paired
 * with a controlled "submit observation" affordance.
 *
 *   • Probe form: pick kind + provider + (optional competition) + surface,
 *     get the resolver's answer + (optionally) the Tier-2 classifier's
 *     calibrated probability + p-value.
 *   • Submit form: writes a real observation into name_observations and
 *     updates the candidate row. Use to seed test cases or to teach
 *     the system a new alias by hand.
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { FlaskConical, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { probePlayground, submitTestObservation } from "./api";
import { FieldLabel } from "./atoms";
import type { Entity } from "./types";

interface ProbeResult {
  resolved: {
    entity: Entity;
    source: string;
    surfaceNormalized: string;
  } | null;
  classifier: { score?: number; pvalue?: number | null; error?: string } | null;
}

export function PlaygroundPanel() {
  const [kind, setKind] = useState<"team" | "competition">("team");
  const [provider, setProvider] = useState("pinnacle");
  const [surface, setSurface] = useState("");
  const [competition, setCompetition] = useState("");
  const [callClassifier, setCallClassifier] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(false);

  const [obsCanonical, setObsCanonical] = useState("");
  const [obsOutcome, setObsOutcome] = useState<
    "matched" | "manual-confirm" | "rejected" | "manual-reject"
  >("manual-confirm");
  const [obsBusy, setObsBusy] = useState(false);

  const probe = useCallback(async () => {
    if (!surface.trim()) {
      toast.error("Enter a surface name to probe");
      return;
    }
    setLoading(true);
    try {
      const d = await probePlayground({
        kind,
        surface,
        provider,
        competitionSurface: competition || undefined,
        callClassifier,
      });
      setResult(d);
    } catch (err) {
      toast.error("Probe failed", { description: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [kind, provider, surface, competition, callClassifier]);

  const submit = useCallback(async () => {
    if (!surface.trim() || !obsCanonical.trim()) {
      toast.error("Surface and canonical name required");
      return;
    }
    setObsBusy(true);
    try {
      const r = await submitTestObservation({
        kind,
        surface,
        canonicalName: obsCanonical,
        provider,
        competition: competition || undefined,
        outcome: obsOutcome,
      });
      if (!r.success) {
        toast.error("Submission failed", { description: r.error });
        return;
      }
      toast.success("Observation recorded", { description: r.message });
    } finally {
      setObsBusy(false);
    }
  }, [kind, surface, obsCanonical, provider, competition, obsOutcome]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 h-full overflow-y-auto">
      {/* Probe */}
      <div className="border border-zinc-800/60 rounded p-3 space-y-3 bg-zinc-900/30">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <FlaskConical className="w-4 h-4 text-violet-400" /> Resolver probe
        </div>
        <p className="text-[11px] text-zinc-500">
          Read-only. Runs the same lookup the matcher uses, optionally calling
          the Tier-2 classifier. Nothing is written.
        </p>

        <div className="flex items-center bg-muted/40 rounded-md p-0.5">
          <button
            onClick={() => setKind("team")}
            className={cn(
              "flex-1 px-2 py-1 text-[11px] rounded font-medium",
              kind === "team" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500",
            )}
          >
            Team
          </button>
          <button
            onClick={() => setKind("competition")}
            className={cn(
              "flex-1 px-2 py-1 text-[11px] rounded font-medium",
              kind === "competition"
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500",
            )}
          >
            Competition
          </button>
        </div>

        <FieldLabel label="Provider">
          <Input
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder="pinnacle"
            className="h-7 text-xs bg-muted/40 border-zinc-700/50"
          />
        </FieldLabel>
        <FieldLabel label="Surface">
          <Input
            value={surface}
            onChange={(e) => setSurface(e.target.value)}
            placeholder='e.g. "Dynamo Kyiv"'
            className="h-7 text-xs bg-muted/40 border-zinc-700/50"
          />
        </FieldLabel>
        {kind === "team" && (
          <FieldLabel label="Competition (optional)">
            <Input
              value={competition}
              onChange={(e) => setCompetition(e.target.value)}
              placeholder='e.g. "Premier League"'
              className="h-7 text-xs bg-muted/40 border-zinc-700/50"
            />
          </FieldLabel>
        )}
        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={callClassifier}
            onChange={(e) => setCallClassifier(e.target.checked)}
            className="accent-violet-500"
          />
          Also call Tier-2 classifier
        </label>
        <Button
          onClick={probe}
          disabled={loading}
          size="sm"
          className="w-full h-8 text-xs bg-violet-600 hover:bg-violet-700"
        >
          {loading ? (
            <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
          ) : (
            <Sparkles className="w-3 h-3 mr-1.5" />
          )}
          Probe resolver
        </Button>

        {result && (
          <div className="mt-2 p-2 bg-zinc-950/40 border border-zinc-800/60 rounded text-[11px] font-mono text-zinc-300 max-h-72 overflow-y-auto">
            <div className="mb-1 text-zinc-500">resolved:</div>
            {result.resolved ? (
              <>
                <div>entity: {result.resolved.entity.canonicalName}</div>
                <div>id: {result.resolved.entity.id}</div>
                <div>via: {result.resolved.source}</div>
                <div>norm: {result.resolved.surfaceNormalized}</div>
              </>
            ) : (
              <div className="text-amber-400">
                → no match (will seed a new candidate on next observation)
              </div>
            )}
            {result.classifier && (
              <>
                <div className="mt-2 text-zinc-500">classifier:</div>
                {result.classifier.error ? (
                  <div className="text-rose-400">
                    error: {result.classifier.error}
                  </div>
                ) : (
                  <>
                    <div>score: {result.classifier.score?.toFixed(4)}</div>
                    {result.classifier.pvalue != null && (
                      <div>p-value: {result.classifier.pvalue.toFixed(4)}</div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Submit */}
      <div className="border border-zinc-800/60 rounded p-3 space-y-3 bg-zinc-900/30">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Sparkles className="w-4 h-4 text-emerald-400" /> Submit observation
        </div>
        <p className="text-[11px] text-zinc-500">
          Writes a real observation into <code>name_observations</code> and
          updates the candidate row. Reuses the probe&apos;s surface/provider/
          competition fields; provide the canonical name to bind to.
        </p>
        <FieldLabel label="Canonical name (entity to bind)">
          <Input
            value={obsCanonical}
            onChange={(e) => setObsCanonical(e.target.value)}
            placeholder="e.g. Dynamo Kyiv"
            className="h-7 text-xs bg-muted/40 border-zinc-700/50"
          />
        </FieldLabel>
        <FieldLabel label="Outcome">
          <select
            value={obsOutcome}
            onChange={(e) => setObsOutcome(e.target.value as typeof obsOutcome)}
            className="h-7 text-xs bg-muted/40 border border-zinc-700/50 rounded w-full px-2"
          >
            <option value="manual-confirm">manual-confirm (positive)</option>
            <option value="matched">matched (positive)</option>
            <option value="rejected">rejected (negative)</option>
            <option value="manual-reject">manual-reject (negative)</option>
          </select>
        </FieldLabel>
        <Button
          onClick={submit}
          disabled={obsBusy}
          size="sm"
          className="w-full h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
        >
          {obsBusy && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
          Record observation
        </Button>
      </div>
    </div>
  );
}
