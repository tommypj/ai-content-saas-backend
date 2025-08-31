// Route: GET /jobs/:id
// Notes:
// - Protected by JWT middleware (assumes req.user.id present).
// - Validates :id with Zod.
// - Returns shape per 04-api-contracts JobResponse: { id, userId, type, status, startedAt?, finishedAt?, error?, result? }
// - Scopes to the requesting user; returns 404 if not found or belongs to another user.

const express = require("express");
const { z } = require("zod");
const mongoose = require("mongoose");
const { Schema } = mongoose;
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

/**
 * Minimal JobModel data-access placeholder.
 * Replace with your real repository/ORM (e.g., Mongoose, Prisma).
 */
const JobModel = {
  /**
   * @param {string} id
   * @returns {Promise<null | {
   *   id: string,
   *   userId: string,
   *   type: string,
   *   status: keyof typeof JobStatus,
   *   result?: unknown,
   *   error?: unknown,
   *   startedAt?: string | Date,
   *   finishedAt?: string | Date,
   * }>}
   */
  // eslint-disable-next-line no-unused-vars
  async getById(id) {
    const doc = await Job.findById(id).lean();
    if (!doc) return null;
    return {
      id: String(doc._id),
      userId: String(doc.userId),
      type: doc.type,
      status: doc.status,
      // Optional fields per contract — only include if present in the DB.
      ...(typeof doc.result !== "undefined" ? { result: doc.result } : {}),
      ...(doc.error ? { error: doc.error } : {}),
      // If you add explicit startedAt/finishedAt later, include them here.
    };
  },
};

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

    const job = await JobModel.getById(parse.data);
    if (!job || job.userId !== userId) {
      return res.status(404).json({ error: "Job not found" });
    }

    const response = {
      id: job.id,
      userId: job.userId,
      type: job.type,
      status: job.status,
      // Optional contract fields — only include if present.
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(typeof job.result !== "undefined" ? { result: job.result } : {}),
    };

    return res.status(200).json(response);
  } catch (err) {
    return next(err);
  }
});

module.exports = { jobsRouter };

// Aligns to 06-data-models.md Job collection fields. Status per 06-workflow.md.
const JobSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["KEYWORDS", "ARTICLE", "SEO"],
      required: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"],
      required: true,
      default: "PENDING",
    },
    payload: { type: Schema.Types.Mixed },
    result: { type: Schema.Types.Mixed },
    error: { type: Schema.Types.Mixed },
    tokensUsed: { type: Number, default: 0 },
    attempt: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Job", JobSchema);