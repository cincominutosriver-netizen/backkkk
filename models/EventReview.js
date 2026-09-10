const mongoose = require('mongoose');

const eventReviewSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Owner',
      required: true,
      index: true
    },
    contributorName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80
    },
    ratings: {
      gastronomy: {
        type: Number,
        required: true,
        min: 1,
        max: 5
      },
      ambience: {
        type: Number,
        required: true,
        min: 1,
        max: 5
      },
      staff: {
        type: Number,
        required: true,
        min: 1,
        max: 5
      }
    },
    overallRating: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    comment: {
      type: String,
      trim: true,
      maxlength: 1000
    },
    awardedPoints: {
      type: Number,
      default: 0,
      min: 0
    },
    pointsAwardedAt: Date
  },
  {
    timestamps: true,
    collection: 'eventReviews'
  }
);

eventReviewSchema.index({ eventId: 1, ownerId: 1 }, { unique: true });
eventReviewSchema.index({ eventId: 1, createdAt: -1 });

module.exports = mongoose.model('EventReview', eventReviewSchema);
