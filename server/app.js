const bcrypt = require('bcryptjs');
const express = require('express');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { randomUUID } = require('node:crypto');
const { createHash, randomBytes } = require('node:crypto');
const path = require('node:path');
const multer = require('multer');
const { z, ZodError } = require('zod');
const {
  COOKIE_NAME,
  authenticate,
  isBuyer,
  isManager,
  isSeller,
  issueSession
} = require('./auth');
const { runTransaction } = require('./db');

const verificationTokenLifetime = 24 * 60 * 60 * 1000;
const genericVerificationMessage =
  'Si la direccion puede registrarse, te enviaremos un enlace para confirmar tu correo. Revisa tambien la carpeta de spam.';
const registrationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(72)
});
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(72),
  rememberMe: z.boolean().default(false)
});
const verificationRequestSchema = z.object({
  email: z.string().trim().email().max(254)
});
const verificationSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});
const productImageExtensions = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};
const productImageSchema = z.string().trim().min(1).max(500).refine(
  (value) => /^\/(?:assets|uploads)\/[A-Za-z0-9._/-]+$/.test(value) || /^https:\/\//i.test(value),
  'La imagen debe ser una ruta local valida o una URL HTTPS.'
);
const productSchema = z.object({
  name: z.string().trim().min(2).max(100),
  category: z.string().trim().min(2).max(50),
  description: z.string().trim().min(5).max(1000),
  image: productImageSchema,
  price: z.number().finite().min(0.01).max(100000),
  stock: z.number().int().min(0).max(100000),
  widthCm: z.number().finite().min(0.1).max(500).nullable().default(null),
  heightCm: z.number().finite().min(0.1).max(500).nullable().default(null),
  depthCm: z.number().finite().min(0.1).max(500).nullable().default(null),
  colors: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  design: z.string().trim().max(500).default(''),
  images: z.array(productImageSchema).max(10).default([])
});
const checkoutSchema = z.object({
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(50)
  })).min(1).max(50)
});
const cartSchema = z.object({
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(50)
  })).max(100).refine(
    (items) => new Set(items.map((item) => item.productId)).size === items.length,
    'No repitas productos en la bolsa.'
  )
});
const staffSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(72),
  role: z.enum(['seller', 'manager'])
});
const staffPasswordSchema = z.object({
  password: z.string().min(10).max(72)
});

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function formatProduct(row) {
  const { colorsJson, imagesJson, ...product } = row;
  return {
    ...product,
    colors: JSON.parse(colorsJson || '[]'),
    images: JSON.parse(imagesJson || '[]')
  };
}

function productDetailsSnapshot(product) {
  return {
    category: product.category,
    description: product.description,
    widthCm: product.widthCm,
    heightCm: product.heightCm,
    depthCm: product.depthCm,
    colors: JSON.parse(product.colorsJson || '[]'),
    design: product.design || '',
    images: JSON.parse(product.imagesJson || '[]')
  };
}

function createApp({
  db,
  jwtSecret,
  isProduction = false,
  webRoot = path.join(__dirname, '..', 'public'),
  uploadDirectory = path.join(__dirname, '..', 'data', 'product-images'),
  appBaseUrl = 'http://localhost:3000',
  sendVerificationEmail,
  logger = console
}) {
  if (!db) throw new Error('createApp requiere una conexion de base de datos.');
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres.');

  const app = express();
  const resolvedUploadDirectory = path.resolve(uploadDirectory);
  fs.mkdirSync(resolvedUploadDirectory, { recursive: true });
  const imageUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, resolvedUploadDirectory),
      filename: (_req, file, callback) => {
        const extension = productImageExtensions[file.mimetype];
        callback(null, `${randomUUID()}${extension || '.invalid'}`);
      }
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 11, fields: 0, parts: 11 },
    fileFilter: (_req, file, callback) => {
      if (!productImageExtensions[file.mimetype]) {
        const error = new Error('Solo se aceptan fotos JPG, PNG o WebP.');
        error.code = 'INVALID_IMAGE_TYPE';
        return callback(error);
      }
      return callback(null, true);
    }
  });
  const receiveProductImages = (req, res, next) => {
    imageUpload.array('images', 11)(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError) {
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({
          error: tooLarge
            ? 'Cada foto debe pesar como maximo 5 MB.'
            : 'Puedes seleccionar una foto principal y hasta 10 fotos adicionales.'
        });
      }
      if (error.code === 'INVALID_IMAGE_TYPE') return res.status(400).json({ error: error.message });
      return next(error);
    });
  };
  const hasValidImageSignature = async (file) => {
    const handle = await fsPromises.open(file.path, 'r');
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const bytes = header.subarray(0, bytesRead);
      if (file.mimetype === 'image/jpeg') {
        return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      }
      if (file.mimetype === 'image/png') {
        return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }
      return file.mimetype === 'image/webp' &&
        bytes.length >= 12 &&
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WEBP';
    } finally {
      await handle.close();
    }
  };
  const requireAuth = authenticate(db, jwtSecret);
  const optionalAuth = authenticate(db, jwtSecret, { optional: true });
  const staffOrManager = (req, res, next) => {
    if (req.user && ['seller', 'manager', 'owner'].includes(req.user.role)) return next();
    return res.status(403).json({ error: 'No tienes permisos para realizar esta accion.' });
  };
  const managerOrOwner = (req, res, next) => {
    if (req.user && ['manager', 'owner'].includes(req.user.role)) return next();
    return res.status(403).json({ error: 'No tienes permisos para realizar esta accion.' });
  };
  const currentBuyerSession = (req, res, next) => {
    const buyerId = req.get('X-Buyer-Id');
    if (buyerId && buyerId !== req.user.id) {
      return res.status(409).json({
        error: 'La cuenta activa cambio en otra pestana. Recarga para continuar.'
      });
    }
    return next();
  };
  const saveAudit = (actor, action, entityType, entityId, details = {}) => {
    db.prepare(`
      INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(actor.id, actor.name, actor.role, action, entityType, entityId || null, JSON.stringify(details));
  };

  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'img-src': ["'self'", 'data:', 'https:', 'blob:'],
        'script-src': ["'self'"],
        'style-src': ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    return next();
  });
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      let origin;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        return res.status(403).json({ error: 'Origen de solicitud no permitido.' });
      }
      if (origin.host !== req.headers.host || origin.protocol !== `${req.protocol}:`) {
        return res.status(403).json({ error: 'Origen de solicitud no permitido.' });
      }
    }
    return next();
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' }
  });
  const verificationRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Hiciste demasiadas solicitudes. Espera unos minutos e intenta de nuevo.' }
  });
  const verificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Hiciste demasiados intentos. Espera unos minutos e intenta de nuevo.' }
  });
  const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
  const createPendingRegistration = (input) => {
    const token = randomBytes(32).toString('base64url');
    const pending = {
      id: randomUUID(),
      userId: input.userId || null,
      name: input.name,
      email: input.email,
      passwordHash: input.passwordHash,
      tokenHash: tokenHash(token),
      expiresAt: Date.now() + verificationTokenLifetime
    };
    const record = db.prepare(`
      INSERT INTO pending_customer_registrations
        (id, user_id, name, email, password_hash, token_hash, expires_at)
      VALUES (@id, @userId, @name, @email, @passwordHash, @tokenHash, @expiresAt)
      ON CONFLICT(email) DO UPDATE SET
        user_id = excluded.user_id,
        name = excluded.name,
        password_hash = excluded.password_hash,
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at
      RETURNING id
    `).get(pending);
    return {
      id: record.id,
      token,
      email: input.email,
      name: input.name
    };
  };
  const deliverVerification = async (pending) => {
    const url = new URL('/', appBaseUrl);
    url.searchParams.set('verify', pending.token);
    await sendVerificationEmail({
      to: pending.email,
      name: pending.name,
      verificationUrl: url.href
    });
  };

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  app.post('/api/auth/register', verificationRequestLimiter, async (req, res, next) => {
    try {
      if (!sendVerificationEmail) {
        return res.status(503).json({
          error: 'El registro requiere configurar el servidor SMTP para enviar el correo de verificacion.',
          code: 'EMAIL_NOT_CONFIGURED'
        });
      }
      const input = registrationSchema.parse(req.body);
      const email = input.email.toLowerCase();
      const existingUser = db.prepare(`
        SELECT id, name, email, role, status, password_hash AS passwordHash,
               email_verified_at AS emailVerifiedAt
        FROM users WHERE email = ? COLLATE NOCASE
      `).get(email);
      if (existingUser &&
        (existingUser.role !== 'buyer' || existingUser.emailVerifiedAt || existingUser.status !== 'active')) {
        return res.status(202).json({ message: genericVerificationMessage });
      }
      const passwordHash = existingUser
        ? existingUser.passwordHash
        : await bcrypt.hash(input.password, 12);
      const pending = createPendingRegistration({
        userId: existingUser?.id,
        name: existingUser?.name || input.name,
        email,
        passwordHash
      });
      try {
        await deliverVerification(pending);
      } catch (error) {
        logger.error('No se pudo enviar el correo de verificacion:', error.message);
        return res.status(502).json({
          error: 'No se pudo enviar el correo de verificacion. Comprueba la configuracion SMTP e intenta de nuevo.',
          code: 'EMAIL_DELIVERY_FAILED'
        });
      }
      return res.status(202).json({ message: genericVerificationMessage, email });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(202).json({ message: genericVerificationMessage });
      }
      return next(error);
    }
  });

  app.post('/api/auth/login', authLimiter, async (req, res, next) => {
    try {
      const input = loginSchema.parse(req.body);
      const user = db.prepare(`
        SELECT id, name, email, role, status, password_hash,
               email_verified_at AS emailVerifiedAt
        FROM users WHERE email = ? COLLATE NOCASE
      `).get(input.email);
      const validPassword = await bcrypt.compare(input.password, user?.password_hash || '$2a$12$invalidhashforconstanttimecomparison000000000000000000000');
      if (!user || user.status !== 'active' || !validPassword) {
        return res.status(401).json({ error: 'Correo o contrasena incorrectos.' });
      }
      if (user.role === 'buyer' && !user.emailVerifiedAt) {
        return res.status(403).json({
          error: 'Confirma tu correo para activar tu cuenta. Puedes solicitar un enlace nuevo.',
          code: 'EMAIL_NOT_VERIFIED'
        });
      }
      issueSession(user, jwtSecret, res, isProduction, input.rememberMe);
      return res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/auth/resend-verification', verificationRequestLimiter, async (req, res, next) => {
    try {
      const input = verificationRequestSchema.parse(req.body);
      if (!sendVerificationEmail) {
        return res.status(503).json({
          error: 'El reenvio requiere configurar el servidor SMTP.',
          code: 'EMAIL_NOT_CONFIGURED'
        });
      }
      const email = input.email.toLowerCase();
      const existingUser = db.prepare(`
        SELECT id, name, email, role, status, password_hash AS passwordHash,
               email_verified_at AS emailVerifiedAt
        FROM users WHERE email = ? COLLATE NOCASE
      `).get(email);
      const pendingRegistration = db.prepare(`
        SELECT id, user_id AS userId, name, email, password_hash AS passwordHash,
               token_hash AS tokenHash, expires_at AS expiresAt
        FROM pending_customer_registrations WHERE email = ? COLLATE NOCASE
      `).get(email);
      const isUnverifiedBuyer = existingUser?.role === 'buyer' &&
        existingUser.status === 'active' && !existingUser.emailVerifiedAt;
      if (!isUnverifiedBuyer && !pendingRegistration) {
        return res.json({ message: genericVerificationMessage });
      }
      const pending = createPendingRegistration({
        userId: isUnverifiedBuyer ? existingUser.id : pendingRegistration.userId,
        name: isUnverifiedBuyer ? existingUser.name : pendingRegistration.name,
        email,
        passwordHash: isUnverifiedBuyer ? existingUser.passwordHash : pendingRegistration.passwordHash
      });
      try {
        await deliverVerification(pending);
      } catch (error) {
        if (pendingRegistration) {
          db.prepare(`
            UPDATE pending_customer_registrations SET token_hash = ?, expires_at = ? WHERE id = ?
          `).run(pendingRegistration.tokenHash, pendingRegistration.expiresAt, pending.id);
        } else {
          db.prepare('DELETE FROM pending_customer_registrations WHERE id = ?').run(pending.id);
        }
        logger.error('No se pudo reenviar el correo de verificacion:', error.message);
        return res.status(502).json({
          error: 'No se pudo enviar el correo. Comprueba el servidor SMTP e intenta de nuevo.',
          code: 'EMAIL_DELIVERY_FAILED'
        });
      }
      return res.json({ message: genericVerificationMessage });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/auth/verify-email', verificationLimiter, (req, res, next) => {
    try {
      const input = verificationSchema.parse(req.body);
      const pending = db.prepare(`
        SELECT id, user_id AS userId, name, email, password_hash AS passwordHash, expires_at AS expiresAt
        FROM pending_customer_registrations WHERE token_hash = ?
      `).get(tokenHash(input.token));
      if (!pending) {
        return res.status(400).json({ error: 'El enlace no es valido o ya fue utilizado.' });
      }
      if (pending.expiresAt <= Date.now()) {
        return res.status(410).json({
          error: 'El enlace vencio. Solicita que te enviemos uno nuevo.',
          code: 'EMAIL_VERIFICATION_EXPIRED'
        });
      }
      const completeVerification = runTransaction(db, () => {
        if (pending.userId) {
          const updated = db.prepare(`
            UPDATE users SET email_verified_at = CURRENT_TIMESTAMP
            WHERE id = ? AND role = 'buyer' AND email_verified_at IS NULL AND status = 'active'
          `).run(pending.userId);
          if (updated.changes !== 1) {
            const error = new Error('La cuenta ya no puede verificarse con este enlace.');
            error.status = 409;
            throw error;
          }
        } else {
          const buyerId = randomUUID();
          db.prepare(`
            INSERT INTO users (id, name, email, password_hash, role, email_verified_at)
            VALUES (?, ?, ?, ?, 'buyer', CURRENT_TIMESTAMP)
          `).run(buyerId, pending.name, pending.email, pending.passwordHash);
        }
        db.prepare('DELETE FROM pending_customer_registrations WHERE id = ?').run(pending.id);
      });
      completeVerification();
      return res.json({ message: 'Correo confirmado. Ya puedes iniciar sesion.' });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'Este correo ya tiene una cuenta activa.' });
      }
      return next(error);
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/'
    });
    return res.status(204).end();
  });

  app.get('/api/auth/me', optionalAuth, (req, res) => res.json({ user: req.user || null }));

  app.get('/api/products', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 50) : '';
    const products = db.prepare(`
      SELECT id, name, category, description, image, price_cents AS priceCents,
             stock, featured, seller_id AS sellerId, width_cm AS widthCm,
             height_cm AS heightCm, depth_cm AS depthCm, colors_json AS colorsJson,
             design, images_json AS imagesJson
      FROM products
      WHERE active = 1
        AND (? = '' OR name LIKE '%' || ? || '%' OR description LIKE '%' || ? || '%')
        AND (? = '' OR category = ?)
      ORDER BY featured DESC, created_at DESC
      LIMIT 100
    `).all(query, query, query, category, category).map(formatProduct);
    return res.json({ products, categories: db.prepare(
      'SELECT DISTINCT category FROM products WHERE active = 1 ORDER BY category'
    ).all().map((row) => row.category) });
  });

  app.get('/api/cart/mine', requireAuth, isBuyer, currentBuyerSession, (req, res) => {
    const items = db.prepare(`
      SELECT p.id AS productId, c.quantity, p.name, p.category, p.description,
             p.image, p.price_cents AS priceCents, p.stock, p.active,
             p.width_cm AS widthCm, p.height_cm AS heightCm, p.depth_cm AS depthCm,
             p.colors_json AS colorsJson, p.design, p.images_json AS imagesJson
      FROM buyer_cart_items c
      JOIN products p ON p.id = c.product_id
      WHERE c.buyer_id = ?
      ORDER BY c.updated_at DESC, p.name COLLATE NOCASE
    `).all(req.user.id).map((item) => ({
      ...formatProduct(item),
      id: item.productId
    }));
    return res.json({ items });
  });

  app.put('/api/cart/mine', requireAuth, isBuyer, currentBuyerSession, (req, res, next) => {
    try {
      const { items } = cartSchema.parse(req.body);
      const saveCart = runTransaction(db, () => {
        const findProduct = db.prepare(
          'SELECT name, stock FROM products WHERE id = ? AND active = 1'
        );
        for (const item of items) {
          const product = findProduct.get(item.productId);
          if (!product) {
            const error = new Error('Uno de los productos ya no esta disponible.');
            error.status = 409;
            throw error;
          }
          if (item.quantity > product.stock) {
            const error = new Error(`Stock insuficiente para ${product.name}.`);
            error.status = 409;
            throw error;
          }
        }
        db.prepare('DELETE FROM buyer_cart_items WHERE buyer_id = ?').run(req.user.id);
        const insert = db.prepare(`
          INSERT INTO buyer_cart_items (buyer_id, product_id, quantity)
          VALUES (?, ?, ?)
        `);
        for (const item of items) insert.run(req.user.id, item.productId, item.quantity);
      });
      saveCart();
      return res.json({ message: 'Bolsa guardada.' });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/favorites/mine', requireAuth, isBuyer, currentBuyerSession, (req, res) => {
    const favorites = db.prepare(`
      SELECT p.id, p.name, p.category, p.description, p.image,
             p.price_cents AS priceCents, p.stock, p.seller_id AS sellerId,
             p.width_cm AS widthCm, p.height_cm AS heightCm, p.depth_cm AS depthCm,
             p.colors_json AS colorsJson, p.design, p.images_json AS imagesJson
      FROM buyer_favorites f
      JOIN products p ON p.id = f.product_id
      WHERE f.buyer_id = ? AND p.active = 1
      ORDER BY f.created_at DESC
    `).all(req.user.id).map(formatProduct);
    return res.json({ favorites });
  });

  app.post('/api/favorites/:productId', requireAuth, isBuyer, currentBuyerSession, (req, res, next) => {
    if (!z.string().uuid().safeParse(req.params.productId).success) {
      return res.status(400).json({ error: 'Producto no valido.' });
    }
    const product = db.prepare('SELECT id FROM products WHERE id = ? AND active = 1')
      .get(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    try {
      const result = db.prepare(`
        INSERT OR IGNORE INTO buyer_favorites (buyer_id, product_id)
        VALUES (?, ?)
      `).run(req.user.id, product.id);
      return res.status(result.changes ? 201 : 200).json({ favorite: true });
    } catch (error) {
      return next(error);
    }
  });

  app.delete('/api/favorites/:productId', requireAuth, isBuyer, currentBuyerSession, (req, res) => {
    if (!z.string().uuid().safeParse(req.params.productId).success) {
      return res.status(400).json({ error: 'Producto no valido.' });
    }
    db.prepare('DELETE FROM buyer_favorites WHERE buyer_id = ? AND product_id = ?')
      .run(req.user.id, req.params.productId);
    return res.status(204).end();
  });

  app.post('/api/checkout', requireAuth, isBuyer, currentBuyerSession, (req, res, next) => {
    try {
      const input = checkoutSchema.parse(req.body);
      const quantities = new Map();
      for (const item of input.items) {
        quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
      }
      if ([...quantities.values()].some((quantity) => quantity > 50)) {
        return res.status(400).json({ error: 'La cantidad solicitada supera el limite por producto.' });
      }

      const createOrder = runTransaction(db, () => {
        const orderItems = [];
        let totalCents = 0;
        for (const [productId, quantity] of quantities) {
          const product = db.prepare(`
            SELECT id, name, category, description, image, price_cents, stock,
                   width_cm AS widthCm, height_cm AS heightCm, depth_cm AS depthCm,
                   colors_json AS colorsJson, design, images_json AS imagesJson
            FROM products WHERE id = ? AND active = 1
          `).get(productId);
          if (!product) {
            const error = new Error('Uno de los productos ya no esta disponible.');
            error.status = 409;
            throw error;
          }
          const changed = db.prepare(`
            UPDATE products SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND active = 1 AND stock >= ?
          `).run(quantity, productId, quantity);
          if (changed.changes !== 1) {
            const error = new Error(`Stock insuficiente para ${product.name}.`);
            error.status = 409;
            throw error;
          }
          const lineTotalCents = product.price_cents * quantity;
          totalCents += lineTotalCents;
          orderItems.push({
            ...product,
            quantity,
            lineTotalCents,
            detailsSnapshot: productDetailsSnapshot(product)
          });
        }

        const transactionId = randomUUID();
        db.prepare(`
          INSERT INTO transactions (id, buyer_id, total_cents, status, payment_method)
          VALUES (?, ?, ?, 'paid', 'simulated')
        `).run(transactionId, req.user.id, totalCents);
        const insertItem = db.prepare(`
          INSERT INTO transaction_items
            (transaction_id, product_id, product_name, unit_price_cents, quantity,
             line_total_cents, image_snapshot, details_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of orderItems) {
          insertItem.run(
            transactionId,
            item.id,
            item.name,
            item.price_cents,
            item.quantity,
            item.lineTotalCents,
            item.image,
            JSON.stringify(item.detailsSnapshot)
          );
        }
        const deleteCartItem = db.prepare(`
          DELETE FROM buyer_cart_items
          WHERE buyer_id = ? AND product_id = ? AND quantity <= ?
        `);
        const updateCart = db.prepare(`
          UPDATE buyer_cart_items SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP
          WHERE buyer_id = ? AND product_id = ? AND quantity > ?
        `);
        for (const [productId, quantity] of quantities) {
          deleteCartItem.run(req.user.id, productId, quantity);
          updateCart.run(quantity, req.user.id, productId, quantity);
        }
        return {
          id: transactionId,
          totalCents,
          items: orderItems.map(({ id, name, image, price_cents, quantity, lineTotalCents, detailsSnapshot }) => ({
            productId: id,
            name,
            image,
            unitPriceCents: price_cents,
            quantity,
            lineTotalCents,
            ...detailsSnapshot
          }))
        };
      });

      return res.status(201).json({ transaction: createOrder() });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/transactions/mine', requireAuth, isBuyer, (req, res) => {
    const transactions = db.prepare(`
      SELECT t.id, t.total_cents AS totalCents, t.status, t.payment_method AS paymentMethod,
             t.created_at AS createdAt,
             (SELECT COUNT(*) FROM transaction_items i WHERE i.transaction_id = t.id) AS itemCount
      FROM transactions t WHERE t.buyer_id = ? ORDER BY t.created_at DESC LIMIT 50
    `).all(req.user.id);
    if (!transactions.length) return res.json({ transactions });
    const itemPlaceholders = transactions.map(() => '?').join(', ');
    const items = db.prepare(`
      SELECT i.transaction_id AS transactionId, i.product_id AS productId,
             i.product_name AS name, i.unit_price_cents AS unitPriceCents,
             i.quantity, i.line_total_cents AS lineTotalCents,
             i.image_snapshot AS imageSnapshot, i.details_json AS detailsJson,
             p.image AS currentImage, p.category AS currentCategory,
             p.description AS currentDescription, p.width_cm AS currentWidthCm,
             p.height_cm AS currentHeightCm, p.depth_cm AS currentDepthCm,
             p.colors_json AS currentColorsJson, p.design AS currentDesign,
             p.images_json AS currentImagesJson
      FROM transaction_items i
      LEFT JOIN products p ON p.id = i.product_id
      WHERE i.transaction_id IN (${itemPlaceholders})
      ORDER BY i.id
    `).all(...transactions.map((transaction) => transaction.id));
    const itemsByTransaction = new Map(transactions.map((transaction) => [transaction.id, []]));
    for (const item of items) {
      const saved = JSON.parse(item.detailsJson || '{}');
      const currentColors = JSON.parse(item.currentColorsJson || '[]');
      const currentImages = JSON.parse(item.currentImagesJson || '[]');
      itemsByTransaction.get(item.transactionId).push({
        productId: item.productId,
        name: item.name,
        image: item.imageSnapshot || item.currentImage || '',
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
        lineTotalCents: item.lineTotalCents,
        category: Object.hasOwn(saved, 'category') ? saved.category : item.currentCategory || '',
        description: Object.hasOwn(saved, 'description') ? saved.description : item.currentDescription || '',
        widthCm: Object.hasOwn(saved, 'widthCm') ? saved.widthCm : item.currentWidthCm,
        heightCm: Object.hasOwn(saved, 'heightCm') ? saved.heightCm : item.currentHeightCm,
        depthCm: Object.hasOwn(saved, 'depthCm') ? saved.depthCm : item.currentDepthCm,
        colors: Array.isArray(saved.colors) ? saved.colors : currentColors,
        design: Object.hasOwn(saved, 'design') ? saved.design : item.currentDesign || '',
        images: Array.isArray(saved.images) ? saved.images : currentImages
      });
    }
    for (const transaction of transactions) {
      transaction.items = itemsByTransaction.get(transaction.id);
    }
    return res.json({ transactions });
  });

  app.get('/api/seller/audit', requireAuth, isSeller, (req, res) => {
    const logs = db.prepare(`
      SELECT id, actor_name AS actorName, actor_role AS actorRole, action,
             entity_type AS entityType, entity_id AS entityId, details,
             created_at AS createdAt
      FROM audit_logs WHERE actor_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(req.user.id).map((log) => ({ ...log, details: JSON.parse(log.details) }));
    return res.json({ logs });
  });

  app.get('/api/seller/products', requireAuth, staffOrManager, (req, res) => {
    const isSellerUser = req.user.role === 'seller';
    const products = db.prepare(`
      SELECT id, name, category, description, image, price_cents AS priceCents,
             stock, active, seller_id AS sellerId, width_cm AS widthCm,
             height_cm AS heightCm, depth_cm AS depthCm, colors_json AS colorsJson,
             design, images_json AS imagesJson
      FROM products
      WHERE (? = 0 OR active = 1)
      ORDER BY active DESC, created_at DESC, name COLLATE NOCASE
    `).all(isSellerUser ? 1 : 0).map(formatProduct);
    return res.json({ products });
  });

  app.post('/api/seller/uploads', requireAuth, staffOrManager, receiveProductImages, async (req, res, next) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Selecciona al menos una foto del dispositivo.' });
    try {
      const validImages = await Promise.all(files.map(hasValidImageSignature));
      if (validImages.some((valid) => !valid)) {
        await Promise.all(files.map((file) => fsPromises.unlink(file.path)));
        return res.status(400).json({ error: 'Una de las fotos no es una imagen JPG, PNG o WebP valida.' });
      }
      return res.status(201).json({
        images: files.map((file) => `/uploads/${file.filename}`)
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/seller/products', requireAuth, staffOrManager, (req, res, next) => {
    try {
      const input = productSchema.parse(req.body);
      const id = randomUUID();
      db.prepare(`
        INSERT INTO products
          (id, seller_id, name, category, description, image, price_cents, stock,
           width_cm, height_cm, depth_cm, colors_json, design, images_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, req.user.id, input.name, input.category, input.description, input.image,
        Math.round(input.price * 100), input.stock, input.widthCm, input.heightCm, input.depthCm,
        JSON.stringify(input.colors), input.design, JSON.stringify(input.images));
      saveAudit(req.user, 'product.created', 'product', id, { name: input.name });
      return res.status(201).json({
        product: {
          id, ...input, priceCents: Math.round(input.price * 100),
          sellerId: req.user.id, active: 1
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  app.put('/api/seller/products/:id', requireAuth, staffOrManager, (req, res, next) => {
    try {
      const input = productSchema.parse(req.body);
      const product = db.prepare('SELECT id, seller_id AS sellerId FROM products WHERE id = ? AND active = 1')
        .get(req.params.id);
      if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
      db.prepare(`
        UPDATE products
        SET name = ?, category = ?, description = ?, image = ?, price_cents = ?, stock = ?,
            width_cm = ?, height_cm = ?, depth_cm = ?, colors_json = ?, design = ?,
            images_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(input.name, input.category, input.description, input.image,
        Math.round(input.price * 100), input.stock, input.widthCm, input.heightCm, input.depthCm,
        JSON.stringify(input.colors), input.design, JSON.stringify(input.images), product.id);
      saveAudit(req.user, 'product.updated', 'product', product.id, { name: input.name });
      return res.json({ product: { id: product.id, ...input, priceCents: Math.round(input.price * 100), sellerId: product.sellerId } });
    } catch (error) {
      return next(error);
    }
  });

  app.delete('/api/seller/products/:id', requireAuth, staffOrManager, (req, res) => {
    const product = db.prepare('SELECT id, seller_id AS sellerId, name FROM products WHERE id = ? AND active = 1')
      .get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (req.user.role === 'seller' && product.sellerId !== req.user.id) {
      return res.status(403).json({ error: 'Solo puedes eliminar productos que hayas publicado.' });
    }
    db.prepare('UPDATE products SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(product.id);
    saveAudit(req.user, 'product.deleted', 'product', product.id, { name: product.name });
    return res.status(204).end();
  });

  app.get('/api/admin/summary', requireAuth, isManager, (req, res) => {
    const summary = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM products WHERE active = 1) AS activeProducts,
        (SELECT COUNT(*) FROM users WHERE role = 'seller' AND status = 'active') AS activeSellers,
        (SELECT COUNT(*) FROM transactions) AS transactions,
        (SELECT COALESCE(SUM(total_cents), 0) FROM transactions) AS revenueCents
    `).get();
    return res.json({ summary });
  });

  app.get('/api/admin/transactions', requireAuth, isManager, (req, res) => {
    const offsetValue = Number(req.query.offset);
    const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
    const limit = 100;
    const total = db.prepare('SELECT COUNT(*) AS total FROM transactions').get().total;
    const transactions = db.prepare(`
      SELECT t.id, t.total_cents AS totalCents, t.status, t.payment_method AS paymentMethod,
             t.created_at AS createdAt, u.name AS buyerName, u.email AS buyerEmail,
             (SELECT COUNT(*) FROM transaction_items i WHERE i.transaction_id = t.id) AS itemCount
      FROM transactions t JOIN users u ON u.id = t.buyer_id
      ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
    return res.json({
      transactions,
      pagination: { offset, limit, total, nextOffset: offset + transactions.length < total ? offset + limit : null }
    });
  });

  app.get('/api/admin/carts', requireAuth, isManager, (req, res) => {
    const offsetValue = Number(req.query.offset);
    const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
    const limit = 100;
    const total = db.prepare(`
      SELECT COUNT(*) AS total FROM users WHERE role = 'buyer'
    `).get().total;
    const buyers = db.prepare(`
      SELECT u.id AS buyerId, u.name AS buyerName, u.email AS buyerEmail,
             COUNT(c.product_id) AS itemCount,
             COALESCE(SUM(c.quantity), 0) AS unitCount,
             COALESCE(SUM(c.quantity * p.price_cents), 0) AS totalCents
      FROM users u
      LEFT JOIN buyer_cart_items c ON c.buyer_id = u.id
      LEFT JOIN products p ON p.id = c.product_id
      WHERE u.role = 'buyer'
      GROUP BY u.id
      ORDER BY u.name COLLATE NOCASE, u.email COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const itemsByBuyer = new Map(buyers.map((buyer) => [buyer.buyerId, []]));
    if (buyers.length) {
      const placeholders = buyers.map(() => '?').join(', ');
      const items = db.prepare(`
        SELECT c.buyer_id AS buyerId, p.id AS productId, p.name, p.image,
               p.price_cents AS priceCents, p.stock, p.active, c.quantity
        FROM buyer_cart_items c
        JOIN products p ON p.id = c.product_id
        WHERE c.buyer_id IN (${placeholders})
        ORDER BY p.name COLLATE NOCASE
      `).all(...buyers.map((buyer) => buyer.buyerId));
      for (const item of items) itemsByBuyer.get(item.buyerId).push(item);
    }
    return res.json({
      carts: buyers.map((buyer) => ({
        ...buyer,
        items: itemsByBuyer.get(buyer.buyerId)
      })),
      pagination: {
        offset,
        limit,
        total,
        nextOffset: offset + buyers.length < total ? offset + limit : null
      }
    });
  });

  app.get('/api/admin/audit', requireAuth, isManager, (req, res) => {
    const offsetValue = Number(req.query.offset);
    const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
    const limit = 100;
    const total = db.prepare(`
      SELECT COUNT(*) AS total FROM audit_logs WHERE actor_role = 'seller' OR ? = 'owner'
    `).get(req.user.role).total;
    const logs = db.prepare(`
      SELECT id, actor_id AS actorId, actor_name AS actorName, actor_role AS actorRole,
             action, entity_type AS entityType, entity_id AS entityId,
             details, created_at AS createdAt
      FROM audit_logs
      WHERE actor_role = 'seller' OR ? = 'owner'
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(req.user.role, limit, offset);
    return res.json({
      logs: logs.map((log) => ({ ...log, details: JSON.parse(log.details) })),
      pagination: { offset, limit, total, nextOffset: offset + logs.length < total ? offset + limit : null }
    });
  });

  app.get('/api/admin/users', requireAuth, isManager, (req, res) => {
    const users = db.prepare(`
      SELECT id, name, email, role, status, created_at AS createdAt
      FROM users
      WHERE role != 'owner' AND (? = 'owner' OR role != 'manager')
      ORDER BY created_at DESC LIMIT 500
    `).all(req.user.role);
    return res.json({ users });
  });

  app.post('/api/admin/users', requireAuth, managerOrOwner, async (req, res, next) => {
    try {
      const input = staffSchema.parse(req.body);
      if (input.role === 'manager' && req.user.role !== 'owner') {
        return res.status(403).json({ error: 'Solo el dueño puede asignar el rol de gerente.' });
      }
      const id = randomUUID();
      const passwordHash = await bcrypt.hash(input.password, 12);
      db.prepare(`
        INSERT INTO users (id, name, email, password_hash, role, email_verified_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(id, input.name, input.email.toLowerCase(), passwordHash, input.role);
      saveAudit(req.user, `user.${input.role}.created`, 'user', id, { email: input.email.toLowerCase() });
      return res.status(201).json({
        user: { id, name: input.name, email: input.email.toLowerCase(), role: input.role, status: 'active' }
      });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
      }
      return next(error);
    }
  });

  app.patch('/api/admin/users/:id/password', requireAuth, isManager, async (req, res, next) => {
    try {
      const input = staffPasswordSchema.parse(req.body);
      const target = db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(req.params.id);
      if (!target || target.role !== 'seller') {
        return res.status(404).json({ error: 'Vendedor no encontrado.' });
      }
      if (target.status !== 'active') {
        return res.status(409).json({ error: 'Reactiva la cuenta antes de cambiar su contrasena.' });
      }
      const passwordHash = await bcrypt.hash(input.password, 12);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, target.id);
      saveAudit(req.user, 'user.password.reset', 'user', target.id, { role: target.role });
      return res.json({ message: 'Contrasena del vendedor actualizada.' });
    } catch (error) {
      return next(error);
    }
  });

  app.patch('/api/admin/users/:id/status', requireAuth, isManager, (req, res) => {
    const input = z.object({ status: z.enum(['active', 'suspended']) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Estado de usuario no valido.' });
    const target = db.prepare('SELECT id, name, role, status FROM users WHERE id = ?').get(req.params.id);
    if (!target || target.role === 'owner' || (target.role === 'manager' && req.user.role !== 'owner')) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (target.id === req.user.id) return res.status(400).json({ error: 'No puedes cambiar tu propio estado.' });
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(input.data.status, target.id);
    saveAudit(req.user, `user.${input.data.status}`, 'user', target.id, { role: target.role });
    return res.json({ user: { id: target.id, status: input.data.status } });
  });

  app.delete('/api/admin/users/:id', requireAuth, isManager, (req, res) => {
    const target = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.params.id);
    if (!target || target.role === 'owner' || (target.role === 'manager' && req.user.role !== 'owner')) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (target.id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta.' });
    if (target.role === 'buyer') {
      db.prepare('DELETE FROM buyer_cart_items WHERE buyer_id = ?').run(target.id);
      db.prepare('DELETE FROM buyer_favorites WHERE buyer_id = ?').run(target.id);
      const hasOrders = db.prepare('SELECT 1 FROM transactions WHERE buyer_id = ? LIMIT 1').get(target.id);
      if (hasOrders) {
        db.prepare(`
          UPDATE users SET name = 'Cuenta eliminada', email = ?, status = 'suspended'
          WHERE id = ?
        `).run(`deleted+${target.id}@invalid.local`, target.id);
      } else {
        db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      }
    } else {
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    }
    saveAudit(req.user, 'user.deleted', 'user', target.id, { role: target.role });
    return res.status(204).end();
  });

  app.use('/uploads', express.static(resolvedUploadDirectory, {
    fallthrough: false,
    maxAge: isProduction ? '7d' : 0,
    dotfiles: 'deny',
    index: false,
    setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff')
  }));
  app.use('/assets', express.static(path.join(webRoot, 'assets'), {
    fallthrough: false,
    maxAge: isProduction ? '7d' : 0,
    dotfiles: 'deny',
    index: false
  }));
  app.use(express.static(webRoot, { index: 'index.html', dotfiles: 'deny' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Recurso no encontrado.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: 'Datos no validos.',
        details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
      });
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Cada foto debe pesar como maximo 5 MB.' });
    }
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    }
    logger.error('Error de solicitud:', error);
    return res.status(500).json({ error: 'Ocurrio un error interno. Intenta de nuevo.' });
  });

  return app;
}

module.exports = { createApp };
