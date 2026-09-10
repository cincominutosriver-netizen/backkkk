const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const firstNonEmpty = (...values) =>
  values.map((value) => String(value || '').trim()).find(Boolean) || '';
const parsePositiveInt = (value, defaultValue) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
};
const parseBoolean = (value, defaultValue = false) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return defaultValue;
};
const withTimeout = async (promise, timeoutMs, timeoutMessage) => {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const sendViaSmtp = async ({ email, subject, html, text }) => {
  const host = firstNonEmpty(process.env.SMTP_HOST);
  const portRaw = firstNonEmpty(process.env.SMTP_PORT);
  const user = firstNonEmpty(process.env.SMTP_USER);
  const pass = firstNonEmpty(process.env.SMTP_PASS);
  const from = firstNonEmpty(process.env.SMTP_FROM, process.env.MAIL_FROM, process.env.RESEND_FROM_EMAIL);
  const port = Number.parseInt(portRaw || '0', 10);
  const timeoutMs = parsePositiveInt(process.env.SMTP_TIMEOUT_MS, 12000);

  if (!host || !port || !user || !pass || !from) {
    return {
      attempted: false,
      sent: false,
      reason: 'smtp-not-configured'
    };
  }

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    return {
      attempted: false,
      sent: false,
      reason: 'smtp-module-missing'
    };
  }

  const secure = parseBoolean(process.env.SMTP_SECURE, port === 465);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs
  });

  try {
    await withTimeout(
      transporter.sendMail({
        from,
        to: email,
        subject: String(subject || '').trim() || 'EventIN',
        html: String(html || '').trim() || '<p>Sin contenido</p>',
        text: String(text || '').trim() || undefined
      }),
      timeoutMs + 1000,
      `Timeout enviando email por SMTP (${timeoutMs}ms)`
    );
    return { attempted: true, sent: true, provider: 'smtp' };
  } catch (error) {
    throw new Error(`No se pudo enviar email por SMTP: ${error?.message || 'sin detalle'}`);
  }
};

const sendViaResend = async ({ email, subject, html, text }) => {
  const apiKey = firstNonEmpty(
    process.env.RESEND_API_KEY,
    process.env.RESEND_KEY,
    process.env.RESEND_TOKEN
  );
  const from = firstNonEmpty(
    process.env.RESEND_FROM_EMAIL,
    process.env.RESEND_FROM,
    process.env.RESEND_FROM_MAIL
  );
  const timeoutMs = parsePositiveInt(process.env.RESEND_TIMEOUT_MS, 12000);
  if (!apiKey || !from) {
    return {
      attempted: false,
      sent: false,
      reason: `resend-not-configured:${!apiKey ? 'missing-api-key' : 'ok'}:${!from ? 'missing-from' : 'ok'}`
    };
  }

  let response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        from,
        to: [email],
        subject: String(subject || '').trim() || 'EventIN',
        html: String(html || '').trim() || '<p>Sin contenido</p>',
        text: String(text || '').trim() || undefined
      })
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`No se pudo conectar con Resend: timeout (${timeoutMs}ms)`);
    }
    throw new Error(`No se pudo conectar con Resend: ${error?.message || 'sin detalle'}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const payload = await response.text().catch(() => '');
    throw new Error(
      `No se pudo enviar email por Resend (${response.status}): ${payload || 'sin detalle'}`
    );
  }

  return { attempted: true, sent: true, provider: 'resend' };
};

const sendTransactionalEmail = async ({ to, subject, html, text = '' }) => {
  const email = normalizeEmail(to);
  if (!email) {
    return { attempted: false, sent: false, reason: 'missing-recipient' };
  }

  const reasons = [];
  let attempted = false;

  try {
    const smtpResult = await sendViaSmtp({ email, subject, html, text });
    attempted = attempted || Boolean(smtpResult.attempted);
    if (smtpResult.sent) return smtpResult;
    if (smtpResult.reason) reasons.push(smtpResult.reason);
  } catch (error) {
    attempted = true;
    reasons.push(error?.message || 'smtp-error');
  }

  try {
    const resendResult = await sendViaResend({ email, subject, html, text });
    attempted = attempted || Boolean(resendResult.attempted);
    if (resendResult.sent) return resendResult;
    if (resendResult.reason) reasons.push(resendResult.reason);
  } catch (error) {
    attempted = true;
    reasons.push(error?.message || 'resend-error');
  }

  return {
    attempted,
    sent: false,
    reason: reasons.join('|') || 'mail-error'
  };
};

module.exports = {
  normalizeEmail,
  sendTransactionalEmail
};
