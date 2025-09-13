'use strict';

const express = require('express');
const cors = require('cors');
const winston = require('winston');
const { requireAuth } = require('./middleware/auth');
const authRouter = require('./routes/auth');
const aiRouter = require('./routes/ai');
const { jobsRouter } = require('./routes/jobs');

const logger = winston.createLogger({
  level: 'info',
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

const app = express();
// Allow frontend at localhost:5173; add credentials if you use cookies
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());

// ---- PUBLIC auth routes (no JWT) ----
app.use('/api/v1/auth', authRouter);

// ---- PUBLIC debug route (no JWT) ----
app.get('/api/v1/debug', (req, res) => {
  res.json({ 
    message: 'Backend is running correctly',
    timestamp: new Date().toISOString(),
    routes: ['auth', 'ai', 'jobs'],
    status: 'ok'
  });
});

// ---- PROTECTED routes (require JWT) ----
app.use('/api/v1', requireAuth, aiRouter);
app.use('/api/v1', requireAuth, jobsRouter);

// health
app.get('/health', (_req, res) => res.json({ ok: true }));

// centralized error handler
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  logger.error(err.stack || err.message || 'Unhandled error');
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

module.exports = { app, logger };
