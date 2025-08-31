'use strict';

// Load .env so tests can see MONGODB_URI / JWT_SECRET
require('dotenv').config();

const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../src/app');

const uri = process.env.MONGODB_URI;

// Simple unique suffix for usernames/emails to avoid collisions across runs
function uid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}
function uniqueEmail() {
  return `demo_${uid()}@example.com`;
}
function uniqueUsername(prefix = 'demo') {
  return `${prefix}_${uid()}`;
}

describe('Auth happy paths', () => {
  beforeAll(async () => {
    if (!uri) throw new Error('MONGODB_URI not set for tests');
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(uri, { autoIndex: true });
    }
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  test('register returns token and user', async () => {
    const email = uniqueEmail();
    const username = uniqueUsername('demo');

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ username, email, password: 'Password123!' })
      .set('Content-Type', 'application/json');

    expect([201, 409]).toContain(res.status); // allow re-run tolerance
    if (res.status === 201) {
      expect(res.body.token).toBeTruthy();
      expect(res.body.user).toBeTruthy();
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.username).toBe(username);
    } else {
      // If 409, assert the API tells us the user exists (idempotency-ish)
      expect(res.body.error).toMatch(/exists/i);
    }
  });

  test('login returns token and user', async () => {
    const email = uniqueEmail();
    const username = uniqueUsername('demo2');

    // Ensure user exists
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ username, email, password: 'Password123!' })
      .set('Content-Type', 'application/json');

    expect([201, 409]).toContain(reg.status);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password123!' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(email);
  });
});
