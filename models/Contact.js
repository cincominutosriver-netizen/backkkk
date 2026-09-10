const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      maxlength: 20
    },
    profileNameKey: {
      type: String,
      trim: true,
      lowercase: true
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      index: true
    },
    phone: String,
    whatsapp: String,
    website: String,
    isOwner: {
      type: Boolean,
      default: false
    },
    points: {
      type: Number,
      default: 0
    },
    strikes: {
      type: Number,
      default: 3
    },
    internalBadge: String,
    contactPreference: {
      type: String,
      enum: ['phone', 'email', 'whatsapp', 'website'],
      default: 'email'
    },
    membership: {
      tier: {
        type: String,
        enum: ['free', 'basic', 'premium'],
        default: 'basic'
      },
      period: {
        type: String,
        enum: ['month', 'quarter', 'year'],
        default: 'year'
      }
    },
    events: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Event'
      }
    ]
  },
  {
    timestamps: true,
    collection: 'contacts'
  }
);

contactSchema.index({ points: -1, email: 1 });
contactSchema.index(
  { profileNameKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      profileNameKey: { $type: 'string' }
    }
  }
);

module.exports = mongoose.model('Contact', contactSchema);
