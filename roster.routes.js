const express = require('express');
const crypto = require('crypto');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

// الدكتور والمعيد بس
router.use(requireAuth, requireRole('lecturer', 'ta'));

const MANUAL_STATUSES = ['present', 'absent', 'excused'];

const sha256 = (obj) =>
  crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

// بيتأكد إن المستخدم ده مدرّس في شعبة الحصة دي
async function getSessionIfAllowed(db, sessionId, userId) {
  const r = await db.query(
    `SELECT s.session_id, s.status
     FROM attendance_sessions s
     JOIN timetable_slots ts ON ts.slot_id = s.slot_id
     JOIN section_staff ss ON ss.section_id = ts.section_id
     JOIN staff_profiles sp ON sp.staff_id = ss.staff_id
     WHERE s.session_id = $1 AND sp.user_id = $2`,
    [sessionId, userId]
  );
  return r.rows[0];
}

// قايمة الحصة (Live Roster)
router.get('/:id/roster', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid session id' });
  }
  try {
    const session = await getSessionIfAllowed(pool, id, req.user.userId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found (or not yours)' });
    }

    const r = await pool.query(
      `SELECT a.attendance_id, sp.student_code, sp.student_name,
              a.attendance_status, a.minutes_late, a.source, a.attendance_timestamp
       FROM attendance a
       JOIN student_profiles sp ON sp.student_id = a.student_id
       WHERE a.session_id = $1
       ORDER BY sp.student_name`,
      [id]
    );

    const rows = r.rows;
    const count = (s) => rows.filter((x) => x.attendance_status === s).length;

    res.json({
      session_id: id,
      session_status: session.status,
      summary: {
        total: rows.length,
        present: count('present'),
        late: count('late'),
        excused: count('excused'),
        absent: count('absent'),
      },
      students: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// تعديل يدوي لحالة طالب (السبب إجباري + تسجيل في الـ audit)
router.patch('/:id/attendance/:attendanceId', async (req, res) => {
  const sessionId = Number(req.params.id);
  const attendanceId = Number(req.params.attendanceId);
  const { status } = req.body;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';

  if (!Number.isInteger(sessionId) || !Number.isInteger(attendanceId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  if (!MANUAL_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${MANUAL_STATUSES.join(', ')}` });
  }
  if (reason.length < 3) {
    return res.status(400).json({ error: 'reason is required (at least 3 characters)' });
  }

  const client = await pool.connect();
  let began = false;
  try {
    const session = await getSessionIfAllowed(client, sessionId, req.user.userId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found (or not yours)' });
    }

    await client.query('BEGIN');
    began = true;

    const cur = await client.query(
      `SELECT attendance_status, minutes_late
       FROM attendance
       WHERE attendance_id = $1 AND session_id = $2
       FOR UPDATE`,
      [attendanceId, sessionId]
    );
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      began = false;
      return res.status(404).json({ error: 'Attendance record not found in this session' });
    }

    const before = cur.rows[0];
    const after = { attendance_status: status, minutes_late: 0 };

    await client.query(
      `UPDATE attendance
       SET attendance_status = $1, minutes_late = 0, source = 'manual',
           validation_result = 'manual_correction',
           updated_by = $2, updated_at = NOW()
       WHERE attendance_id = $3`,
      [status, req.user.userId, attendanceId]
    );

    await client.query(
      `INSERT INTO audit_events
         (actor_user_id, action, entity_type, entity_id, before_hash, after_hash, details)
       VALUES ($1, 'attendance.manual_update', 'attendance', $2, $3, $4, $5)`,
      [
        req.user.userId,
        attendanceId,
        sha256(before),
        sha256(after),
        JSON.stringify({ before, after, reason }),
      ]
    );

    await client.query('COMMIT');
    res.json({ attendance_id: attendanceId, before, after, reason });
  } catch (err) {
    if (began) await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;