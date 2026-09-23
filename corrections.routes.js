const express = require('express');
const crypto = require('crypto');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

router.use(requireAuth);

const STUDENT_REQUEST_STATUSES = ['present', 'excused'];

const sha256 = (obj) =>
  crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

async function logAudit(client, { actorUserId, action, entityType, entityId, before, after, details }) {
  await client.query(
    `INSERT INTO audit_events
       (actor_user_id, action, entity_type, entity_id, before_hash, after_hash, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorUserId, action, entityType, entityId, sha256(before), sha256(after), JSON.stringify(details)]
  );
}

// الطالب يقدّم طلب تصحيح
router.post('/', requireRole('student'), async (req, res) => {
  const attId = Number(req.body.attendance_id);
  const { requested_status } = req.body;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  const evidence =
    typeof req.body.evidence_url === 'string' && req.body.evidence_url.trim()
      ? req.body.evidence_url.trim()
      : null;

  if (!Number.isInteger(attId)) {
    return res.status(400).json({ error: 'attendance_id is required' });
  }
  if (!STUDENT_REQUEST_STATUSES.includes(requested_status)) {
    return res.status(400).json({ error: `requested_status must be one of: ${STUDENT_REQUEST_STATUSES.join(', ')}` });
  }
  if (reason.length < 3) {
    return res.status(400).json({ error: 'reason is required (at least 3 characters)' });
  }

  try {
    // السجل لازم يكون بتاع الطالب نفسه
    const own = await pool.query(
      `SELECT a.attendance_id, a.student_id, a.attendance_status
       FROM attendance a
       JOIN student_profiles sp ON sp.student_id = a.student_id
       WHERE a.attendance_id = $1 AND sp.user_id = $2`,
      [attId, req.user.userId]
    );
    if (own.rows.length === 0) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }
    const rec = own.rows[0];
    if (rec.attendance_status === requested_status) {
      return res.status(400).json({ error: 'Your record already has this status' });
    }

    const r = await pool.query(
      `INSERT INTO correction_requests
         (attendance_id, student_id, requested_status, reason, evidence_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING request_id, attendance_id, requested_status, reason, evidence_url, status, created_at`,
      [attId, rec.student_id, requested_status, reason, evidence]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have a pending request for this record' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// الطالب يشوف طلباته هو بس
router.get('/mine', requireRole('student'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cr.request_id, cr.attendance_id, cr.requested_status, cr.reason,
              cr.evidence_url, cr.status, cr.review_reason, cr.created_at, cr.reviewed_at
       FROM correction_requests cr
       JOIN student_profiles sp ON sp.student_id = cr.student_id
       WHERE sp.user_id = $1
       ORDER BY cr.request_id DESC`,
      [req.user.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// الدكتور/المعيد يشوف الطلبات المعلّقة على شُعَبه بس
router.get('/pending', requireRole('lecturer', 'ta'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cr.request_id, cr.attendance_id, sp.student_code, sp.student_name,
              c.course_code, s.session_date,
              a.attendance_status AS current_status, cr.requested_status,
              cr.reason, cr.evidence_url, cr.created_at
       FROM correction_requests cr
       JOIN attendance a ON a.attendance_id = cr.attendance_id
       JOIN student_profiles sp ON sp.student_id = cr.student_id
       JOIN attendance_sessions s ON s.session_id = a.session_id
       JOIN timetable_slots ts ON ts.slot_id = s.slot_id
       JOIN sections sec ON sec.section_id = ts.section_id
       JOIN courses c ON c.course_id = sec.course_id
       JOIN section_staff ss ON ss.section_id = sec.section_id
       JOIN staff_profiles st ON st.staff_id = ss.staff_id
       WHERE cr.status = 'pending' AND st.user_id = $1
       ORDER BY cr.created_at`,
      [req.user.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// الدكتور/المعيد يوافق أو يرفض (السبب إجباري)
router.patch('/:id', requireRole('lecturer', 'ta'), async (req, res) => {
  const id = Number(req.params.id);
  const { decision } = req.body;
  const reviewReason =
    typeof req.body.review_reason === 'string' ? req.body.review_reason.trim() : '';

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }
  if (reviewReason.length < 3) {
    return res.status(400).json({ error: 'review_reason is required (at least 3 characters)' });
  }

  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;

    // الطلب لازم يكون معلّق ومن شعبة الدكتور نفسه
    const found = await client.query(
      `SELECT cr.request_id, cr.attendance_id, cr.requested_status, st.staff_id
       FROM correction_requests cr
       JOIN attendance a ON a.attendance_id = cr.attendance_id
       JOIN attendance_sessions s ON s.session_id = a.session_id
       JOIN timetable_slots ts ON ts.slot_id = s.slot_id
       JOIN section_staff ss ON ss.section_id = ts.section_id
       JOIN staff_profiles st ON st.staff_id = ss.staff_id
       WHERE cr.request_id = $1 AND cr.status = 'pending' AND st.user_id = $2
       FOR UPDATE OF cr`,
      [id, req.user.userId]
    );
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      began = false;
      return res.status(404).json({ error: 'Pending request not found (or not for your sections)' });
    }
    const reqRow = found.rows[0];

    if (decision === 'approved') {
      const cur = await client.query(
        'SELECT attendance_status, minutes_late FROM attendance WHERE attendance_id = $1 FOR UPDATE',
        [reqRow.attendance_id]
      );
      const before = cur.rows[0];
      const after = { attendance_status: reqRow.requested_status, minutes_late: 0 };

      await client.query(
        `UPDATE attendance
         SET attendance_status = $1, minutes_late = 0, source = 'manual',
             validation_result = 'correction_approved',
             updated_by = $2, updated_at = NOW()
         WHERE attendance_id = $3`,
        [reqRow.requested_status, req.user.userId, reqRow.attendance_id]
      );

      await logAudit(client, {
        actorUserId: req.user.userId,
        action: 'correction.approved',
        entityType: 'attendance',
        entityId: reqRow.attendance_id,
        before,
        after,
        details: { request_id: id, before, after, review_reason: reviewReason },
      });
    } else {
      const before = { status: 'pending' };
      const after = { status: 'rejected' };
      await logAudit(client, {
        actorUserId: req.user.userId,
        action: 'correction.rejected',
        entityType: 'correction_request',
        entityId: id,
        before,
        after,
        details: { request_id: id, review_reason: reviewReason },
      });
    }

    await client.query(
      `UPDATE correction_requests
       SET status = $1, reviewer_id = $2, review_reason = $3, reviewed_at = NOW()
       WHERE request_id = $4`,
      [decision, reqRow.staff_id, reviewReason, id]
    );

    await client.query('COMMIT');
    res.json({ request_id: id, status: decision, review_reason: reviewReason });
  } catch (err) {
    if (began) await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;