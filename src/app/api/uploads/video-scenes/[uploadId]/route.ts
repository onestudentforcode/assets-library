import { errorResponse } from "@/server/errors";
import {
  dismissFailedSceneBatch,
  getVideoSceneBatchStatus,
} from "@/server/repositories/scene-batches";

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

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ uploadId: string }> },
) {
  try {
    const { uploadId } = await context.params;
    dismissFailedSceneBatch(uploadId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
