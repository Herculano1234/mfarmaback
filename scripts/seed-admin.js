import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Defina ADMIN_EMAIL e ADMIN_PASSWORD no .env');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
await client.connect();
try {
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const { rowCount } = await client.query(
    `INSERT INTO admins (name, email, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    [ADMIN_NAME || 'Administrador', ADMIN_EMAIL, hash],
  );
  console.log(rowCount ? `Administrador ${ADMIN_EMAIL} criado.` : 'Administrador já existe, nada a fazer.');
} finally {
  await client.end();
}
