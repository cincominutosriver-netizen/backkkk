const Event = require('../models/Event');

exports.getEventById = async (req, res) => {
  try {
    const { id } = req.params;

    const event = await Event.findByIdAndUpdate(
      id,
      { $inc: { viewCount: 1 } },
      { new: true }
    ).lean();

    if (!event) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    res.json(event);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener evento' });
  }
};
