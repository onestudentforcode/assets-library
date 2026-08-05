import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MultimodalAnalyzer } from "@/server/model/analyzer";
import { AppError } from "@/server/errors";
import type {
  SceneDetectGateway,
  SceneSplitResponse,
} from "@/server/services/scene-detect-client";

describe("video scene batch flow", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "scene-batch-flow-"));
    process.env.DATABASE_PATH = path.join(directory, "assets.db");
    process.env.MEDIA_ROOT = path.join(directory, "media");
    process.env.MODEL_PROTOCOL = "openai_chat_completions";
    process.env.MODEL_NAME = "test-model";
    const { initializeDatabase } = await import("@/server/db/migrations");
    initializeDatabase(process.env.DATABASE_PATH).sqlite.close();
  });

  afterAll(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function createBatch(directPublish: boolean, suffix: string) {
    const storage = await import("@/server/media/storage");
    const repository = await import("@/server/repositories/scene-batches");
    const batchId = crypto.randomUUID();
    const temporaryPath = storage.temporaryUploadPath(`source-${suffix}`);
    await fs.writeFile(temporaryPath, "source-video");
    const originalPath = storage.moveIntoSceneBatchStorage(temporaryPath, batchId);
    repository.createVideoSceneBatch({
      id: batchId,
      originalFilename: `campaign-${suffix}.mp4`,
      originalPath,
      sizeBytes: 12,
      directPublish,
    });
    return batchId;
  }

  function gateway(segmentSizes: number[]) {
    const taskId = "6fc24bee8df44ff8a67047d69c61be01";
    const manifest: SceneSplitResponse = {
      taskId,
      originalFilename: "source.mp4",
      durationSeconds: segmentSizes.length,
      sceneCount: segmentSizes.length,
      segments: segmentSizes.map((sizeBytes, offset) => ({
        index: offset + 1,
        startSeconds: offset,
        endSeconds: offset + 1,
        durationSeconds: 1,
        startFrame: offset * 24,
        endFrame: (offset + 1) * 24,
        sizeBytes,
        filename: `segment-${String(offset + 1).padStart(3, "0")}.mp4`,
        downloadUrl: `/ignored/${offset + 1}`,
      })),
    };
    let downloads = 0;
    let deletions = 0;
    const client: SceneDetectGateway & {
      downloads: () => number;
      deletions: () => number;
    } = {
      downloads: () => downloads,
      deletions: () => deletions,
      async split() { return manifest; },
      async getTask() { return manifest; },
      async downloadSegment(_taskId, index, targetPath) {
        downloads += 1;
        await fs.writeFile(targetPath, `segment-${index}`);
        return segmentSizes[index - 1]!;
      },
      async deleteTask() { deletions += 1; },
    };
    return client;
  }

  const analyzer: MultimodalAnalyzer = {
    async analyze() {
      return {
        kind: "video",
        description: "分镜内容",
        topics: [],
        tags: { scene: [], person: [], form: [] },
        visualSegments: [],
        keyMoments: [],
        timeline: [],
      };
    },
  };

  it("accepts exactly 7 MiB, creates all children atomically and publishes together", async () => {
    const repository = await import("@/server/repositories/scene-batches");
    const assets = await import("@/server/repositories/assets");
    const processing = await import("@/server/services/processing");
    const batches = await import("@/server/services/scene-batch-processing");
    const batchId = await createBatch(true, "success");
    const job = repository.claimNextSceneBatchJob();
    expect(job?.batchId).toBe(batchId);
    await batches.processSceneBatchJob(job!, gateway([7 * 1024 * 1024, 10]));

    let status = repository.getVideoSceneBatchStatus(batchId);
    expect(status.processingStatus).toBe("analyzing");
    expect(status.childAssets).toHaveLength(2);
    expect(() => assets.publishAsset(status.childAssets[0]!.assetId)).toThrow(
      /批次完成前/,
    );
    for (let index = 0; index < 2; index += 1) {
      const assetJob = assets.claimNextJob();
      expect(assetJob?.type).toBe("analyze");
      await processing.processJob(assetJob!, analyzer, async () => ({ mimeType: "video/mp4" }));
      repository.reconcileSceneBatch(batchId);
    }
    status = repository.getVideoSceneBatchStatus(batchId);
    expect(status.processingStatus).toBe("completed");
    expect(status.childAssets.every((child) => child.reviewStatus === "published")).toBe(true);
    const detail = assets.getAssetDetail(status.childAssets[0]!.assetId);
    expect(detail.sourceOriginalFilename).toBe("campaign-success.mp4");
    expect(detail.name).toBe("campaign-success-分镜-001");
  });

  it("fails before every download and creates zero children when metadata exceeds by one byte", async () => {
    const repository = await import("@/server/repositories/scene-batches");
    const assetRepository = await import("@/server/repositories/assets");
    const database = await import("@/server/db");
    const schema = await import("@/server/db/schema");
    const batches = await import("@/server/services/scene-batch-processing");
    const { eq } = await import("drizzle-orm");
    const batchId = await createBatch(false, "oversized");
    const client = gateway([7 * 1024 * 1024 + 1]);
    const job = repository.claimNextSceneBatchJob();
    expect(job?.batchId).toBe(batchId);
    await batches.processSceneBatchJob(job!, client);
    const status = repository.getVideoSceneBatchStatus(batchId);
    expect(status).toMatchObject({
      processingStatus: "failed",
      failureCode: "file_too_large",
      failureMessage: expect.stringContaining("整个视频处理已失败"),
      childAssets: [],
    });
    expect(client.downloads()).toBe(0);
    expect(client.deletions()).toBe(1);
    expect(repository.getVideoSceneBatchRecord(batchId)).toMatchObject({
      originalPath: null,
      externalTaskId: null,
    });
    const failedOverviewItem = (await assetRepository.listAssets({ view: "pending" }))
      .items.find((item) => item.id === batchId);
    expect(failedOverviewItem).toMatchObject({
      entryType: "failed_scene_batch",
      processingStatus: "failed",
      reviewStatus: "pending_review",
      sourceOriginalFilename: "campaign-oversized.mp4",
      failureCode: "file_too_large",
    });

    const storedJob = database.db
      .select()
      .from(schema.videoSceneBatchJobs)
      .where(eq(schema.videoSceneBatchJobs.batchId, batchId))
      .get()!;
    expect(storedJob.status).toBe("failed");
    database.db
      .update(schema.videoSceneBatchJobs)
      .set({ status: "queued", availableAt: new Date() })
      .where(eq(schema.videoSceneBatchJobs.id, storedJob.id))
      .run();
    expect(repository.claimNextSceneBatchJob()).toBeNull();
    expect(repository.recoverStaleSceneBatchJobs(0)).toBe(0);
    expect(repository.discardSettledSceneBatchJobs()).toBe(1);
    expect(
      database.db
        .select({ status: schema.videoSceneBatchJobs.status })
        .from(schema.videoSceneBatchJobs)
        .where(eq(schema.videoSceneBatchJobs.id, storedJob.id))
        .get()?.status,
    ).toBe("failed");
    repository.dismissFailedSceneBatch(batchId);
    expect(
      (await assetRepository.listAssets({ view: "pending" })).items.some(
        (item) => item.id === batchId,
      ),
    ).toBe(false);
    expect(() => repository.getVideoSceneBatchStatus(batchId)).toThrow(
      /不存在/,
    );
  });

  it("rolls back every child when one analysis fails", async () => {
    const repository = await import("@/server/repositories/scene-batches");
    const assets = await import("@/server/repositories/assets");
    const processing = await import("@/server/services/processing");
    const batches = await import("@/server/services/scene-batch-processing");
    const batchId = await createBatch(false, "rollback");
    await batches.processSceneBatchJob(
      repository.claimNextSceneBatchJob()!,
      gateway([9, 9]),
    );
    await processing.processJob(
      assets.claimNextJob()!,
      analyzer,
      async () => ({ mimeType: "video/mp4" }),
    );
    await processing.processJob(
      assets.claimNextJob()!,
      { async analyze() { throw new AppError("model_request_failed"); } },
      async () => ({ mimeType: "video/mp4" }),
    );
    repository.reconcileSceneBatch(batchId);
    expect(repository.getVideoSceneBatchStatus(batchId)).toMatchObject({
      processingStatus: "failed",
      failureCode: "model_request_failed",
      childAssets: [],
    });
  });

  it("recovers a stale split job without creating duplicate children", async () => {
    const repository = await import("@/server/repositories/scene-batches");
    const database = await import("@/server/db");
    const schema = await import("@/server/db/schema");
    const batches = await import("@/server/services/scene-batch-processing");
    const { eq } = await import("drizzle-orm");
    const batchId = await createBatch(false, "recovery");
    const firstClaim = repository.claimNextSceneBatchJob()!;
    database.db
      .update(schema.videoSceneBatchJobs)
      .set({ claimedAt: new Date(Date.now() - 180_000) })
      .where(eq(schema.videoSceneBatchJobs.id, firstClaim.id))
      .run();
    expect(repository.recoverStaleSceneBatchJobs()).toBe(1);
    const recovered = repository.claimNextSceneBatchJob()!;
    expect(recovered).toMatchObject({ id: firstClaim.id, batchId, attempt: 2 });
    await batches.processSceneBatchJob(recovered, gateway([8, 8]));
    const childIds = repository
      .getVideoSceneBatchStatus(batchId)
      .childAssets.map((child) => child.assetId);
    expect(childIds).toHaveLength(2);
    expect(new Set(childIds).size).toBe(2);

    const storage = await import("@/server/media/storage");
    const orphan = storage.temporaryUploadPath("recovered-source");
    await fs.writeFile(orphan, "source-video");
    const orphanRelativePath = storage.moveIntoSceneBatchStorage(orphan, batchId);
    const externalTaskId = "6fc24bee8df44ff8a67047d69c61be01";
    database.db
      .update(schema.videoSceneBatches)
      .set({ originalPath: orphanRelativePath, externalTaskId })
      .where(eq(schema.videoSceneBatches.id, batchId))
      .run();
    const cleanupClient = gateway([]);
    let deletes = 0;
    cleanupClient.deleteTask = async (taskId) => {
      expect(taskId).toBe(externalTaskId);
      deletes += 1;
    };
    await batches.cleanupSettledSceneBatchArtifacts(cleanupClient);
    expect(deletes).toBe(1);
    expect(repository.getVideoSceneBatchRecord(batchId)).toMatchObject({
      originalPath: null,
      externalTaskId: null,
    });
    await expect(fs.access(storage.resolveMediaPath(orphanRelativePath))).rejects.toThrow();
  });
});
