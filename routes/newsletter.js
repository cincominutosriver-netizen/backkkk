const express = require('express');
const router = express.Router();
const NewsletterSubscriber = require('../models/NewsletterSubscriber');

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

router.post('/subscribe', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ message: 'Email requerido' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: 'Email inválido' });
    }

    const existing = await NewsletterSubscriber.findOne({ email }).lean();
    if (existing) {
      return res.status(200).json({
        message: 'Este email ya está suscripto al newsletter',
        created: false
      });
    }

    await NewsletterSubscriber.create({
      email,
      source: req.body?.source || 'footer'
    });

    return res.status(201).json({
      message: 'Suscripción guardada correctamente',
      created: true
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(200).json({
        message: 'Este email ya está suscripto al newsletter',
        created: false
      });
    }
    return res.status(500).json({ message: 'No se pudo guardar la suscripción' });
  }
});

module.exports = router;
