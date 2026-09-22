const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// بيعمل user + profile مع بعض، يا الاتنين يتحفظوا يا ولا واحد
async function createUserWithProfile(roleName, email, password, insertProfile) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await client.query('SELECT role_id FROM roles WHERE role_name = $1', [roleName]);
    const hash = await bcrypt.hash(password, 10);
    const user = await client.query(
      'INSERT INTO users (email, password_hash, role_id) VALUES ($1, $2, $3) RETURNING user_id',
      [email, hash, role.rows[0].role_id]
    );
    const profile = await insertProfile(client, user.rows[0].user_id);
    await client.query('COMMIT');
    return profile;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function handleError(err, res) {
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Already exists (duplicate email, code or record)' });
  }
  if (err.code === '23503') {
    return res.status(400).json({ error: 'A referenced id does not exist' });
  }
  if (err.code === '23514') {
    return res.status(400).json({ error: 'Invalid value' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
}

// قايمة الطلبة
router.get('/students', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sp.student_id, sp.student_code, sp.student_name, sp.level,
              sp.department_id, d.department_name, u.user_id, u.email, u.is_active
       FROM student_profiles sp
       JOIN users u ON u.user_id = sp.user_id
       LEFT JOIN departments d ON d.department_id = sp.department_id
       ORDER BY sp.student_code`
    );
    res.json(result.rows);
  } catch (err) {
    handleError(err, res);
  }
});

// إضافة طالب
router.post('/students', async (req, res) => {
  const { email, password, student_code, student_name, level, department_id } = req.body;
  if (!email || !password || !student_code || !student_name) {
    return res.status(400).json({ error: 'email, password, student_code and student_name are required' });
  }
  try {
    const student = await createUserWithProfile('student', email, password, async (client, userId) => {
      const r = await client.query(
        `INSERT INTO student_profiles (user_id, student_code, student_name, level, department_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [userId, student_code, student_name, level || null, department_id || null]
      );
      return r.rows[0];
    });
    res.status(201).json(student);
  } catch (err) {
    handleError(err, res);
  }
});

// قايمة الدكاترة والمعيدين
router.get('/staff', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sp.staff_id, sp.staff_name, sp.staff_type, sp.department_id,
              d.department_name, u.user_id, u.email, u.is_active
       FROM staff_profiles sp
       JOIN users u ON u.user_id = sp.user_id
       LEFT JOIN departments d ON d.department_id = sp.department_id
       ORDER BY sp.staff_name`
    );
    res.json(result.rows);
  } catch (err) {
    handleError(err, res);
  }
});

// إضافة دكتور أو معيد
router.post('/staff', async (req, res) => {
  const { email, password, staff_name, staff_type, department_id } = req.body;
  if (!email || !password || !staff_name || !['lecturer', 'TA'].includes(staff_type)) {
    return res.status(400).json({ error: "email, password, staff_name and staff_type ('lecturer' or 'TA') are required" });
  }
  const roleName = staff_type === 'TA' ? 'ta' : 'lecturer';
  try {
    const staff = await createUserWithProfile(roleName, email, password, async (client, userId) => {
      const r = await client.query(
        `INSERT INTO staff_profiles (user_id, staff_name, staff_type, department_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [userId, staff_name, staff_type, department_id || null]
      );
      return r.rows[0];
    });
    res.status(201).json(staff);
  } catch (err) {
    handleError(err, res);
  }
});

// تعيين دكتور/معيد على شعبة
router.post('/sections/:sectionId/staff', async (req, res) => {
  const { staff_id, staff_role } = req.body;
  if (!staff_id || !staff_role) {
    return res.status(400).json({ error: 'staff_id and staff_role are required' });
  }
  try {
    const r = await pool.query(
      'INSERT INTO section_staff (section_id, staff_id, staff_role) VALUES ($1, $2, $3) RETURNING *',
      [req.params.sectionId, staff_id, staff_role]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    handleError(err, res);
  }
});

// قايمة تسجيلات الطلبة في الشُعَب
router.get('/enrollments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.enrollment_id, e.status, e.enrolled_at,
              sp.student_id, sp.student_code, sp.student_name,
              sec.section_id, sec.section_name,
              c.course_code, c.course_name
       FROM enrollments e
       JOIN student_profiles sp ON sp.student_id = e.student_id
       JOIN sections sec ON sec.section_id = e.section_id
       JOIN courses c ON c.course_id = sec.course_id
       ORDER BY e.enrollment_id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    handleError(err, res);
  }
});

// تسجيل طالب في شعبة
router.post('/enrollments', async (req, res) => {
  const { student_id, section_id } = req.body;
  if (!student_id || !section_id) {
    return res.status(400).json({ error: 'student_id and section_id are required' });
  }
  try {
    const r = await pool.query(
      'INSERT INTO enrollments (student_id, section_id) VALUES ($1, $2) RETURNING *',
      [student_id, section_id]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;