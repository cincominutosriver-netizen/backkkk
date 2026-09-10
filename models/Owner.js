const mongoose = require('mongoose');

const ownerSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    unique: true,
    index: true
  },
  passwordHash: String,
  passwordSalt: String,
  passwordIterations: Number,
  googleSub: {
    type: String,
    trim: true,
    index: true
  },
  username: {
    type: String,
    trim: true,
    lowercase: true,
    unique: true,
    sparse: true,
    index: true
  },
  authProviders: {
    type: [String],
    default: []
  },
  preferences: {
    theme: {
      type: String,
      enum: ['light', 'dark'],
      default: 'light'
    }
  },
  favorites: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event'
    }
  ],
  moderation: {
    isBlocked: {
      type: Boolean,
      default: false,
      index: true
    },
    blockedAt: Date,
    blockedBy: {
      type: String,
      trim: true,
      lowercase: true
    },
    blockedReason: {
      type: String,
      trim: true,
      maxlength: 500
    },
    spamAlertLastSentAt: Date,
    spamAlertLastTotal: {
      type: Number,
      default: 0
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLoginAt: Date
});

module.exports = mongoose.model('Owner', ownerSchema);
