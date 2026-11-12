'use strict';
/*
 * MongoDB data layer.
 *
 * Collections mirror the original tables and keep the same field names, so pages and templates are unchanged.
 * Records keep numeric `id` fields (generated from the `counters` collection) because ids appear in URLs
 * and are used as references between collections.
 *
 * `users` holds one flat document per person. Role-specific fields live on the same document:
 *   students: admission_no, class_id, roll_no, dob, gender, category, apaar_id, aadhaar_last4, is_cwsn, is_bpl, address
 *   teachers / headmaster: employee_id, designation, qualification, joining_date
 *
 * Dates are stored as 'YYYY-MM-DD' strings and timestamps as local 'YYYY-MM-DD HH:MM:SS' strings,
 * so range queries compare correctly as strings.
 *
 * Writes are designed to be safe without multi-document transactions (a standalone MongoDB server does not
 * support them): related data goes into one document where possible, and bulk saves use idempotent upserts.
 */
const { MongoClient } = require('mongodb');
const { nowLocal } = require('./utils');

const isProd = process.env.NODE_ENV === 'production';
const DEFAULT_URI = 'mongodb://127.0.0.1:27017';
const DEFAULT_DB = 'school_management';

let client = null;
let database = null;

function dbNameFromUri(uri) {
  try {
    const name = new URL(uri).pathname.replace(/^\//, '');
    return name || null;
  } catch {
    return null;
  }
}

function settings() {
  const uri = process.env.MONGODB_URI || (isProd ? null : DEFAULT_URI);
  if (!uri) throw new Error('MONGODB_URI must be set in production (see .env.example).');
  return { uri, dbName: process.env.MONGODB_DB || dbNameFromUri(uri) || DEFAULT_DB };
}

/** Host part of the URI without credentials, for log messages. */
function safeHost(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'MongoDB';
  }
}

// [keys, options] per collection. Unique indexes enforce what the old SQL constraints did.
const INDEXES = {
  counters: [],
  school_info: [[{ id: 1 }, { unique: true }]],
  users: [
    [{ id: 1 }, { unique: true }],
    [{ username: 1 }, { unique: true }],
    [{ admission_no: 1 }, { unique: true, partialFilterExpression: { admission_no: { $type: 'string' } } }],
    [{ employee_id: 1 }, { unique: true, partialFilterExpression: { employee_id: { $type: 'string' } } }],
    [{ role: 1, is_active: 1 }],
    [{ class_id: 1 }],
  ],
  classes: [[{ id: 1 }, { unique: true }], [{ name: 1, section: 1 }, { unique: true }], [{ class_teacher_id: 1 }]],
  subjects: [[{ id: 1 }, { unique: true }], [{ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } }]],
  class_subjects: [[{ class_id: 1, subject_id: 1 }, { unique: true }], [{ teacher_id: 1 }]],
  parent_student: [[{ parent_id: 1, student_id: 1 }, { unique: true }], [{ student_id: 1 }]],
  attendance: [[{ student_id: 1, date: 1 }, { unique: true }], [{ date: 1 }]],
  teacher_attendance: [[{ teacher_id: 1, date: 1 }, { unique: true }], [{ date: 1 }]],
  exams: [[{ id: 1 }, { unique: true }]],
  marks: [[{ exam_id: 1, student_id: 1, subject_id: 1 }, { unique: true }], [{ student_id: 1 }]],
  homework: [[{ id: 1 }, { unique: true }], [{ class_id: 1 }], [{ teacher_id: 1 }]],
  timetable: [[{ class_id: 1, day: 1, period: 1 }, { unique: true }], [{ teacher_id: 1, day: 1, period: 1 }]],
  notices: [[{ id: 1 }, { unique: true }], [{ created_at: -1 }]],
  events: [[{ id: 1 }, { unique: true }], [{ date: 1 }]],
  leave_requests: [[{ id: 1 }, { unique: true }], [{ student_id: 1 }]],
  grievances: [[{ id: 1 }, { unique: true }], [{ raised_by: 1 }]],
  midday_meals: [[{ date: 1 }, { unique: true }]],
  scholarships: [[{ id: 1 }, { unique: true }], [{ student_id: 1 }]],
  entitlements: [[{ id: 1 }, { unique: true }], [{ student_id: 1, item: 1, academic_year: 1 }, { unique: true }]],
  audit_log: [[{ id: 1 }, { unique: true }]],
  registrations: [
    [{ id: 1 }, { unique: true }],
    // Only one *pending* request per username (approved/rejected history may repeat).
    [{ username: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } }],
    [{ status: 1 }],
  ],
  sessions: [[{ sid: 1 }, { unique: true }], [{ expires: 1 }, { expireAfterSeconds: 0 }], [{ userId: 1 }]],
  files: [],
};
const COLLECTIONS = Object.keys(INDEXES);

async function ensureIndexes() {
  for (const [name, list] of Object.entries(INDEXES)) {
    for (const [keys, options] of list) await database.collection(name).createIndex(keys, options || {});
  }
}

/** Connects once and creates indexes. Safe to call repeatedly. */
async function connect() {
  if (database) return database;
  const { uri, dbName } = settings();
  client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
  } catch (err) {
    client = null;
    throw new Error(`Could not connect to MongoDB at ${safeHost(uri)}: ${err.message}`);
  }
  database = client.db(dbName);
  await ensureIndexes();
  return database;
}

async function close() {
  if (client) await client.close();
  client = null;
  database = null;
}

function col(name) {
  if (!database) throw new Error('MongoDB is not connected yet.');
  return database.collection(name);
}

function dbInfo() {
  const { uri, dbName } = settings();
  return { host: safeHost(uri), dbName };
}

/** Next numeric id for a collection (atomic, survives restarts). */
async function nextId(name) {
  const r = await col('counters').findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return r.seq;
}

/** Makes the next generated id larger than `value` (used after importing existing data). */
async function bumpCounter(name, value) {
  if (!value) return;
  await col('counters').updateOne({ _id: name }, { $max: { seq: value } }, { upsert: true });
}

/** Form values: empty strings and undefined become null, booleans become 1/0 (matches the old SQL behaviour). */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '') out[k] = null;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

/** Inserts a document with a fresh numeric id and returns the id. */
async function insertWithId(name, doc) {
  const id = await nextId(name);
  await col(name).insertOne({ id, ...doc });
  return id;
}

/** Name of the field that caused a duplicate-key error, or null for any other error. */
function dupKey(err) {
  if (!err || err.code !== 11000) return null;
  return Object.keys(err.keyPattern || err.keyValue || {})[0] || 'unknown';
}

/** Same order as the old `ORDER BY CAST(name AS INTEGER), name, section`. */
function classSort(a, b) {
  const an = a.class_name ?? a.name;
  const bn = b.class_name ?? b.name;
  return (parseInt(an, 10) || 0) - (parseInt(bn, 10) || 0)
    || String(an).localeCompare(String(bn))
    || String(a.section || '').localeCompare(String(b.section || ''));
}

async function audit(userId, action, details, ip) {
  await insertWithId('audit_log', { user_id: userId || null, action, details: details || null, ip: ip || null, created_at: nowLocal() });
}

/** Map of id -> document for the given ids (one query instead of one per row). */
async function byIds(name, ids, projection) {
  const unique = [...new Set(ids.filter((x) => x !== null && x !== undefined))];
  if (!unique.length) return new Map();
  const docs = await col(name).find({ id: { $in: unique } }, projection ? { projection } : {}).toArray();
  return new Map(docs.map((d) => [d.id, d]));
}

module.exports = {
  connect, close, col, dbInfo, nextId, bumpCounter, clean, insertWithId, dupKey, classSort, audit, byIds, COLLECTIONS,
};
