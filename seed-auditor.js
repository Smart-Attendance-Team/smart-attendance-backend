require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function main() {
  const hash = await bcrypt.hash('Auditor@123', 10);
  const role = await pool.query("SELECT role_id FROM roles WHERE role_name = 'auditor'");
  await pool.query(
    `INSERT INTO users (email, password_hash, role_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    ['auditor@test.com', hash, role.rows[0].role_id]
  );
  console.log('Auditor user ready');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});