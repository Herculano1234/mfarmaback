import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { HttpError } from '../lib/httpError.js';

export function signToken(admin) {
  return jwt.sign({ sub: admin.id, name: admin.name, role: 'ROLE_ADMIN' }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

export function requireAdmin(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Sessão em falta. Inicie sessão.');
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    if (payload.role !== 'ROLE_ADMIN') throw new Error('role');
    req.admin = { id: payload.sub, name: payload.name };
    next();
  } catch {
    throw new HttpError(401, 'Sessão inválida ou expirada. Inicie sessão novamente.');
  }
}
