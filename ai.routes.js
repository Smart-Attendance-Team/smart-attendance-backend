const express = require('express');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

router.use(requireAuth);

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000';

router.get('/risk/:studentId', requireRole('admin', 'lecturer', 'ta'), async (req, res) => {
  const studentId = Number(req.params.studentId);

  if (!Number.isInteger(studentId)) {
    return res.status(400).json({ error: 'Invalid student id' });
  }

  try {
    // Get student basic info
    const studentResult = await pool.query(
      `
      SELECT student_id, student_name
      FROM student_profiles
      WHERE student_id = $1
      `,
      [studentId]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentResult.rows[0];

    // Attendance statistics
    const stats = await pool.query(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE attendance_status IN ('present','late')) AS attended,
        COUNT(*) FILTER (WHERE attendance_status = 'late') AS late_count,
        COUNT(*) FILTER (WHERE attendance_status = 'absent') AS absent_count
      FROM attendance
      WHERE student_id = $1
      `,
      [studentId]
    );

    const row = stats.rows[0];

    const total = Number(row.total) || 0;

    const previousAttendance = total
      ? Number(row.attended) / total
      : 0;

    const lateRate = total
      ? Number(row.late_count) / total
      : 0;

    const absenceRate = total
      ? Number(row.absent_count) / total
      : 0;


    // Course load
    const courses = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM enrollments
      WHERE student_id = $1
      AND status = 'active'
      `,
      [studentId]
    );

    const courseLoad = Number(courses.rows[0].count) || 0;


    const aiResponse = await fetch(`${AI_URL}/predict`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        previous_attendance: previousAttendance,
        recent_3week_attendance: previousAttendance,
        previous_late_rate: lateRate,
        previous_absence_rate: absenceRate,
        previous_course_load: courseLoad,
        attendance_trend: 0
      })
    });

    const prediction = await aiResponse.json();


    res.json({
      student_id: student.student_id,
      student_name: student.student_name,
      features: {
        previous_attendance: previousAttendance,
        late_rate: lateRate,
        absence_rate: absenceRate,
        course_load: courseLoad
      },
      ai: prediction
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'AI prediction failed'
    });
  }
});


router.get('/risk', requireRole('admin', 'lecturer', 'ta'), async (req, res) => {
  try {
    const students = await pool.query(`
      SELECT student_id, student_name
      FROM student_profiles
      ORDER BY student_id
    `);

    const results = [];

    for (const student of students.rows) {

      const stats = await pool.query(
        `
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE attendance_status IN ('present','late')) AS attended,
          COUNT(*) FILTER (WHERE attendance_status = 'late') AS late_count,
          COUNT(*) FILTER (WHERE attendance_status = 'absent') AS absent_count
        FROM attendance
        WHERE student_id = $1
        `,
        [student.student_id]
      );

      const row = stats.rows[0];

      const total = Number(row.total) || 0;

      const previousAttendance = total
        ? Number(row.attended) / total
        : 0;

      const lateRate = total
        ? Number(row.late_count) / total
        : 0;

      const absenceRate = total
        ? Number(row.absent_count) / total
        : 0;


      const aiResponse = await fetch(`${AI_URL}/predict`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          previous_attendance: previousAttendance,
          recent_3week_attendance: previousAttendance,
          previous_late_rate: lateRate,
          previous_absence_rate: absenceRate,
          previous_course_load: 0,
          attendance_trend: 0
        })
      });


      const prediction = await aiResponse.json();

      results.push({
        student_id: student.student_id,
        student_name: student.student_name,
        risk_level: prediction.risk_level,
        risk_probability: prediction.risk_probability
      });
    }

    res.json(results);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to generate risk report'
    });
  }
});

router.get('/health', async (req, res) => {
  try {
    // Check database
    await pool.query('SELECT 1');

    // Check AI service
    const aiResponse = await fetch(`${AI_URL}/health`);

    if (!aiResponse.ok) {
      throw new Error('AI service unavailable');
    }

    const aiStatus = await aiResponse.json();

    res.json({
      backend: 'ok',
      database: 'ok',
      ai_service: aiStatus
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      backend: 'error',
      message: err.message
    });
  }
});

module.exports = router;