const express = require('express');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

// كل الـ endpoints هنا للـ admin بس
router.use(requireAuth, requireRole('admin'));

// إضافة قسم
router.post('/departments', async (req, res) => {
  const { department_name } = req.body;
  if (!department_name) {
    return res.status(400).json({ error: 'department_name is required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO departments (department_name) VALUES ($1) RETURNING *',
      [department_name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Department already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// عرض الأقسام
router.get('/departments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY department_id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// إضافة كورس
router.post('/courses', async (req, res) => {
  const { course_code, course_name, department_id } = req.body;
  if (!course_code || !course_name) {
    return res.status(400).json({ error: 'course_code and course_name are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO courses (course_code, course_name, department_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [course_code, course_name, department_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Course code already exists' });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: 'department_id does not exist' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// عرض الكورسات
router.get('/courses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM courses ORDER BY course_id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// تعديل بيانات كورس
router.patch('/courses/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid course id' });
  }
  const { course_code, course_name, department_id } = req.body;
  if (course_code === undefined && course_name === undefined && department_id === undefined) {
    return res.status(400).json({
      error: 'Send at least one of: course_code, course_name, department_id',
    });
  }
  try {
    const cur = await pool.query('SELECT * FROM courses WHERE course_id = $1', [id]);
    if (cur.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }
    const before = cur.rows[0];
    const result = await pool.query(
      `UPDATE courses SET course_code = $2, course_name = $3, department_id = $4
       WHERE course_id = $1 RETURNING *`,
      [
        id,
        course_code !== undefined ? course_code : before.course_code,
        course_name !== undefined ? course_name : before.course_name,
        department_id !== undefined ? department_id : before.department_id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Course code already exists' });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: 'department_id does not exist' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// حذف كورس (مرفوض لو فيه شُعَب مرتبطة بيه)
router.delete('/courses/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid course id' });
  }
  try {
    const result = await pool.query('DELETE FROM courses WHERE course_id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }
    res.json({ deleted: true, course_id: id });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({
        error: 'Cannot delete: sections exist for this course. Edit it instead.',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// إضافة قاعة أو معمل
router.post('/rooms', async (req, res) => {
  const { room_name, building, room_type, capacity } = req.body;
  if (!room_name || !room_type) {
    return res.status(400).json({ error: 'room_name and room_type are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO rooms (room_name, building, room_type, capacity)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [room_name, building || null, room_type, capacity || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23514') {
      return res.status(400).json({ error: "room_type must be 'lecture' or 'lab'" });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// عرض القاعات
router.get('/rooms', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms ORDER BY room_id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// إضافة شعبة
router.post('/sections', async (req, res) => {
  const { course_id, section_name, semester, capacity } = req.body;
  if (!course_id || !section_name || !semester) {
    return res.status(400).json({ error: 'course_id, section_name and semester are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO sections (course_id, section_name, semester, capacity)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [course_id, section_name, semester, capacity || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'course_id does not exist' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// عرض الشعب
router.get('/sections', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sections ORDER BY section_id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;