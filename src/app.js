'use strict';

const express = require('express');
const cors = require('cors');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

const app = express();
app.use(cors());
app.use(express.json());

// ---- API v1 Routers (protected) ----
const { requireAuth } = require('./middleware/auth');
const aiRouter = require('./routes/ai');
const { jobsRouter } = require('./routes/jobs');

// versioned base path per architecture
app.use('/api/v1', requireAuth, aiRouter);
app.use('/api/v1', requireAuth, jobsRouter);


// routes
const authRoutes = require('./routes/auth');
app.use('/api/v1/auth', authRoutes);

// health
app.get('/health', (_req, res) => res.json({ ok: true }));

// centralized error handler
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  logger.error(err.stack || err.message || 'Unhandled error');
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

module.exports = { app, logger };
