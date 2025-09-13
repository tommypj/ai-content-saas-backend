// Route: GET /jobs/:id
// Notes:
// - Protected by JWT middleware (assumes req.user.id present).
// - Validates :id with Zod.
// - Returns shape per 04-api-contracts JobResponse: { id, userId, type, status, startedAt?, finishedAt?, error?, result? }
// - Scopes to the requesting user; returns 404 if not found or belongs to another user.

const express = require("express");
const { z } = require("zod");

// Use the canonical Job model to avoid OverwriteModelError
const Job = require("../models/Job");

const jobsRouter = express.Router();

// Accept common MongoDB ObjectId (24 hex). If you use UUIDs, adjust the schema.
const idSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "Invalid job id format");

// Job status per workflow doc.
// (Heads-up: elsewhere we must use 'SUCCEEDED' not 'SUCCESS'.)
const JobStatus = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
};

// Removed JobModel abstraction - using Job model directly

/**
 * GET /jobs/:id
 */
jobsRouter.get("/jobs/:id", async (req, res, next) => {
  try {
    const parse = idSchema.safeParse(req.params.id);
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.issues[0].message });
    }

    const userId = req?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const job = await Job.findById(parse.data).lean();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (String(job.userId) !== userId) {
      return res.status(404).json({ error: "Job not found" });
    }

    const response = {
      id: String(job._id),
      userId: String(job.userId),
      type: job.type,
      status: job.status,
      // Optional contract fields — only include if present.
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.tokensUsed ? { tokensUsed: job.tokensUsed } : {}),
      ...(job.model ? { model: job.model } : {}),
    };

    return res.status(200).json(response);
  } catch (err) {
    return next(err);
  }
});

module.exports = { jobsRouter };