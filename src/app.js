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
