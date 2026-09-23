const express = require('express');
const bcrypt = require('bcryptjs');
const { parse } = require('csv-parse/sync');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUIRED_COLUMNS = ['student_code', 'student_name', 'email'];
const MAX_ROWS = 1000;

// POST /admin/imports/students?section_id=1&default_password=...&department_id=1
router.post(
  '/imports/students',
  express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }),
  async (req, res) => {
    if (typeof req.body !== 'string' || !req.body.trim()) {
      return res.status(400).json({ error: 'Send the CSV as the request body with Content-Type: text/csv' });
    }

    const defaultPassword = String(req.query.default_password || '');
    if (defaultPassword.length < 8) {
      return res.status(400).json({ error: 'default_password is required (at least 8 characters)' });
    }

    let sectionId = null;
    if (req.query.section_id !== undefined) {
      sectionId = Number(req.query.section_id);
      if (!Number.isInteger(sectionId)) {
        return res.status(400).json({ error: 'section_id must be a number' });
      }
    }

    let departmentId = null;
    if (req.query.department_id !== undefined) {
      departmentId = Number(req.query.department_id);
      if (!Number.isInteger(departmentId)) {
        return res.status(400).json({ error: 'department_id must be a number' });
      }
    }

    // قراءة الملف
    let records;
    try {
      records = parse(req.body, {
        columns: (header) => header.map((h) => h.trim().toLowerCase()),
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } catch (err) {
      return res.status(400).json({ error: `Invalid CSV: ${err.message}` });
    }

    if (records.length === 0) {
      return res.status(400).json({ error: 'The CSV has no data rows' });
    }
    if (records.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (maximum ${MAX_ROWS})` });
    }
    const missing = REQUIRED_COLUMNS.filter((c) => !(c in records[0]));
    if (missing.length) {
      return res.status(400).json({ error: `Missing column(s): ${missing.join(', ')}` });
    }

    try {
      // التأكد من الشعبة والقسم قبل ما نبدأ
      if (sectionId !== null) {
        const s = await pool.query('SELECT 1 FROM sections WHERE section_id = $1', [sectionId]);
        if (s.rows.length === 0) {
          return res.status(400).json({ error: 'section_id does not exist' });
        }
      }
      if (departmentId !== null) {
        const d = await pool.query('SELECT 1 FROM departments WHERE department_id = $1', [departmentId]);
        if (d.rows.length === 0) {
          return res.status(400).json({ error: 'department_id does not exist' });
        }
      }

      const role = await pool.query("SELECT role_id FROM roles WHERE role_name = 'student'");
      const roleId = role.rows[0].role_id;

      // باسورد مؤقت واحد لكل الطلبة (للبيانات التجريبية فقط)
      const passwordHash = await bcrypt.hash(defaultPassword, 10);

      const seenCodes = new Set();
      const seenEmails = new Set();
      const rejected = [];
      let created = 0;

      for (let i = 0; i < records.length; i++) {
        const rowNumber = i + 2; // السطر 1 هو العناوين
        const r = records[i];
        const code = (r.student_code || '').trim();
        const name = (r.student_name || '').trim();
        const email = (r.email || '').trim().toLowerCase();
        const levelRaw = (r.level || '').trim();

        let reason = null;
        if (!code || !name || !email) {
          reason = 'missing student_code, student_name or email';
        } else if (!EMAIL_RE.test(email)) {
          reason = 'invalid email';
        } else if (levelRaw && (!/^\d+$/.test(levelRaw) || Number(levelRaw) < 1 || Number(levelRaw) > 8)) {
          reason = 'level must be a number from 1 to 8';
        } else if (seenCodes.has(code) || seenEmails.has(email)) {
          reason = 'duplicate inside the file';
        }

        if (reason) {
          rejected.push({ row: rowNumber, student_code: code || null, reason });
          continue;
        }
        seenCodes.add(code);
        seenEmails.add(email);

        // كل طالب في transaction لوحده: صف غلط مايوقفش الباقي
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const u = await client.query(
            'INSERT INTO users (email, password_hash, role_id) VALUES ($1, $2, $3) RETURNING user_id',
            [email, passwordHash, roleId]
          );
          const sp = await client.query(
            `INSERT INTO student_profiles (user_id, student_code, student_name, level, department_id)
             VALUES ($1, $2, $3, $4, $5) RETURNING student_id`,
            [u.rows[0].user_id, code, name, levelRaw ? Number(levelRaw) : null, departmentId]
          );
          if (sectionId !== null) {
            await client.query(
              'INSERT INTO enrollments (student_id, section_id) VALUES ($1, $2)',
              [sp.rows[0].student_id, sectionId]
            );
          }
          await client.query('COMMIT');
          created++;
        } catch (err) {
          await client.query('ROLLBACK');
          if (err.code === '23505') {
            rejected.push({ row: rowNumber, student_code: code, reason: 'email or student_code already exists' });
          } else {
            console.error(err);
            rejected.push({ row: rowNumber, student_code: code, reason: 'database error' });
          }
        } finally {
          client.release();
        }
      }

      // تسجيل الاستيراد في الـ audit
      await pool.query(
        `INSERT INTO audit_events (actor_user_id, action, entity_type, details)
         VALUES ($1, 'import.students', 'import', $2)`,
        [
          req.user.userId,
          JSON.stringify({ section_id: sectionId, total: records.length, created, rejected: rejected.length }),
        ]
      );

      res.json({
        total: records.length,
        created,
        rejected: rejected.length,
        rejected_rows: rejected,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;