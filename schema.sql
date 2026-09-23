CREATE TABLE roles (
  role_id SERIAL PRIMARY KEY,
  role_name VARCHAR(50) UNIQUE NOT NULL
);

CREATE TABLE users (
  user_id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id INT NOT NULL REFERENCES roles(role_id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE departments (
  department_id SERIAL PRIMARY KEY,
  department_name VARCHAR(150) UNIQUE NOT NULL
);

CREATE TABLE student_profiles (
  student_id SERIAL PRIMARY KEY,
  user_id INT UNIQUE NOT NULL REFERENCES users(user_id),
  student_code VARCHAR(50) UNIQUE NOT NULL,
  student_name VARCHAR(150) NOT NULL,
  level INT,
  department_id INT REFERENCES departments(department_id)
);

CREATE TABLE staff_profiles (
  staff_id SERIAL PRIMARY KEY,
  user_id INT UNIQUE NOT NULL REFERENCES users(user_id),
  staff_name VARCHAR(150) NOT NULL,
  staff_type VARCHAR(20) NOT NULL CHECK (staff_type IN ('lecturer', 'TA')),
  department_id INT REFERENCES departments(department_id)
);

CREATE TABLE courses (
  course_id SERIAL PRIMARY KEY,
  course_code VARCHAR(30) UNIQUE NOT NULL,
  course_name VARCHAR(200) NOT NULL,
  department_id INT REFERENCES departments(department_id)
);

CREATE TABLE sections (
  section_id SERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(course_id),
  section_name VARCHAR(50) NOT NULL,
  semester VARCHAR(50) NOT NULL,
  capacity INT
);

CREATE TABLE section_staff (
  section_id INT NOT NULL REFERENCES sections(section_id),
  staff_id INT NOT NULL REFERENCES staff_profiles(staff_id),
  staff_role VARCHAR(30) NOT NULL,
  PRIMARY KEY (section_id, staff_id)
);

CREATE TABLE enrollments (
  enrollment_id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES student_profiles(student_id),
  section_id INT NOT NULL REFERENCES sections(section_id),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  enrolled_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, section_id)
);

CREATE TABLE rooms (
  room_id SERIAL PRIMARY KEY,
  room_name VARCHAR(100) NOT NULL,
  building VARCHAR(100),
  room_type VARCHAR(20) NOT NULL CHECK (room_type IN ('lecture', 'lab')),
  capacity INT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION
);

CREATE TABLE timetable_slots (
  slot_id SERIAL PRIMARY KEY,
  section_id INT NOT NULL REFERENCES sections(section_id),
  room_id INT NOT NULL REFERENCES rooms(room_id),
  day_of_week VARCHAR(10) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CHECK (end_time > start_time)
);

CREATE TABLE attendance_sessions (
  session_id SERIAL PRIMARY KEY,
  slot_id INT NOT NULL REFERENCES timetable_slots(slot_id),
  session_date DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by INT NOT NULL REFERENCES staff_profiles(staff_id),
  opened_at TIMESTAMP NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP,
  qr_secret VARCHAR(255) NOT NULL,
  qr_secret_version INT NOT NULL DEFAULT 1,
  UNIQUE (slot_id, session_date)
);

CREATE TABLE attendance (
  attendance_id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES student_profiles(student_id),
  session_id INT NOT NULL REFERENCES attendance_sessions(session_id),
  attendance_timestamp TIMESTAMP,
  source VARCHAR(10) NOT NULL DEFAULT 'qr' CHECK (source IN ('qr', 'manual')),
  validation_result VARCHAR(50),
  attendance_status VARCHAR(10) NOT NULL DEFAULT 'absent'
    CHECK (attendance_status IN ('present', 'absent', 'late', 'excused')),
  minutes_late INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by INT REFERENCES users(user_id),
  UNIQUE (student_id, session_id)
);

CREATE TABLE correction_requests (
  request_id SERIAL PRIMARY KEY,
  attendance_id INT NOT NULL REFERENCES attendance(attendance_id),
  student_id INT NOT NULL REFERENCES student_profiles(student_id),
  requested_status VARCHAR(10) NOT NULL,
  reason TEXT NOT NULL,
  evidence_url VARCHAR(500),
  status VARCHAR(10) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_id INT REFERENCES staff_profiles(staff_id),
  review_reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMP
);

CREATE TABLE audit_events (
  audit_id SERIAL PRIMARY KEY,
  actor_user_id INT NOT NULL REFERENCES users(user_id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INT,
  before_hash VARCHAR(128),
  after_hash VARCHAR(128),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attendance_session ON attendance(session_id);
CREATE INDEX idx_timetable_section_day ON timetable_slots(section_id, day_of_week);

INSERT INTO roles (role_name) VALUES ('student'), ('lecturer'), ('ta'), ('admin'), ('auditor');
ALTER TABLE audit_events ADD COLUMN details JSONB;

CREATE UNIQUE INDEX one_pending_request_per_attendance
ON correction_requests (attendance_id) WHERE status = 'pending';