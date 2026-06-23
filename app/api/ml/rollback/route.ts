
import { NextResponse } from "next/server";
import { logger } from "@/lib/shared/logger";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const targetVersion = Number(body?.targetVersion);

    if (!Number.isInteger(targetVersion) || targetVersion <= 0) {
      return NextResponse.json(
        { error: "targetVersion must be a positive integer" },
        { status: 400 },
      );
    }

    const { db } = await import("@/lib/db/client");
    const { mlModels } = await import("@/lib/db/schema");
    const { eq, and, sql } = await import("drizzle-orm");

    const [target] = await db
      .select({
        id: mlModels.id,
        status: mlModels.status,
        version: mlModels.version,
      })
      .from(mlModels)
      .where(eq(mlModels.version, targetVersion))
      .limit(1);

    if (!target) {
      return NextResponse.json(
        { error: `No model row at version ${targetVersion}` },
        { status: 404 },
      );
    }
    if (target.status !== "retired" && target.status !== "deployed") {
      return NextResponse.json(
        {
          error: `v${targetVersion} status is "${target.status}" — only retired/deployed models can be rolled back to.`,
        },
        { status: 409 },
      );
    }
    if (target.status === "deployed") {
      return NextResponse.json({
        ok: true,
        alreadyDeployed: true,
        targetVersion,
      });
    }

    const result = await db.transaction(async (tx) => {
      const now = new Date().toISOString();

      const [previous] = await tx
        .select({ id: mlModels.id, version: mlModels.version })
        .from(mlModels)
        .where(eq(mlModels.status, "deployed"))
        .limit(1);

      if (previous) {
        await tx
          .update(mlModels)
          .set({ status: "retired", retiredAt: now })
          .where(
            and(eq(mlModels.id, previous.id), eq(mlModels.status, "deployed")),
          );
      }

      const updated = await tx
        .update(mlModels)
        .set({ status: "deployed", deployedAt: now, retiredAt: null })
        .where(
          and(
            eq(mlModels.id, target.id),
            sql`${mlModels.status} IN ('retired', 'deployed')`,
          ),
        )
        .returning({ id: mlModels.id, version: mlModels.version });

      if (updated.length === 0) {
        throw new Error(
          `Failed to deploy v${targetVersion} — concurrent state change`,
        );
      }

      return {
        previousVersion: previous?.version ?? null,
        targetVersion: updated[0].version,
      };
    });

    logger.info(
      "MLRollback",
      `Deployed swapped: v${result.previousVersion ?? "—"} → v${result.targetVersion}`,
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("MLRollback", `Failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
