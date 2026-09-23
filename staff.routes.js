const express = require('express');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

// الدكتور والمعيد بس
router.use(requireAuth, requireRole('lecturer', 'ta'));

// بيانات الدكتور/المعيد المسجّل دخوله (من الـ token بس، مفيش id بيتبعت)
router.get('/me', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sp.staff_id, sp.staff_name, sp.staff_type, u.email,
              d.department_name
       FROM staff_profiles sp
       JOIN users u ON u.user_id = sp.user_id
       LEFT JOIN departments d ON d.department_id = sp.department_id
       WHERE sp.user_id = $1`,
      [req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No staff profile for this user' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;