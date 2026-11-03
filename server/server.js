require('dotenv').config();

const { randomBytes } = require('node:crypto');
const { createApp } = require('./app');
const { createDatabase } = require('./db');
const { createVerificationEmailSender, getAppBaseUrl } = require('./email');

const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET || (!isProduction ? randomBytes(32).toString('hex') : '');
if (!process.env.JWT_SECRET && isProduction) {
  throw new Error('Define JWT_SECRET con al menos 32 caracteres antes de iniciar en produccion.');
}
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET no esta definido; las sesiones de desarrollo se invalidaran al reiniciar.');
}

const db = createDatabase();
const appBaseUrl = getAppBaseUrl(
  process.env.APP_BASE_URL || `http://localhost:${port}`,
  isProduction
);
const sendVerificationEmail = createVerificationEmailSender(process.env);
if (!sendVerificationEmail) {
  console.warn('Verificacion por correo deshabilitada: configura las variables SMTP en .env.');
}
const app = createApp({
  db,
  jwtSecret,
  isProduction,
  appBaseUrl,
  sendVerificationEmail
});
const server = app.listen(port, () => {
  console.log(`Stefbykurd esta disponible en http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
