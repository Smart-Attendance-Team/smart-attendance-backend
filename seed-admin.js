require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function main() {
  const hash = await bcrypt.hash('Admin@123', 10);
  const role = await pool.query("SELECT role_id FROM roles WHERE role_name = 'admin'");
  await pool.query(
    `INSERT INTO users (email, password_hash, role_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    ['admin@test.com', hash, role.rows[0].role_id]
  );
  console.log('Admin user ready');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});