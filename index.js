'use strict';

const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { app, logger } = require('./src/app');

dotenv.config();

const PORT = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ai-content-saas';

// start HTTP server
const server = app.listen(PORT, () => logger.info(`API listening on :${PORT}`));

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
