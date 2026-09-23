const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

// الدكتور والمعيد بس
router.use(requireAuth, requireRole('lecturer', 'ta'));

const QR_LIFETIME_SECONDS = 20;
const TIMEZONE = process.env.APP_TIMEZONE || 'Africa/Cairo';

// اليوم والتاريخ والوقت الحالي بتوقيت القاهرة (مش توقيت الجهاز)
function nowParts() {
  const now = new Date();
  return {
    day: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: TIMEZONE }),
    date: now.toLocaleDateString('en-CA', { timeZone: TIMEZONE }),
    time: now.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour12: false }),
  };
}

// مواعيد الدكتور/المعيد (وهل فيه جلسة اتفتحت النهارده)
router.get('/my-slots', async (req, res) => {
  const { day, date } = nowParts();
  try {
    const result = await pool.query(
      `SELECT ts.slot_id, c.course_code, c.course_name,
              sec.section_id, sec.section_name,
              r.room_name, r.building, ts.day_of_week,
              to_char(ts.start_time, 'HH24:MI') AS start_time,
              to_char(ts.end_time, 'HH24:MI') AS end_time,
              s.session_id, s.status AS session_status
       FROM timetable_slots ts
       JOIN section_staff ss ON ss.section_id = ts.section_id
       JOIN staff_profiles sp ON sp.staff_id = ss.staff_id AND sp.user_id = $1
       JOIN sections sec ON sec.section_id = ts.section_id
       JOIN courses c ON c.course_id = sec.course_id
       JOIN rooms r ON r.room_id = ts.room_id
       LEFT JOIN attendance_sessions s
              ON s.slot_id = ts.slot_id AND s.session_date = $2::date
       ORDER BY ts.start_time, c.course_code`,
      [req.user.userId, date]
    );
    res.json(result.rows.map((row) => ({ ...row, is_today: row.day_of_week === day })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// فتح حصة
router.post('/open', async (req, res) => {
  const { slot_id } = req.body;
  if (!slot_id) {
    return res.status(400).json({ error: 'slot_id is required' });
  }

  const client = await pool.connect();
  let began = false;
  try {
    const staff = await client.query(
      'SELECT staff_id FROM staff_profiles WHERE user_id = $1',
      [req.user.userId]
    );
    if (staff.rows.length === 0) {
      return res.status(403).json({ error: 'No staff profile for this user' });
    }
    const staffId = staff.rows[0].staff_id;

    // الموعد لازم يكون لشعبة الدكتور نفسه
    const slotRes = await client.query(
      `SELECT ts.slot_id, ts.section_id, ts.day_of_week, ts.start_time, ts.end_time
       FROM timetable_slots ts
       JOIN section_staff ss ON ss.section_id = ts.section_id AND ss.staff_id = $2
       WHERE ts.slot_id = $1`,
      [slot_id, staffId]
    );
    if (slotRes.rows.length === 0) {
      return res.status(403).json({ error: 'Slot not found or not assigned to you' });
    }
    const slot = slotRes.rows[0];

    const { day, date, time } = nowParts();
    if (slot.day_of_week !== day) {
      return res.status(400).json({ error: 'This slot is not scheduled for today' });
    }
    if (time < slot.start_time || time > slot.end_time) {
      return res.status(400).json({ error: 'Outside the scheduled time of this slot' });
    }

    await client.query('BEGIN');
    began = true;

    const secret = crypto.randomBytes(32).toString('hex');
    const sessionRes = await client.query(
      `INSERT INTO attendance_sessions (slot_id, session_date, opened_by, qr_secret)
       VALUES ($1, $2, $3, $4)
       RETURNING session_id, slot_id, session_date, status, opened_at`,
      [slot.slot_id, date, staffId, secret]
    );
    const session = sessionRes.rows[0];

    // تثبيت قائمة الطلبة: كل المسجلين يبدأوا "غايبين"
    const roster = await client.query(
      `INSERT INTO attendance (student_id, session_id)
       SELECT student_id, $1 FROM enrollments
       WHERE section_id = $2 AND status = 'active'`,
      [session.session_id, slot.section_id]
    );

    await client.query('COMMIT');
    res.status(201).json({ ...session, roster_count: roster.rowCount });
  } catch (err) {
    if (began) await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Session already opened for this slot today' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// قفل حصة
router.post('/:id/close', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid session id' });
  }
  try {
    const result = await pool.query(
      `UPDATE attendance_sessions
       SET status = 'closed', closed_at = NOW()
       WHERE session_id = $1
         AND status = 'open'
         AND opened_by = (SELECT staff_id FROM staff_profiles WHERE user_id = $2)
       RETURNING session_id, status, closed_at`,
      [id, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Open session not found (or not yours)' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// جلب الـ QR الحالي (كل طلب بيرجّع توكن جديد قصير العمر)
router.get('/:id/qr', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid session id' });
  }
  try {
    const result = await pool.query(
      `SELECT s.session_id, s.qr_secret, s.qr_secret_version
       FROM attendance_sessions s
       JOIN staff_profiles sp ON sp.staff_id = s.opened_by
       WHERE s.session_id = $1 AND s.status = 'open' AND sp.user_id = $2`,
      [id, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Open session not found (or not yours)' });
    }
    const s = result.rows[0];
    const token = jwt.sign(
      { sid: s.session_id, v: s.qr_secret_version },
      s.qr_secret,
      { expiresIn: QR_LIFETIME_SECONDS }
    );
    res.json({ token, expires_in_seconds: QR_LIFETIME_SECONDS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;