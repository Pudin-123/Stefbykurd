const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const initialProducts = [
  {
    name: 'Bolso tote floral',
    category: 'Estampados',
    description: 'Un toque de color para tus dias. Reutilizable, amplio y lleno de flores.',
    image: '/assets/floral-tote.jpg',
    priceCents: 189000,
    stock: 24,
    featured: 1
  },
  {
    name: 'Tote geometrico',
    category: 'Estampados',
    description: 'Diseno geometrico en tonos naturales, ligero y listo para acompanarte.',
    image: '/assets/geometric-tote.jpg',
    priceCents: 169000,
    stock: 18,
    featured: 1
  },
  {
    name: 'Bolso negro esencial',
    category: 'Clasicos',
    description: 'Minimalista y versatil. Tu bolso de todos los dias, hecho para durar.',
    image: '/assets/black-tote.jpg',
    priceCents: 149000,
    stock: 32,
    featured: 1
  },
  {
    name: 'Tote natural',
    category: 'Clasicos',
    description: 'Un basico atemporal en color natural, comodo y reutilizable.',
    image: '/assets/natural-tote.jpg',
    priceCents: 129000,
    stock: 27,
    featured: 0
  },
  {
    name: 'Bolso tote botanico',
    category: 'Estampados',
    description: 'Inspirado en la naturaleza, con un estampado botanico delicado.',
    image: '/assets/botanical-tote.jpg',
    priceCents: 199000,
    stock: 14,
    featured: 1
  },
  {
    name: 'Tote azul marino',
    category: 'Clasicos',
    description: 'Color profundo y silueta comoda para tus compras y salidas.',
    image: '/assets/navy-tote.jpg',
    priceCents: 159000,
    stock: 20,
    featured: 0
  },
  {
    name: 'Bolso tote de flores',
    category: 'Estampados',
    description: 'Un estampado alegre que transforma cualquier paseo.',
    image: '/assets/flower-tote.jpg',
    priceCents: 189000,
    stock: 16,
    featured: 0
  },
  {
    name: 'Bolso rojo granate',
    category: 'Clasicos',
    description: 'Una pieza practica con un color que no pasa desapercibido.',
    image: '/assets/burgundy-tote.jpg',
    priceCents: 159000,
    stock: 12,
    featured: 0
  }
];

function createDatabase(file = process.env.DATABASE_FILE || './data/stefbykurd.sqlite') {
  const resolvedFile = file === ':memory:' ? file : path.resolve(file);
  if (resolvedFile !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedFile), { recursive: true });
  }
  const db = new DatabaseSync(resolvedFile);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  initializeDatabase(db);
  return db;
}

function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'manager', 'owner')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      email_verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pending_customer_registrations (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      seller_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      image TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      stock INTEGER NOT NULL CHECK (stock >= 0),
      width_cm REAL,
      height_cm REAL,
      depth_cm REAL,
      colors_json TEXT NOT NULL DEFAULT '[]',
      design TEXT NOT NULL DEFAULT '',
      images_json TEXT NOT NULL DEFAULT '[]',
      featured INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      status TEXT NOT NULL DEFAULT 'paid',
      payment_method TEXT NOT NULL DEFAULT 'simulated',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transaction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      line_total_cents INTEGER NOT NULL,
      image_snapshot TEXT NOT NULL DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS buyer_cart_items (
      buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 50),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (buyer_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS buyer_favorites (
      buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (buyer_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_products_active_category ON products(active, category);
    CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_buyer_date ON transactions(buyer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_actor_date ON audit_logs(actor_id, created_at DESC);
  `);
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((column) => column.name === 'email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
  }
  const productColumns = db.prepare('PRAGMA table_info(products)').all();
  for (const [name, definition] of [
    ['width_cm', 'REAL'],
    ['height_cm', 'REAL'],
    ['depth_cm', 'REAL'],
    ['colors_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['design', "TEXT NOT NULL DEFAULT ''"],
    ['images_json', "TEXT NOT NULL DEFAULT '[]'"]
  ]) {
    if (!productColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
    }
  }
  const transactionItemColumns = db.prepare('PRAGMA table_info(transaction_items)').all();
  if (!transactionItemColumns.some((column) => column.name === 'image_snapshot')) {
    db.exec("ALTER TABLE transaction_items ADD COLUMN image_snapshot TEXT NOT NULL DEFAULT ''");
  }
  if (!transactionItemColumns.some((column) => column.name === 'details_json')) {
    db.exec("ALTER TABLE transaction_items ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}'");
  }
  db.exec(`
    UPDATE users SET email_verified_at = CURRENT_TIMESTAMP
    WHERE role IN ('seller', 'manager', 'owner') AND email_verified_at IS NULL
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_customer_verification_expiry
    ON pending_customer_registrations(expires_at)
  `);
  seedProducts(db);
}

function seedProducts(db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
  if (count > 0) return;
  const insert = db.prepare(`
    INSERT INTO products
      (id, name, category, description, image, price_cents, stock, featured)
    VALUES (@id, @name, @category, @description, @image, @priceCents, @stock, @featured)
  `);
  const seed = runTransaction(db, () => {
    for (const product of initialProducts) {
      insert.run({ ...product, id: require('node:crypto').randomUUID() });
    }
  });
  seed();
}

function runTransaction(db, work) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work(...args);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'La transaccion SQLite fallo y no pudo revertirse.'
        );
      }
      throw error;
    }
  };
}

module.exports = { createDatabase, initializeDatabase, runTransaction };
