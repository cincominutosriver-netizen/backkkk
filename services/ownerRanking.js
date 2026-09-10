const Contact = require('../models/Contact');

const normalizeEmail = (email) =>
  String(email || '').trim().toLowerCase();

const registeredContactsPipeline = () => [
  {
    $lookup: {
      from: 'owners',
      localField: 'email',
      foreignField: 'email',
      as: 'ownerRecords'
    }
  },
  {
    $addFields: {
      ownerRecord: { $arrayElemAt: ['$ownerRecords', 0] }
    }
  },
  {
    $match: {
      ownerRecord: { $ne: null }
    }
  }
];

const getOwnerContactStatsByEmail = async (email) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return {
      name: '',
      points: 0,
      ranking: null,
      internalBadge: '',
      isOwner: false,
      username: ''
    };
  }

  const [profile] = await Contact.aggregate([
    { $match: { email: normalizedEmail } },
    ...registeredContactsPipeline(),
    {
      $project: {
        _id: 0,
        email: 1,
        name: { $ifNull: ['$name', ''] },
        points: { $ifNull: ['$points', 0] },
        internalBadge: { $ifNull: ['$internalBadge', ''] },
        isOwner: { $ifNull: ['$isOwner', false] },
        username: { $ifNull: ['$ownerRecord.username', ''] }
      }
    }
  ]);

  if (!profile) {
    return {
      name: '',
      points: 0,
      ranking: null,
      internalBadge: '',
      isOwner: false,
      username: ''
    };
  }

  const [rankResult] = await Contact.aggregate([
    ...registeredContactsPipeline(),
    {
      $match: {
        points: { $gt: Number(profile.points || 0) }
      }
    },
    { $count: 'higherCount' }
  ]);

  return {
    name: String(profile.name || ''),
    points: Number(profile.points || 0),
    ranking: Number(rankResult?.higherCount || 0) + 1,
    internalBadge: String(profile.internalBadge || ''),
    isOwner: Boolean(profile.isOwner),
    username: String(profile.username || '')
  };
};

const getOwnerLeaderboard = async ({ limit = 10 } = {}) => {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
  const rows = await Contact.aggregate([
    ...registeredContactsPipeline(),
    {
      $project: {
        _id: 0,
        email: 1,
        name: { $ifNull: ['$name', ''] },
        points: { $ifNull: ['$points', 0] },
        internalBadge: { $ifNull: ['$internalBadge', ''] },
        isOwner: { $ifNull: ['$isOwner', false] },
        username: { $ifNull: ['$ownerRecord.username', ''] },
        ownerCreatedAt: '$ownerRecord.createdAt'
      }
    },
    {
      $sort: {
        points: -1,
        username: 1,
        email: 1
      }
    },
    {
      $limit: safeLimit
    }
  ]);

  let previousPoints = null;
  let currentRank = 0;

  return rows.map((row, index) => {
    const rowPoints = Number(row.points || 0);
    if (previousPoints === null || rowPoints < previousPoints) {
      currentRank = index + 1;
      previousPoints = rowPoints;
    }

    return {
      email: String(row.email || ''),
      username: String(row.username || ''),
      name: String(row.name || ''),
      points: rowPoints,
      ranking: currentRank,
      internalBadge: String(row.internalBadge || ''),
      isOwner: Boolean(row.isOwner),
      createdAt: row.ownerCreatedAt || null
    };
  });
};

const buildOwnerResponse = async (owner) => {
  const stats = await getOwnerContactStatsByEmail(owner?.email);

  return {
    id: owner._id,
    email: owner.email,
    username: owner.username || stats.username || '',
    name: stats.name || '',
    points: stats.points,
    ranking: stats.ranking,
    internalBadge: stats.internalBadge,
    isOwner: stats.isOwner,
    preferences: {
      theme: String(owner?.preferences?.theme || 'light').trim().toLowerCase() === 'dark' ? 'dark' : 'light'
    }
  };
};

module.exports = {
  buildOwnerResponse,
  getOwnerContactStatsByEmail,
  getOwnerLeaderboard
};
