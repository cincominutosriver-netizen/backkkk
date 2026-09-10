const mongoose = require('mongoose');

const seoAreaSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true
    },
    label: String,
    country: String,
    provinceSlug: String,
    provinceLabel: String,
    regionType: String,
    gbaZone: String,
    municipalitySlug: String,
    municipalityLabel: String,
    localitySlug: String,
    localityLabel: String,
    neighborhoodSlug: String,
    neighborhoodLabel: String,
    eventCount: Number,
    categoryCounts: mongoose.Schema.Types.Mixed,
    indexable: {
      type: Boolean,
      default: false,
      index: true
    },
    reasons: [String]
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('SeoArea', seoAreaSchema, 'seoAreas');
