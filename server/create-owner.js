require('dotenv').config();

const bcrypt = require('bcryptjs');
const { randomUUID } = require('node:crypto');
const { createDatabase } = require('./db');

async function main() {
  const { OWNER_NAME, OWNER_EMAIL, OWNER_PASSWORD } = process.env;
  if (!OWNER_NAME || !OWNER_EMAIL || !OWNER_PASSWORD) {
    throw new Error('Configura OWNER_NAME, OWNER_EMAIL y OWNER_PASSWORD antes de crear al dueño.');
  }
  if (OWNER_PASSWORD.length < 12 || OWNER_PASSWORD.length > 72) {
    throw new Error('OWNER_PASSWORD debe tener entre 12 y 72 caracteres.');
  }
  const db = createDatabase();
  try {
    const exists = db.prepare('SELECT 1 FROM users WHERE role = ? LIMIT 1').get('owner');
    if (exists) throw new Error('Ya existe una cuenta de dueño; no se creara otra.');
    const id = randomUUID();
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, email_verified_at)
      VALUES (?, ?, ?, ?, 'owner', CURRENT_TIMESTAMP)
    `).run(id, OWNER_NAME.trim(), OWNER_EMAIL.trim().toLowerCase(), passwordHash);
    console.log(`Cuenta de dueño creada: ${OWNER_EMAIL.trim().toLowerCase()}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
