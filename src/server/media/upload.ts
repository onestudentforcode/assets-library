import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import Busboy from "busboy";
import { AppError } from "@/server/errors";
import { temporaryUploadPath } from "@/server/media/storage";
import type { MediaType } from "@/shared/contracts";

export interface ParsedUpload {
  temporaryPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  directPublish: boolean;
}

function storageError() {
  return new AppError("storage_error", undefined, 500);
}

export function removeTemporaryFile(pathToRemove: string) {
  try {
    fs.rmSync(pathToRemove, { force: true });
  } catch {
    // The original upload error is more actionable than cleanup failures.
  }
}

export function parseMultipart(
  request: Request,
  maximumBytes: number,
): Promise<ParsedUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new AppError("invalid_request", "请求必须使用 multipart/form-data。");
  }
  if (!request.body) throw new AppError("invalid_request");

  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: Object.fromEntries(request.headers.entries()),
      defParamCharset: "utf8",
      limits: { files: 1, fileSize: maximumBytes },
    });
    let temporaryPath = "";
    let filename = "";
    let mimeType = "";
    let sizeBytes = 0;
    let directPublish = false;
    const fileWrites: Promise<void>[] = [];
    const outputs: fs.WriteStream[] = [];
    let parseError: Error | null = null;
    let finalizing = false;
    const fail = (error: Error) => { parseError ??= error; };
    const finish = async () => {
      if (finalizing) return;
      finalizing = true;
      if ((await Promise.allSettled(fileWrites)).some((result) => result.status === "rejected")) {
        fail(storageError());
      }
      if (parseError || !temporaryPath || !filename || sizeBytes === 0) {
        removeTemporaryFile(temporaryPath);
        reject(parseError ?? new AppError("invalid_request", "请选择一个非空文件。"));
        return;
      }
      resolve({ temporaryPath, filename, mimeType, sizeBytes, directPublish });
    };

    busboy.on("field", (name, value) => {
      if (name === "directPublish") directPublish = value === "true";
      else fail(new AppError("invalid_request", "不支持额外的表单字段。"));
    });
    busboy.on("file", (name, stream, info) => {
      if (name !== "file" || temporaryPath) {
        stream.resume();
        fail(new AppError(name === "file" ? "multiple_files" : "invalid_request"));
        return;
      }
      try {
        temporaryPath = temporaryUploadPath(crypto.randomUUID());
        const output = fs.createWriteStream(temporaryPath, { flags: "wx" });
        outputs.push(output);
        fileWrites.push(new Promise<void>((resolveWrite, rejectWrite) => {
          output.on("finish", resolveWrite);
          output.on("error", () => rejectWrite(storageError()));
          stream.on("error", () => rejectWrite(storageError()));
        }));
        filename = path.basename(info.filename);
        mimeType = info.mimeType;
        stream.on("data", (chunk: Buffer) => { sizeBytes += chunk.length; });
        stream.on("limit", () => fail(new AppError("file_too_large")));
        stream.pipe(output);
      } catch {
        stream.resume();
        fail(storageError());
      }
    });
    busboy.on("filesLimit", () => fail(new AppError("multiple_files")));
    busboy.on("error", () => {
      fail(new AppError("invalid_request"));
      for (const output of outputs) output.destroy();
      void finish();
    });
    busboy.on("finish", () => { void finish(); });
    const source = Readable.fromWeb(request.body as never);
    source.on("error", () => {
      fail(new AppError("invalid_request"));
      for (const output of outputs) output.destroy();
      void finish();
    });
    source.pipe(busboy);
  });
}

export function uploadExtension(
  filename: string,
  declaredMime: string,
  expectedMediaType: MediaType,
) {
  const extension = path.extname(filename).toLowerCase();
  if (expectedMediaType === "video") {
    if (extension !== ".mp4" || declaredMime !== "video/mp4") {
      throw new AppError("unsupported_media_type", "视频接口仅接受 H.264 MP4 视频。");
    }
    return extension;
  }
  const imageTypes = new Map([
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".png", "image/png"],
    [".webp", "image/webp"],
  ]);
  if (imageTypes.get(extension) !== declaredMime) {
    throw new AppError("unsupported_media_type", "图片接口仅接受 JPEG、PNG、JPG 或 WebP 图片。");
  }
  return extension;
}
