import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../lib/httpError.js';
import { audit } from '../lib/audit.js';

const PUBLIC_COLUMNS = `id, pharmacy_id, name, email, phone, role, active,
  must_change_password, last_login_at, created_at`;

const generatePassword = () => crypto.randomBytes(9).toString('base64url');

async function assertPharmacy(pharmacyId) {
  const { rowCount } = await query('SELECT 1 FROM pharmacies WHERE id = $1 AND deleted_at IS NULL', [pharmacyId]);
  if (!rowCount) throw new HttpError(404, 'Farmácia não encontrada.');
}

export async function listByPharmacy(pharmacyId) {
  await assertPharmacy(pharmacyId);
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM pharmacy_users
     WHERE pharmacy_id = $1 AND deleted_at IS NULL
     ORDER BY role, name`,
    [pharmacyId],
  );
  return rows;
}

export async function create(pharmacyId, data, adminId) {
  await assertPharmacy(pharmacyId);
  const temporaryPassword = data.password ? null : generatePassword();
  const hash = await bcrypt.hash(data.password ?? temporaryPassword, 12);

  const { rows } = await query(
    `INSERT INTO pharmacy_users (pharmacy_id, name, email, phone, role, password_hash)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PUBLIC_COLUMNS}`,
    [pharmacyId, data.name, data.email, data.phone ?? null, data.role, hash],
  );
  await audit({ query }, adminId, 'PHARMACY_USER_CREATED', 'pharmacy_user', rows[0].id, { role: data.role, pharmacyId });
  return { user: rows[0], temporary_password: temporaryPassword };
}

const UPDATABLE = ['name', 'email', 'phone', 'role', 'active'];

export async function update(pharmacyId, userId, data, adminId) {
  const cols = UPDATABLE.filter((c) => data[c] !== undefined);
  if (!cols.length) throw new HttpError(422, 'Nada para actualizar.');

  const { rows } = await query(
    `UPDATE pharmacy_users SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}
     WHERE id = $1 AND pharmacy_id = $2 AND deleted_at IS NULL
     RETURNING ${PUBLIC_COLUMNS}`,
    [userId, pharmacyId, ...cols.map((c) => data[c])],
  );
  if (!rows[0]) throw new HttpError(404, 'Conta não encontrada.');
  await audit({ query }, adminId, 'PHARMACY_USER_UPDATED', 'pharmacy_user', userId, { fields: cols });
  return rows[0];
}

export async function resetPassword(pharmacyId, userId, adminId) {
  const temporaryPassword = generatePassword();
  const hash = await bcrypt.hash(temporaryPassword, 12);
  const { rowCount } = await query(
    `UPDATE pharmacy_users SET password_hash = $3, must_change_password = true
     WHERE id = $1 AND pharmacy_id = $2 AND deleted_at IS NULL`,
    [userId, pharmacyId, hash],
  );
  if (!rowCount) throw new HttpError(404, 'Conta não encontrada.');
  await audit({ query }, adminId, 'PHARMACY_USER_PASSWORD_RESET', 'pharmacy_user', userId);
  return { temporary_password: temporaryPassword };
}

export async function remove(pharmacyId, userId, adminId) {
  await withTransaction(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE pharmacy_users SET deleted_at = now(), active = false
       WHERE id = $1 AND pharmacy_id = $2 AND deleted_at IS NULL`,
      [userId, pharmacyId],
    );
    if (!rowCount) throw new HttpError(404, 'Conta não encontrada.');
    await audit(db, adminId, 'PHARMACY_USER_DELETED', 'pharmacy_user', userId);
  });
}
