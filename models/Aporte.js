const mongoose = require('mongoose');

const aporteSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true
    },
    contributorName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Owner'
    },
    contributionType: {
      type: String,
      enum: ['text', 'photo', 'video'],
      default: 'text',
      index: true
    },
    field: {
      type: String,
      required: true,
      trim: true
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    likes: {
      type: Number,
      default: 0,
      min: 0
    },
    likedByOwners: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Owner'
      }
    ],
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true
    },
    awardedPoints: {
      type: Number,
      default: 0,
      min: 0
    },
    pointsAwardedAt: Date,
    reviewerNote: {
      type: String,
      trim: true,
      maxlength: 500
    },
    reviewedAt: Date,
    reviewedBy: {
      type: String,
      trim: true
    }
  },
  {
    timestamps: true,
    collection: 'aportes'
  }
);

module.exports = mongoose.model('Aporte', aporteSchema);
