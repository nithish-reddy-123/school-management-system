'use strict';
/*
 * One-time import of the old SQLite database (data/school.db) into MongoDB.
 *
 *   npm run migrate:sqlite              imports into an empty MongoDB database
 *   npm run migrate:sqlite -- --force   first DELETES this app's collections in the configured MongoDB database
 *
 * Options: --file=<path to .db>  (default: DB_PATH or data/school.db)
 *
 * The SQLite file is copied to a temporary folder and read from the copy, so the original is never modified.
 * Ids are kept, so links between records stay the same. Student and teacher profile rows are merged into
 * their user documents. Old login sessions are not imported (everyone signs in again once).
 */
require('dotenv').config({ quiet: true });
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { Binary } = require('mongodb');
const { connect, close, col, dbInfo, bumpCounter, COLLECTIONS } = require('./db');

const args = process.argv.slice(2);
const force = args.includes('--force');
const fileArg = (args.find((a) => a.startsWith('--file=')) || '').slice(7);
const sourcePath = path.resolve(fileArg || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'school.db'));

// Tables copied as they are; `true` means the table has a numeric id that the counters must continue from.
const TABLES = {
  classes: true, subjects: true, class_subjects: false, parent_student: false, attendance: false, teacher_attendance: false,
  exams: true, marks: false, homework: true, timetable: false, notices: true, events: true, leave_requests: true,
  grievances: true, midday_meals: false, scholarships: true, entitlements: true, audit_log: true, registrations: true,
};
const PHOTO_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Opens a temporary copy of the SQLite database (including its -wal file, which may hold recent changes). */
function openCopy(file) {
  if (!fs.existsSync(file)) throw new Error(`SQLite database not found: ${file}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-migrate-'));
  const copy = path.join(dir, 'school.db');
  fs.copyFileSync(file, copy);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
  return { db: new DatabaseSync(copy), dir };
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Rows as plain objects (node:sqlite returns null-prototype objects). */
function rows(db, table) {
  return tableExists(db, table) ? db.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r })) : [];
}

const blankToNull = (v) => (v === '' || v === undefined ? null : v);

function buildUsers(db) {
  const students = new Map(rows(db, 'students').map((s) => [s.user_id, s]));
  const teachers = new Map(rows(db, 'teachers').map((t) => [t.user_id, t]));
  return rows(db, 'users').map((u) => {
    const doc = { ...u, username: String(u.username).toLowerCase() };
    const extra = students.get(u.id) || teachers.get(u.id);
    if (extra) {
      const { user_id: _ignored, ...fields } = extra;
      Object.assign(doc, fields);
    }
    // Unique fields: blank values become null so they do not clash with each other.
    if ('admission_no' in doc) doc.admission_no = blankToNull(doc.admission_no);
    if ('employee_id' in doc) doc.employee_id = blankToNull(doc.employee_id);
    return doc;
  });
}

async function importPhoto(school, sourceDir) {
  if (!school || !school.photo) return false;
  const file = path.join(sourceDir, 'uploads', path.basename(school.photo));
  if (!fs.existsSync(file)) {
    school.photo = null;
    return false;
  }
  const data = fs.readFileSync(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  await col('files').replaceOne(
    { _id: 'school-photo' },
    { _id: 'school-photo', data: new Binary(data), contentType: PHOTO_MIME[ext] || 'application/octet-stream', size: data.length, updated_at: null },
    { upsert: true },
  );
  return true;
}

async function main() {
  const { host, dbName } = dbInfo();
  const mongo = await connect();
  if ((await col('users').findOne({})) && !force) {
    console.error(`The MongoDB database "${dbName}" on ${host} already has users. Nothing was imported.`);
    console.error('Use --force to DELETE this app\'s collections in that database and import again.');
    process.exitCode = 1;
    return;
  }
  const { db, dir } = openCopy(sourcePath);
  try {
    if (force) {
      const existing = new Set((await mongo.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
      for (const name of COLLECTIONS) if (existing.has(name)) await mongo.collection(name).drop();
      await close();
      await connect(); // recreates the indexes
    }
    const report = [];

    const school = rows(db, 'school_info').find((s) => s.id === 1) || null;
    const photo = await importPhoto(school, path.dirname(sourcePath));
    if (school) await col('school_info').replaceOne({ id: 1 }, school, { upsert: true });
    report.push(['school_info', school ? 1 : 0], ['files (school photo)', photo ? 1 : 0]);

    const users = buildUsers(db);
    if (users.length) await col('users').insertMany(users, { ordered: true });
    await bumpCounter('users', Math.max(0, ...users.map((u) => u.id)));
    report.push(['users (with student/teacher details)', users.length]);

    for (const [table, hasId] of Object.entries(TABLES)) {
      let list = rows(db, table);
      if (table === 'attendance') list = list.map(({ id: _id, ...r }) => r); // unique by (student_id, date)
      if (list.length) await col(table).insertMany(list, { ordered: true });
      if (hasId) await bumpCounter(table, Math.max(0, ...list.map((r) => r.id)));
      report.push([table, list.length]);
    }

    console.log(`Imported ${sourcePath}\n   into MongoDB database "${dbName}" on ${host}:`);
    for (const [name, n] of report) console.log(`  ${name.padEnd(40)} ${n}`);
    console.log('Old login sessions were not imported; users sign in again once.');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .catch((err) => {
    console.error(`Migration failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => close());
