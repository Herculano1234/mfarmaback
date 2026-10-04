import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { HttpError } from '../lib/httpError.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function signStaffToken(user) {
  return jwt.sign({ typ: 'pharmacy', sub: user.id, pid: user.pharmacy_id, role: user.role }, env.jwtSecret, {
    expiresIn: process.env.STAFF_JWT_EXPIRES_IN ?? '12h',
  });
}

// Valida o token E confirma na base de dados que a conta e a farmácia continuam activas.
// Assim, desactivar uma farmácia em Finanças bloqueia o acesso de imediato.
export const requireStaff = (...roles) => asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Sessão em falta. Inicie sessão.');

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw new HttpError(401, 'Sessão expirada. Inicie sessão novamente.');
  }
  if (payload.typ !== 'pharmacy') throw new HttpError(401, 'Sessão inválida.');

  const { rows } = await query(
    `SELECT u.id, u.name, u.role, u.active, u.pharmacy_id, p.status AS pharmacy_status
     FROM pharmacy_users u JOIN pharmacies p ON p.id = u.pharmacy_id
     WHERE u.id = $1 AND u.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [payload.sub],
  );
  const row = rows[0];
  if (!row || !row.active) throw new HttpError(401, 'Esta conta foi desactivada.');
  if (row.pharmacy_status !== 'ACTIVA') {
    throw new HttpError(403, 'A sua farmácia está inactiva. Contacte a Moyo.', undefined, 'PHARMACY_INACTIVE');
  }
  if (roles.length && !roles.includes(row.role)) throw new HttpError(403, 'Não tem permissão para esta acção.');

  req.staff = { id: row.id, name: row.name, role: row.role, pharmacyId: row.pharmacy_id };
  next();
});
