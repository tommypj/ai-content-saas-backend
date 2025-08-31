// backend/src/routes/ai.ts
import { Router } from "express";

/* TEMP: Allow CommonJS require in TS until @types/node (or full TS backend) is in place. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;

/**
 * Assumptions:
 * - An auth middleware attaches `user` to `req` with `id` (e.g., `requireAuth`).
 * - Mongoose is configured; Job model exists at ../models/Job (CommonJS).
 * - Strict body validation will be added later, per contracts.
 */

// Minimal typing to avoid Express/Node typings friction for now.
type ReqWithUser = any;

// Phase 3 initial scope: only KEYWORDS job creation.
const ALLOWED_TYPES = new Set(["KEYWORDS"]);

// Status per workflow: PENDING → RUNNING → SUCCEEDED | FAILED.
type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

// Use the real Mongoose Job model (CommonJS export).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Job: any = require("../models/Job");

// Thin data-layer wrapper to keep the route clean.
const JobModel = {
  async create(data: { type: string; status: JobStatus; payload: unknown; userId: string }) {
    const doc = await Job.create({
      userId: data.userId,
      type: data.type,
      status: data.status,
      payload: data.payload,
    });
    return { id: String(doc._id), type: String(doc.type), status: doc.status as JobStatus };
  },
};

export const aiRouter = Router();

/**
 * POST /ai/:type
 * Creates a job with status PENDING for supported AI job types.
 *
 * Request:
 *   - params.type: "KEYWORDS" (only, for this step)
 *   - body: arbitrary JSON persisted as `payload` (schema to follow)
 * Response: 201 { jobId }
 */
aiRouter.post("/ai/:type", async (req: ReqWithUser, res, next) => {
  try {
    const { type } = (req.params ?? {}) as { type?: string };
    if (!type || !ALLOWED_TYPES.has(type)) {
      return res.status(400).json({
        error: "Unsupported AI job type for this phase",
        supported: Array.from(ALLOWED_TYPES),
      });
    }

    const userId = req?.user?.id as string | undefined;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Defer strict validation; accept any JSON for now.
    const payload = req.body ?? {};

    const job = await JobModel.create({ type, status: "PENDING", payload, userId });
    return res.status(201).json({ jobId: job.id });
  } catch (err) {
    return next(err);
  }
});

export default aiRouter;
