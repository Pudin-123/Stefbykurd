const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'stefbykurd_session';
const COOKIE_MAX_AGE = 8 * 60 * 60 * 1000;
const REMEMBERED_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const roles = {
  buyer: ['buyer'],
  seller: ['seller'],
  manager: ['manager', 'owner']
};

function cookieOptions(isProduction, rememberMe) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: rememberMe ? REMEMBERED_COOKIE_MAX_AGE : COOKIE_MAX_AGE
  };
}

function authenticate(db, jwtSecret, { optional = false } = {}) {
  return (req, res, next) => {
    const token = req.cookies[COOKIE_NAME];
    if (!token) {
      return optional ? next() : res.status(401).json({ error: 'Inicia sesion para continuar.' });
    }

    try {
      const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
      const user = db.prepare(`
        SELECT id, name, email, role, status, email_verified_at AS emailVerifiedAt
        FROM users WHERE id = ?
      `).get(payload.sub);
      if (!user || user.status !== 'active' || (user.role === 'buyer' && !user.emailVerifiedAt)) {
        return optional ? next() : res.status(401).json({ error: 'La sesion ya no es valida.' });
      }
      req.user = user;
      return next();
    } catch (error) {
      if (error.name !== 'JsonWebTokenError' && error.name !== 'TokenExpiredError') {
        return next(error);
      }
      return optional ? next() : res.status(401).json({ error: 'La sesion ya no es valida.' });
    }
  };
}

function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Inicia sesion para continuar.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permisos para realizar esta accion.' });
    }
    return next();
  };
}

function isBuyer(req, res, next) {
  return requireRoles('buyer')(req, res, next);
}

function isSeller(req, res, next) {
  return requireRoles('seller')(req, res, next);
}

function isManager(req, res, next) {
  return requireRoles('manager', 'owner')(req, res, next);
}

function isOwner(req, res, next) {
  return requireRoles('owner')(req, res, next);
}

function issueSession(user, jwtSecret, res, isProduction, rememberMe = false) {
  const token = jwt.sign(
    { sub: user.id },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: rememberMe ? '30d' : '8h', issuer: 'stefbykurd-store' }
  );
  res.cookie(COOKIE_NAME, token, cookieOptions(isProduction, rememberMe));
}

module.exports = {
  COOKIE_NAME,
  authenticate,
  isBuyer,
  isManager,
  isOwner,
  isSeller,
  issueSession
};
