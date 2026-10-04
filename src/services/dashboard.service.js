import { query } from '../config/db.js';

export async function getDashboard() {
  const [counts, series, best, overdue, top, recent] = await Promise.all([
    query(
      `SELECT
         count(*)                                         AS total,
         count(*) FILTER (WHERE status = 'ACTIVA')        AS active,
         count(*) FILTER (WHERE status = 'INACTIVA')      AS inactive,
         count(*) FILTER (WHERE created_at >= date_trunc('month', now())) AS new_this_month
       FROM pharmacies WHERE deleted_at IS NULL`,
    ),
    // Últimos 6 meses (o último é o mês corrente), com 0 nos meses sem pagamentos.
    query(
      `SELECT to_char(m, 'YYYY-MM') AS month,
              COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'PAGO'), 0) AS revenue
       FROM generate_series(
              date_trunc('month', current_date)::date - interval '5 months',
              date_trunc('month', current_date)::date,
              interval '1 month') AS m
       LEFT JOIN payments p ON p.reference_month = m::date
       GROUP BY m ORDER BY m`,
    ),
    query(
      `SELECT to_char(reference_month, 'YYYY-MM') AS month, SUM(amount) AS revenue
       FROM payments WHERE status = 'PAGO'
       GROUP BY reference_month ORDER BY revenue DESC, reference_month DESC LIMIT 1`,
    ),
    query(
      `SELECT count(*) AS count, COALESCE(SUM(amount), 0) AS amount
       FROM payments
       WHERE status = 'PENDENTE' AND reference_month < date_trunc('month', current_date)::date`,
    ),
    query(
      `SELECT ph.id, ph.name, SUM(p.amount) AS revenue
       FROM payments p JOIN pharmacies ph ON ph.id = p.pharmacy_id
       WHERE p.status = 'PAGO'
         AND p.reference_month > (date_trunc('month', current_date) - interval '12 months')::date
       GROUP BY ph.id, ph.name ORDER BY revenue DESC LIMIT 1`,
    ),
    query(
      `SELECT id, name, province, municipality, status, monthly_fee, created_at
       FROM pharmacies WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5`,
    ),
  ]);

  const s = series.rows;
  const last = s[s.length - 2];
  const before = s[s.length - 3];
  const changePct = before.revenue > 0 ? ((last.revenue - before.revenue) / before.revenue) * 100 : null;

  return {
    pharmacies: counts.rows[0],
    revenue: {
      last_month: { month: last.month, amount: last.revenue, previous_amount: before.revenue, change_pct: changePct },
      current_month: s[s.length - 1],
      best_month: best.rows[0] ?? null,
      series: s,
    },
    overdue: overdue.rows[0],
    top_pharmacy: top.rows[0] ?? null,
    recent_pharmacies: recent.rows,
  };
}
