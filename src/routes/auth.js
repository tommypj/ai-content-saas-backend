'use strict';
/**
 * Auth routes: /auth/register, /auth/login
 * - Zod validation
 * - Uses User model
 * - Issues JWT on success
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const User = require('../models/User');

const router = express.Router();

// --- Schemas ---
const registerSchema = z.object({
  username: z.string().min(3).max(64).trim().toLowerCase(),
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(8),
  settings: z.record(z.any()).optional(),
});

const loginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(8),
});

// --- Helpers ---
function signJwt(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error('JWT_SECRET not configured');
    err.status = 500;
    throw err;
  }
  const payload = { sub: user.id, username: user.username };
  return jwt.sign(payload, secret, { expiresIn: '1d' });
}

// --- Routes ---
// POST /auth/register
router.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    }
    const { username, email, password, settings = {} } = parsed.data;

    const existing = await User.findOne({ $or: [{ email }, { username }] }).lean();
    if (existing) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const user = new User({ username, email, password, settings });
    await user.save();

    const token = signJwt(user);
    return res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        settings: user.settings || {},
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// POST /auth/login
router.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    }
    const { email, password } = parsed.data;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signJwt(user);
    return res.status(200).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        settings: user.settings || {},
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
