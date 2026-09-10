const mongoose = require('mongoose');
const { getPublicPathFields } = require('../utils/eventPublicPath');

const eventSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    required: true,
    enum: ['salon', 'quinta', 'club', 'restaurante', 'hotel', 'casa', 'depto', 'quincho', 'terraza', 'otro']
  },
  location: {
    province: { type: String, required: true },
    city: { type: String, required: true },
    district: String,
    locality: String,
    county: String,
    address: String,
    placeId: {
      type: String,
      trim: true
    },

    coordinates: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [lng, lat]
        required: true
      }
    }
  },
  capacity: {
    max: Number
  },
  priceRange: {
    min: Number,
    max: Number,
    minARS: Number,
    maxARS: Number,
    minUSD: Number,
    maxUSD: Number,
    currency: {
      type: String,
      enum: ['ARS', 'USD'],
      default: 'ARS'
    }
  },
  plans: {
    hasPlans: { type: Boolean, default: false },
    items: [{
      title: String,
      description: String,
      price: Number,
      priceARS: Number,
      priceUSD: Number,
      priceDate: Date,
      priceCurrency: {
        type: String,
        enum: ['ARS', 'USD'],
        default: 'ARS'
      }
    }]
  },
  pricing: {
    mode: {
      type: String,
      enum: ['none', 'per_hour', 'per_day', 'per_night', 'per_person'],
      default: 'none'
    },
    perHour: Number,
    perHourCurrency: {
      type: String,
      enum: ['ARS', 'USD'],
      default: 'ARS'
    },
    perHourDate: Date,
    perDay: Number,
    perDayCurrency: {
      type: String,
      enum: ['ARS', 'USD'],
      default: 'ARS'
    },
    perDayDate: Date,
    perNight: Number,
    perNightCurrency: {
      type: String,
      enum: ['ARS', 'USD'],
      default: 'ARS'
    },
    perNightDate: Date,
    perPerson: Number,
    perPersonCurrency: {
      type: String,
      enum: ['ARS', 'USD'],
      default: 'ARS'
    },
    perPersonDate: Date,
    dayHours: String,
    nightHours: String
  },
  partyTypes: [String],
  eventType: {
    type: String,
    enum: ['boda', 'cumpleaños', 'cumpleaños-infantil', 'empresarial', 'quinceaños', 'despedida', 'asado', 'reunion', 'otro'],
    required: true
  },
  
  // MEMBRESIA DEL DUEÑO
  ownerTier: {
    type: String,
    enum: ['free', 'basic', 'premium'],
    default: 'free'
  },
  
  media: {
    videos: [{
      url: String,
      lowResUrl: String,
      order: Number,
      thumbnail: String
    }],
    photos: [{
      url: String,
      order: Number,
      description: String
    }]
  },
  
  description: String,

  slug: {
    type: String,
    trim: true,
    index: true
  },
  publicPath: {
    type: String,
    trim: true,
    index: true
  },
  publicPathCandidates: [{
    type: String,
    trim: true,
    index: true
  }],
  geoClassification: {
    type: mongoose.Schema.Types.Mixed
  },
  
  contactInfo: {
    phone: String,
    email: String,
    website: String,
    whatsapp: String // Muy importante en Argentina
  },
  preferredContactMethod: {
    type: String,
    enum: ['email', 'whatsapp', 'phone', 'website'],
    default: 'email'
  },

  ownerEmail: {
    type: String,
    lowercase: true,
    trim: true,
    index: true
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
  moderation: {
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true
    },
    reviewedBy: {
      type: String,
      lowercase: true,
      trim: true
    },
    reviewedAt: Date,
    reason: {
      type: String,
      trim: true,
      maxlength: 500
    }
  },
  
  featured: {
    type: Boolean,
    default: false
  },
  
  // Campos utiles
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Para estadisticas
  viewCount: {
    type: Number,
    default: 0
  },
  contactRequestCount: {
    type: Number,
    default: 0
  }
  
}, {
  timestamps: true
});

// Indice geoespacial para busquedas por proximidad
eventSchema.index({
  'location.coordinates': '2dsphere'
});

eventSchema.pre('validate', function setPublicPathFields(next) {
  const fields = getPublicPathFields(this);
  this.slug = fields.slug;
  this.publicPath = fields.publicPath;
  this.publicPathCandidates = fields.publicPathCandidates;
  next();
});

// Metodo para obtener media segun tier
eventSchema.methods.getMediaForDisplay = function() {
  const limits = {
    free: { photos: 5, videos: 2 },
    basic: { photos: 15, videos: 5 },
    premium: { photos: 100, videos: 10 } 
  };

  const limit = limits[this.ownerTier];
  
  return {
    photos: limit.photos === -1 ? this.media.photos : this.media.photos.slice(0, limit.photos),
    videos: limit.videos === -1 ? this.media.videos : this.media.videos.slice(0, limit.videos),
    tier: this.ownerTier
  };
};

module.exports = mongoose.model('Event', eventSchema);
