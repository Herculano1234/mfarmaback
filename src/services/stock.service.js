import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../lib/httpError.js';

const FLAG_SQL = `CASE WHEN p.stock_qty <= 0 THEN 'INDISPONIVEL'
                       WHEN p.stock_qty <= p.min_stock THEN 'POUCO_ESTOQUE'
                       ELSE 'DISPONIVEL' END`;
const COLS = `p.id, p.sku, p.barcode, p.name, p.category, p.price, p.requires_prescription,
              p.active, p.min_stock, p.stock_qty, ${FLAG_SQL} AS flag`;

export const isManager = (role) => role === 'ROLE_GERENTE';

// O técnico nunca recebe a quantidade exacta, só a flag de estado.
export function present(row, role) {
  if (isManager(role)) return row;
  const { stock_qty: _q, min_stock: _m, ...rest } = row;
  return rest;
}

export async function catalog(staff) {
  const { rows } = await query(
    `SELECT ${COLS} FROM products p
     WHERE p.pharmacy_id = $1 AND p.deleted_at IS NULL AND ($2::boolean OR p.active)
     ORDER BY p.name LIMIT 10000`,
    [staff.pharmacyId, isManager(staff.role)],
  );
  return rows.map((r) => present(r, staff.role));
}

export async function lookup(staff, code) {
  const { rows } = await query(
    `SELECT ${COLS} FROM products p
     WHERE p.pharmacy_id = $1 AND p.deleted_at IS NULL AND ($3::boolean OR p.active)
       AND (p.barcode = $2 OR upper(p.sku) = upper($2))
     LIMIT 1`,
    [staff.pharmacyId, code, isManager(staff.role)],
  );
  if (!rows[0]) throw new HttpError(404, 'Produto não encontrado.');
  return present(rows[0], staff.role);
}

async function getOne(db, pharmacyId, id) {
  const { rows } = await db.query(`SELECT ${COLS} FROM products p WHERE p.id = $1 AND p.pharmacy_id = $2 AND p.deleted_at IS NULL`, [id, pharmacyId]);
  if (!rows[0]) throw new HttpError(404, 'Produto não encontrado.');
  return rows[0];
}

export async function createProduct(staff, data) {
  const id = await withTransaction(async (db) => {
    let { sku } = data;
    if (!sku) {
      const r = await db.query('UPDATE pharmacies SET next_sku = next_sku + 1 WHERE id = $1 RETURNING next_sku - 1 AS n', [staff.pharmacyId]);
      sku = `MYO-${String(r.rows[0].n).padStart(6, '0')}`;
    }
    const { rows } = await db.query(
      `INSERT INTO products (pharmacy_id, sku, barcode, name, category, price, min_stock, requires_prescription)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [staff.pharmacyId, sku, data.barcode ?? null, data.name, data.category ?? null,
        data.price ?? 0, data.min_stock ?? 5, data.requires_prescription ?? false],
    );
    if (data.initial_stock > 0) {
      await applyMovement(db, staff, rows[0].id, 'ENTRADA', data.initial_stock, 'Stock inicial');
    }
    return rows[0].id;
  });
  return getOne({ query }, staff.pharmacyId, id);
}

const UPDATABLE = ['sku', 'barcode', 'name', 'category', 'price', 'min_stock', 'requires_prescription', 'active'];

export async function updateProduct(staff, id, data) {
  const cols = UPDATABLE.filter((c) => data[c] !== undefined);
  if (!cols.length) throw new HttpError(422, 'Nada para actualizar.');
  const { rowCount } = await query(
    `UPDATE products SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}
     WHERE id = $1 AND pharmacy_id = $2 AND deleted_at IS NULL`,
    [id, staff.pharmacyId, ...cols.map((c) => data[c])],
  );
  if (!rowCount) throw new HttpError(404, 'Produto não encontrado.');
  return getOne({ query }, staff.pharmacyId, id);
}

export async function removeProduct(staff, id) {
  const { rowCount } = await query(
    'UPDATE products SET deleted_at = now(), active = false WHERE id = $1 AND pharmacy_id = $2 AND deleted_at IS NULL',
    [id, staff.pharmacyId],
  );
  if (!rowCount) throw new HttpError(404, 'Produto não encontrado.');
}

// Aplica uma variação de stock com bloqueio da linha e regista o movimento.
export async function applyMovement(db, staff, productId, type, delta, reason, extra = {}) {
  const { rows } = await db.query(
    'UPDATE products SET stock_qty = stock_qty + $2 WHERE id = $1 AND pharmacy_id = $3 AND deleted_at IS NULL RETURNING stock_qty',
    [productId, delta, staff.pharmacyId],
  );
  if (!rows[0]) throw new HttpError(404, 'Produto não encontrado.');
  await db.query(
    `INSERT INTO stock_movements (pharmacy_id, product_id, type, quantity, balance_after, reason, user_id, dispensation_id, inventory_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [staff.pharmacyId, productId, type, delta, rows[0].stock_qty, reason ?? null, staff.id,
      extra.dispensationId ?? null, extra.inventoryId ?? null],
  );
  return rows[0].stock_qty;
}

export async function manualMovement(staff, productId, { type, quantity, reason }) {
  await withTransaction(async (db) => {
    if (type === 'SAIDA') {
      const { rows } = await db.query(
        'SELECT stock_qty FROM products WHERE id = $1 AND pharmacy_id = $2 AND deleted_at IS NULL FOR UPDATE',
        [productId, staff.pharmacyId],
      );
      if (!rows[0]) throw new HttpError(404, 'Produto não encontrado.');
      if (rows[0].stock_qty < quantity) throw new HttpError(409, `Estoque insuficiente (existem ${rows[0].stock_qty}).`);
    }
    await applyMovement(db, staff, productId, type, type === 'SAIDA' ? -quantity : quantity, reason);
  });
  return getOne({ query }, staff.pharmacyId, productId);
}

export async function listMovements(staff, { productId, limit }) {
  const params = [staff.pharmacyId, limit];
  let filter = '';
  if (productId) { params.push(productId); filter = 'AND m.product_id = $3'; }
  const { rows } = await query(
    `SELECT m.id, m.type, m.quantity, m.balance_after, m.reason, m.created_at,
            p.name AS product_name, p.sku, u.name AS user_name
     FROM stock_movements m
     JOIN products p ON p.id = m.product_id
     LEFT JOIN pharmacy_users u ON u.id = m.user_id
     WHERE m.pharmacy_id = $1 ${filter}
     ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
    params,
  );
  return rows;
}

// Sugestões de venda cruzada: produtos de venda livre, em stock, que costumam sair juntos
// (últimos 180 dias). Se houver poucos dados, completa com os mais vendidos do último mês.
export async function recommendations(staff, productIds) {
  const pharmacyId = staff.pharmacyId;
  const together = await query(
    `SELECT ${COLS}, count(*) AS score
     FROM dispensation_items a
     JOIN dispensations d ON d.id = a.dispensation_id
     JOIN dispensation_items b ON b.dispensation_id = a.dispensation_id
     JOIN products p ON p.id = b.product_id
     WHERE d.pharmacy_id = $1 AND a.product_id = ANY($2::uuid[]) AND b.product_id <> ALL($2::uuid[])
       AND d.created_at > now() - interval '180 days'
       AND p.deleted_at IS NULL AND p.active AND p.stock_qty > 0 AND NOT p.requires_prescription
     GROUP BY p.id ORDER BY score DESC, p.name LIMIT 6`,
    [pharmacyId, productIds],
  );
  const result = together.rows.map(({ score: _s, ...r }) => ({ ...present(r, staff.role), reason: 'COMPRADO_JUNTO' }));

  if (result.length < 6) {
    const skip = [...productIds, ...result.map((r) => r.id)];
    const top = await query(
      `SELECT ${COLS}, SUM(i.quantity) AS sold
       FROM dispensation_items i
       JOIN dispensations d ON d.id = i.dispensation_id
       JOIN products p ON p.id = i.product_id
       WHERE d.pharmacy_id = $1 AND d.created_at > now() - interval '30 days'
         AND p.id <> ALL($2::uuid[])
         AND p.deleted_at IS NULL AND p.active AND p.stock_qty > 0 AND NOT p.requires_prescription
       GROUP BY p.id ORDER BY sold DESC, p.name LIMIT $3`,
      [pharmacyId, skip, 6 - result.length],
    );
    result.push(...top.rows.map(({ sold: _s, ...r }) => ({ ...present(r, staff.role), reason: 'MAIS_VENDIDO' })));
  }
  return result;
}

export async function managerDashboard(staff) {
  const pid = staff.pharmacyId;
  const [stats, today, series, top, divergences] = await Promise.all([
    query(
      `SELECT count(*) AS products,
              count(*) FILTER (WHERE stock_qty > 0 AND stock_qty <= min_stock) AS low,
              count(*) FILTER (WHERE stock_qty <= 0) AS out,
              COALESCE(SUM(stock_qty * price) FILTER (WHERE stock_qty > 0), 0) AS stock_value
       FROM products WHERE pharmacy_id = $1 AND deleted_at IS NULL AND active`,
      [pid],
    ),
    query(
      `SELECT count(*) AS count, COALESCE(SUM(total), 0) AS total
       FROM dispensations WHERE pharmacy_id = $1 AND created_at >= date_trunc('day', now())`,
      [pid],
    ),
    query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(SUM(x.total), 0) AS total
       FROM generate_series((current_date - 6)::timestamp, current_date::timestamp, interval '1 day') d
       LEFT JOIN dispensations x ON x.pharmacy_id = $1 AND x.created_at::date = d::date
       GROUP BY d ORDER BY d`,
      [pid],
    ),
    query(
      `SELECT p.name, SUM(i.quantity) AS quantity
       FROM dispensation_items i
       JOIN dispensations d ON d.id = i.dispensation_id
       JOIN products p ON p.id = i.product_id
       WHERE d.pharmacy_id = $1 AND d.created_at > now() - interval '30 days'
       GROUP BY p.id ORDER BY quantity DESC LIMIT 5`,
      [pid],
    ),
    query(
      `SELECT count(*) AS count FROM inventory_items ii
       JOIN inventories i ON i.id = ii.inventory_id
       WHERE i.pharmacy_id = $1 AND i.status = 'CONCLUIDO' AND ii.status = 'CONTADO'
         AND ii.counted_qty <> ii.theoretical_qty`,
      [pid],
    ),
  ]);
  return {
    stock: stats.rows[0],
    today: today.rows[0],
    last_7_days: series.rows,
    top_products: top.rows,
    pending_divergences: divergences.rows[0].count,
  };
}
