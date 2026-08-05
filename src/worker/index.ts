import {
  claimNextJob,
  recoverStaleJobs,
  requeueFailedEmbeddingJobs,
} from "@/server/repositories/assets";
import { loadConfig } from "@/server/config";
import { processJob } from "@/server/services/processing";
import {
  claimNextSceneBatchJob,
  discardSettledSceneBatchJobs,
  recoverStaleSceneBatchJobs,
  reconcileAnalyzingSceneBatches,
} from "@/server/repositories/scene-batches";
import {
  cleanupSettledSceneBatchArtifacts,
  processSceneBatchJob,
} from "@/server/services/scene-batch-processing";

const pollIntervalMs = 1_000;
const recoveryIntervalMs = 30_000;
let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  const config = loadConfig();
  recoverStaleJobs();
  discardSettledSceneBatchJobs();
  recoverStaleSceneBatchJobs();
  reconcileAnalyzingSceneBatches();
  await cleanupSettledSceneBatchArtifacts();
  const requeuedEmbeddings = requeueFailedEmbeddingJobs();
  if (requeuedEmbeddings > 0) {
    console.log(`Requeued ${requeuedEmbeddings} failed embedding job(s).`);
  }
  const recoveryTimer = setInterval(() => {
    const recovered = recoverStaleJobs();
    const discardedSceneBatches = discardSettledSceneBatchJobs();
    const recoveredSceneBatches = recoverStaleSceneBatchJobs();
    const reconciledSceneBatches = reconcileAnalyzingSceneBatches();
    if (recovered + recoveredSceneBatches > 0) {
      console.log(
        `Recovered ${recovered} asset job(s) and ${recoveredSceneBatches} scene batch job(s).`,
      );
    }
    if (reconciledSceneBatches > 0) {
      console.log(`Reconciled ${reconciledSceneBatches} scene batch(es).`);
    }
    if (discardedSceneBatches > 0) {
      console.log(`Discarded ${discardedSceneBatches} settled scene batch job(s).`);
    }
  }, recoveryIntervalMs);
  console.log(
    `Asset processing worker started (model: ${config.modelConfigured ? "configured" : "not configured"}, protocol: ${config.MODEL_PROTOCOL}).`,
  );
  while (!stopping) {
    const sceneBatchJob = claimNextSceneBatchJob();
    if (sceneBatchJob) {
      await processSceneBatchJob(sceneBatchJob);
      continue;
    }
    const job = claimNextJob();
    if (job) {
      await processJob(job);
      reconcileAnalyzingSceneBatches();
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  clearInterval(recoveryTimer);
  console.log("Asset processing worker stopped.");
}

void main();
