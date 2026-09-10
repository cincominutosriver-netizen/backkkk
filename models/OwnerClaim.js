const mongoose = require('mongoose');

const ownerClaimSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true
    },
    claimEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true
    },
    reviewerNote: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ''
    },
    reviewedAt: Date,
    reviewedBy: {
      type: String,
      trim: true,
      lowercase: true,
      default: ''
    },
    eventSnapshot: {
      name: { type: String, default: '' },
      city: { type: String, default: '' },
      province: { type: String, default: '' }
    },
    contactSnapshot: {
      phone: { type: String, default: '' },
      email: { type: String, default: '' },
      whatsapp: { type: String, default: '' },
      website: { type: String, default: '' }
    },
    source: {
      type: String,
      default: 'event-profile'
    }
  },
  {
    timestamps: true,
    collection: 'owner_claims'
  }
);

ownerClaimSchema.index({ eventId: 1, claimEmail: 1, status: 1 });

module.exports = mongoose.model('OwnerClaim', ownerClaimSchema);
