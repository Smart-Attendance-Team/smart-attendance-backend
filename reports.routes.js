const express = require('express');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'auditor', 'lecturer', 'ta'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// بيقرا الفلاتر من الرابط ويتأكد إنها سليمة
function parseFilters(query) {
  const filters = {};
  const errors = [];

  if (query.course_code) filters.course_code = String(query.course_code).trim();
  if (query.student_code) filters.student_code = String(query.student_code).trim();

  for (const key of ['section_id', 'staff_id']) {
    if (query[key] !== undefined && query[key] !== '') {
      const n = Number(query[key]);
      if (!Number.isInteger(n)) errors.push(`${key} must be a number`);
      else filters[key] = n;
    }
  }

  for (const key of ['from', 'to']) {
    if (query[key]) {
      if (!DATE_RE.test(query[key])) errors.push(`${key} must be YYYY-MM-DD`);
      else filters[key] = query[key];
    }
  }

  return { filters, errors };
}

// بيجيب السجلات حسب الفلاتر
async function fetchRows(filters, user) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (filters.course_code) add('c.course_code = ?', filters.course_code);
  if (filters.section_id !== undefined) add('sec.section_id = ?', filters.section_id);
  if (filters.student_code) add('sp.student_code = ?', filters.student_code);
  if (filters.staff_id !== undefined) {
    add(
      `EXISTS (SELECT 1 FROM section_staff x
               WHERE x.section_id = sec.section_id AND x.staff_id = ?)`,
      filters.staff_id
    );
  }
  if (filters.from) add('s.session_date >= ?::date', filters.from);
  if (filters.to) add('s.session_date <= ?::date', filters.to);

  // الدكتور/المعيد يشوف شُعَبه هو بس
  if (user.role === 'lecturer' || user.role === 'ta') {
    add(
      `EXISTS (SELECT 1 FROM section_staff y
               JOIN staff_profiles yp ON yp.staff_id = y.staff_id
               WHERE y.section_id = sec.section_id AND yp.user_id = ?)`,
      user.userId
    );
  }

  const sql = `
    SELECT c.course_code, c.course_name, sec.section_name,
           to_char(s.session_date, 'YYYY-MM-DD') AS session_date,
           sp.student_code, sp.student_name,
           a.attendance_status, a.minutes_late, a.source
    FROM attendance a
    JOIN student_profiles sp ON sp.student_id = a.student_id
    JOIN attendance_sessions s ON s.session_id = a.session_id
    JOIN timetable_slots ts ON ts.slot_id = s.slot_id
    JOIN sections sec ON sec.section_id = ts.section_id
    JOIN courses c ON c.course_id = sec.course_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.session_date, c.course_code, sec.section_name, sp.student_code`;

  const result = await pool.query(sql, params);
  return result.rows;
}

// ملخص الأرقام (بيتحسب من نفس السجلات، فبيطابقها دايماً)
function summarize(rows) {
  const count = (s) => rows.filter((r) => r.attendance_status === s).length;
  const total = rows.length;
  const present = count('present');
  const late = count('late');
  const excused = count('excused');
  const absent = count('absent');
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    total,
    present,
    late,
    excused,
    absent,
    attendance_rate_percent: pct(present + late),
    late_rate_percent: pct(late),
  };
}

const CSV_COLUMNS = [
  'course_code', 'course_name', 'section_name', 'session_date',
  'student_code', 'student_name', 'attendance_status', 'minutes_late', 'source',
];

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // حماية من CSV injection لو الخلية بتبدأ بـ = أو + أو - أو @
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
  }
  // \uFEFF عشان Excel يقرا الحروف العربية صح
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function handleError(err, res) {
  if (err.code === '22008' || err.code === '22007') {
    return res.status(400).json({ error: 'Invalid date value' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
}

// التقرير (JSON)
router.get('/attendance', async (req, res) => {
  const { filters, errors } = parseFilters(req.query);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  try {
    const rows = await fetchRows(filters, req.user);
    res.json({ filters, summary: summarize(rows), rows });
  } catch (err) {
    handleError(err, res);
  }
});

// التصدير (CSV) بنفس الفلاتر
router.get('/attendance/export', async (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase();
  if (format !== 'csv') {
    return res.status(400).json({ error: 'Only format=csv is available for now' });
  }

  const { filters, errors } = parseFilters(req.query);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  try {
    const rows = await fetchRows(filters, req.user);

    // تسجيل التصدير في الـ audit
    await pool.query(
      `INSERT INTO audit_events (actor_user_id, action, entity_type, details)
       VALUES ($1, 'report.export.csv', 'report', $2)`,
      [req.user.userId, JSON.stringify({ filters, row_count: rows.length })]
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-report.csv"');
    res.send(toCsv(rows));
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;