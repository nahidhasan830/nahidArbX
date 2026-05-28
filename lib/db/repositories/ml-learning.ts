import { desc, eq, sql } from "drizzle-orm";
import { db } from "../client";
import {
  mlLearningExplanations,
  type MlLearningExplanationRow,
  type NewMlLearningExplanationRow,
} from "../schema";
import type { LearningExplanationResponse } from "@/lib/ml/learning/types";

export function toLearningExplanationResponse(
  row: MlLearningExplanationRow,
): LearningExplanationResponse {
  return {
    id: row.id,
    snapshotHash: row.snapshotHash,
    explanationType: row.explanationType,
    provider: row.provider,
    model: row.model,
    status: row.status,
    summary: row.summary,
    content: row.content as LearningExplanationResponse["content"],
    promptHash: row.promptHash,
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
  };
}

export async function getLearningExplanation(filters: {
  snapshotHash: string;
  explanationType: string;
  model: string;
}): Promise<LearningExplanationResponse | null> {
  const [row] = await db
    .select()
    .from(mlLearningExplanations)
    .where(
      sql`${mlLearningExplanations.snapshotHash} = ${filters.snapshotHash}
        AND ${mlLearningExplanations.explanationType} = ${filters.explanationType}
        AND ${mlLearningExplanations.model} = ${filters.model}`,
    )
    .limit(1);
  return row ? toLearningExplanationResponse(row) : null;
}

export async function getLatestLearningExplanation(
  snapshotHash: string,
): Promise<LearningExplanationResponse | null> {
  const [row] = await db
    .select()
    .from(mlLearningExplanations)
    .where(eq(mlLearningExplanations.snapshotHash, snapshotHash))
    .orderBy(desc(mlLearningExplanations.createdAt))
    .limit(1);
  return row ? toLearningExplanationResponse(row) : null;
}

export async function upsertLearningExplanation(
  input: NewMlLearningExplanationRow,
): Promise<LearningExplanationResponse> {
  const [row] = await db
    .insert(mlLearningExplanations)
    .values(input)
    .onConflictDoUpdate({
      target: [
        mlLearningExplanations.snapshotHash,
        mlLearningExplanations.explanationType,
        mlLearningExplanations.model,
      ],
      set: {
        provider: sql`excluded.provider`,
        status: sql`excluded.status`,
        summary: sql`excluded.summary`,
        content: sql`excluded.content`,
        promptHash: sql`excluded.prompt_hash`,
        generatedAt: sql`excluded.generated_at`,
      },
    })
    .returning();
  return toLearningExplanationResponse(row);
}
