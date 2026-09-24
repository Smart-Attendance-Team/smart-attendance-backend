const express = require('express');
const cors = require('cors');
const pool = require('./db');
const authRoutes = require('./auth.routes');
const adminRoutes = require('./admin.routes');
const peopleRoutes = require('./people.routes');
const timetableRoutes = require('./timetable.routes');
const importRoutes = require('./import.routes');
const sessionRoutes = require('./session.routes');
const rosterRoutes = require('./roster.routes');
const attendanceRoutes = require('./attendance.routes');
const correctionRoutes = require('./corrections.routes');
const reportRoutes = require('./reports.routes');
const auditRoutes = require('./audit.routes');
const flagsRoutes = require('./flags.routes');
const studentsRoutes = require('./students.routes');
const staffRoutes = require('./staff.routes');
const { requireAuth, requireRole } = require('./auth.middleware');

const app = express();

const allowedOrigins = (
  process.env.CORS_ORIGIN ||
  'http://localhost:3001,http://localhost:3002'
)
  .split(',')
  .map((o) => o.trim());

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/db-check', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ db: 'connected', time: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ db: 'error', message: err.message });
  }
});

app.use('/auth', authRoutes);

app.get('/me', requireAuth, (req, res) => {
  res.json({ userId: req.user.userId, role: req.user.role });
});

app.get('/admin/ping', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ message: 'Welcome, admin' });
});

app.use('/admin', adminRoutes);
app.use('/admin', peopleRoutes);
app.use('/admin', timetableRoutes);
app.use('/admin', importRoutes);
app.use('/sessions', sessionRoutes);
app.use('/sessions', rosterRoutes);
app.use('/attendance', attendanceRoutes);
app.use('/students', studentsRoutes);
app.use('/staff', staffRoutes);
app.use('/corrections', correctionRoutes);
app.use('/reports', reportRoutes);
app.use('/audit-events', auditRoutes);
app.use('/flags', flagsRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, (err) => {
  if (err) {
    console.error('Could not start the server:', err.message);
    process.exit(1);
  }

  console.log(`Server running on http://localhost:${PORT}`);
});