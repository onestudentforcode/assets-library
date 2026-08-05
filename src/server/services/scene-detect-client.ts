import fs from "node:fs";
import { openAsBlob } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { loadConfig } from "@/server/config";
import { AppError } from "@/server/errors";

const segmentSchema = z.object({
  index: z.number().int().positive(),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  durationSeconds: z.number().positive(),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
  filename: z.string().min(1),
  downloadUrl: z.string().min(1),
});

export const sceneSplitResponseSchema = z
  .object({
    taskId: z.string().regex(/^[0-9a-f]{32}$/i),
    originalFilename: z.string().min(1),
    durationSeconds: z.number().positive(),
    sceneCount: z.number().int().positive(),
    segments: z.array(segmentSchema).min(1),
  })
  .superRefine((value, context) => {
    if (value.sceneCount !== value.segments.length) {
      context.addIssue({ code: "custom", message: "分镜数量与清单不一致。" });
    }
    const indexes = new Set(value.segments.map((segment) => segment.index));
    if (
      indexes.size !== value.segments.length ||
      value.segments.some((segment, position) => segment.index !== position + 1)
    ) {
      context.addIssue({ code: "custom", message: "分镜索引必须连续且唯一。" });
    }
  });

export type SceneSplitResponse = z.infer<typeof sceneSplitResponseSchema>;

export interface SceneDetectGateway {
  split(filePath: string, filename: string): Promise<SceneSplitResponse>;
  getTask(taskId: string): Promise<SceneSplitResponse>;
  downloadSegment(
    taskId: string,
    index: number,
    targetPath: string,
    maximumBytes: number,
  ): Promise<number>;
  deleteTask(taskId: string): Promise<void>;
}

function sceneFailure(message: string, cause?: unknown) {
  return new AppError(
    "scene_split_failed",
    cause instanceof Error ? `${message}：${cause.message}` : message,
    502,
  );
}

export class SceneDetectClient implements SceneDetectGateway {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  constructor(
    baseUrl = loadConfig().SCENE_DETECT_BASE_URL,
    timeoutMs = loadConfig().SCENE_DETECT_TIMEOUT_MS,
  ) {
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    this.timeoutMs = timeoutMs;
  }

  private async request(url: URL, init?: RequestInit) {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw sceneFailure("无法连接视频分镜服务", error);
    }
  }

  async split(filePath: string, filename: string): Promise<SceneSplitResponse> {
    const body = new FormData();
    body.append("file", await openAsBlob(filePath, { type: "video/mp4" }), filename);
    const response = await this.request(new URL("api/v1/videos/split", this.baseUrl), {
      method: "POST",
      body,
    });
    return this.parseManifestResponse(response, true);
  }

  async getTask(taskId: string): Promise<SceneSplitResponse> {
    const response = await this.request(
      new URL(`api/v1/videos/split/${encodeURIComponent(taskId)}`, this.baseUrl),
    );
    return this.parseManifestResponse(response);
  }

  private async parseManifestResponse(response: Response, cleanupInvalid = false) {
    if (!response.ok) {
      throw sceneFailure(`视频分镜服务返回 HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
      return sceneSplitResponseSchema.parse(payload);
    } catch (error) {
      const taskId =
        payload &&
        typeof payload === "object" &&
        "taskId" in payload &&
        typeof payload.taskId === "string" &&
        /^[0-9a-f]{32}$/i.test(payload.taskId)
          ? payload.taskId
          : null;
      if (cleanupInvalid && taskId) {
        try {
          await this.deleteTask(taskId);
        } catch {
          // The invalid response remains the primary failure.
        }
      }
      throw sceneFailure("视频分镜服务返回了非法清单", error);
    }
  }

  async downloadSegment(
    taskId: string,
    index: number,
    targetPath: string,
    maximumBytes: number,
  ) {
    const response = await this.request(
      new URL(
        `api/v1/videos/split/${encodeURIComponent(taskId)}/segments/${index}`,
        this.baseUrl,
      ),
    );
    if (!response.ok || !response.body) {
      throw sceneFailure(`分镜 ${index} 下载失败（HTTP ${response.status}）`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    let sizeBytes = 0;
    const sizeGate = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        callback(
          sizeBytes > maximumBytes ? new AppError("file_too_large") : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        sizeGate,
        fs.createWriteStream(targetPath, { flags: "wx" }),
      );
      if (sizeBytes === 0) throw sceneFailure(`分镜 ${index} 下载为空文件`);
      return sizeBytes;
    } catch (error) {
      fs.rmSync(targetPath, { force: true });
      if (error instanceof AppError) throw error;
      throw sceneFailure(`分镜 ${index} 下载失败`, error);
    }
  }

  async deleteTask(taskId: string) {
    const response = await this.request(
      new URL(`api/v1/videos/split/${encodeURIComponent(taskId)}`, this.baseUrl),
      { method: "DELETE" },
    );
    if (!response.ok) throw sceneFailure(`清理外部分镜任务失败（HTTP ${response.status}）`);
  }
}
