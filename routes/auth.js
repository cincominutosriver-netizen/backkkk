const express = require('express');
const crypto = require('crypto');
const Owner = require('../models/Owner');
const Contact = require('../models/Contact');
const Event = require('../models/Event');
const OwnerOtp = require('../models/OwnerOtp');
const OwnerSession = require('../models/OwnerSession');
const { sendTransactionalEmail } = require('../services/transactionalEmail');
const {
  buildOwnerResponse,
  getOwnerContactStatsByEmail,
  getOwnerLeaderboard
} = require('../services/ownerRanking');

const router = express.Router();

const OTP_TTL_MINUTES = 10;
const SESSION_DAYS = 30;
const PROFILE_NAME_MAX_LENGTH = 20;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
let googleClient = null;
try {
  const { OAuth2Client } = require('google-auth-library');
  googleClient = GOOGLE_CLIENT_ID
    ? new OAuth2Client(GOOGLE_CLIENT_ID)
    : null;
} catch {
  googleClient = null;
}

const canReturnCode =
  process.env.OTP_DEV_MODE === 'true' ||
  process.env.NODE_ENV !== 'production';
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

const normalizeEmail = (email) =>
  String(email || '').trim().toLowerCase();
const normalizeUsername = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '')
    .slice(0, 24);
const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  if (typeof value === 'number') return value === 1;
  return false;
};
const normalizeTheme = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'dark' ? 'dark' : 'light';
};
const normalizeDisplayName = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
const normalizeProfileNameKey = (value) =>
  normalizeDisplayName(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
const buildUsernameSuggestion = (value = '') => {
  const normalized = normalizeUsername(value);
  return normalized || `user${Math.random().toString(36).slice(2, 8)}`;
};
const escapeRegex = (value = '') =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const getProfileNameValidationMessage = (name) => {
  if (name.length < 2) {
    return 'El nombre debe tener al menos 2 caracteres';
  }
  if (name.length > PROFILE_NAME_MAX_LENGTH) {
    return `El nombre no puede superar ${PROFILE_NAME_MAX_LENGTH} caracteres`;
  }
  return '';
};
const isProfileNameAvailable = async (name, ownerEmail) => {
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  const profileNameKey = normalizeProfileNameKey(name);
  const [existingProfile] = await Contact.aggregate([
    {
      $match: {
        email: { $ne: normalizedOwnerEmail },
        $or: [
          { profileNameKey },
          { name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } }
        ]
      }
    },
    {
      $lookup: {
        from: 'owners',
        localField: 'email',
        foreignField: 'email',
        as: 'ownerRecords'
      }
    },
    {
      $match: {
        ownerRecords: { $ne: [] }
      }
    },
    { $limit: 1 },
    { $project: { _id: 1 } }
  ]);

  return !existingProfile;
};
const isDuplicateProfileNameError = (error) =>
  Number(error?.code) === 11000 && Boolean(error?.keyPattern?.profileNameKey);

const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEYLEN = 64;

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const hash = crypto
    .pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, 'sha256')
    .toString('hex');
  return { salt, hash, iterations: PASSWORD_ITERATIONS };
};

const verifyPassword = (password, owner) => {
  if (!owner?.passwordHash || !owner?.passwordSalt) return false;
  const iterations = owner.passwordIterations || PASSWORD_ITERATIONS;
  const hash = crypto
    .pbkdf2Sync(String(password), owner.passwordSalt, iterations, PASSWORD_KEYLEN, 'sha256')
    .toString('hex');
  return crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(owner.passwordHash, 'hex')
  );
};

const createOwnerSession = async (owner) => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  );

  await OwnerSession.create({
    ownerId: owner._id,
    tokenHash,
    expiresAt
  });

  return token;
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const hasEventForOwnerEmail = async (email) => {
  const total = await Event.countDocuments({
    $or: [
      { ownerEmail: email },
      { 'contactInfo.email': email }
    ]
  });
  return total > 0;
};

const buildOtpEmail = ({ code, purpose = 'signup' }) => {
  const safeCode = escapeHtml(code);
  const isPasswordReset = purpose === 'password-reset';
  const subject = isPasswordReset
    ? 'EventIN - Codigo para restablecer contrasena'
    : 'EventIN - Codigo de acceso';
  const title = isPasswordReset
    ? 'Restablece tu contrasena'
    : 'Completa el acceso a tu cuenta';
  const intro = isPasswordReset
    ? 'Recibimos una solicitud para cambiar la contrasena de tu cuenta.'
    : 'Usa este codigo para crear tu contrasena e ingresar a tus publicaciones.';

  return {
    subject,
    text: `${intro} Codigo: ${code}. Vence en ${OTP_TTL_MINUTES} minutos.`,
    html: [
      '<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#1f2937;">',
      `<h2 style="margin:0 0 10px;">${title}</h2>`,
      `<p style="margin:0 0 8px;">${intro}</p>`,
      '<p style="margin:0 0 8px;">Este codigo vence en 10 minutos.</p>',
      `<p style="margin:12px 0 14px;font-size:28px;font-weight:700;letter-spacing:4px;">${safeCode}</p>`,
      '<p style="margin:0;">Si no solicitaste este codigo, ignora este mensaje.</p>',
      '</div>'
    ].join('')
  };
};

const sendOwnerOtpEmail = async ({ email, code, purpose = 'signup' }) => {
  const payload = buildOtpEmail({ code, purpose });
  return sendTransactionalEmail({
    to: email,
    subject: payload.subject,
    html: payload.html,
    text: payload.text
  });
};

router.post('/request-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const requestedScope = String(req.body?.scope || '').trim().toLowerCase();
    const scope = requestedScope === 'owner-publication'
      ? 'owner-publication'
      : 'generic';
    if (!email) {
      return res.status(400).json({ message: 'Email requerido' });
    }

    if (scope === 'owner-publication') {
      const hasAssociatedEvent = await hasEventForOwnerEmail(email);
      if (!hasAssociatedEvent) {
        return res.status(404).json({
          message: 'No encontramos publicaciones asociadas a ese email'
        });
      }
    }

    await OwnerOtp.deleteMany({ email });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await OwnerOtp.create({ email, codeHash, expiresAt, scope });

    let mailStatus = { attempted: false, sent: false, reason: 'mail-not-attempted' };
    try {
      mailStatus = await sendOwnerOtpEmail({ email, code, purpose: 'signup' });
    } catch (mailError) {
      mailStatus = {
        attempted: true,
        sent: false,
        reason: mailError?.message || 'mail-error'
      };
    }

    if (!canReturnCode && !mailStatus.sent) {
      console.error('[auth/request-otp] OTP email send failed', {
        email,
        scope,
        attempted: Boolean(mailStatus.attempted),
        reason: mailStatus.reason || 'unknown'
      });
      await OwnerOtp.deleteMany({ email });
      return res.status(500).json({
        message: 'No pudimos enviar el codigo por email. Intenta nuevamente.'
      });
    }

    if (canReturnCode) {
      return res.json({
        ok: true,
        devCode: code,
        expiresAt,
        emailSent: Boolean(mailStatus.sent),
        mailReason: mailStatus.reason || null
      });
    }

    return res.json({ ok: true, expiresAt });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '').trim();
    const isOwner = normalizeBoolean(req.body?.isOwner);
    const profileName = normalizeDisplayName(req.body?.name);

    if (!email || !code) {
      return res.status(400).json({ message: 'Email y codigo requeridos' });
    }

    const otp = await OwnerOtp.findOne({ email }).sort({ createdAt: -1 });
    if (!otp) {
      return res.status(400).json({ message: 'Codigo invalido' });
    }

    if (otp.expiresAt < new Date()) {
      await OwnerOtp.deleteMany({ email });
      return res.status(400).json({ message: 'Codigo vencido' });
    }

    if (otp.codeHash !== sha256(code)) {
      otp.attempts += 1;
      await otp.save();
      return res.status(400).json({ message: 'Codigo invalido' });
    }

    if (otp.scope === 'password-reset') {
      return res.status(400).json({ message: 'Codigo invalido para este flujo' });
    }

    let owner = await Owner.findOne({ email });
    const isNewOwner = !owner;
    if (profileName || (isNewOwner && otp.scope === 'generic')) {
      const profileNameError = getProfileNameValidationMessage(profileName);
      if (profileNameError) {
        return res.status(400).json({ message: profileNameError });
      }

      const profileNameAvailable = await isProfileNameAvailable(profileName, email);
      if (!profileNameAvailable) {
        return res.status(409).json({ message: 'Ese nombre ya esta en uso' });
      }
    }

    const needsPassword = !owner?.passwordHash;
    if (!owner) {
      if (otp.scope === 'owner-publication') {
        const hasAssociatedEvent = await hasEventForOwnerEmail(email);
        if (!hasAssociatedEvent) {
          await OwnerOtp.deleteMany({ email });
          return res.status(403).json({
            message: 'Este email no tiene publicaciones asociadas'
          });
        }
      }
      owner = new Owner({ email, lastLoginAt: new Date() });
    } else {
      owner.lastLoginAt = new Date();
    }

    if (needsPassword && password.length < 6) {
      return res
        .status(400)
        .json({ message: 'Se requiere una contraseÃ±a de al menos 6 caracteres', needsPassword: true });
    }

    if (needsPassword) {
      const { salt, hash, iterations } = hashPassword(password);
      owner.passwordSalt = salt;
      owner.passwordHash = hash;
      owner.passwordIterations = iterations;
    }

    await owner.save();
    await OwnerOtp.deleteMany({ email });

    const contactSet = {
      isOwner,
      email
    };
    if (profileName) {
      contactSet.name = profileName;
      contactSet.profileNameKey = normalizeProfileNameKey(profileName);
    }

    await Contact.findOneAndUpdate(
      { email },
      {
        $set: contactSet,
        $setOnInsert: {
          contactPreference: 'email',
          membership: {
            tier: 'basic',
            period: 'year'
          }
        }
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    const token = await createOwnerSession(owner);

    return res.json({
      token,
      owner: await buildOwnerResponse(owner),
      isNewOwner
    });
  } catch (error) {
    if (isDuplicateProfileNameError(error)) {
      return res.status(409).json({ message: 'Ese nombre ya esta en uso' });
    }
    return res.status(500).json({ message: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '').trim();

    if (!email || !password) {
      return res.status(400).json({ message: 'Email y contraseÃ±a requeridos' });
    }

    const owner = await Owner.findOne({ email });
    if (!owner || !owner.passwordHash) {
      return res.status(400).json({ message: 'Cuenta sin contraseÃ±a, usa el cÃ³digo' });
    }

    if (!verifyPassword(password, owner)) {
      return res.status(401).json({ message: 'Credenciales invÃ¡lidas' });
    }

    owner.lastLoginAt = new Date();
    await owner.save();

    const token = await createOwnerSession(owner);

    return res.json({
      token,
      owner: await buildOwnerResponse(owner)
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/google', async (req, res) => {
  try {
    if (!googleClient || !GOOGLE_CLIENT_ID) {
      return res.status(500).json({ message: 'Google login no configurado' });
    }

    const idToken = String(req.body?.idToken || '').trim();
    if (!idToken) {
      return res.status(400).json({ message: 'idToken requerido' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email = normalizeEmail(payload?.email);
    const googleSub = String(payload?.sub || '').trim();
    const emailVerified = Boolean(payload?.email_verified);
    const googleName = String(payload?.name || '').trim();

    if (!email || !emailVerified || !googleSub) {
      return res.status(401).json({ message: 'Token de Google invÃ¡lido' });
    }

    let owner = await Owner.findOne({ email });
    const isNewOwner = !owner;

    if (!owner) {
      owner = await Owner.create({
        email,
        googleSub,
        authProviders: ['google'],
        lastLoginAt: new Date()
      });
    } else {
      owner.lastLoginAt = new Date();
      if (!owner.googleSub) {
        owner.googleSub = googleSub;
      }
      const providers = Array.isArray(owner.authProviders)
        ? owner.authProviders
        : [];
      if (!providers.includes('google')) {
        owner.authProviders = [...providers, 'google'];
      }
      await owner.save();
    }

    const token = await createOwnerSession(owner);

    const googleProfileName = normalizeDisplayName(googleName);
    const googleContactSet = {
      email,
      contactPreference: 'email',
      membership: {
        tier: 'basic',
        period: 'year'
      }
    };
    if (
      googleProfileName &&
      !getProfileNameValidationMessage(googleProfileName) &&
      await isProfileNameAvailable(googleProfileName, email)
    ) {
      googleContactSet.name = googleProfileName;
      googleContactSet.profileNameKey = normalizeProfileNameKey(googleProfileName);
    }

    await Contact.findOneAndUpdate(
      { email },
      {
        $set: googleContactSet
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    return res.json({
      token,
      owner: await buildOwnerResponse(owner),
      isNewOwner,
      needsUsername: !String(owner.username || '').trim(),
      suggestedUsername: !String(owner.username || '').trim()
        ? buildUsernameSuggestion(googleName || email.split('@')[0])
        : ''
    });
  } catch (error) {
    return res.status(401).json({ message: 'No pudimos validar Google login' });
  }
});

router.post('/forgot-password/request', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) {
      return res.status(400).json({ message: 'Email requerido' });
    }

    const owner = await Owner.findOne({ email });
    if (!owner) {
      // Respuesta neutra para no revelar si el email existe.
      return res.json({ ok: true });
    }

    await OwnerOtp.deleteMany({ email });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await OwnerOtp.create({
      email,
      codeHash,
      expiresAt,
      scope: 'password-reset'
    });

    let mailStatus = { attempted: false, sent: false, reason: 'mail-not-attempted' };
    try {
      mailStatus = await sendOwnerOtpEmail({
        email,
        code,
        purpose: 'password-reset'
      });
    } catch (mailError) {
      mailStatus = {
        attempted: true,
        sent: false,
        reason: mailError?.message || 'mail-error'
      };
    }

    if (!canReturnCode && !mailStatus.sent) {
      console.error('[auth/forgot-password/request] OTP email send failed', {
        email,
        attempted: Boolean(mailStatus.attempted),
        reason: mailStatus.reason || 'unknown'
      });
      await OwnerOtp.deleteMany({ email });
      return res.status(500).json({
        message: 'No pudimos enviar el codigo por email. Intenta nuevamente.'
      });
    }

    if (canReturnCode) {
      return res.json({
        ok: true,
        devCode: code,
        expiresAt,
        emailSent: Boolean(mailStatus.sent),
        mailReason: mailStatus.reason || null
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/forgot-password/reset', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '').trim();

    if (!email || !code || !newPassword) {
      return res.status(400).json({ message: 'Email, cÃ³digo y nueva contraseÃ±a requeridos' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'La contraseÃ±a debe tener al menos 6 caracteres' });
    }

    const owner = await Owner.findOne({ email });
    if (!owner) {
      return res.status(400).json({ message: 'CÃ³digo invÃ¡lido' });
    }

    const otp = await OwnerOtp.findOne({ email }).sort({ createdAt: -1 });
    if (!otp) {
      return res.status(400).json({ message: 'CÃ³digo invÃ¡lido' });
    }

    if (otp.expiresAt < new Date()) {
      await OwnerOtp.deleteMany({ email });
      return res.status(400).json({ message: 'CÃ³digo vencido' });
    }

    if (otp.codeHash !== sha256(code)) {
      otp.attempts += 1;
      await otp.save();
      return res.status(400).json({ message: 'CÃ³digo invÃ¡lido' });
    }

    if (otp.scope !== 'password-reset') {
      return res.status(400).json({ message: 'CÃ³digo invÃ¡lido' });
    }

    const { salt, hash, iterations } = hashPassword(newPassword);
    owner.passwordSalt = salt;
    owner.passwordHash = hash;
    owner.passwordIterations = iterations;
    owner.lastLoginAt = new Date();
    await owner.save();

    await OwnerOtp.deleteMany({ email });
    await OwnerSession.deleteMany({ ownerId: owner._id });

    return res.json({ ok: true, message: 'ContraseÃ±a actualizada correctamente' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

const requireOwnerAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ message: 'No autorizado' });
    }

    const tokenHash = sha256(token);
    const session = await OwnerSession.findOne({ tokenHash }).populate('ownerId');

    if (!session || !session.ownerId) {
      return res.status(401).json({ message: 'Sesion invalida' });
    }

    if (session.expiresAt < new Date()) {
      await OwnerSession.deleteOne({ _id: session._id });
      return res.status(401).json({ message: 'Sesion vencida' });
    }

    req.owner = session.ownerId;
    req.ownerSession = session;
    return next();
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const requireAdminAuth = async (req, res, next) => {
  await requireOwnerAuth(req, res, async () => {
    const email = String(req.owner?.email || '').toLowerCase();
    if (!ADMIN_EMAILS.has(email)) {
      return res.status(403).json({ message: 'Se requieren permisos de administrador' });
    }
    return next();
  });
};

router.get('/me', requireOwnerAuth, async (req, res) => {
  try {
    const ownerPayload = await buildOwnerResponse(req.owner);
    return res.json({
      owner: ownerPayload
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.put('/preferences', requireOwnerAuth, async (req, res) => {
  try {
    const theme = normalizeTheme(req.body?.theme);
    req.owner.preferences = {
      ...(req.owner.preferences || {}),
      theme
    };
    await req.owner.save();

    const ownerPayload = await buildOwnerResponse(req.owner);
    return res.json({
      ok: true,
      owner: ownerPayload
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.put('/profile', requireOwnerAuth, async (req, res) => {
  try {
    const name = normalizeDisplayName(req.body?.name);
    const profileNameError = getProfileNameValidationMessage(name);
    if (profileNameError) {
      return res.status(400).json({ message: profileNameError });
    }

    const profileNameAvailable = await isProfileNameAvailable(name, req.owner.email);
    if (!profileNameAvailable) {
      return res.status(409).json({ message: 'Ese nombre ya esta en uso' });
    }

    await Contact.findOneAndUpdate(
      { email: req.owner.email },
      {
        $set: {
          name,
          profileNameKey: normalizeProfileNameKey(name),
          email: req.owner.email
        },
        $setOnInsert: {
          contactPreference: 'email',
          membership: {
            tier: 'basic',
            period: 'year'
          }
        }
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    const ownerPayload = await buildOwnerResponse(req.owner);
    return res.json({
      ok: true,
      owner: ownerPayload
    });
  } catch (error) {
    if (isDuplicateProfileNameError(error)) {
      return res.status(409).json({ message: 'Ese nombre ya esta en uso' });
    }
    return res.status(500).json({ message: error.message });
  }
});

router.put('/username', requireOwnerAuth, async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    if (!username || username.length < 3) {
      return res.status(400).json({
        message: 'El nombre de usuario debe tener al menos 3 caracteres validos'
      });
    }

    const existingOwner = await Owner.findOne({
      username,
      _id: { $ne: req.owner._id }
    }).select('_id');
    if (existingOwner) {
      return res.status(409).json({ message: 'Ese nombre de usuario ya esta en uso' });
    }

    req.owner.username = username;
    await req.owner.save();

    const ownerPayload = await buildOwnerResponse(req.owner);
    return res.json({
      ok: true,
      owner: ownerPayload
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/public-profile/:username', async (req, res) => {
  try {
    const username = normalizeUsername(req.params?.username);
    if (!username) {
      return res.status(400).json({ message: 'Usuario invalido' });
    }

    const owner = await Owner.findOne({ username }).select('email username createdAt');
    if (!owner) {
      return res.status(404).json({ message: 'Perfil no encontrado' });
    }

    const stats = await getOwnerContactStatsByEmail(owner.email);

    return res.json({
      profile: {
        username: owner.username || '',
        name: stats.name || owner.username || '',
        points: stats.points,
        ranking: stats.ranking,
        internalBadge: stats.internalBadge,
        isOwner: stats.isOwner,
        createdAt: owner.createdAt || null
      }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const leaderboard = await getOwnerLeaderboard({
      limit: req.query?.limit
    });

    return res.json({
      leaderboard
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/favorites', requireOwnerAuth, async (req, res) => {
  try {
    const owner = await Owner.findById(req.owner._id).populate('favorites');
    return res.json({ favorites: owner?.favorites || [] });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/favorites/:eventId', requireOwnerAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    await Owner.updateOne(
      { _id: req.owner._id },
      { $addToSet: { favorites: event._id } }
    );

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.delete('/favorites/:eventId', requireOwnerAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    await Owner.updateOne(
      { _id: req.owner._id },
      { $pull: { favorites: eventId } }
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/logout', requireOwnerAuth, async (req, res) => {
  await OwnerSession.deleteOne({ _id: req.ownerSession._id });
  return res.json({ ok: true });
});

module.exports = { router, requireOwnerAuth, requireAdminAuth };

