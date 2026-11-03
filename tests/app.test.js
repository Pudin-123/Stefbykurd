const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const jwt = require('jsonwebtoken');
const { afterEach, beforeEach, test } = require('node:test');
const { createApp } = require('../server/app');
const { createDatabase, initializeDatabase } = require('../server/db');
const { createVerificationEmailSender, getAppBaseUrl } = require('../server/email');

const jwtSecret = 'test-secret-with-at-least-thirty-two-characters';
let db;
let server;
let noMailServer;
let baseUrl;
let verificationEmails;
let failEmailDelivery;
let uploadDirectory;

beforeEach(async () => {
  verificationEmails = [];
  failEmailDelivery = false;
  uploadDirectory = path.join(os.tmpdir(), `stefbykurd-test-${randomUUID()}`);
  db = createDatabase(':memory:');
  const app = createApp({
    db,
    jwtSecret,
    appBaseUrl: 'https://store.example.test',
    uploadDirectory,
    logger: { error() {} },
    sendVerificationEmail: async (message) => {
      if (failEmailDelivery) throw new Error('test SMTP error');
      verificationEmails.push(message);
    }
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (noMailServer) await new Promise((resolve) => noMailServer.close(resolve));
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) db.close();
  if (uploadDirectory && fs.existsSync(uploadDirectory)) {
    fs.rmSync(uploadDirectory, { recursive: true, force: true });
  }
});

test('la URL SMTP usa un origen estable y exige HTTPS en produccion', () => {
  assert.equal(getAppBaseUrl('https://shop.example.test/', true), 'https://shop.example.test');
  assert.throws(() => getAppBaseUrl('http://shop.example.test', true), /HTTPS en produccion/);
  assert.throws(() => getAppBaseUrl('https://shop.example.test/otro', false), /sin rutas ni credenciales/);
  assert.equal(createVerificationEmailSender({}), null);
  assert.throws(() => createVerificationEmailSender({ SMTP_HOST: 'mail.example.test' }), /SMTP_HOST y SMTP_PORT/);
});

test('solo el personal autenticado puede cargar imagenes validas desde el dispositivo', async () => {
  const seller = await createStaff('seller', 'upload-seller@example.com');
  const session = await login(seller.email);
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const uploaded = await uploadImages(session.cookie, [{
    name: 'producto.jpg',
    type: 'image/jpeg',
    content: imageBytes
  }]);
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.data.images.length, 1);
  const servedImage = await fetch(`${baseUrl}${uploaded.data.images[0]}`);
  assert.equal(servedImage.status, 200);
  assert.deepEqual(Buffer.from(await servedImage.arrayBuffer()), imageBytes);

  const rejected = await uploadImages(session.cookie, [{
    name: 'texto.jpg',
    type: 'image/jpeg',
    content: Buffer.from('not an image')
  }]);
  assert.equal(rejected.response.status, 400);
  const buyer = await registerBuyer('upload-buyer@example.com');
  const denied = await uploadImages(buyer.cookie, [{
    name: 'producto.jpg',
    type: 'image/jpeg',
    content: imageBytes
  }]);
  assert.equal(denied.response.status, 403);
});

test('la politica de imagenes permite vistas previas locales sin abrir otros origenes', async () => {
  const response = await fetch(baseUrl);
  const policy = response.headers.get('content-security-policy');
  const imageDirective = policy.split(';').map((directive) => directive.trim())
    .find((directive) => directive.startsWith('img-src '));
  assert.deepEqual(imageDirective.split(/\s+/), ['img-src', "'self'", 'data:', 'https:', 'blob:']);
});

test('la migracion agrega detalles de producto y fotos historicas sin perder tablas antiguas', () => {
  const legacyDb = new DatabaseSync(':memory:');
  legacyDb.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY, seller_id TEXT, name TEXT NOT NULL, category TEXT NOT NULL,
      description TEXT NOT NULL, image TEXT NOT NULL, price_cents INTEGER NOT NULL,
      stock INTEGER NOT NULL, featured INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE transaction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id TEXT NOT NULL, product_id TEXT,
      product_name TEXT NOT NULL, unit_price_cents INTEGER NOT NULL,
      quantity INTEGER NOT NULL, line_total_cents INTEGER NOT NULL
    );
  `);
  initializeDatabase(legacyDb);
  const productColumns = legacyDb.prepare('PRAGMA table_info(products)').all().map((column) => column.name);
  const itemColumns = legacyDb.prepare('PRAGMA table_info(transaction_items)').all().map((column) => column.name);
  assert.ok(productColumns.includes('width_cm'));
  assert.ok(productColumns.includes('images_json'));
  assert.ok(itemColumns.includes('image_snapshot'));
  assert.ok(itemColumns.includes('details_json'));
  const cartColumns = legacyDb.prepare('PRAGMA table_info(buyer_cart_items)').all().map((column) => column.name);
  const favoriteColumns = legacyDb.prepare('PRAGMA table_info(buyer_favorites)').all().map((column) => column.name);
  assert.ok(cartColumns.includes('buyer_id'));
  assert.ok(favoriteColumns.includes('product_id'));
  assert.equal(legacyDb.prepare('SELECT COUNT(*) AS count FROM products').get().count, 8);
  legacyDb.close();
});

async function uploadImages(cookie, entries) {
  const form = new FormData();
  for (const { name, type, content } of entries) {
    form.append('images', new Blob([content], { type }), name);
  }
  const response = await fetch(`${baseUrl}/api/seller/uploads`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form
  });
  return { response, data: await response.json() };
}

async function request(path, { cookie, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers
    }
  });
  const data = response.status === 204 ? null : await response.json();
  const setCookie = response.headers.get('set-cookie');
  return {
    response,
    data,
    cookie: setCookie ? setCookie.split(';')[0] : cookie
  };
}

async function registerBuyer(email = 'buyer@example.com') {
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cliente de prueba', email, password: 'secure-password-123' })
  });
  assert.equal(registration.response.status, 202);
  assert.equal(verificationEmails.at(-1).to, email.toLowerCase());
  const token = new URL(verificationEmails.at(-1).verificationUrl).searchParams.get('verify');
  await request('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token })
  }).then(({ response }) => assert.equal(response.status, 200));
  return login(email);
}

async function createStaff(role, email) {
  const id = randomUUID();
  const passwordHash = await bcrypt.hash('secure-password-123', 4);
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, role, email, passwordHash, role);
  return { id, email, password: 'secure-password-123' };
}

async function login(email, password = 'secure-password-123') {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

test('el registro publico exige verificar el correo antes de crear e iniciar una cuenta', async () => {
  const anonymousSession = await request('/api/auth/me');
  assert.equal(anonymousSession.response.status, 200);
  assert.equal(anonymousSession.data.user, null);

  const { response, data, cookie } = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Cliente',
      email: 'public@example.com',
      password: 'secure-password-123',
      role: 'owner'
    })
  });
  assert.equal(response.status, 202);
  assert.equal(data.email, 'public@example.com');
  assert.equal(cookie, undefined);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('public@example.com').count,
    0
  );
  const deniedUntilVerified = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'public@example.com', password: 'secure-password-123' })
  });
  assert.equal(deniedUntilVerified.response.status, 401);

  const email = verificationEmails.at(-1);
  assert.equal(email.to, 'public@example.com');
  assert.match(email.verificationUrl, /^https:\/\/store\.example\.test\/\?verify=/);
  const token = new URL(email.verificationUrl).searchParams.get('verify');
  assert.equal(data.message.includes(token), false);
  const verification = await request('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token })
  });
  assert.equal(verification.response.status, 200);
  assert.equal(db.prepare(
    'SELECT role FROM users WHERE email = ?'
  ).get('public@example.com').role, 'buyer');
  const usedToken = await request('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token })
  });
  assert.equal(usedToken.response.status, 400);
  const verifiedSession = await login('public@example.com');
  assert.equal(verifiedSession.response.status, 200);

  const product = {
    name: 'Producto no autorizado',
    category: 'Test',
    description: 'Un producto que no se debe poder crear.',
    image: '/assets/black-tote.jpg',
    price: 10,
    stock: 5
  };
  const denied = await request('/api/seller/products', {
    method: 'POST',
    cookie: verifiedSession.cookie,
    body: JSON.stringify(product)
  });
  assert.equal(denied.response.status, 403);
});

test('reenviar verificacion rota el enlace y recupera enlaces vencidos', async () => {
  await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Correo pendiente',
      email: 'pending@example.com',
      password: 'secure-password-123'
    })
  });
  const oldToken = new URL(verificationEmails[0].verificationUrl).searchParams.get('verify');
  const resend = await request('/api/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ email: 'PENDING@example.com' })
  });
  assert.equal(resend.response.status, 200);
  const newToken = new URL(verificationEmails.at(-1).verificationUrl).searchParams.get('verify');
  assert.notEqual(newToken, oldToken);
  const rejectedOldLink = await request('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token: oldToken })
  });
  assert.equal(rejectedOldLink.response.status, 400);

  db.prepare('UPDATE pending_customer_registrations SET expires_at = 0 WHERE email = ?')
    .run('pending@example.com');
  const expiredLink = await request('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token: newToken })
  });
  assert.equal(expiredLink.response.status, 410);
  assert.equal(expiredLink.data.code, 'EMAIL_VERIFICATION_EXPIRED');
  const renewedEmail = await request('/api/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ email: 'pending@example.com' })
  });
  assert.equal(renewedEmail.response.status, 200);
  const renewedToken = new URL(verificationEmails.at(-1).verificationUrl).searchParams.get('verify');
  const verification = await request('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token: renewedToken })
  });
  assert.equal(verification.response.status, 200);
});

test('si falla SMTP el reenvio conserva el enlace que ya se habia entregado', async () => {
  failEmailDelivery = true;
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Entrega pendiente',
      email: 'smtp-failure@example.com',
      password: 'secure-password-123'
    })
  });
  assert.equal(registration.response.status, 502);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM users WHERE email = ?'
  ).get('smtp-failure@example.com').count, 0);

  failEmailDelivery = false;
  await request('/api/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ email: 'smtp-failure@example.com' })
  });
  const deliveredToken = new URL(verificationEmails.at(-1).verificationUrl).searchParams.get('verify');
  failEmailDelivery = true;
  const failedResend = await request('/api/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ email: 'smtp-failure@example.com' })
  });
  assert.equal(failedResend.response.status, 502);
  const restoredToken = await request('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token: deliveredToken })
  });
  assert.equal(restoredToken.response.status, 200);
});

test('las cuentas de compradores anteriores a la verificacion reciben el mismo bloqueo', async () => {
  const legacyUserId = randomUUID();
  const passwordHash = await bcrypt.hash('secure-password-123', 4);
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role)
    VALUES (?, 'Cliente anterior', 'legacy@example.com', ?, 'buyer')
  `).run(legacyUserId, passwordHash);
  const legacySessionToken = jwt.sign(
    { sub: legacyUserId },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '8h', issuer: 'stefbykurd-store' }
  );
  const blockedExistingSession = await request('/api/transactions/mine', {
    cookie: `stefbykurd_session=${legacySessionToken}`
  });
  assert.equal(blockedExistingSession.response.status, 401);
  const attemptedLogin = await login('legacy@example.com');
  assert.equal(attemptedLogin.response.status, 403);
  assert.equal(attemptedLogin.data.code, 'EMAIL_NOT_VERIFIED');
  const resent = await request('/api/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ email: 'legacy@example.com' })
  });
  assert.equal(resent.response.status, 200);
  const token = new URL(verificationEmails.at(-1).verificationUrl).searchParams.get('verify');
  const verified = await request('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token })
  });
  assert.equal(verified.response.status, 200);
  assert.equal((await login('legacy@example.com')).response.status, 200);
});

test('registro sin correo SMTP informa la configuracion necesaria y no crea cuentas', async () => {
  noMailServer = createApp({ db, jwtSecret }).listen(0);
  await new Promise((resolve) => noMailServer.once('listening', resolve));
  const originalBaseUrl = baseUrl;
  baseUrl = `http://127.0.0.1:${noMailServer.address().port}`;
  try {
    const result = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Sin SMTP',
        email: 'no-smtp@example.com',
        password: 'secure-password-123'
      })
    });
    assert.equal(result.response.status, 503);
    assert.equal(result.data.code, 'EMAIL_NOT_CONFIGURED');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('no-smtp@example.com').count,
      0
    );
  } finally {
    baseUrl = originalBaseUrl;
    await new Promise((resolve) => noMailServer.close(resolve));
    noMailServer = null;
  }
});

test('el inicio de sesion responde igual si la cuenta no existe', async () => {
  const { response, data } = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'missing@example.com', password: 'secure-password-123' })
  });
  assert.equal(response.status, 401);
  assert.equal(data.error, 'Correo o contrasena incorrectos.');
});

test('recordar sesion extiende el JWT y la cookie a 30 dias sin cambiar el valor por defecto', async () => {
  const rememberedUser = await createStaff('seller', 'remembered@example.com');
  const remembered = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: rememberedUser.email,
      password: rememberedUser.password,
      rememberMe: true
    })
  });
  assert.equal(remembered.response.status, 200);
  assert.match(remembered.response.headers.get('set-cookie'), /Max-Age=2592000/);
  const rememberedToken = jwt.verify(
    decodeURIComponent(remembered.cookie.split('=')[1]),
    jwtSecret,
    { algorithms: ['HS256'] }
  );
  assert.equal(rememberedToken.exp - rememberedToken.iat, 30 * 24 * 60 * 60);

  const regularUser = await createStaff('seller', 'regular@example.com');
  const regular = await login(regularUser.email, regularUser.password);
  assert.equal(regular.response.status, 200);
  assert.match(regular.response.headers.get('set-cookie'), /Max-Age=28800/);
  const regularToken = jwt.verify(
    decodeURIComponent(regular.cookie.split('=')[1]),
    jwtSecret,
    { algorithms: ['HS256'] }
  );
  assert.equal(regularToken.exp - regularToken.iat, 8 * 60 * 60);
});

test('el checkout registra la compra y descuenta stock de forma consistente', async () => {
  const { cookie } = await registerBuyer();
  const { data: catalog } = await request('/api/products');
  const product = catalog.products[0];
  const originalStock = product.stock;
  const purchase = await request('/api/checkout', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ items: [{ productId: product.id, quantity: 2 }] })
  });
  assert.equal(purchase.response.status, 201);
  assert.equal(purchase.data.transaction.items[0].quantity, 2);

  const after = await request('/api/products');
  assert.equal(after.data.products.find((item) => item.id === product.id).stock, originalStock - 2);
  const history = await request('/api/transactions/mine', { cookie });
  assert.equal(history.data.transactions.length, 1);
  assert.equal(history.data.transactions[0].totalCents, product.priceCents * 2);
});

test('cada comprador conserva su propia bolsa y el gerente puede consultar las bolsas', async () => {
  const firstBuyer = await registerBuyer('cart-first@example.com');
  const secondBuyer = await registerBuyer('cart-second@example.com');
  const manager = await createStaff('manager', 'cart-manager@example.com');
  const managerSession = await login(manager.email);
  const seller = await createStaff('seller', 'cart-seller@example.com');
  const sellerSession = await login(seller.email);
  const { data: catalog } = await request('/api/products');
  const product = catalog.products[0];

  const firstSave = await request('/api/cart/mine', {
    method: 'PUT',
    cookie: firstBuyer.cookie,
    body: JSON.stringify({ items: [{ productId: product.id, quantity: 2 }] })
  });
  assert.equal(firstSave.response.status, 200);
  const firstCart = await request('/api/cart/mine', { cookie: firstBuyer.cookie });
  assert.equal(firstCart.data.items.length, 1);
  assert.equal(firstCart.data.items[0].quantity, 2);
  assert.equal(firstCart.data.items[0].image, product.image);
  const secondCart = await request('/api/cart/mine', { cookie: secondBuyer.cookie });
  assert.deepEqual(secondCart.data.items, []);
  const staleTabCart = await request('/api/cart/mine', {
    cookie: firstBuyer.cookie,
    headers: { 'X-Buyer-Id': secondBuyer.data.user.id }
  });
  assert.equal(staleTabCart.response.status, 409);

  const managerCarts = await request('/api/admin/carts', { cookie: managerSession.cookie });
  assert.equal(managerCarts.response.status, 200);
  const firstManagedCart = managerCarts.data.carts.find((cart) => cart.buyerId === firstBuyer.data.user.id);
  assert.equal(firstManagedCart.buyerEmail, 'cart-first@example.com');
  assert.equal(firstManagedCart.items[0].productId, product.id);
  assert.equal(firstManagedCart.items[0].quantity, 2);
  const secondManagedCart = managerCarts.data.carts.find((cart) => cart.buyerId === secondBuyer.data.user.id);
  assert.equal(secondManagedCart.itemCount, 0);
  assert.equal(secondManagedCart.totalCents, 0);
  assert.equal((await request('/api/admin/carts', { cookie: firstBuyer.cookie })).response.status, 403);
  assert.equal((await request('/api/admin/carts', { cookie: sellerSession.cookie })).response.status, 403);

  const purchase = await request('/api/checkout', {
    method: 'POST',
    cookie: firstBuyer.cookie,
    body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] })
  });
  assert.equal(purchase.response.status, 201);
  const remaining = await request('/api/cart/mine', { cookie: firstBuyer.cookie });
  assert.equal(remaining.data.items[0].quantity, 1);

  const invalidQuantity = await request('/api/cart/mine', {
    method: 'PUT',
    cookie: secondBuyer.cookie,
    body: JSON.stringify({ items: [{ productId: product.id, quantity: product.stock + 1 }] })
  });
  assert.equal(invalidQuantity.response.status, 409);
  assert.deepEqual((await request('/api/cart/mine', { cookie: secondBuyer.cookie })).data.items, []);
});

test('los favoritos se guardan por comprador y devuelven imagen y stock', async () => {
  const firstBuyer = await registerBuyer('favorite-first@example.com');
  const secondBuyer = await registerBuyer('favorite-second@example.com');
  const seller = await createStaff('seller', 'favorite-seller@example.com');
  const sellerSession = await login(seller.email);
  const { data: catalog } = await request('/api/products');
  const product = catalog.products[0];

  const added = await request(`/api/favorites/${product.id}`, {
    method: 'POST',
    cookie: firstBuyer.cookie
  });
  assert.equal(added.response.status, 201);
  const duplicate = await request(`/api/favorites/${product.id}`, {
    method: 'POST',
    cookie: firstBuyer.cookie
  });
  assert.equal(duplicate.response.status, 200);
  const favorites = await request('/api/favorites/mine', { cookie: firstBuyer.cookie });
  assert.equal(favorites.data.favorites[0].id, product.id);
  assert.equal(favorites.data.favorites[0].image, product.image);
  assert.equal(favorites.data.favorites[0].stock, product.stock);
  assert.deepEqual((await request('/api/favorites/mine', { cookie: secondBuyer.cookie })).data.favorites, []);
  assert.equal((await request(`/api/favorites/${product.id}`, { method: 'POST', cookie: sellerSession.cookie })).response.status, 403);

  const removed = await request(`/api/favorites/${product.id}`, {
    method: 'DELETE',
    cookie: firstBuyer.cookie
  });
  assert.equal(removed.response.status, 204);
  assert.deepEqual((await request('/api/favorites/mine', { cookie: firstBuyer.cookie })).data.favorites, []);
});

test('la ficha publica y el historial conservan las fotos y detalles del producto comprado', async () => {
  const seller = await createStaff('seller', 'details-seller@example.com');
  const sellerSession = await login(seller.email);
  const productPayload = {
    name: 'Bolso con ficha completa',
    category: 'Test',
    description: 'Un bolso de prueba con todos los detalles.',
    image: '/assets/black-tote.jpg',
    price: 25,
    stock: 3,
    heightCm: 35,
    widthCm: 28,
    depthCm: 10,
    colors: ['Natural', 'Verde'],
    design: 'Estampado botanico',
    images: ['/assets/geometric-tote.jpg']
  };
  const created = await request('/api/seller/products', {
    method: 'POST',
    cookie: sellerSession.cookie,
    body: JSON.stringify(productPayload)
  });
  assert.equal(created.response.status, 201);

  const catalog = await request('/api/products');
  const publicProduct = catalog.data.products.find((item) => item.id === created.data.product.id);
  assert.equal(publicProduct.widthCm, 28);
  assert.equal(publicProduct.heightCm, 35);
  assert.deepEqual(publicProduct.colors, ['Natural', 'Verde']);
  assert.deepEqual(publicProduct.images, ['/assets/geometric-tote.jpg']);

  const buyer = await registerBuyer('details-buyer@example.com');
  const purchase = await request('/api/checkout', {
    method: 'POST',
    cookie: buyer.cookie,
    body: JSON.stringify({ items: [{ productId: created.data.product.id, quantity: 1 }] })
  });
  assert.equal(purchase.response.status, 201);

  const updatedProduct = await request(`/api/seller/products/${created.data.product.id}`, {
    method: 'PUT',
    cookie: sellerSession.cookie,
    body: JSON.stringify({
      ...productPayload,
      widthCm: 99,
      colors: ['Negro'],
      design: 'Diseno actualizado',
      images: []
    })
  });
  assert.equal(updatedProduct.response.status, 200);

  const history = await request('/api/transactions/mine', { cookie: buyer.cookie });
  const purchasedItem = history.data.transactions[0].items[0];
  assert.equal(purchasedItem.name, productPayload.name);
  assert.equal(purchasedItem.image, productPayload.image);
  assert.equal(purchasedItem.widthCm, 28);
  assert.equal(purchasedItem.heightCm, 35);
  assert.deepEqual(purchasedItem.colors, ['Natural', 'Verde']);
  assert.equal(purchasedItem.design, 'Estampado botanico');
  assert.deepEqual(purchasedItem.images, ['/assets/geometric-tote.jpg']);
});

test('un checkout sin stock revierte cambios y no crea una transaccion parcial', async () => {
  const { cookie } = await registerBuyer();
  const { data: catalog } = await request('/api/products');
  const first = catalog.products[0];
  const second = catalog.products[1];
  db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(second.id);

  const purchase = await request('/api/checkout', {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      items: [
        { productId: first.id, quantity: 1 },
        { productId: second.id, quantity: 1 }
      ]
    })
  });
  assert.equal(purchase.response.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 0);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(first.id).stock, first.stock);
});

test('solo managers pueden crear vendedores y el vendedor gestiona el inventario compartido', async () => {
  const manager = await createStaff('manager', 'manager@example.com');
  const managerSession = await login(manager.email);
  const createSeller = await request('/api/admin/users', {
    method: 'POST',
    cookie: managerSession.cookie,
    body: JSON.stringify({
      name: 'Vendedora Uno',
      email: 'seller-one@example.com',
      password: 'seller-password-123',
      role: 'seller'
    })
  });
  assert.equal(createSeller.response.status, 201);
  assert.equal(createSeller.data.user.status, 'active');
  const sellerOne = await login('seller-one@example.com', 'seller-password-123');
  assert.equal(sellerOne.response.status, 200);
  assert.equal(sellerOne.data.user.role, 'seller');

  const deniedManager = await request('/api/admin/users', {
    method: 'POST',
    cookie: managerSession.cookie,
    body: JSON.stringify({
      name: 'Gerente Dos',
      email: 'manager-two@example.com',
      password: 'manager-password-123',
      role: 'manager'
    })
  });
  assert.equal(deniedManager.response.status, 403);

  const resetPassword = await request(`/api/admin/users/${sellerOne.data.user.id}/password`, {
    method: 'PATCH',
    cookie: managerSession.cookie,
    body: JSON.stringify({ password: 'seller-new-password-456' })
  });
  assert.equal(resetPassword.response.status, 200);
  assert.equal((await login('seller-one@example.com', 'seller-password-123')).response.status, 401);
  const updatedSellerSession = await login('seller-one@example.com', 'seller-new-password-456');
  assert.equal(updatedSellerSession.response.status, 200);

  const productPayload = {
    name: 'Producto de vendedor',
    category: 'Test',
    description: 'Bolso creado por un vendedor.',
    image: '/assets/black-tote.jpg',
    price: 15,
    stock: 0
  };
  const created = await request('/api/seller/products', {
    method: 'POST',
    cookie: updatedSellerSession.cookie,
    body: JSON.stringify(productPayload)
  });
  assert.equal(created.response.status, 201);
  const updated = await request(`/api/seller/products/${created.data.product.id}`, {
    method: 'PUT',
    cookie: updatedSellerSession.cookie,
    body: JSON.stringify({ ...productPayload, name: 'Producto actualizado por vendedor', price: 18 })
  });
  assert.equal(updated.response.status, 200);
  const ownAudit = await request('/api/seller/audit', { cookie: updatedSellerSession.cookie });
  assert.ok(ownAudit.data.logs.some((log) => log.action === 'product.created'));
  assert.ok(ownAudit.data.logs.some((log) => log.action === 'product.updated'));

  const sellerTwo = await createStaff('seller', 'seller-two@example.com');
  const sellerTwoSession = await login(sellerTwo.email);
  const inventory = await request('/api/seller/products', { cookie: sellerTwoSession.cookie });
  assert.ok(inventory.data.products.some((product) =>
    product.id === created.data.product.id && product.stock === 0
  ));
  const edit = await request(`/api/seller/products/${created.data.product.id}`, {
    method: 'PUT',
    cookie: sellerTwoSession.cookie,
    body: JSON.stringify({ ...productPayload, name: 'Edicion ajena' })
  });
  assert.equal(edit.response.status, 200);
  const deleteOtherSellerProduct = await request(`/api/seller/products/${created.data.product.id}`, {
    method: 'DELETE',
    cookie: sellerTwoSession.cookie
  });
  assert.equal(deleteOtherSellerProduct.response.status, 403);

  const { data: audit } = await request('/api/admin/audit', { cookie: managerSession.cookie });
  assert.ok(audit.logs.some((log) => log.action === 'product.created'));
  assert.ok(audit.logs.some((log) =>
    log.action === 'product.updated' &&
    log.actorId === updatedSellerSession.data.user.id &&
    log.details.name === 'Producto actualizado por vendedor'
  ));
  assert.ok(audit.logs.some((log) =>
    log.action === 'product.updated' &&
    log.actorId === sellerTwo.id &&
    log.details.name === 'Edicion ajena'
  ));
});

test('el panel pagina el historial completo de transacciones y auditoria', async () => {
  const manager = await createStaff('manager', 'history-manager@example.com');
  const seller = await createStaff('seller', 'history-seller@example.com');
  const buyer = await registerBuyer('history-buyer@example.com');
  const buyerId = buyer.data.user.id;
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (id, buyer_id, total_cents, status, payment_method)
    VALUES (?, ?, 1000, 'paid', 'simulated')
  `);
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type, details)
    VALUES (?, 'Vendedor historial', 'seller', 'product.created', 'product', '{}')
  `);
  for (let index = 0; index < 105; index += 1) {
    insertTransaction.run(randomUUID(), buyerId);
    insertAudit.run(seller.id);
  }
  const managerSession = await login(manager.email);

  const firstTransactionsPage = await request('/api/admin/transactions', { cookie: managerSession.cookie });
  assert.equal(firstTransactionsPage.data.transactions.length, 100);
  assert.equal(firstTransactionsPage.data.pagination.total, 105);
  assert.equal(firstTransactionsPage.data.pagination.nextOffset, 100);
  const lastTransactionsPage = await request('/api/admin/transactions?offset=100', { cookie: managerSession.cookie });
  assert.equal(lastTransactionsPage.data.transactions.length, 5);

  const firstAuditPage = await request('/api/admin/audit', { cookie: managerSession.cookie });
  assert.equal(firstAuditPage.data.logs.length, 100);
  assert.equal(firstAuditPage.data.pagination.total, 105);
  const lastAuditPage = await request('/api/admin/audit?offset=100', { cookie: managerSession.cookie });
  assert.equal(lastAuditPage.data.logs.length, 5);
});
