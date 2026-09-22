const express = require('express');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

// الطلبة بس
router.use(requireAuth, requireRole('student'));

// بيانات الطالب المسجّل دخوله (من الـ token بس، مفيش id بيتبعت)
router.get('/me', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sp.student_id, sp.student_code, sp.student_name, u.email,
              sp.level, d.department_name
       FROM student_profiles sp
       JOIN users u ON u.user_id = sp.user_id
       LEFT JOIN departments d ON d.department_id = sp.department_id
       WHERE sp.user_id = $1`,
      [req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No student profile for this user' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// جدول محاضرات الطالب الأسبوعي (من الشُعَب المسجّل فيها)
router.get('/my-timetable', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ts.slot_id, c.course_code, c.course_name,
              sec.section_id, sec.section_name,
              r.room_name, r.room_type, r.building, ts.day_of_week,
              to_char(ts.start_time, 'HH24:MI') AS start_time,
              to_char(ts.end_time, 'HH24:MI') AS end_time
       FROM timetable_slots ts
       JOIN sections sec ON sec.section_id = ts.section_id
       JOIN courses c ON c.course_id = sec.course_id
       JOIN rooms r ON r.room_id = ts.room_id
       JOIN enrollments e ON e.section_id = sec.section_id AND e.status = 'active'
       JOIN student_profiles sp ON sp.student_id = e.student_id
       WHERE sp.user_id = $1
       ORDER BY
         array_position(ARRAY['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday'], ts.day_of_week),
         ts.start_time`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;