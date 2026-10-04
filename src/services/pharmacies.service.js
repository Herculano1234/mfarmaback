import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../lib/httpError.js';
import { audit } from '../lib/audit.js';

// Lista branca de colunas que podem ser escritas (evita SQL injection por nome de campo).
const WRITABLE = [
  'parent_id', 'name', 'nif', 'license_number', 'province',
  'municipality', 'address', 'phone', 'email', 'monthly_fee',
];

const SELECT_WITH_COUNTS = `
  SELECT p.*, parent.name AS parent_name,
    (SELECT count(*) FROM pharmacy_users u
       WHERE u.pharmacy_id = p.id AND u.deleted_at IS NULL AND u.role = 'ROLE_GERENTE')  AS managers_count,
    (SELECT count(*) FROM pharmacy_users u
       WHERE u.pharmacy_id = p.id AND u.deleted_at IS NULL AND u.role = 'ROLE_TECNICO') AS technicians_count
  FROM pharmacies p
  LEFT JOIN pharmacies parent ON parent.id = p.parent_id`;

async function assertValidParent(db, parentId, selfId = null) {
  if (!parentId) return;
  if (parentId === selfId) throw new HttpError(422, 'Uma farmácia não pode ser filial de si própria.');

  const parent = await db.query('SELECT parent_id FROM pharmacies WHERE id = $1 AND deleted_at IS NULL', [parentId]);
  if (!parent.rows[0]) throw new HttpError(422, 'Farmácia principal não encontrada.');
  if (parent.rows[0].parent_id) throw new HttpError(422, 'A farmácia principal escolhida já é uma filial.');

  if (selfId) {
    const kids = await db.query('SELECT 1 FROM pharmacies WHERE parent_id = $1 AND deleted_at IS NULL LIMIT 1', [selfId]);
    if (kids.rowCount) throw new HttpError(422, 'Esta farmácia tem filiais e não pode passar a ser filial.');
  }
}

export async function list({ q, status, page, limit, parents_only: parentsOnly }) {
  const params = [];
  const where = ['p.deleted_at IS NULL'];

  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    const i = params.length;
    where.push(`(p.name ILIKE $${i} OR p.nif ILIKE $${i} OR p.municipality ILIKE $${i} OR p.province ILIKE $${i})`);
  }
  if (status) {
    params.push(status);
    where.push(`p.status = $${params.length}`);
  }
  if (parentsOnly) where.push('p.parent_id IS NULL');

  const whereSql = where.join(' AND ');
  const { rows: countRows } = await query(`SELECT count(*) AS total FROM pharmacies p WHERE ${whereSql}`, params);

  params.push(limit, (page - 1) * limit);
  const { rows } = await query(
    `${SELECT_WITH_COUNTS} WHERE ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: countRows[0].total };
}

export async function getById(id) {
  const { rows } = await query(`${SELECT_WITH_COUNTS} WHERE p.id = $1 AND p.deleted_at IS NULL`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Farmácia não encontrada.');

  const branches = await query(
    `SELECT id, name, status, municipality FROM pharmacies
     WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [id],
  );
  return { ...rows[0], branches: branches.rows };
}

export async function create(data, adminId) {
  const id = await withTransaction(async (db) => {
    await assertValidParent(db, data.parent_id);
    const cols = WRITABLE.filter((c) => data[c] !== undefined);
    const { rows } = await db.query(
      `INSERT INTO pharmacies (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => data[c]),
    );
    await audit(db, adminId, 'PHARMACY_CREATED', 'pharmacy', rows[0].id, { name: data.name });
    return rows[0].id;
  });
  return getById(id);
}

export async function update(id, data, adminId) {
  const cols = WRITABLE.filter((c) => data[c] !== undefined);
  if (!cols.length) throw new HttpError(422, 'Nada para actualizar.');

  await withTransaction(async (db) => {
    if (data.parent_id !== undefined) await assertValidParent(db, data.parent_id, id);
    const { rowCount } = await db.query(
      `UPDATE pharmacies SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
       WHERE id = $1 AND deleted_at IS NULL`,
      [id, ...cols.map((c) => data[c])],
    );
    if (!rowCount) throw new HttpError(404, 'Farmácia não encontrada.');
    await audit(db, adminId, 'PHARMACY_UPDATED', 'pharmacy', id, { fields: cols });
  });
  return getById(id);
}

export async function setStatus(id, status, reason, adminId) {
  await withTransaction(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE pharmacies SET
         status = $2::pharmacy_status,
         deactivated_at = CASE WHEN $2::pharmacy_status = 'INACTIVA' THEN now() ELSE NULL END,
         deactivation_reason = CASE WHEN $2::pharmacy_status = 'INACTIVA' THEN $3 ELSE NULL END
       WHERE id = $1 AND deleted_at IS NULL`,
      [id, status, reason ?? null],
    );
    if (!rowCount) throw new HttpError(404, 'Farmácia não encontrada.');
    await audit(db, adminId, status === 'INACTIVA' ? 'PHARMACY_DEACTIVATED' : 'PHARMACY_REACTIVATED', 'pharmacy', id, { reason });
  });
  return getById(id);
}

// Eliminação lógica: mantém o histórico financeiro.
export async function remove(id, adminId) {
  await withTransaction(async (db) => {
    const kids = await db.query('SELECT 1 FROM pharmacies WHERE parent_id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
    if (kids.rowCount) throw new HttpError(409, 'Elimine ou mova primeiro as filiais desta farmácia.');

    const { rowCount } = await db.query(
      `UPDATE pharmacies SET deleted_at = now(), status = 'INACTIVA', deactivated_at = COALESCE(deactivated_at, now())
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!rowCount) throw new HttpError(404, 'Farmácia não encontrada.');
    await db.query('UPDATE pharmacy_users SET deleted_at = now() WHERE pharmacy_id = $1 AND deleted_at IS NULL', [id]);
    await audit(db, adminId, 'PHARMACY_DELETED', 'pharmacy', id);
  });
}
