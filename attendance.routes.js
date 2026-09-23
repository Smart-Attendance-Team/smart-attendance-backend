// const express = require('express');
// const jwt = require('jsonwebtoken');
// const rateLimit = require('express-rate-limit');
// const pool = require('./db');
// const { requireAuth, requireRole } = require('./auth.middleware');

// const router = express.Router();

// // الطلبة بس
// router.use(requireAuth, requireRole('student'));

// // 10 محاولات scan في الدقيقة لكل حساب طالب
// const scanLimiter = rateLimit({
//   windowMs: 60 * 1000,
//   limit: 10,
//   keyGenerator: (req) => `user-${req.user.userId}`,
//   standardHeaders: true,
//   legacyHeaders: false,
//   message: { accepted: false, reason: 'too_many_attempts' },
// });

// const LATE_AFTER_MINUTES = 15;

// // الطالب بيعمل scan للـ QR
// router.post('/scan', scanLimiter, async (req, res) => {
//   const { token } = req.body;
//   if (!token || typeof token !== 'string') {
//     return res.status(400).json({ accepted: false, reason: 'token is required' });
//   }

//   // بنقرا رقم الحصة من التوكن الأول (من غير ما نثق فيه) عشان نجيب سرّها
//   const decoded = jwt.decode(token);
//   const sid = decoded ? Number(decoded.sid) : NaN;
//   if (!Number.isInteger(sid)) {
//     return res.status(400).json({ accepted: false, reason: 'invalid_token' });
//   }

//   try {
//     const sessionRes = await pool.query(
//       `SELECT session_id, status, qr_secret, qr_secret_version,
//               FLOOR(EXTRACT(EPOCH FROM (NOW() - opened_at)) / 60)::int AS minutes_since_open
//        FROM attendance_sessions WHERE session_id = $1`,
//       [sid]
//     );
//     const session = sessionRes.rows[0];
//     if (!session) {
//       return res.status(400).json({ accepted: false, reason: 'invalid_token' });
//     }
//     if (session.status !== 'open') {
//       return res.status(400).json({ accepted: false, reason: 'session_closed' });
//     }

//     // التحقق من التوقيع والصلاحية
//     try {
//       const payload = jwt.verify(token, session.qr_secret);
//       if (payload.v !== session.qr_secret_version) {
//         throw new Error('version mismatch');
//       }
//     } catch (err) {
//       const reason = err.name === 'TokenExpiredError' ? 'expired_token' : 'invalid_token';
//       return res.status(400).json({ accepted: false, reason });
//     }

//     // الطالب لازم يكون في قائمة الحصة
//     const rowRes = await pool.query(
//       `SELECT a.attendance_id, a.attendance_timestamp, a.attendance_status, a.minutes_late
//        FROM attendance a
//        JOIN student_profiles sp ON sp.student_id = a.student_id
//        WHERE sp.user_id = $1 AND a.session_id = $2`,
//       [req.user.userId, sid]
//     );
//     const row = rowRes.rows[0];
//     if (!row) {
//       return res.status(403).json({ accepted: false, reason: 'not_enrolled' });
//     }

//     // لو اتسجّل قبل كده: نفس الرد من غير تكرار
//     if (row.attendance_timestamp) {
//       return res.json({
//         accepted: true,
//         duplicate: true,
//         attendance_status: row.attendance_status,
//         minutes_late: row.minutes_late,
//       });
//     }

//     const late = session.minutes_since_open > LATE_AFTER_MINUTES;
//     const upd = await pool.query(
//       `UPDATE attendance
//        SET attendance_timestamp = NOW(), source = 'qr', validation_result = 'accepted',
//            attendance_status = $2, minutes_late = $3, updated_at = NOW()
//        WHERE attendance_id = $1 AND attendance_timestamp IS NULL
//        RETURNING attendance_status, minutes_late, attendance_timestamp`,
//       [row.attendance_id, late ? 'late' : 'present', late ? session.minutes_since_open : 0]
//     );

//     // لو 0 صفوف يبقى scan تاني سبقه في نفس اللحظة
//     if (upd.rows.length === 0) {
//       return res.json({ accepted: true, duplicate: true });
//     }

//     res.json({ accepted: true, duplicate: false, ...upd.rows[0] });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'Server error' });
//   }
// });

// // الطالب يشوف سجلّه هو بس
// router.get('/me', async (req, res) => {
//   try {
//     const result = await pool.query(
//       `SELECT a.attendance_id, c.course_code, c.course_name, s.session_date,
//               a.attendance_status, a.minutes_late, a.attendance_timestamp
//        FROM attendance a
//        JOIN student_profiles sp ON sp.student_id = a.student_id
//        JOIN attendance_sessions s ON s.session_id = a.session_id
//        JOIN timetable_slots ts ON ts.slot_id = s.slot_id
//        JOIN sections sec ON sec.section_id = ts.section_id
//        JOIN courses c ON c.course_id = sec.course_id
//        WHERE sp.user_id = $1
//        ORDER BY s.session_date DESC, a.attendance_id DESC`,
//       [req.user.userId]
//     );
//     res.json(result.rows);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'Server error' });
//   }
// });

// module.exports = router;


const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

// الطلبة بس
router.use(requireAuth, requireRole('student'));

// 10 محاولات scan في الدقيقة لكل حساب طالب
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `user-${req.user.userId}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { accepted: false, reason: 'too_many_attempts' },
});

const LATE_AFTER_MINUTES = 15;

// الطالب بيعمل scan للـ QR
router.post('/scan', scanLimiter, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ accepted: false, reason: 'token is required' });
  }

  // بنقرا رقم الحصة من التوكن الأول (من غير ما نثق فيه) عشان نجيب سرّها
  const decoded = jwt.decode(token);
  const sid = decoded ? Number(decoded.sid) : NaN;
  if (!Number.isInteger(sid)) {
    return res.status(400).json({ accepted: false, reason: 'invalid_token' });
  }

  try {
    const sessionRes = await pool.query(
      `SELECT session_id, status, qr_secret, qr_secret_version,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - opened_at)) / 60)::int AS minutes_since_open
       FROM attendance_sessions WHERE session_id = $1`,
      [sid]
    );
    const session = sessionRes.rows[0];
    if (!session) {
      return res.status(400).json({ accepted: false, reason: 'invalid_token' });
    }
    if (session.status !== 'open') {
      return res.status(400).json({ accepted: false, reason: 'session_closed' });
    }

    // التحقق من التوقيع والصلاحية
    try {
      const payload = jwt.verify(token, session.qr_secret);
      if (payload.v !== session.qr_secret_version) {
        throw new Error('version mismatch');
      }
    } catch (err) {
      const reason = err.name === 'TokenExpiredError' ? 'expired_token' : 'invalid_token';
      return res.status(400).json({ accepted: false, reason });
    }

    // الطالب لازم يكون في قائمة الحصة
    const rowRes = await pool.query(
      `SELECT a.attendance_id, a.attendance_timestamp, a.attendance_status,
              a.minutes_late, a.source
       FROM attendance a
       JOIN student_profiles sp ON sp.student_id = a.student_id
       WHERE sp.user_id = $1 AND a.session_id = $2`,
      [req.user.userId, sid]
    );
    const row = rowRes.rows[0];
    if (!row) {
      return res.status(403).json({ accepted: false, reason: 'not_enrolled' });
    }

    // لو اتسجّل قبل كده: نفس الرد من غير تكرار
    if (row.attendance_timestamp) {
      return res.json({
        accepted: true,
        duplicate: true,
        attendance_status: row.attendance_status,
        minutes_late: row.minutes_late,
      });
    }

    // الدكتور عدّل السجل يدوياً: الـ scan مايغيّرش قراره
    if (row.source === 'manual') {
      return res.status(409).json({
        accepted: false,
        reason: 'manually_recorded',
        attendance_status: row.attendance_status,
      });
    }

    const late = session.minutes_since_open > LATE_AFTER_MINUTES;
    const upd = await pool.query(
      `UPDATE attendance
       SET attendance_timestamp = NOW(), source = 'qr', validation_result = 'accepted',
           attendance_status = $2, minutes_late = $3, updated_at = NOW()
       WHERE attendance_id = $1 AND attendance_timestamp IS NULL AND source <> 'manual'
       RETURNING attendance_status, minutes_late, attendance_timestamp`,
      [row.attendance_id, late ? 'late' : 'present', late ? session.minutes_since_open : 0]
    );

    // لو 0 صفوف يبقى scan تاني سبقه في نفس اللحظة (أو الدكتور عدّل يدوياً)
    if (upd.rows.length === 0) {
      return res.json({ accepted: true, duplicate: true });
    }

    res.json({ accepted: true, duplicate: false, ...upd.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// الطالب يشوف سجلّه هو بس
router.get('/me', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.attendance_id, c.course_code, c.course_name, s.session_date,
              a.attendance_status, a.minutes_late, a.attendance_timestamp
       FROM attendance a
       JOIN student_profiles sp ON sp.student_id = a.student_id
       JOIN attendance_sessions s ON s.session_id = a.session_id
       JOIN timetable_slots ts ON ts.slot_id = s.slot_id
       JOIN sections sec ON sec.section_id = ts.section_id
       JOIN courses c ON c.course_id = sec.course_id
       WHERE sp.user_id = $1
       ORDER BY s.session_date DESC, a.attendance_id DESC`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;