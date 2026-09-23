const express = require('express');
const crypto = require('crypto');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

const DAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// يقبل HH:MM أو HH:MM:SS ويرجّع HH:MM:SS (أو null لو الصيغة غلط)
function normTime(t) {
  if (typeof t !== 'string') return null;
  const m = t.trim().match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  return m ? `${m[1]}:${m[2]}:${m[3] || '00'}` : null;
}

const sha256 = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

// تسجيل عمليات الأدمن في الـ audit (قبل/بعد)
async function logAudit(db, { actorUserId, action, entityId, before, after }) {
  await db.query(
    `INSERT INTO audit_events
       (actor_user_id, action, entity_type, entity_id, before_hash, after_hash, details)
     VALUES ($1, $2, 'timetable_slot', $3, $4, $5, $6)`,
    [
      actorUserId,
      action,
      entityId,
      before ? sha256(before) : null,
      after ? sha256(after) : null,
      JSON.stringify({ before: before || null, after: after || null }),
    ]
  );
}

// هل القاعة مشغولة في نفس اليوم والوقت (موعد تاني بيتقاطع معاه)؟
async function findRoomConflict(db, { roomId, day, start, end, excludeSlotId = 0 }) {
  const r = await db.query(
    `SELECT slot_id FROM timetable_slots
     WHERE room_id = $1 AND day_of_week = $2 AND slot_id <> $3
       AND start_time < $5::time AND end_time > $4::time
     LIMIT 1`,
    [roomId, day, excludeSlotId, start, end]
  );
  return r.rows[0] || null;
}

// إضافة موعد محاضرة لشعبة
router.post('/timetable-slots', async (req, res) => {
  const { section_id, room_id, day_of_week } = req.body;

  if (!section_id || !room_id || !day_of_week || !req.body.start_time || !req.body.end_time) {
    return res.status(400).json({
      error: 'section_id, room_id, day_of_week, start_time and end_time are required',
    });
  }
  if (!DAYS.includes(day_of_week)) {
    return res.status(400).json({ error: `day_of_week must be one of: ${DAYS.join(', ')}` });
  }
  const start = normTime(req.body.start_time);
  const end = normTime(req.body.end_time);
  if (!start || !end) {
    return res.status(400).json({ error: 'Invalid time format, use HH:MM' });
  }
  if (end <= start) {
    return res.status(400).json({ error: 'end_time must be after start_time' });
  }

  try {
    const conflict = await findRoomConflict(pool, { roomId: room_id, day: day_of_week, start, end });
    if (conflict) {
      return res.status(409).json({
        error: `Room is already booked at this time (slot ${conflict.slot_id})`,
      });
    }

    const result = await pool.query(
      `INSERT INTO timetable_slots (section_id, room_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [section_id, room_id, day_of_week, start, end]
    );
    await logAudit(pool, {
      actorUserId: req.user.userId,
      action: 'timetable_slot.create',
      entityId: result.rows[0].slot_id,
      before: null,
      after: result.rows[0],
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'section_id or room_id does not exist' });
    }
    if (err.code === '22P02') {
      return res.status(400).json({ error: 'section_id and room_id must be numbers' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// عرض المواعيد
router.get('/timetable-slots', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM timetable_slots ORDER BY slot_id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// تعديل موعد (القاعة / اليوم / الوقت). أي حقل تبعتيه بس هو اللي بيتغيّر
router.patch('/timetable-slots/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid slot id' });
  }

  const { room_id, day_of_week, start_time, end_time } = req.body;
  if (room_id === undefined && day_of_week === undefined &&
      start_time === undefined && end_time === undefined) {
    return res.status(400).json({
      error: 'Send at least one of: room_id, day_of_week, start_time, end_time',
    });
  }
  if (day_of_week !== undefined && !DAYS.includes(day_of_week)) {
    return res.status(400).json({ error: `day_of_week must be one of: ${DAYS.join(', ')}` });
  }
  let newStart;
  let newEnd;
  if (start_time !== undefined) {
    newStart = normTime(start_time);
    if (!newStart) return res.status(400).json({ error: 'Invalid start_time, use HH:MM' });
  }
  if (end_time !== undefined) {
    newEnd = normTime(end_time);
    if (!newEnd) return res.status(400).json({ error: 'Invalid end_time, use HH:MM' });
  }

  try {
    const cur = await pool.query('SELECT * FROM timetable_slots WHERE slot_id = $1', [id]);
    if (cur.rows.length === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    const before = cur.rows[0];

    // مايتعدّلش موعد فيه جلسة مفتوحة دلوقتي
    const open = await pool.query(
      `SELECT 1 FROM attendance_sessions WHERE slot_id = $1 AND status = 'open' LIMIT 1`,
      [id]
    );
    if (open.rows.length > 0) {
      return res.status(409).json({ error: 'This slot has an open session. Close it first.' });
    }

    const merged = {
      room_id: room_id !== undefined ? room_id : before.room_id,
      day_of_week: day_of_week !== undefined ? day_of_week : before.day_of_week,
      start_time: newStart || normTime(before.start_time),
      end_time: newEnd || normTime(before.end_time),
    };
    if (merged.end_time <= merged.start_time) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }

    const conflict = await findRoomConflict(pool, {
      roomId: merged.room_id,
      day: merged.day_of_week,
      start: merged.start_time,
      end: merged.end_time,
      excludeSlotId: id,
    });
    if (conflict) {
      return res.status(409).json({
        error: `Room is already booked at this time (slot ${conflict.slot_id})`,
      });
    }

    const upd = await pool.query(
      `UPDATE timetable_slots
       SET room_id = $2, day_of_week = $3, start_time = $4, end_time = $5
       WHERE slot_id = $1
       RETURNING *`,
      [id, merged.room_id, merged.day_of_week, merged.start_time, merged.end_time]
    );
    await logAudit(pool, {
      actorUserId: req.user.userId,
      action: 'timetable_slot.update',
      entityId: id,
      before,
      after: upd.rows[0],
    });
    res.json(upd.rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'room_id does not exist' });
    }
    if (err.code === '22P02') {
      return res.status(400).json({ error: 'room_id must be a number' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// حذف موعد (ممنوع لو اتفتحت عليه جلسات قبل كده عشان سجل الحضور مايضيعش)
router.delete('/timetable-slots/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid slot id' });
  }
  try {
    const del = await pool.query('DELETE FROM timetable_slots WHERE slot_id = $1 RETURNING *', [id]);
    if (del.rows.length === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    await logAudit(pool, {
      actorUserId: req.user.userId,
      action: 'timetable_slot.delete',
      entityId: id,
      before: del.rows[0],
      after: null,
    });
    res.json({ deleted: true, slot_id: id });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({
        error: 'Cannot delete: attendance sessions already exist for this slot. Edit it instead.',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;