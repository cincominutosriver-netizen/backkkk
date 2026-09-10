const mongoose = require('mongoose');

const ownerOtpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  codeHash: {
    type: String,
    required: true
  },
  scope: {
    type: String,
    enum: ['generic', 'owner-publication', 'password-reset'],
    default: 'generic',
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }
  },
  attempts: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('OwnerOtp', ownerOtpSchema);
