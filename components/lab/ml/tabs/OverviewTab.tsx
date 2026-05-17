"use client";

/**
 * OverviewTab — Pipeline monitoring: hero, paper, buckets, model history, training data.
 */

import type { MLTrainingState } from "@/components/hooks/useMLTrainingStream";
import type { PipelineData, StageStatus } from "../types";
import { HeroPanel } from "../panels/HeroPanel";
import { LiveTrainingPanel } from "../panels/LiveTrainingPanel";
import { InspectorRail } from "../panels/InspectorRail";
import { PaperComparisonPanel } from "../panels/PaperComparisonPanel";
import { ScoreBucketPanel } from "../panels/ScoreBucketPanel";
import { LearningCurvePanel } from "../panels/ChartPanels";
import { ModelHistoryTable } from "../ModelHistoryTable";
import { TrainingDataTable } from "../TrainingDataTable";

export function OverviewTab({
  data,
  trainingStream,
}: {
  data: PipelineData;
  statuses: StageStatus[];
  trainingStream: MLTrainingState;
}) {
  return (
    <div className="bg-gradient-to-br from-[oklch(0.06_0.01_250)] via-[oklch(0.07_0.01_240)] to-[oklch(0.05_0.02_220)]">
      <div className="mx-auto max-w-[1800px] space-y-2 p-2.5 md:p-3">
        {/* Row 1: Hero bar */}
        <HeroPanel data={data} trainingStream={trainingStream} />

        {/* Row 2: Live training (conditional) */}
        {trainingStream.currentTraining && (
          <LiveTrainingPanel
            training={trainingStream.currentTraining}
            log={trainingStream.trainingLog}
            isConnected={trainingStream.isConnected}
            dataCount={data.dataCollection.qualifiedForTraining}
          />
        )}

        {/* Row 3: Paper + Score buckets */}
        <div className="grid gap-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <PaperComparisonPanel data={data} />
          <ScoreBucketPanel data={data} />
        </div>

        {/* Row 4: Learning curve */}
        <LearningCurvePanel data={data} />

        {/* Row 5: Inspector rail */}
        <InspectorRail data={data} />

        {/* Row 6: Model history */}
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
          <ModelHistoryTable models={data.modelHistory ?? []} />
        </div>

        {/* Row 7: Training data */}
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
          <TrainingDataTable />
        </div>
      </div>
    </div>
  );
}
