# Smart Attendance & Classroom Verification: Backend (ATT)

Node.js + Express + PostgreSQL backend for the Smart Attendance project.
All data is synthetic. No real student or staff records are used.

## Features (MVP)
- Password login with role-based access (student, lecturer, ta, admin, auditor)
- Course, section, enrollment, room and timetable management, plus CSV student import with a rejection report
- Scheduled attendance sessions with a rotating signed QR token (20 seconds)
- QR scan: idempotent (a second scan never creates a duplicate) and rate limited
- Live roster and manual corrections with a mandatory reason
- Student correction requests (pending, approved, rejected)
- Reports with filters and CSV export
- Rule-based attendance flags (advisory only, they never change attendance)
- Audit log for manual changes, approvals, imports and exports (read-only for the auditor)

## Requirements
- Node.js 20 or newer
- PostgreSQL 16 or newer

## Setup
1. Install the dependencies:
```
   npm install
```
2. Create the environment file and fill in your own values:
```
   copy .env.example .env
```
3. Create an empty database named `attendance_db` in PostgreSQL, then run `schema.sql` against it (pgAdmin Query Tool, or `psql -d attendance_db -f schema.sql`).
4. Create the demo admin and auditor accounts:
```
   node seed-admin.js
   node seed-auditor.js
```
5. Start the server:
```
   node index.js
```
   The API runs on http://localhost:3000. Check it with `GET /health`.

## Environment variables
| Variable | Purpose |
|---|---|
| DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD | PostgreSQL connection |
| JWT_SECRET | Secret used to sign login tokens. Never commit it. |

## Demo accounts (synthetic)
| Role | Email | Password | Created by |
|---|---|---|---|
| admin | admin@test.com | Admin@123 | `node seed-admin.js` |
| auditor | auditor@test.com | Auditor@123 | `node seed-auditor.js` |

Lecturers, TAs and students are created by the admin through the API
(`POST /admin/staff`, `POST /admin/students`, or the CSV import `POST /admin/imports/students`).

## API contract
The full contract is in `openapi.yaml`. Open it in https://editor.swagger.io to browse it.
Send the login token as `Authorization: Bearer <token>` on every request.

## Notes
- Authorization is enforced on the backend for every endpoint.
- Attendance flags are advisory only and can be unavailable without blocking attendance capture.