'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { queueSqliteSnapshot } = require('./mongodb');

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'school.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let db = new DatabaseSync(dbPath);

function configureDatabase() {
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
}

configureDatabase();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS school_info (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  name_hi TEXT,
  udise_code TEXT,
  address TEXT,
  block TEXT,
  district TEXT,
  state TEXT,
  board TEXT,
  medium TEXT,
  phone TEXT,
  email TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('headmaster','teacher','student','parent')),
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS teachers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_id TEXT UNIQUE,
  designation TEXT,
  qualification TEXT,
  joining_date TEXT
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT 'A',
  class_teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (name, section)
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT
);

CREATE TABLE IF NOT EXISTS class_subjects (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (class_id, subject_id)
);

CREATE TABLE IF NOT EXISTS students (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  admission_no TEXT NOT NULL UNIQUE,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  roll_no INTEGER,
  dob TEXT,
  gender TEXT CHECK (gender IN ('M','F','O')),
  category TEXT CHECK (category IN ('GEN','OBC','SC','ST','EWS')),
  apaar_id TEXT,
  aadhaar_last4 TEXT,
  is_cwsn INTEGER NOT NULL DEFAULT 0,
  is_bpl INTEGER NOT NULL DEFAULT 0,
  address TEXT
);

CREATE TABLE IF NOT EXISTS parent_student (
  parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relation TEXT,
  PRIMARY KEY (parent_id, student_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('P','A','L')),
  marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (student_id, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);

CREATE TABLE IF NOT EXISTS teacher_attendance (
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('P','A','L')),
  check_in_time TEXT,
  PRIMARY KEY (teacher_id, date)
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  max_marks INTEGER NOT NULL CHECK (max_marks > 0),
  exam_date TEXT,
  academic_year TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marks (
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  marks_obtained REAL NOT NULL,
  entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (exam_id, student_id, subject_id)
);

CREATE TABLE IF NOT EXISTS homework (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS timetable (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 6),
  period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 8),
  subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (class_id, day, period)
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('all','staff','students','parents','students_parents')),
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('holiday','exam','event','ptm','smc')),
  description TEXT
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS grievances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raised_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  raised_role TEXT NOT NULL,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  response TEXT,
  responded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS midday_meals (
  date TEXT PRIMARY KEY,
  menu TEXT NOT NULL,
  students_present INTEGER NOT NULL DEFAULT 0,
  meals_served INTEGER NOT NULL DEFAULT 0,
  quality_checked INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scholarships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheme_name TEXT NOT NULL,
  amount REAL,
  academic_year TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','verified','sanctioned','disbursed','rejected')),
  applied_on TEXT,
  remarks TEXT
);

CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  academic_year TEXT NOT NULL,
  distributed_on TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (student_id, item, academic_year)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Self-registrations wait here until the headmaster approves them; only then is a real user account created.
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('student','parent','teacher')),
  username TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_pending_username ON registrations(username) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`;

function applySchema() {
  db.exec(SCHEMA);
}

applySchema();

// Lightweight migrations: add newer columns to databases created by earlier versions.
const MIGRATIONS = {
  school_info: [['name_te', 'TEXT'], ['about', 'TEXT'], ['facilities', 'TEXT'], ['timings', 'TEXT'], ['photo', 'TEXT']],
};
function applyMigrations() {
  for (const [table, columns] of Object.entries(MIGRATIONS)) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const [name, type] of columns) {
      if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

applyMigrations();

// node:sqlite rejects undefined/boolean bind values, so normalise them.
function norm(params) {
  return params.map((p) => {
    if (p === undefined || p === '') return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

const one = (sql, ...params) => stmt(sql).get(...norm(params));
const all = (sql, ...params) => stmt(sql).all(...norm(params));
const run = (sql, ...params) => {
  const result = stmt(sql).run(...norm(params));
  queueSqliteSnapshot(dbPath);
  return result;
};

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    queueSqliteSnapshot(dbPath);
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function replaceDatabase(snapshot) {
  if (!snapshot) return;
  db.close();
  fs.writeFileSync(dbPath, snapshot);
  db = new DatabaseSync(dbPath);
  configureDatabase();
  cache.clear();
  applySchema();
  applyMigrations();
}

function audit(userId, action, details, ip) {
  run('INSERT INTO audit_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)', userId || null, action, details || null, ip || null);
}

// Uploaded files (school photo) live next to the database so a single folder backup covers everything.
const UPLOAD_DIR = path.join(path.dirname(dbPath), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

module.exports = { get db() { return db; }, one, all, run, tx, audit, dbPath, UPLOAD_DIR, replaceDatabase };
