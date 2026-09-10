const mongoose = require('mongoose');
const Event = require('../models/Event');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;

const provinces = [
  { province: 'Buenos Aires', city: 'CABA', coords: [-58.3816, -34.6037] },
  { province: 'Buenos Aires', city: 'La Plata', coords: [-57.9536, -34.9214] },
  { province: 'Buenos Aires', city: 'Mar del Plata', coords: [-57.5575, -38.0055] },
  { province: 'Córdoba', city: 'Córdoba', coords: [-64.1888, -31.4201] },
  { province: 'Santa Fe', city: 'Rosario', coords: [-60.6393, -32.9442] },
  { province: 'Mendoza', city: 'Mendoza', coords: [-68.8458, -32.8895] },
  { province: 'Tucumán', city: 'San Miguel de Tucumán', coords: [-65.2226, -26.8083] },
  { province: 'Salta', city: 'Salta', coords: [-65.4117, -24.7821] },
  { province: 'Neuquén', city: 'Neuquén', coords: [-68.0591, -38.9516] },
  { province: 'Misiones', city: 'Posadas', coords: [-55.8961, -27.3621] }
];

const types = ['salon', 'quinta', 'club', 'restaurante', 'hotel', 'casa', 'depto', 'quincho', 'terraza', 'otro'];
const USD_RATE = 1000;
const photoPool = [
  'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267',
  'https://images.unsplash.com/photo-1505691938895-1758d7feb511',
  'https://images.unsplash.com/photo-1484154218962-a197022b5858',
  'https://images.unsplash.com/photo-1523217582562-09d0def993a6',
  'https://images.unsplash.com/photo-1502005097973-6a7082348e28',
  'https://images.unsplash.com/photo-1449844908441-8829872d2607'
];

const videoPool = [
  {
    url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1502005097973-6a7082348e28'
  },
  {
    url: 'https://www.w3schools.com/html/movie.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1523217582562-09d0def993a6'
  },
  {
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1484154218962-a197022b5858'
  }
];

const pick = (arr, i) => arr[i % arr.length];
const pickMany = (arr, count, start) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(arr[(start + i) % arr.length]);
  }
  return out;
};

const buildEvent = (i, tier) => {
  const loc = pick(provinces, i);
  const type = pick(types, i);
  const priceDate = new Date();
  const minCap = 30 + (i % 6) * 20;
  const maxCap = minCap + 50 + (i % 4) * 30;
  const minPrice = 80000 + (i % 5) * 20000;
  const maxPrice = minPrice + 70000 + (i % 3) * 30000;
  const minPriceUsd = Math.round(minPrice / USD_RATE);
  const maxPriceUsd = Math.round(maxPrice / USD_RATE);
  const photos = pickMany(photoPool, tier === 'premium' ? 6 : 3, i);
  const videos = pickMany(videoPool, tier === 'premium' ? 2 : 1, i);
  const plans = [
    {
      title: `Plan básico ${type} (${minCap} personas)`,
      description: '6 hs + mobiliario',
      price: minPrice,
      priceARS: minPrice,
      priceUSD: minPriceUsd,
      priceDate,
      priceCurrency: 'ARS'
    },
    {
      title: `Plan completo ${type} (${maxCap} personas)`,
      description: '8 hs + catering',
      price: maxPrice,
      priceARS: maxPrice,
      priceUSD: maxPriceUsd,
      priceDate,
      priceCurrency: 'ARS'
    }
  ];

  return {
    name: `${type.toUpperCase()} ${loc.city} ${tier === 'premium' ? 'Premium' : 'Basic'} #${i + 1}`,
    type,
    location: {
      province: loc.province,
      city: loc.city,
      address: `Av. Principal ${100 + i}`,
      coordinates: {
        type: 'Point',
        coordinates: loc.coords
      }
    },
    capacity: { max: maxCap },
    priceRange: {
      min: minPrice,
      max: maxPrice,
      minARS: minPrice,
      maxARS: maxPrice,
      minUSD: minPriceUsd,
      maxUSD: maxPriceUsd,
      currency: 'ARS'
    },
    ownerTier: tier,
    plans: {
      hasPlans: true,
      items: plans
    },
    media: {
      videos: videos.map((video, idx) => ({
        url: video.url,
        order: idx + 1,
        thumbnail: video.thumbnail
      })),
      photos: photos.map((url, idx) => ({ url, order: idx + 1, description: 'Foto del espacio' }))
    },
    description: `Espacio ${tier} ideal para eventos sociales y corporativos en ${loc.city}.`,
    contactInfo: {
      phone: `+54 11 5555 ${String(1000 + i).slice(-4)}`,
      email: `contacto${i + 1}@eventin.com`,
      website: 'https://eventin.com',
      whatsapp: `+54 9 11 5555 ${String(1000 + i).slice(-4)}`
    },
    ownerEmail: `owner${i + 1}@eventin.com`,
    featured: tier === 'premium' && i % 2 === 0,
    isActive: true
  };
};

const run = async () => {
  if (!MONGO_URI) {
    console.error('Falta MONGO_URI en .env');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);

  await Event.deleteMany({});

  const basicEvents = Array.from({ length: 20 }, (_, i) => buildEvent(i, 'basic'));
  const premiumEvents = Array.from({ length: 20 }, (_, i) => buildEvent(i + 20, 'premium'));
  const payload = [...basicEvents, ...premiumEvents];

  const result = await Event.insertMany(payload);
  console.log(`Seed OK: ${result.length} eventos creados.`);

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Seed error:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});

