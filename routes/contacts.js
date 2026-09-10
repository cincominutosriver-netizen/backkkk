const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');
const Event = require('../models/Event');

// POST - Crear/actualizar contacto propietario y vincular evento
router.post('/', async (req, res) => {
  try {
    const { eventId } = req.body;
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ message: 'Email requerido' });
    }

    if (eventId) {
      const event = await Event.findById(eventId);
      if (!event) {
        return res.status(404).json({ message: 'Evento no encontrado' });
      }
    }

    const payload = {
      name: req.body?.name || '',
      email,
      phone: req.body?.phone || '',
      whatsapp: req.body?.whatsapp || '',
      website: req.body?.website || '',
      contactPreference: req.body?.contactPreference || 'email',
      membership: {
        tier: req.body?.membership?.tier || 'basic',
        period: req.body?.membership?.period || 'year'
      }
    };

    const update = eventId
      ? { $set: payload, $addToSet: { events: eventId } }
      : { $set: payload };

    const contact = await Contact.findOneAndUpdate({ email }, update, {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true
    });

    res.status(201).json({
      message: 'Contacto guardado correctamente',
      contact
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// GET - Obtener contactos
router.get('/', async (req, res) => {
  try {
    const { email } = req.query;
    const query = {};

    if (email) {
      query.email = String(email).trim().toLowerCase();
    }

    const contacts = await Contact.find(query)
      .populate('events', 'name location eventType ownerTier')
      .sort({ createdAt: -1 });

    res.json(contacts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET - Obtener un contacto
router.get('/:id', async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id).populate('events');

    if (!contact) {
      return res.status(404).json({ message: 'Contacto no encontrado' });
    }

    res.json(contact);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PUT - Actualizar contacto
router.put('/:id', async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.email) {
      payload.email = String(payload.email).trim().toLowerCase();
    }

    const contact = await Contact.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true
    });

    if (!contact) {
      return res.status(404).json({ message: 'Contacto no encontrado' });
    }

    res.json(contact);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// DELETE - Eliminar contacto
router.delete('/:id', async (req, res) => {
  try {
    await Contact.findByIdAndDelete(req.params.id);
    res.json({ message: 'Contacto eliminado' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
