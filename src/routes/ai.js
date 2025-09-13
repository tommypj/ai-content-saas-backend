// @ts-nocheck
'use strict';

// CJS router so src/app.js can require('./routes/ai') at runtime.
// Mirrors the existing ai.ts behavior for POST /ai/:type (KEYWORDS only).
const express = require('express');
const router = express.Router();
const Job = require('../models/Job');

const ALLOWED_TYPES = new Set(['KEYWORDS', 'ARTICLE', 'SEO', 'META', 'IMAGE', 'HASHTAGS']);

router.post('/ai', async (req, res, next) => {
  console.log('[DEBUG] POST /ai called with body:', req.body);
  try {
    const type = String(req.body?.type || '').toUpperCase();
    console.log('[DEBUG] Job type:', type);
    if (!ALLOWED_TYPES.has(type)) {
      console.log('[DEBUG] Unsupported type:', type, 'Supported:', Array.from(ALLOWED_TYPES));
      return res.status(400).json({
        error: 'Unsupported AI job type',
        supported: Array.from(ALLOWED_TYPES),
        received: type
      });
    }

    const userId = (req && req.user && (req.user.id || req.user._id)) || null;
    console.log('[DEBUG] User ID:', userId);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Extract the type from body, and pass the rest as payload
    const { type: jobType, ...payload } = req.body || {};
    console.log('[DEBUG] Creating job with payload:', payload);

    const doc = await Job.create({
      userId,
      type,
      status: 'PENDING',
      payload,
      attempt: 0,
      tokensUsed: 0,
    });

    console.log('[DEBUG] Job created successfully:', doc._id);
    return res.status(201).json({ id: String(doc._id) });
  } catch (err) {
    console.error('[ERROR] POST /ai failed:', err);
    next(err);
  }
});

// Debug endpoint to test if routes are loaded
router.get('/ai/debug', (req, res) => {
  res.json({ 
    message: 'AI route is loaded successfully', 
    allowedTypes: Array.from(ALLOWED_TYPES),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
