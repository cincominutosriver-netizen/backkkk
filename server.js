const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const eventsRoutes = require('./routes/events');
const contactsRoutes = require('./routes/contacts');
const getEventRoutes = require('./routes/getEvent');
const searchRoutes = require('./routes/search');
const { router: authRoutes } = require('./routes/auth');
const mediaRoutes = require('./routes/media');
const submissionsRoutes = require('./routes/submissions');
const newsletterRoutes = require('./routes/newsletter');
const aportesRoutes = require('./routes/aportes');

const app = express();

const normalizeOrigin = (value) => {
  if (!value) return '';
  return value.trim().replace(/\/+$/, '').toLowerCase();
};

// Middlewares
const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://eventin.com.ar',
  'https://www.eventin.com.ar',
  'https://eventin-back.vercel.app',
];

const allowedOrigins = (process.env.CORS_ORIGINS || defaultOrigins.join(','))
  .split(',')
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // Postman/server-to-server

    const normalizedOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalizedOrigin)) return callback(null, true);

    try {
      if (/\.vercel\.app$/.test(new URL(origin).hostname)) return callback(null, true); // previews
    } catch (_) {
      return callback(null, false);
    }

    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Review-Token'],
  credentials: true
};

app.options('*', cors());
app.use(cors(corsOptions));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/events', eventsRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/getevent', getEventRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/submissions', submissionsRoutes);
app.use('/api/newsletter', newsletterRoutes);
app.use('/api/aportes', aportesRoutes);

// Rutas de prueba
app.get('/', (req, res) => {
  res.json({ message: 'TE AMO CARCHU MI AMOR' });
});

// Conexion a MongoDB
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('Conectado a MongoDB');
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en puerto ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Error conectando a MongoDB:', error);
  });
