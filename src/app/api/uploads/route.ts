import crypto from "node:crypto";
import path from "node:path";
import { loadConfig } from "@/server/config";
import { AppError, errorResponse } from "@/server/errors";
import {
  moveIntoAssetStorage,
  removeAssetFiles,
} from "@/server/media/storage";
import {
  parseMultipart,
  removeTemporaryFile,
  uploadExtension,
  type ParsedUpload,
} from "@/server/media/upload";
import { createAsset } from "@/server/repositories/assets";
import type { MediaType } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleUpload(request: Request, expectedMediaType: MediaType) {
  let parsed: ParsedUpload | null = null;
  let storedPath: string | null = null;
  try {
    const config = loadConfig();
    parsed = await parseMultipart(
      request,
      expectedMediaType === "image"
        ? config.MAX_IMAGE_BYTES
        : config.MAX_VIDEO_BYTES,
    );
    const extension = uploadExtension(
      parsed.filename,
      parsed.mimeType,
      expectedMediaType,
    );
    const assetId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    storedPath = moveIntoAssetStorage(parsed.temporaryPath, assetId, extension);
    const name = path.basename(parsed.filename, path.extname(parsed.filename)).trim() || "未命名素材";
    const status = createAsset({
      assetId, uploadId, name: name.slice(0, 255), originalFilename: parsed.filename,
      originalPath: storedPath, mimeType: parsed.mimeType, declaredMime: parsed.mimeType,
      mediaType: expectedMediaType, sizeBytes: parsed.sizeBytes, directPublish: parsed.directPublish,
    });
    return Response.json(status, { status: 202 });
  } catch (error) {
    if (parsed?.temporaryPath) removeTemporaryFile(parsed.temporaryPath);
    if (storedPath) {
      try { removeAssetFiles(storedPath); } catch { /* preserve upload error */ }
    }
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/uploads/images") return handleUpload(request, "image");
  if (pathname === "/api/uploads/videos") return handleUpload(request, "video");
  return errorResponse(new AppError("invalid_request", "请使用 /api/uploads/images 或 /api/uploads/videos。"));
}
