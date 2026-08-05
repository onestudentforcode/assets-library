import crypto from "node:crypto";
import { loadConfig } from "@/server/config";
import { AppError, errorResponse } from "@/server/errors";
import {
  moveIntoSceneBatchStorage,
  removeStoredFile,
} from "@/server/media/storage";
import { createVideoSceneBatch } from "@/server/repositories/scene-batches";
import {
  parseMultipart,
  removeTemporaryFile,
  uploadExtension,
} from "@/server/media/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let temporaryPath: string | null = null;
  let storedPath: string | null = null;
  try {
    const parsed = await parseMultipart(request, loadConfig().MAX_VIDEO_BYTES);
    temporaryPath = parsed.temporaryPath;
    uploadExtension(parsed.filename, parsed.mimeType, "video");
    const batchId = crypto.randomUUID();
    storedPath = moveIntoSceneBatchStorage(parsed.temporaryPath, batchId);
    temporaryPath = null;
    return Response.json(
      createVideoSceneBatch({
        id: batchId,
        originalFilename: parsed.filename,
        originalPath: storedPath,
        sizeBytes: parsed.sizeBytes,
        directPublish: parsed.directPublish,
      }),
      { status: 202 },
    );
  } catch (error) {
    if (temporaryPath) removeTemporaryFile(temporaryPath);
    if (storedPath) {
      try {
        removeStoredFile(storedPath);
      } catch {
        return errorResponse(new AppError("storage_error", undefined, 500));
      }
    }
    return errorResponse(error);
  }
}
