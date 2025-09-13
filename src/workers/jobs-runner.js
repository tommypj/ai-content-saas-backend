
// backend/src/workers/jobs-runner.js
// Jobs runner: claims oldest PENDING KEYWORDS job and runs it with AI.
const Job = require("../models/Job");
const { generateKeywords, generateArticle, generateSEOReview, generateMeta, generateImage, generateHashtags } = require("../providers/ai");

let busy = false;

// Standardize provider label to Gemini unless overridden
const PROVIDER = process.env.AI_PROVIDER || "gemini";
const INSTANCE_ID = process.env.WORKER_INSTANCE_ID || `worker-${process.pid}`;

const MAX_RAW_SNIPPET = 500;

function toJobError(err, type = "PROVIDER") {
  const message = err?.message || String(err || "Unknown error");
  // Try to capture a small snippet of any raw text for debugging without bloating DB
  const raw = err?.raw || err?.rawText || err?.response?.data || err?.stack || "";
  const rawSnippet = typeof raw === "string" ? raw.slice(0, MAX_RAW_SNIPPET) : undefined;
  const parseError = err?.parseError;
  return {
    type,
    code: err?.code || "AI_CALL_FAILED",
    provider: process.env.AI_PROVIDER || "gemini",
    message,
    ...(rawSnippet ? { rawSnippet } : {}),
    ...(parseError ? { parseError } : {}),
  };
}


async function processOne() {
  if (busy) return;
  busy = true;
  let job = null;
  try {
    // Atomically claim one job to avoid double-processing in multi-instance setups
    job = await Job.findOneAndUpdate(
      { 
        status: "PENDING", 
        type: { $in: ["KEYWORDS", "ARTICLE", "SEO", "META", "IMAGE", "HASHTAGS"] },
        $or: [
          { claimedBy: { $exists: false } },
          { claimedBy: INSTANCE_ID }
        ]
      },
      { 
        $set: { 
          status: "RUNNING",
          claimedBy: INSTANCE_ID,
          claimedAt: new Date()
        } 
      },
      { sort: { createdAt: 1 }, new: true }
    ).lean();

    if (!job) { busy = false; return; } // nothing to do (ensure busy is released)

    const jobType = job.type;
    const seed = (job.payload && (job.payload.seed || job.payload.topic)) || "untitled";
    const locale = (job.payload && job.payload.locale) || process.env.DEFAULT_LOCALE || "en";
    const maxAttempts = Number(process.env.JOB_MAX_ATTEMPTS || 3);

    let lastErr = null;
    for (let a = job.attempt || 0; a < maxAttempts; a++) {
      try {
        let result, tokensUsed, model;
        
        if (jobType === "KEYWORDS") {
          // Expect generateKeywords to return { result, tokensUsed, model }
          const response = await generateKeywords({ seed, locale });
          result = response.result;
          tokensUsed = response.tokensUsed;
          model = response.model;
        } else if (jobType === "ARTICLE") {
          // Extract keywords and settings from payload
          const keywords = job.payload?.keywords || [];
          const settings = job.payload?.settings || {};
          const response = await generateArticle({ keywords, topic: seed, locale, settings });
          result = response.result;
          tokensUsed = response.tokensUsed;
          model = response.model;
        } else if (jobType === "SEO") {
          // Extract article from payload - expect title and content directly
          const title = job.payload?.title;
          const content = job.payload?.content;
          const keywords = job.payload?.keywords || [];
          if (!title || !content) {
            throw new Error('SEO job requires title and content in payload');
          }
          const article = { title, content };
          const response = await generateSEOReview({ article, keywords, topic: seed, locale });
          result = response.result;
          tokensUsed = response.tokensUsed;
          model = response.model;
        } else if (jobType === "META") {
          console.log('[DEBUG] Processing META job with payload:', JSON.stringify(job.payload, null, 2));
          // Extract article from payload - expect title and content directly
          const title = job.payload?.title;
          const content = job.payload?.content;
          const keywords = job.payload?.keywords || [];
          if (!title || !content) {
            throw new Error('META job requires title and content in payload');
          }
          const article = { title, content };
          console.log('[DEBUG] Calling generateMeta with:', { articleTitle: article.title, keywordsCount: keywords.length, topic: seed });
          const response = await generateMeta({ article, keywords, topic: seed, locale });
          result = response.result;
          tokensUsed = response.tokensUsed;
          model = response.model;
          console.log('[DEBUG] META generation completed successfully');
        } else if (jobType === "IMAGE") {
          console.log('[DEBUG] Processing IMAGE job with payload:', JSON.stringify(job.payload, null, 2));
          // Extract article from payload - expect title and content directly
          const title = job.payload?.title;
          const content = job.payload?.content;
          const keywords = job.payload?.keywords || [];
          if (!title || !content) {
            throw new Error('IMAGE job requires title and content in payload');
          }
          const article = { title, content };
          console.log('[DEBUG] Calling generateImage with:', { articleTitle: article.title, keywordsCount: keywords.length, topic: seed });
          const response = await generateImage({ article, keywords, topic: seed, locale });
          result = response.result;
          tokensUsed = response.tokensUsed;
          model = response.model;
          console.log('[DEBUG] IMAGE generation completed successfully');
        } else if (jobType === "HASHTAGS") {
          console.log('[DEBUG] Processing HASHTAGS job with payload:', JSON.stringify(job.payload, null, 2));
          // Extract article from payload - expect title and content directly
          const title = job.payload?.title;
          const content = job.payload?.content;
          const keywords = job.payload?.keywords || [];
          if (!title || !content) {
            throw new Error('HASHTAGS job requires title and content in payload');
          }
          const article = { title, content };
          console.log('[DEBUG] Calling generateHashtags with:', { articleTitle: article.title, keywordsCount: keywords.length, topic: seed });
          const response = await generateHashtags({ article, keywords, topic: seed, locale });
          result = response.result;
          tokensUsed = response.tokensUsed;
          model = response.model;
          console.log('[DEBUG] HASHTAGS generation completed successfully');
        } else {
          throw new Error(`Unsupported job type: ${jobType}`);
        }
        await Job.updateOne(
          { _id: job._id },
          {
            $set: { status: "SUCCEEDED", result, model, attempt: a + 1 },
            $inc: { tokensUsed: Number(tokensUsed || 0) }
          }
        );
        lastErr = null;
        break;
      } catch (err) {
        console.error(`[ERROR] Job ${jobType} failed on attempt ${a + 1}:`, err.message);
        console.error('[ERROR] Full error:', err);
        lastErr = err;
        // brief backoff before retry
        await new Promise(r => setTimeout(r, 300 + a * 300));
      }
    }

    if (lastErr) {
      await Job.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "FAILED",
            attempt: maxAttempts,
            error: toJobError(lastErr)
          }
        }
      );
    }
  } catch (err) {
    // Best-effort failure marking if we've already claimed a job
    if (job && job._id) {
      await Job.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "FAILED",
            error: toJobError(err, "WORKER_UNCAUGHT")
          }
        }
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
