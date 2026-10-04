import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../lib/httpError.js';
import { applyMovement } from './stock.service.js';

// items: [{ product_id, quantity }]. `offline: true` aceita a venda mesmo sem stock suficiente,
// porque o medicamento já foi entregue; a diferença aparece depois na conciliação.
export async function create(staff, { client_uuid: clientUuid, items, offline }) {
  const existing = await query(
    'SELECT id, total FROM dispensations WHERE pharmacy_id = $1 AND client_uuid = $2',
    [staff.pharmacyId, clientUuid],
  );
  if (existing.rows[0]) return { ...existing.rows[0], duplicate: true };

  // Junta linhas repetidas e ordena para evitar deadlocks entre vendas simultâneas.
  const merged = new Map();
  for (const it of items) merged.set(it.product_id, (merged.get(it.product_id) ?? 0) + it.quantity);
  const lines = [...merged.entries()].sort(([a], [b]) => a.localeCompare(b));

  return withTransaction(async (db) => {
    const priced = [];
    for (const [productId, quantity] of lines) {
      const { rows } = await db.query(
        `SELECT id, name, price, stock_qty FROM products
         WHERE id = $1 AND pharmacy_id = $2 AND deleted_at IS NULL AND active FOR UPDATE`,
        [productId, staff.pharmacyId],
      );
      const p = rows[0];
      if (!p) throw new HttpError(422, 'Um dos produtos já não está disponível no catálogo.');
      if (!offline && p.stock_qty < quantity) {
        throw new HttpError(409, p.stock_qty <= 0 ? `${p.name} está indisponível.` : `Estoque insuficiente de ${p.name}.`);
      }
      priced.push({ productId, quantity, price: p.price });
    }

    const total = Math.round(priced.reduce((sum, l) => sum + l.price * l.quantity, 0) * 100) / 100;
    const { rows } = await db.query(
      `INSERT INTO dispensations (pharmacy_id, user_id, client_uuid, total, offline)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, total`,
      [staff.pharmacyId, staff.id, clientUuid, total, Boolean(offline)],
    );
    const dispensationId = rows[0].id;
    for (const l of priced) {
      await db.query(
        'INSERT INTO dispensation_items (dispensation_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)',
        [dispensationId, l.productId, l.quantity, l.price],
      );
      await applyMovement(db, staff, l.productId, 'DISPENSACAO', -l.quantity, null, { dispensationId });
    }
    return rows[0];
  });
}
