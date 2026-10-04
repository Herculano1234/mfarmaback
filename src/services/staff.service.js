import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';
import { HttpError } from '../lib/httpError.js';
import { signStaffToken } from '../middleware/staff.js';

const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5J5V3o6o2s0qk8y0xT6nVx0kM1sU1yK';

const present = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  must_change_password: u.must_change_password,
  pharmacy: { id: u.pharmacy_id, name: u.pharmacy_name },
});

const SELECT_USER = `
  SELECT u.id, u.name, u.email, u.role, u.active, u.password_hash, u.must_change_password,
         u.pharmacy_id, p.name AS pharmacy_name, p.status AS pharmacy_status
  FROM pharmacy_users u JOIN pharmacies p ON p.id = u.pharmacy_id`;

export async function login(email, password) {
  const { rows } = await query(`${SELECT_USER} WHERE u.email = $1 AND u.deleted_at IS NULL AND p.deleted_at IS NULL`, [email]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Email ou senha incorrectos.');
  if (!user.active) throw new HttpError(403, 'Esta conta está desactivada. Fale com o gerente.');
  if (user.pharmacy_status !== 'ACTIVA') {
    throw new HttpError(403, 'A sua farmácia está inactiva. Contacte a Moyo.', undefined, 'PHARMACY_INACTIVE');
  }
  await query('UPDATE pharmacy_users SET last_login_at = now() WHERE id = $1', [user.id]);
  return { token: signStaffToken(user), user: present(user) };
}

export async function me(userId) {
  const { rows } = await query(`${SELECT_USER} WHERE u.id = $1`, [userId]);
  return present(rows[0]);
}

export async function changePassword(userId, current, next) {
  const { rows } = await query('SELECT password_hash FROM pharmacy_users WHERE id = $1', [userId]);
  if (!(await bcrypt.compare(current, rows[0].password_hash))) throw new HttpError(422, 'A senha actual está incorrecta.');
  if (current === next) throw new HttpError(422, 'A nova senha deve ser diferente da actual.');
  const hash = await bcrypt.hash(next, 12);
  await query('UPDATE pharmacy_users SET password_hash = $2, must_change_password = false WHERE id = $1', [userId, hash]);
}

export async function listTeam(pharmacyId) {
  const { rows } = await query(
    `SELECT id, name, email, phone, role, active, last_login_at FROM pharmacy_users
     WHERE pharmacy_id = $1 AND deleted_at IS NULL ORDER BY role, name`,
    [pharmacyId],
  );
  return rows;
}

// O gerente só activa/desactiva técnicos da sua própria farmácia.
export async function setTechnicianActive(pharmacyId, userId, active) {
  const { rowCount } = await query(
    `UPDATE pharmacy_users SET active = $3
     WHERE id = $1 AND pharmacy_id = $2 AND role = 'ROLE_TECNICO' AND deleted_at IS NULL`,
    [userId, pharmacyId, active],
  );
  if (!rowCount) throw new HttpError(404, 'Técnico não encontrado.');
}
