const mongoose = require('mongoose');

const newsletterSubscriberSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      index: true
    },
    source: {
      type: String,
      trim: true,
      default: 'footer'
    },
    subscribedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true,
    collection: 'newsletter_subscribers'
  }
);

module.exports = mongoose.model('NewsletterSubscriber', newsletterSubscriberSchema);
