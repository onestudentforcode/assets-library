import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "@/server/errors";
import {
  moveIntoAssetStorage,
  removeAssetFiles,
  removeStoredFile,
  resolveMediaPath,
  temporaryUploadPath,
} from "@/server/media/storage";
import {
  clearSceneBatchOriginalPath,
  clearSceneBatchExternalTask,
  completeSceneBatchJob,
  createSceneChildren,
  failSceneBatch,
  getVideoSceneBatchRecord,
  heartbeatSceneBatchJob,
  listSettledSceneBatchesPendingCleanup,
  setSceneBatchStage,
  type ClaimedSceneBatchJob,
  type SceneChildInput,
} from "@/server/repositories/scene-batches";
import type { FailureCode } from "@/shared/contracts";
import {
  SceneDetectClient,
  type SceneDetectGateway,
  type SceneSplitResponse,
} from "@/server/services/scene-detect-client";

export const maximumSceneBytes = 7 * 1024 * 1024;

function deterministicUuid(batchId: string, index: number, purpose: string) {
  const bytes = Buffer.from(
    crypto.createHash("sha256").update(`${batchId}:${index}:${purpose}`).digest("hex").slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function childName(originalFilename: string, index: number) {
  const base = path.basename(originalFilename, path.extname(originalFilename)).trim() || "未命名视频";
  return `${base}-分镜-${String(index).padStart(3, "0")}`.slice(0, 255);
}

function validateManifest(manifest: SceneSplitResponse) {
  const oversized = manifest.segments.find(
    (segment) => segment.sizeBytes > maximumSceneBytes,
  );
  if (oversized) {
    throw new AppError(
      "file_too_large",
      `分镜 ${oversized.index} 超过 7 MiB 限制。`,
    );
  }
}

function cleanOriginal(batchId: string) {
  const batch = getVideoSceneBatchRecord(batchId);
  if (!batch?.originalPath) return;
  try {
    removeStoredFile(batch.originalPath);
  } finally {
    clearSceneBatchOriginalPath(batchId);
  }
}

export async function cleanupSettledSceneBatchArtifacts(
  client: SceneDetectGateway = new SceneDetectClient(),
) {
  const batches = listSettledSceneBatchesPendingCleanup();
  for (const batch of batches) {
    if (batch.originalPath) {
      try {
        cleanOriginal(batch.id);
      } catch (error) {
        console.error("Failed to clean recovered scene batch source video.", error);
      }
    }
    if (batch.externalTaskId) {
      await bestEffortDelete(client, batch.externalTaskId);
      clearSceneBatchExternalTask(batch.id);
    }
  }
  return batches.length;
}

async function bestEffortDelete(client: SceneDetectGateway, taskId: string | null) {
  if (!taskId) return;
  try {
    await client.deleteTask(taskId);
  } catch (error) {
    console.error("Failed to clean external scene task.", error);
  }
}

export async function processSceneBatchJob(
  job: ClaimedSceneBatchJob,
  client: SceneDetectGateway = new SceneDetectClient(),
) {
  const batch = getVideoSceneBatchRecord(job.batchId);
  if (!batch) return;
  if (["completed", "failed", "analyzing"].includes(batch.processingStatus)) {
    completeSceneBatchJob(job);
    await cleanupSettledSceneBatchArtifacts(client);
    return;
  }
  const heartbeat = setInterval(() => {
    try {
      heartbeatSceneBatchJob(job);
    } catch (error) {
      console.error("Scene batch heartbeat failed.", error);
    }
  }, 30_000);
  heartbeat.unref();
  let externalTaskId = batch.externalTaskId;
  const storedChildren: string[] = [];
  try {
    if (!batch.originalPath) throw new AppError("scene_split_failed", "来源视频文件不存在。", 500);
    setSceneBatchStage(job, "splitting");
    const manifest = externalTaskId
      ? await client.getTask(externalTaskId)
      : await client.split(resolveMediaPath(batch.originalPath), batch.originalFilename);
    externalTaskId = manifest.taskId;
    setSceneBatchStage(job, "validating_segments", {
      externalTaskId,
      sceneCount: manifest.sceneCount,
    });
    validateManifest(manifest);

    const children: SceneChildInput[] = [];
    for (const segment of manifest.segments) {
      const assetId = deterministicUuid(batch.id, segment.index, "asset");
      const uploadId = deterministicUuid(batch.id, segment.index, "upload");
      const temporaryPath = temporaryUploadPath(
        `${batch.id}-${String(segment.index).padStart(3, "0")}`,
      );
      fs.rmSync(temporaryPath, { force: true });
      const actualSize = await client.downloadSegment(
        manifest.taskId,
        segment.index,
        temporaryPath,
        maximumSceneBytes,
      );
      if (actualSize !== segment.sizeBytes) {
        fs.rmSync(temporaryPath, { force: true });
        throw new AppError(
          "scene_split_failed",
          `分镜 ${segment.index} 的实际大小与清单不一致。`,
          502,
        );
      }
      const originalPath = moveIntoAssetStorage(temporaryPath, assetId, ".mp4");
      storedChildren.push(originalPath);
      const name = childName(batch.originalFilename, segment.index);
      children.push({
        assetId,
        uploadId,
        name,
        originalFilename: `${name}.mp4`,
        originalPath,
        sizeBytes: actualSize,
      });
    }
    createSceneChildren(job, children);
    cleanOriginal(batch.id);
    await bestEffortDelete(client, externalTaskId);
    clearSceneBatchExternalTask(batch.id);
  } catch (error) {
    for (const originalPath of storedChildren) {
      try {
        removeAssetFiles(originalPath);
      } catch {
        // Preserve the batch failure that caused rollback.
      }
    }
    const appError =
      error instanceof AppError
        ? error
        : new AppError("scene_split_failed", "视频分镜处理失败。", 502);
    failSceneBatch(
      batch.id,
      appError.code satisfies FailureCode,
      appError.message,
      job,
    );
    try {
      cleanOriginal(batch.id);
    } catch (cleanupError) {
      console.error("Failed to clean scene batch source video.", cleanupError);
    }
    await bestEffortDelete(client, externalTaskId);
    clearSceneBatchExternalTask(batch.id);
  } finally {
    clearInterval(heartbeat);
  }
}
