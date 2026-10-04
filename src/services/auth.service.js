import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';
import { HttpError } from '../lib/httpError.js';
import { signToken } from '../middleware/auth.js';

// Hash fictício para manter o tempo de resposta quando o email não existe.
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5J5V3o6o2s0qk8y0xT6nVx0kM1sU1yK';

export async function login(email, password) {
  const { rows } = await query(
    'SELECT id, name, email, password_hash, active FROM admins WHERE email = $1',
    [email],
  );
  const admin = rows[0];
  const ok = await bcrypt.compare(password, admin?.password_hash ?? DUMMY_HASH);
  if (!admin || !ok || !admin.active) throw new HttpError(401, 'Email ou senha incorrectos.');

  await query('UPDATE admins SET last_login_at = now() WHERE id = $1', [admin.id]);
  return { token: signToken(admin), admin: { id: admin.id, name: admin.name, email: admin.email } };
}

export async function me(adminId) {
  const { rows } = await query('SELECT id, name, email FROM admins WHERE id = $1 AND active', [adminId]);
  if (!rows[0]) throw new HttpError(401, 'Sessão inválida.');
  return rows[0];
}
