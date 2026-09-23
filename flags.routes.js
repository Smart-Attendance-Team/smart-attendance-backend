const express = require('express');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'auditor', 'lecturer', 'ta'));

function readNumber(value, fallback, { min, max, integer }) {
  if (value === undefined || value === '') return { value: fallback };
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    return { error: true };
  }
  return { value: n };
}

// الدكتور/المعيد يشوف شُعَبه بس
function staffScope(paramNumber) {
  return `AND EXISTS (
            SELECT 1 FROM section_staff ss
            JOIN staff_profiles st ON st.staff_id = ss.staff_id
            WHERE ss.section_id = sec.section_id AND st.user_id = $${paramNumber})`;
}

router.get('/', async (req, res) => {
  const t = readNumber(req.query.threshold, 75, { min: 1, max: 100 });
  const m = readNumber(req.query.min_sessions, 1, { min: 1, max: 1000, integer: true });
  const c = readNumber(req.query.corrections, 3, { min: 1, max: 1000, integer: true });
  if (t.error || m.error || c.error) {
    return res.status(400).json({
      error: 'threshold must be 1-100; min_sessions and corrections must be whole numbers of at least 1',
    });
  }
  const threshold = t.value;
  const minSessions = m.value;
  const correctionLimit = c.value;
  const isStaff = req.user.role === 'lecturer' || req.user.role === 'ta';

  try {
    // القاعدة 1: حضور منخفض
    const lowParams = [minSessions];
    if (isStaff) lowParams.push(req.user.userId);
    const low = await pool.query(
      `SELECT sp.student_code, sp.student_name, c.course_code, sec.section_name,
              COUNT(*) FILTER (WHERE a.attendance_status IN ('present', 'late'))::int AS attended,
              COUNT(*) FILTER (WHERE a.attendance_status <> 'excused')::int AS counted
       FROM attendance a
       JOIN attendance_sessions s ON s.session_id = a.session_id AND s.status = 'closed'
       JOIN timetable_slots ts ON ts.slot_id = s.slot_id
       JOIN sections sec ON sec.section_id = ts.section_id
       JOIN courses c ON c.course_id = sec.course_id
       JOIN student_profiles sp ON sp.student_id = a.student_id
       WHERE TRUE ${isStaff ? staffScope(2) : ''}
       GROUP BY sp.student_id, sp.student_code, sp.student_name,
                c.course_code, sec.section_id, sec.section_name
       HAVING COUNT(*) FILTER (WHERE a.attendance_status <> 'excused') >= $1
       ORDER BY sp.student_code`,
      lowParams
    );

    const flags = [];
    for (const r of low.rows) {
      const rate = Math.round((r.attended / r.counted) * 1000) / 10;
      if (rate < threshold) {
        flags.push({
          type: 'low_attendance',
          student_code: r.student_code,
          student_name: r.student_name,
          course_code: r.course_code,
          section_name: r.section_name,
          explanation: `Attended ${r.attended} of ${r.counted} counted sessions (${rate}%), below the ${threshold}% threshold`,
          details: { attended: r.attended, counted: r.counted, rate_percent: rate },
        });
      }
    }

    // القاعدة 2: طلبات تصحيح كتيرة في آخر 30 يوم
    const corrParams = [correctionLimit];
    if (isStaff) corrParams.push(req.user.userId);
    const corr = await pool.query(
      `SELECT sp.student_code, sp.student_name, COUNT(*)::int AS requests
       FROM correction_requests cr
       JOIN attendance a ON a.attendance_id = cr.attendance_id
       JOIN attendance_sessions s ON s.session_id = a.session_id
       JOIN timetable_slots ts ON ts.slot_id = s.slot_id
       JOIN sections sec ON sec.section_id = ts.section_id
       JOIN student_profiles sp ON sp.student_id = cr.student_id
       WHERE cr.created_at >= NOW() - INTERVAL '30 days' ${isStaff ? staffScope(2) : ''}
       GROUP BY sp.student_id, sp.student_code, sp.student_name
       HAVING COUNT(*) >= $1
       ORDER BY requests DESC, sp.student_code`,
      corrParams
    );

    for (const r of corr.rows) {
      flags.push({
        type: 'many_correction_requests',
        student_code: r.student_code,
        student_name: r.student_name,
        explanation: `${r.requests} correction requests in the last 30 days (limit ${correctionLimit})`,
        details: { requests: r.requests },
      });
    }

    res.json({
      available: true,
      method: 'rule_based',
      advisory_only: true,
      generated_at: new Date().toISOString(),
      thresholds: {
        attendance_percent: threshold,
        min_sessions: minSessions,
        corrections_in_30_days: correctionLimit,
      },
      count: flags.length,
      flags,
    });
  } catch (err) {
    // لو الـ flags وقعت، تسجيل الحضور مش بيتأثر
    console.error(err);
    res.status(503).json({
      available: false,
      error: 'Flags are temporarily unavailable. Attendance capture is not affected.',
    });
  }
});

module.exports = router;