const mongoose = require('mongoose');

const pendingMediaItemSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    path: { type: String, required: true },
    publicUrl: { type: String, required: true },
    mime: { type: String, default: '' },
    bytes: { type: Number, default: 0 }
  },
  { _id: false }
);

const pendingSubmissionSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true
    },
    eventDraft: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    localMedia: {
      photos: {
        type: [pendingMediaItemSchema],
        default: []
      },
      videos: {
        type: [pendingMediaItemSchema],
        default: []
      }
    },
    moderation: {
      approvedByOwner: {
        type: Boolean,
        default: false
      }
    },
    reviewedAt: Date,
    reviewerNote: {
      type: String,
      trim: true,
      maxlength: 500
    },
    createdEventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event'
    }
  },
  {
    timestamps: true,
    collection: 'pending_submissions'
  }
);

module.exports = mongoose.model('PendingSubmission', pendingSubmissionSchema);
