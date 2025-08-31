
// backend/src/workers/jobs-runner.js
// Phase 3 stub worker: picks the oldest PENDING KEYWORDS job, marks RUNNING,
// writes a mock result, then marks SUCCEEDED. Safe to replace with real AI later.
const Job = require("../models/Job");

let busy = false;

async function processOne() {
  if (busy) return;
  busy = true;
  let job = null;
  try {
    // Atomically claim one job to avoid double-processing in multi-instance setups
    job = await Job.findOneAndUpdate(
      { status: "PENDING", type: "KEYWORDS" },
      { $set: { status: "RUNNING" } },
      { sort: { createdAt: 1 }, new: true }
    ).lean();

    if (!job) return; // nothing to do

    const seed =
      (job.payload && (job.payload.seed || job.payload.topic)) || "untitled";

    // --- MOCK RESULT (to be replaced by real AI call)
    const keywords = Array.from({ length: 10 }, (_, i) => ({
      keyword: `${seed} keyword ${i + 1}`,
      volume: Math.max(100, 1200 - i * 75),
      difficulty: Math.max(5, 60 - i * 4),
      source: "mock",
    }));
    const result = { topic: seed, keywords };
    // --- end mock

    await Job.updateOne(
      { _id: job._id },
      { $set: { status: "SUCCEEDED", result } }
    );
  } catch (err) {
    // Best-effort failure marking if we've already claimed a job
    if (job && job._id) {
      await Job.updateOne(
        { _id: job._id },
        { $set: { status: "FAILED", error: { message: String(err?.message || err) } } }
      ).catch(() => {});
    }
  } finally {
    busy = false;
  }
}

function startJobsRunner(options = {}) {
  const intervalMs = options.intervalMs ?? 1500;
  setInterval(processOne, intervalMs);
  // eslint-disable-next-line no-console
  console.log(`[jobs-runner] started (interval=${intervalMs}ms)`);
}

module.exports = { startJobsRunner };
