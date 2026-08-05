import { errorResponse } from "@/server/errors";
import { getVideoSceneBatchStatus } from "@/server/repositories/scene-batches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ uploadId: string }> },
) {
  try {
    const { uploadId } = await context.params;
    return Response.json(getVideoSceneBatchStatus(uploadId));
  } catch (error) {
    return errorResponse(error);
  }
}
