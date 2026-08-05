import crypto from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import { db, sqlite } from "@/server/db";
import {
  assets,
  processingJobs,
  uploadRequests,
  videoSceneBatchJobs,
  videoSceneBatches,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import {
  type FailureCode,
  type SceneBatchProcessingStatus,
  type UploadStatus,
  type VideoSceneBatchStatus,
} from "@/shared/contracts";

const batchProgress: Record<SceneBatchProcessingStatus, number> = {
  queued: 5,
  splitting: 20,
  validating_segments: 40,
  analyzing: 65,
  completed: 100,
  failed: 100,
};

const assetProgress = {
  queued: 10,
  validating: 25,
  analyzing: 60,
  completed: 100,
  failed: 100,
} as const;

export interface CreateVideoSceneBatchInput {
  id: string;
  originalFilename: string;
  originalPath: string;
  sizeBytes: number;
  directPublish: boolean;
}

export function createVideoSceneBatch(input: CreateVideoSceneBatchInput) {
  const now = new Date();
  db.transaction((tx) => {
    tx.insert(videoSceneBatches)
      .values({
        ...input,
        processingStatus: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(videoSceneBatchJobs)
      .values({
        id: crypto.randomUUID(),
        batchId: input.id,
        status: "queued",
        attempt: 0,
        availableAt: now,
        stage: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  return getVideoSceneBatchStatus(input.id);
}

export function getVideoSceneBatchRecord(batchId: string) {
  return db
    .select()
    .from(videoSceneBatches)
    .where(eq(videoSceneBatches.id, batchId))
    .get();
}

export function getVideoSceneBatchStatus(batchId: string): VideoSceneBatchStatus {
  const batch = getVideoSceneBatchRecord(batchId);
  if (!batch) throw new AppError("invalid_request", "分镜上传记录不存在。", 404);
  const children = db
    .select({ upload: uploadRequests, asset: assets })
    .from(assets)
    .innerJoin(uploadRequests, eq(uploadRequests.assetId, assets.id))
    .where(
      and(
        eq(assets.sourceBatchId, batchId),
        ne(assets.reviewStatus, "deleted"),
      ),
    )
    .orderBy(asc(assets.name))
    .all();
  return {
    uploadId: batch.id,
    originalFilename: batch.originalFilename,
    processingStatus: batch.processingStatus,
    progressPercent: batchProgress[batch.processingStatus],
    sceneCount: batch.sceneCount,
    failureCode: batch.failureCode as FailureCode | null,
    failureMessage: batch.failureMessage,
    childAssets: children.map(({ upload, asset }): UploadStatus => ({
      uploadId: upload.id,
      assetId: asset.id,
      mediaType: asset.mediaType,
      processingStatus: asset.processingStatus,
      reviewStatus: asset.reviewStatus,
      progressPercent: assetProgress[asset.processingStatus],
      failureCode: asset.failureCode as FailureCode | null,
      failureMessage: asset.failureMessage,
    })),
  };
}

export interface ClaimedSceneBatchJob {
  id: string;
  batchId: string;
  attempt: number;
}

export function claimNextSceneBatchJob(): ClaimedSceneBatchJob | null {
  const now = Date.now();
  return sqlite.transaction(() => {
    const row = sqlite
      .prepare(
        `SELECT id, batch_id AS batchId, attempt FROM video_scene_batch_jobs
         WHERE status = 'queued' AND available_at <= ?
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(now) as ClaimedSceneBatchJob | undefined;
    if (!row) return null;
    const result = sqlite
      .prepare(
        `UPDATE video_scene_batch_jobs SET status = 'running', claimed_at = ?,
         attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'queued'`,
      )
      .run(now, now, row.id);
    return result.changes === 1 ? { ...row, attempt: row.attempt + 1 } : null;
  }).immediate();
}

export function heartbeatSceneBatchJob(job: ClaimedSceneBatchJob) {
  const now = new Date();
  return db
    .update(videoSceneBatchJobs)
    .set({ claimedAt: now, updatedAt: now })
    .where(
      and(
        eq(videoSceneBatchJobs.id, job.id),
        eq(videoSceneBatchJobs.status, "running"),
        eq(videoSceneBatchJobs.attempt, job.attempt),
      ),
    )
    .run().changes;
}

export function completeSceneBatchJob(job: ClaimedSceneBatchJob) {
  return db
    .update(videoSceneBatchJobs)
    .set({ status: "completed", updatedAt: new Date() })
    .where(
      and(
        eq(videoSceneBatchJobs.id, job.id),
        eq(videoSceneBatchJobs.status, "running"),
        eq(videoSceneBatchJobs.attempt, job.attempt),
      ),
    )
    .run().changes;
}

export function setSceneBatchStage(
  job: ClaimedSceneBatchJob,
  processingStatus: "splitting" | "validating_segments",
  values: { externalTaskId?: string; sceneCount?: number } = {},
) {
  const now = new Date();
  return db.transaction((tx) => {
    const jobUpdate = tx
      .update(videoSceneBatchJobs)
      .set({ stage: processingStatus, claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(videoSceneBatchJobs.id, job.id),
          eq(videoSceneBatchJobs.status, "running"),
          eq(videoSceneBatchJobs.attempt, job.attempt),
        ),
      )
      .run();
    if (jobUpdate.changes !== 1) return false;
    tx.update(videoSceneBatches)
      .set({ processingStatus, ...values, updatedAt: now })
      .where(eq(videoSceneBatches.id, job.batchId))
      .run();
    return true;
  });
}

export interface SceneChildInput {
  assetId: string;
  uploadId: string;
  name: string;
  originalFilename: string;
  originalPath: string;
  sizeBytes: number;
}

export function createSceneChildren(
  job: ClaimedSceneBatchJob,
  children: SceneChildInput[],
) {
  const now = new Date();
  return db.transaction((tx) => {
    const batch = tx
      .select({ directPublish: videoSceneBatches.directPublish })
      .from(videoSceneBatches)
      .where(eq(videoSceneBatches.id, job.batchId))
      .get();
    if (!batch) throw new AppError("invalid_request", "分镜批次不存在。", 404);
    const existing = tx
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.sourceBatchId, job.batchId))
      .all();
    if (existing.length > 0) {
      tx.update(videoSceneBatchJobs)
        .set({ status: "completed", stage: "analyzing", updatedAt: now })
        .where(eq(videoSceneBatchJobs.id, job.id))
        .run();
      tx.update(videoSceneBatches)
        .set({ processingStatus: "analyzing", updatedAt: now })
        .where(eq(videoSceneBatches.id, job.batchId))
        .run();
      return false;
    }
    for (const child of children) {
      tx.insert(assets)
        .values({
          id: child.assetId,
          name: child.name,
          description: "",
          mediaType: "video",
          originalFilename: child.originalFilename,
          originalPath: child.originalPath,
          mimeType: "video/mp4",
          sizeBytes: child.sizeBytes,
          directPublish: batch.directPublish,
          sourceBatchId: job.batchId,
          processingStatus: "queued",
          reviewStatus: "pending_review",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(uploadRequests)
        .values({
          id: child.uploadId,
          assetId: child.assetId,
          clientFilename: child.originalFilename,
          declaredMime: "video/mp4",
          sizeBytes: child.sizeBytes,
          createdAt: now,
        })
        .run();
      tx.insert(processingJobs)
        .values({
          id: crypto.randomUUID(),
          assetId: child.assetId,
          type: "analyze",
          status: "queued",
          attempt: 0,
          availableAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    tx.update(videoSceneBatches)
      .set({ processingStatus: "analyzing", updatedAt: now })
      .where(eq(videoSceneBatches.id, job.batchId))
      .run();
    tx.update(videoSceneBatchJobs)
      .set({ status: "completed", stage: "analyzing", updatedAt: now })
      .where(
        and(
          eq(videoSceneBatchJobs.id, job.id),
          eq(videoSceneBatchJobs.status, "running"),
          eq(videoSceneBatchJobs.attempt, job.attempt),
        ),
      )
      .run();
    return true;
  });
}

export function clearSceneBatchOriginalPath(batchId: string) {
  db.update(videoSceneBatches)
    .set({ originalPath: null, updatedAt: new Date() })
    .where(eq(videoSceneBatches.id, batchId))
    .run();
}

export function clearSceneBatchExternalTask(batchId: string) {
  db.update(videoSceneBatches)
    .set({ externalTaskId: null, updatedAt: new Date() })
    .where(eq(videoSceneBatches.id, batchId))
    .run();
}

export function failSceneBatch(
  batchId: string,
  code: FailureCode,
  message: string,
  job?: ClaimedSceneBatchJob,
) {
  const now = new Date();
  db.transaction((tx) => {
    const children = tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.sourceBatchId, batchId),
          ne(assets.reviewStatus, "deleted"),
        ),
      )
      .all();
    if (children.length) {
      tx.update(assets)
        .set({ reviewStatus: "deleted", deletedAt: now, updatedAt: now })
        .where(inArray(assets.id, children.map(({ id }) => id)))
        .run();
      for (const child of children) {
        const cleanupExists = tx
          .select({ id: processingJobs.id })
          .from(processingJobs)
          .where(
            and(
              eq(processingJobs.assetId, child.id),
              eq(processingJobs.type, "cleanup"),
              inArray(processingJobs.status, ["queued", "running"]),
            ),
          )
          .get();
        if (!cleanupExists) {
          tx.insert(processingJobs)
            .values({
              id: crypto.randomUUID(),
              assetId: child.id,
              type: "cleanup",
              status: "queued",
              attempt: 0,
              availableAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
      }
    }
    tx.update(videoSceneBatches)
      .set({
        processingStatus: "failed",
        failureCode: code,
        failureMessage: message,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(videoSceneBatches.id, batchId))
      .run();
    if (job) {
      tx.update(videoSceneBatchJobs)
        .set({ status: "failed", updatedAt: now })
        .where(eq(videoSceneBatchJobs.id, job.id))
        .run();
    }
  });
}

export function reconcileSceneBatch(batchId: string) {
  const batch = getVideoSceneBatchRecord(batchId);
  if (!batch || batch.processingStatus !== "analyzing") return false;
  const children = db
    .select()
    .from(assets)
    .where(eq(assets.sourceBatchId, batchId))
    .all();
  const failed = children.find((child) => child.processingStatus === "failed");
  if (failed) {
    failSceneBatch(
      batchId,
      (failed.failureCode as FailureCode | null) ?? "internal_error",
      failed.failureMessage ?? "分镜素材分析失败。",
    );
    return true;
  }
  if (!children.length || children.some((child) => child.processingStatus !== "completed")) {
    return false;
  }
  const now = new Date();
  db.transaction((tx) => {
    if (batch.directPublish) {
      tx.update(assets)
        .set({ reviewStatus: "published", updatedAt: now })
        .where(eq(assets.sourceBatchId, batchId))
        .run();
    }
    tx.update(videoSceneBatches)
      .set({
        processingStatus: "completed",
        failureCode: null,
        failureMessage: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(videoSceneBatches.id, batchId))
      .run();
  });
  return true;
}

export function reconcileAnalyzingSceneBatches() {
  const batches = db
    .select({ id: videoSceneBatches.id })
    .from(videoSceneBatches)
    .where(eq(videoSceneBatches.processingStatus, "analyzing"))
    .all();
  return batches.filter(({ id }) => reconcileSceneBatch(id)).length;
}

export function listSettledSceneBatchesPendingCleanup() {
  return db
    .select()
    .from(videoSceneBatches)
    .where(
      and(
        inArray(videoSceneBatches.processingStatus, [
          "analyzing",
          "completed",
          "failed",
        ]),
        or(
          isNotNull(videoSceneBatches.originalPath),
          isNotNull(videoSceneBatches.externalTaskId),
        ),
      ),
    )
    .all();
}

export function recoverStaleSceneBatchJobs(staleAfterMs = 2 * 60_000) {
  const now = new Date();
  return db
    .update(videoSceneBatchJobs)
    .set({ status: "queued", claimedAt: null, availableAt: now, updatedAt: now })
    .where(
      and(
        eq(videoSceneBatchJobs.status, "running"),
        lt(videoSceneBatchJobs.claimedAt, new Date(now.getTime() - staleAfterMs)),
      ),
    )
    .run().changes;
}
