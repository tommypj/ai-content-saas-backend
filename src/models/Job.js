'use strict';

const mongoose = require('mongoose');

const JobSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['KEYWORDS', 'ARTICLE', 'SEO', 'META', 'IMAGE', 'HASHTAGS'], required: true, index: true },
    status: { type: String, enum: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'], required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    result: { type: mongoose.Schema.Types.Mixed },
    error: { type: mongoose.Schema.Types.Mixed },
    model: { type: String },
    tokensUsed: { type: Number, default: 0 },
    attempt: { type: Number, default: 0 },
    claimedBy: { type: String },
    claimedAt: { type: Date }
  },
  { timestamps: true }
);

// Helps the worker claim the oldest PENDING job by type efficiently
JobSchema.index({ status: 1, type: 1, createdAt: 1 });

module.exports = mongoose.models.Job || mongoose.model('Job', JobSchema);
