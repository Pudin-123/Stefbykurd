const nodemailer = require('nodemailer');

function getAppBaseUrl(value, isProduction = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('APP_BASE_URL debe ser una URL valida para enviar enlaces de verificacion.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('APP_BASE_URL debe ser el origen de la tienda, sin rutas ni credenciales.');
  }
  if (isProduction && url.protocol !== 'https:') {
    throw new Error('APP_BASE_URL debe usar HTTPS en produccion.');
  }
  return url.origin;
}

function createVerificationEmailSender(env = process.env) {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = env;
  if (![SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM].some(Boolean)) return null;

  if (!SMTP_HOST || !SMTP_PORT) {
    throw new Error('Configura SMTP_HOST y SMTP_PORT para habilitar la verificacion por correo.');
  }
  if (Boolean(SMTP_USER) !== Boolean(SMTP_PASSWORD)) {
    throw new Error('Configura SMTP_USER y SMTP_PASSWORD juntos, o deja ambos vacios.');
  }
  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT debe ser un puerto valido.');
  }
  const secureText = SMTP_SECURE?.toLowerCase();
  if (secureText && !['true', 'false'].includes(secureText)) {
    throw new Error('SMTP_SECURE solo puede ser true o false.');
  }
  const from = SMTP_FROM || SMTP_USER;
  if (!from) throw new Error('Configura SMTP_FROM con el correo que envia las verificaciones.');

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: secureText ? secureText === 'true' : port === 465,
    ...(SMTP_USER ? { auth: { user: SMTP_USER, pass: SMTP_PASSWORD } } : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });

  return async ({ to, name, verificationUrl }) => {
    const safeName = name.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
    await transporter.sendMail({
      from,
      to,
      subject: 'Confirma tu correo para Stefbykurd',
      text: [
        `Hola, ${name}.`,
        '',
        'Para completar la creacion de tu cuenta, confirma que tienes acceso a este correo:',
        verificationUrl,
        '',
        'El enlace vence en 24 horas. Si no solicitaste esta cuenta, puedes ignorar este mensaje.'
      ].join('\n'),
      html: `
        <main style="max-width:560px;margin:32px auto;padding:32px;color:#292a24;font-family:Arial,sans-serif;line-height:1.6">
          <p>Hola, ${safeName}.</p>
          <h1 style="font-family:Georgia,serif;font-weight:500">Confirma tu correo</h1>
          <p>Para completar la creacion de tu cuenta Stefbykurd, confirma que tienes acceso a este correo.</p>
          <p style="margin:28px 0">
            <a href="${verificationUrl}" style="padding:14px 22px;background:#34372d;color:white;text-decoration:none">
              Confirmar mi correo
            </a>
          </p>
          <p>El enlace vence en 24 horas. Si no solicitaste esta cuenta, puedes ignorar este mensaje.</p>
        </main>
      `
    });
  };
}

module.exports = { createVerificationEmailSender, getAppBaseUrl };
