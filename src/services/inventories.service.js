import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../lib/httpError.js';
import { applyMovement, isManager } from './stock.service.js';

export async function list(staff) {
  if (!isManager(staff.role)) return listActive(staff);
  const { rows } = await query(
    `SELECT i.id, i.title, i.status, i.scheduled_for, i.started_at, i.finished_at, i.closed_at,
            count(ii.id) AS total_items,
            count(ii.id) FILTER (WHERE ii.counted_qty IS NOT NULL) AS counted_items,
            count(ii.id) FILTER (WHERE ii.status = 'CONTADO' AND ii.counted_qty <> ii.theoretical_qty) AS divergent_items
     FROM inventories i LEFT JOIN inventory_items ii ON ii.inventory_id = i.id
     WHERE i.pharmacy_id = $1
     GROUP BY i.id ORDER BY i.created_at DESC LIMIT 50`,
    [staff.pharmacyId],
  );
  return rows;
}

// O que o técnico vê: só título, data e estado. Nunca o stock teórico.
export async function listActive(staff) {
  const { rows } = await query(
    `SELECT id, title, status, scheduled_for FROM inventories
     WHERE pharmacy_id = $1 AND status IN ('AGENDADO', 'EM_CURSO')
     ORDER BY (status = 'EM_CURSO') DESC, scheduled_for`,
    [staff.pharmacyId],
  );
  return rows;
}

export async function create(staff, { title, scheduled_for: scheduledFor }) {
  const { rows } = await query(
    `INSERT INTO inventories (pharmacy_id, title, scheduled_for, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id, title, status, scheduled_for`,
    [staff.pharmacyId, title, scheduledFor, staff.id],
  );
  return rows[0];
}

async function getInventory(db, staff, id, forUpdate = false) {
  const { rows } = await db.query(
    `SELECT * FROM inventories WHERE id = $1 AND pharmacy_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id, staff.pharmacyId],
  );
  if (!rows[0]) throw new HttpError(404, 'Inventário não encontrado.');
  return rows[0];
}

export async function start(staff, id) {
  await withTransaction(async (db) => {
    const inv = await getInventory(db, staff, id, true);
    if (inv.status !== 'AGENDADO') throw new HttpError(409, 'Só é possível iniciar inventários agendados.');
    const open = await db.query(
      "SELECT 1 FROM inventories WHERE pharmacy_id = $1 AND status = 'EM_CURSO' LIMIT 1",
      [staff.pharmacyId],
    );
    if (open.rowCount) throw new HttpError(409, 'Já existe um inventário em curso. Conclua-o primeiro.');

    await db.query(
      `INSERT INTO inventory_items (inventory_id, product_id, theoretical_qty)
       SELECT $1, id, stock_qty FROM products
       WHERE pharmacy_id = $2 AND deleted_at IS NULL AND active`,
      [id, staff.pharmacyId],
    );
    await db.query("UPDATE inventories SET status = 'EM_CURSO', started_at = now() WHERE id = $1", [id]);
  });
}

export async function finish(staff, id) {
  const { rowCount } = await query(
    `UPDATE inventories SET status = 'CONCLUIDO', finished_at = now()
     WHERE id = $1 AND pharmacy_id = $2 AND status = 'EM_CURSO'`,
    [id, staff.pharmacyId],
  );
  if (!rowCount) throw new HttpError(409, 'Só é possível concluir inventários em curso.');
}

// Contagem cega: o técnico envia a quantidade sem ver o stock teórico.
export async function count(staff, id, { product_id: productId, counted_qty: qty }) {
  const inv = await getInventory({ query }, staff, id);
  if (inv.status !== 'EM_CURSO') throw new HttpError(409, 'Este inventário não está em curso.');

  const { rows } = await query(
    `INSERT INTO inventory_items (inventory_id, product_id, theoretical_qty, counted_qty, counted_by, counted_at, status)
     SELECT $1, p.id, p.stock_qty, $3, $4, now(), 'CONTADO'
     FROM products p WHERE p.id = $2 AND p.pharmacy_id = $5 AND p.deleted_at IS NULL
     ON CONFLICT (inventory_id, product_id) DO UPDATE
       SET counted_qty = EXCLUDED.counted_qty, counted_by = EXCLUDED.counted_by,
           counted_at = now(), status = 'CONTADO'
     RETURNING product_id`,
    [id, productId, qty, staff.id, staff.pharmacyId],
  );
  if (!rows[0]) throw new HttpError(404, 'Produto não encontrado.');
}

export async function reconciliation(staff, id) {
  const inv = await getInventory({ query }, staff, id);
  const { rows } = await query(
    `SELECT ii.id, ii.product_id, p.name, p.sku, ii.theoretical_qty, ii.counted_qty, ii.status,
            (ii.counted_qty - ii.theoretical_qty) AS divergence,
            u.name AS counted_by_name, ii.counted_at
     FROM inventory_items ii
     JOIN products p ON p.id = ii.product_id
     LEFT JOIN pharmacy_users u ON u.id = ii.counted_by
     WHERE ii.inventory_id = $1
     ORDER BY (ii.status = 'CONTADO' AND ii.counted_qty <> ii.theoretical_qty) DESC,
              (ii.status = 'PENDENTE') DESC, p.name`,
    [id],
  );
  return { inventory: { id: inv.id, title: inv.title, status: inv.status, scheduled_for: inv.scheduled_for }, items: rows };
}

// Aplica a diferença contada sobre o stock actual (mantém as vendas feitas entretanto).
async function approveRow(db, staff, inv, item) {
  const delta = item.counted_qty - item.theoretical_qty;
  if (delta !== 0) {
    await applyMovement(db, staff, item.product_id, 'AJUSTE_INVENTARIO', delta, `Inventário: ${inv.title}`, { inventoryId: inv.id });
  }
  await db.query("UPDATE inventory_items SET status = 'APROVADO' WHERE id = $1", [item.id]);
}

async function loadContado(db, inv, itemId = null) {
  const { rows } = await db.query(
    `SELECT id, product_id, theoretical_qty, counted_qty FROM inventory_items
     WHERE inventory_id = $1 AND status = 'CONTADO' ${itemId ? 'AND id = $2' : ''} FOR UPDATE`,
    itemId ? [inv.id, itemId] : [inv.id],
  );
  return rows;
}

export async function resolveItem(staff, id, itemId, approve) {
  await withTransaction(async (db) => {
    const inv = await getInventory(db, staff, id);
    if (inv.status !== 'CONCLUIDO') throw new HttpError(409, 'A conciliação só é possível após concluir a contagem.');
    const [item] = await loadContado(db, inv, itemId);
    if (!item) throw new HttpError(404, 'Item não encontrado ou já resolvido.');
    if (approve) await approveRow(db, staff, inv, item);
    else await db.query("UPDATE inventory_items SET status = 'REJEITADO' WHERE id = $1", [item.id]);
  });
}

export async function approveAll(staff, id) {
  return withTransaction(async (db) => {
    const inv = await getInventory(db, staff, id);
    if (inv.status !== 'CONCLUIDO') throw new HttpError(409, 'A conciliação só é possível após concluir a contagem.');
    const items = await loadContado(db, inv);
    for (const item of items) await approveRow(db, staff, inv, item);
    return { approved: items.length };
  });
}

export async function close(staff, id) {
  await withTransaction(async (db) => {
    const inv = await getInventory(db, staff, id, true);
    if (inv.status !== 'CONCLUIDO') throw new HttpError(409, 'Conclua a contagem antes de fechar.');
    const left = await db.query(
      "SELECT count(*) AS n FROM inventory_items WHERE inventory_id = $1 AND status = 'CONTADO'",
      [id],
    );
    if (left.rows[0].n > 0) throw new HttpError(409, `Ainda há ${left.rows[0].n} itens por aprovar ou rejeitar.`);
    await db.query("UPDATE inventories SET status = 'FECHADO', closed_at = now() WHERE id = $1", [id]);
  });
}
