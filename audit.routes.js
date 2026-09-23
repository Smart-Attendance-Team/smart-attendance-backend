const express = require('express');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

// قراءة فقط: الـ Auditor والـ Admin
router.use(requireAuth, requireRole('auditor', 'admin'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/', async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (req.query.entity_type) add('ae.entity_type = ?', String(req.query.entity_type));
  if (req.query.action) add('ae.action = ?', String(req.query.action));

  for (const [key, column] of [['entity_id', 'ae.entity_id'], ['actor_user_id', 'ae.actor_user_id']]) {
    if (req.query[key] !== undefined && req.query[key] !== '') {
      const n = Number(req.query[key]);
      if (!Number.isInteger(n)) {
        return res.status(400).json({ error: `${key} must be a number` });
      }
      add(`${column} = ?`, n);
    }
  }

  if (req.query.from) {
    if (!DATE_RE.test(req.query.from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
    add('ae.created_at >= ?::date', req.query.from);
  }
  if (req.query.to) {
    if (!DATE_RE.test(req.query.to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
    add('ae.created_at < (?::date + 1)', req.query.to);
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    params.push(limit, offset);
    const sql = `
      SELECT ae.audit_id, ae.created_at, ae.action, ae.entity_type, ae.entity_id,
             u.email AS actor_email, r.role_name AS actor_role,
             ae.before_hash, ae.after_hash, ae.details
      FROM audit_events ae
      JOIN users u ON u.user_id = ae.actor_user_id
      JOIN roles r ON r.role_id = u.role_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ae.audit_id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(sql, params);
    res.json({ count: result.rows.length, limit, offset, events: result.rows });
  } catch (err) {
    if (err.code === '22008' || err.code === '22007') {
      return res.status(400).json({ error: 'Invalid date value' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;