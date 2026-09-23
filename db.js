require('dotenv').config();
const { Pool, types } = require('pg');

// نرجّع التواريخ (DATE) كنص YYYY-MM-DD من غير ما تتحوّل لتوقيت
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

module.exports = pool;