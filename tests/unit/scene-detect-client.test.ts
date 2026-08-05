import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SceneDetectClient,
  sceneSplitResponseSchema,
} from "@/server/services/scene-detect-client";

describe("scene detection client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts the upstream 32-character UUID hex task identifier", () => {
    expect(
      sceneSplitResponseSchema.parse({
        taskId: "6fc24bee8df44ff8a67047d69c61be01",
        originalFilename: "source.mp4",
        durationSeconds: 2,
        sceneCount: 1,
        segments: [
          {
            index: 1,
            startSeconds: 0,
            endSeconds: 2,
            durationSeconds: 2,
            startFrame: 0,
            endFrame: 48,
            sizeBytes: 4,
            filename: "segment-001.mp4",
            downloadUrl: "/api/v1/videos/split/task/segments/1",
          },
        ],
      }).taskId,
    ).toBe("6fc24bee8df44ff8a67047d69c61be01");
  });

  it("streams segment downloads and rejects one byte above 7 MiB", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scene-client-"));
    const client = new SceneDetectClient("http://127.0.0.1:28200", 1_000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(7 * 1024 * 1024 + 1), { status: 200 }),
    );
    await expect(
      client.downloadSegment("a".repeat(32), 1, path.join(directory, "too-large.mp4"), 7 * 1024 * 1024),
    ).rejects.toMatchObject({ code: "file_too_large" });
    await expect(fs.stat(path.join(directory, "too-large.mp4"))).rejects.toThrow();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("rejects an empty manifest and best-effort deletes its upstream task", async () => {
    const taskId = "b".repeat(32);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          taskId,
          originalFilename: "empty.mp4",
          durationSeconds: 1,
          sceneCount: 0,
          segments: [],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scene-invalid-"));
    const source = path.join(directory, "source.mp4");
    await fs.writeFile(source, "video");
    const client = new SceneDetectClient("http://127.0.0.1:28200", 1_000);
    await expect(client.split(source, "empty.mp4")).rejects.toMatchObject({
      code: "scene_split_failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    await fs.rm(directory, { recursive: true, force: true });
  });
});
