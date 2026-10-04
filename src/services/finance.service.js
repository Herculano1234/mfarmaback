import { query } from '../config/db.js';
import { HttpError } from '../lib/httpError.js';
import { audit } from '../lib/audit.js';
import { monthToDate } from '../lib/months.js';

// Cria a cobrança do mês para todas as farmácias activas que ainda não a têm.
export async function generateMonth(month, adminId) {
  const first = monthToDate(month);
  const { rowCount } = await query(
    `INSERT INTO payments (pharmacy_id, reference_month, amount)
     SELECT id, $1::date, monthly_fee
     FROM pharmacies
     WHERE status = 'ACTIVA' AND deleted_at IS NULL
       AND created_at < ($1::date + interval '1 month')
     ON CONFLICT (pharmacy_id, reference_month) DO NOTHING`,
    [first],
  );
  await audit({ query }, adminId, 'PAYMENTS_GENERATED', 'payment', null, { month, created: rowCount });
  return { created: rowCount };
}

export async function summary(month) {
  const first = monthToDate(month);
  const [totals, counts] = await Promise.all([
    query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = 'PAGO'), 0)     AS received,
         COALESCE(SUM(amount) FILTER (WHERE status = 'PENDENTE'), 0) AS pending,
         count(*) FILTER (WHERE status = 'PAGO')     AS paid_count,
         count(*) FILTER (WHERE status = 'PENDENTE') AS pending_count
       FROM payments WHERE reference_month = $1::date`,
      [first],
    ),
    query(
      `SELECT
         count(*) FILTER (WHERE status = 'ACTIVA')   AS active,
         count(*) FILTER (WHERE status = 'INACTIVA') AS inactive
       FROM pharmacies WHERE deleted_at IS NULL`,
    ),
  ]);
  const t = totals.rows[0];
  return {
    month,
    received: t.received,
    pending: t.pending,
    expected: t.received + t.pending,
    paid_count: t.paid_count,
    pending_count: t.pending_count,
    pharmacies_active: counts.rows[0].active,
    pharmacies_inactive: counts.rows[0].inactive,
  };
}

export async function listPayments(month, status) {
  const params = [monthToDate(month)];
  let statusSql = '';
  if (status) {
    params.push(status);
    statusSql = 'AND p.status = $2::payment_status';
  }
  const { rows } = await query(
    `SELECT p.id, p.pharmacy_id, ph.name AS pharmacy_name, ph.status AS pharmacy_status,
            ph.province, p.amount, p.status, p.paid_at, p.method, p.reference, p.notes
     FROM payments p
     JOIN pharmacies ph ON ph.id = p.pharmacy_id AND ph.deleted_at IS NULL
     WHERE p.reference_month = $1::date ${statusSql}
     ORDER BY (p.status = 'PENDENTE') DESC, ph.name`,
    params,
  );
  return rows;
}

export async function markPaid(id, { method, reference, notes, paid_at: paidAt }, adminId) {
  const { rows } = await query(
    `UPDATE payments SET status = 'PAGO', paid_at = COALESCE($2::timestamptz, now()),
       method = $3, reference = $4, notes = $5, registered_by = $6
     WHERE id = $1 AND status = 'PENDENTE' RETURNING id, pharmacy_id`,
    [id, paidAt ?? null, method, reference ?? null, notes ?? null, adminId],
  );
  if (!rows[0]) await explainNoUpdate(id, 'Esta cobrança já está paga.');
  await audit({ query }, adminId, 'PAYMENT_REGISTERED', 'payment', id, { method });
}

export async function revert(id, adminId) {
  const { rows } = await query(
    `UPDATE payments SET status = 'PENDENTE', paid_at = NULL, method = NULL,
       reference = NULL, registered_by = NULL
     WHERE id = $1 AND status = 'PAGO' RETURNING id`,
    [id],
  );
  if (!rows[0]) await explainNoUpdate(id, 'Esta cobrança já está pendente.');
  await audit({ query }, adminId, 'PAYMENT_REVERTED', 'payment', id);
}

async function explainNoUpdate(id, conflictMessage) {
  const exists = await query('SELECT 1 FROM payments WHERE id = $1', [id]);
  throw new HttpError(exists.rowCount ? 409 : 404, exists.rowCount ? conflictMessage : 'Cobrança não encontrada.');
}
