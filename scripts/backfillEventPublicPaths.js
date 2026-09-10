require('dotenv').config();

const mongoose = require('mongoose');
const Event = require('../models/Event');
const { getPublicPathFields } = require('../utils/eventPublicPath');

const MONGO_URI = process.env.MONGO_URI;

async function main() {
  if (!MONGO_URI) {
    throw new Error('Falta MONGO_URI en el entorno');
  }

  await mongoose.connect(MONGO_URI);

  const events = await Event.find({})
    .select('_id name location slug publicPath publicPathCandidates')
    .lean();

  let updated = 0;

  for (const event of events) {
    const fields = getPublicPathFields(event);
    const currentCandidates = Array.isArray(event.publicPathCandidates)
      ? event.publicPathCandidates
      : [];
    const nextCandidates = fields.publicPathCandidates;
    const sameCandidates =
      currentCandidates.length === nextCandidates.length &&
      currentCandidates.every((item, index) => item === nextCandidates[index]);

    if (
      event.slug === fields.slug &&
      event.publicPath === fields.publicPath &&
      sameCandidates
    ) {
      continue;
    }

    await Event.updateOne({ _id: event._id }, { $set: fields });
    updated += 1;
  }

  console.log(`Eventos revisados: ${events.length}. Eventos actualizados: ${updated}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
