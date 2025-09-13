'use strict';

const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { app, logger } = require('./src/app');
const { startJobsRunner } = require("./src/workers/jobs-runner");


dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['JWT_SECRET', 'MONGODB_URI', 'GOOGLE_API_KEY'];
const missing = requiredEnvVars.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Please check your .env file and ensure all required variables are set.');
  process.exit(1);
}

const PORT = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ai-content-saas';
const WORKER_INTERVAL_MS = Number(process.env.JOBS_RUNNER_INTERVAL_MS || 1500);

// start HTTP server
const server = app.listen(PORT, () => logger.info(`API listening on :${PORT}`));

// start background worker (in-process, Phase 3 stub)
try {
  logger.info(`[jobs-runner] starting (interval=${WORKER_INTERVAL_MS}ms)`);
  startJobsRunner({ intervalMs: WORKER_INTERVAL_MS });
} catch (err) {
  logger.error(`jobs-runner failed to start: ${err?.message || err}`);
}

// connect Mongo (retry simple)
let connecting = false;
async function connectMongo() {
  if (connecting) return;
  connecting = true;
  try {
    await mongoose.connect(uri, { autoIndex: true });
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error(`Mongo connect failed: ${err.message}`);
    setTimeout(() => {
      connecting = false;
      connectMongo();
    }, 3000);
  }
}
connectMongo();

// graceful shutdown
process.on('SIGINT', async () => {
  await mongoose.connection.close().catch(() => {});
  server.close(() => process.exit(0));
});
