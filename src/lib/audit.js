export async function audit(db, adminId, action, entity, entityId, details = null) {
  await db.query(
    `INSERT INTO audit_log (admin_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)`,
    [adminId ?? null, action, entity, entityId ?? null, details ? JSON.stringify(details) : null],
  );
}
