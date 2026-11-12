'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Binary } = require('mongodb');
const { col, clean, nextId, insertWithId, dupKey, classSort, audit, byIds } = require('../db');
const { destroyUserSessions } = require('../sessionStore');
const { requireRole, verifyCsrf, csrfFailed } = require('../middleware/auth');
const A = require('../services/academics');
const { PHOTO_ID } = require('./common');
const {
  str, toInt, isValidDate, localDate, localTime, nowLocal, academicYear, generatePassword, csvEscape, percent,
  monthParam, dayOfWeek, CATEGORIES, GENDERS, DAYS, PERIODS,
} = require('../utils');

const router = express.Router();
router.use(requireRole('headmaster'));

const ROLES = ['student', 'teacher', 'parent', 'headmaster'];
const STAFF = { $in: ['teacher', 'headmaster'] };
const SCHEMES = [
  'Pre-Matric Scholarship for SC Students',
  'Pre-Matric Scholarship for ST Students',
  'Pre-Matric Scholarship for OBC Students',
  'Pre-Matric Scholarship for Minorities',
  'Pre-Matric Scholarship for Students with Disabilities',
  'National Means-cum-Merit Scholarship (NMMSS)',
  'State Merit Scholarship',
];
const SCHOLARSHIP_STATUS = ['applied', 'verified', 'sanctioned', 'disbursed', 'rejected'];
const ITEMS = ['Free Textbooks', 'School Uniform', 'School Bag', 'Shoes & Socks', 'Workbooks & Stationery', 'Bicycle'];
const TEACHER_FIELDS = ['employee_id', 'designation', 'qualification', 'joining_date'];

/** Case-insensitive "contains" match for search boxes (user input is escaped, so it is never treated as a pattern). */
function containsRx(q) {
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/** Copies the named fields, using null for missing ones (templates expect every column to exist). */
function pick(doc, fields) {
  return Object.fromEntries(fields.map((f) => [f, doc[f] ?? null]));
}

const byName = (a, b) => String(a.full_name).localeCompare(String(b.full_name));

async function isHoliday(date) {
  return dayOfWeek(date) === 0 || !!(await col('events').findOne({ type: 'holiday', date }));
}

async function activeStudentIds(extra = {}) {
  return col('users').distinct('id', { role: 'student', is_active: 1, ...extra });
}

async function studentByAdmission(admissionNo) {
  if (!admissionNo) return null;
  return col('users').findOne({ role: 'student', admission_no: admissionNo }, { projection: { _id: 0, id: 1, full_name: 1 } });
}

/** Counts per value of `field` for active students, as [{ k, n }]. */
async function studentGroups(field) {
  const rows = await col('users').aggregate([
    { $match: { role: 'student', is_active: 1 } },
    { $group: { _id: { $ifNull: [`$${field}`, null] }, n: { $sum: 1 } } },
  ]).toArray();
  return rows.map((r) => ({ k: r._id, n: r.n }));
}

/* ---------------- Dashboard ---------------- */

async function dashboard(req, res) {
  const today = localDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  const users = col('users');
  const [students, teachers, parents, classCount, openGrievances, pendingScholarships, pendingLeaves] = await Promise.all([
    users.countDocuments({ role: 'student', is_active: 1 }),
    users.countDocuments({ role: 'teacher', is_active: 1 }),
    users.countDocuments({ role: 'parent', is_active: 1 }),
    col('classes').countDocuments(),
    col('grievances').countDocuments({ status: { $ne: 'resolved' } }),
    col('scholarships').countDocuments({ status: { $in: ['applied', 'verified'] } }),
    col('leave_requests').countDocuments({ status: 'pending' }),
  ]);
  const counts = { students, teachers, parents, classes: classCount, open_grievances: openGrievances, pending_scholarships: pendingScholarships, pending_leaves: pendingLeaves };

  const activeIds = await activeStudentIds();
  const activeStaff = await users.distinct('id', { role: STAFF, is_active: 1 });
  const [attTotal, attPresent, staffPresent] = await Promise.all([
    col('attendance').countDocuments({ date: today, student_id: { $in: activeIds } }),
    col('attendance').countDocuments({ date: today, student_id: { $in: activeIds }, status: 'P' }),
    col('teacher_attendance').countDocuments({ date: today, teacher_id: { $in: activeStaff }, status: 'P' }),
  ]);
  const staff = { present: staffPresent, total: activeStaff.length };

  // Every student's class, to work out per-class figures without one query per class.
  const studentRows = await users.find({ role: 'student' }, { projection: { _id: 0, id: 1, class_id: 1, is_active: 1 } }).toArray();
  const classOf = new Map(studentRows.map((s) => [s.id, s.class_id ?? null]));
  const classesWithActive = new Set(studentRows.filter((s) => s.is_active && s.class_id).map((s) => s.class_id));
  const markedToday = new Set((await col('attendance').distinct('student_id', { date: today })).map((id) => classOf.get(id)));
  const monthly = await col('attendance').aggregate([
    { $match: { date: { $gte: monthStart } } },
    { $group: { _id: '$student_id', total: { $sum: 1 }, present: { $sum: { $cond: [{ $eq: ['$status', 'P'] }, 1, 0] } } } },
  ]).toArray();
  const perClass = new Map();
  for (const r of monthly) {
    const cid = classOf.get(r._id);
    if (!cid) continue;
    const c = perClass.get(cid) || { total: 0, present: 0 };
    c.total += r.total;
    c.present += r.present;
    perClass.set(cid, c);
  }

  const classes = (await col('classes').find({}, { projection: { _id: 0 } }).toArray()).sort(classSort);
  const teacherNames = await byIds('users', classes.map((c) => c.class_teacher_id), { id: 1, full_name: 1 });
  const unmarked = classes.filter((c) => classesWithActive.has(c.id) && !markedToday.has(c.id)).map((c) => ({
    id: c.id, name: c.name, section: c.section, class_teacher_name: (teacherNames.get(c.class_teacher_id) || {}).full_name || null,
  }));
  const classAttendance = classes.map((c) => {
    const s = perClass.get(c.id) || { total: 0, present: 0 };
    return { id: c.id, name: c.name, section: c.section, total: s.total, present: s.present, percent: percent(s.present, s.total) };
  });

  const [gender, category, holiday, mdmToday, lowAttendance, notices, events] = await Promise.all([
    studentGroups('gender'),
    studentGroups('category'),
    isHoliday(today),
    col('midday_meals').findOne({ date: today }, { projection: { _id: 0 } }),
    A.lowAttendance(),
    A.noticesFor(req.user, 5),
    A.upcomingEvents(5),
  ]);
  res.render('headmaster/dashboard', {
    title: 'Headmaster Dashboard',
    today, counts, staff, unmarked, gender, category, classAttendance,
    att: { total: attTotal, present: attPresent, percent: percent(attPresent, attTotal) },
    holiday, mdmToday,
    lowAttendance: lowAttendance.slice(0, 10),
    notices, events,
    CATEGORIES, GENDERS,
  });
}

/* ---------------- School profile ---------------- */

router.get('/school', (req, res) => {
  res.render('headmaster/school', { title: 'School Profile' });
});

router.post('/school', async (req, res) => {
  const f = (k, max = 200) => str(req.body[k], max);
  const name = f('name');
  if (!name) {
    req.flash('error', 'School name is required.');
    return res.redirect('/hm/school');
  }
  const udise = f('udise_code', 11);
  if (udise && !/^\d{11}$/.test(udise)) {
    req.flash('error', 'UDISE+ code must be 11 digits.');
    return res.redirect('/hm/school');
  }
  await col('school_info').updateOne({ id: 1 }, {
    $set: {
      name, name_hi: f('name_hi'), name_te: f('name_te'), udise_code: udise, address: f('address', 500), block: f('block'),
      district: f('district'), state: f('state'), board: f('board'), medium: f('medium'), phone: f('phone', 20), email: f('email'),
      timings: f('timings', 120), about: f('about', 2000), facilities: f('facilities', 2000),
    },
  }, { upsert: true });
  await audit(req.user.id, 'school_profile_updated', null, req.ip);
  req.flash('success', 'School profile updated.');
  res.redirect('/hm/school');
});

/* School photo shown on the public landing page. Kept in memory, checked by file signature, then stored in MongoDB. */
const PHOTO_TYPES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
// 3 MB keeps the photo well inside MongoDB's 16 MB document limit.
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 5 } }).single('photo');

router.post('/school/photo', (req, res, next) => {
  photoUpload(req, res, async (err) => {
    try {
      if (!verifyCsrf(req)) return csrfFailed(res);
      if (err) {
        req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'The photo must be smaller than 3 MB.' : 'Upload failed. Please try again.');
        return res.redirect('/hm/school');
      }
      const type = req.file && PHOTO_TYPES.find((t) => req.file.buffer.length > 12 && t.test(req.file.buffer));
      if (!type) {
        req.flash('error', 'Please choose a JPG, PNG or WebP image.');
        return res.redirect('/hm/school');
      }
      await col('files').replaceOne(
        { _id: PHOTO_ID },
        { _id: PHOTO_ID, data: new Binary(req.file.buffer), contentType: type.mime, size: req.file.buffer.length, updated_at: nowLocal() },
        { upsert: true },
      );
      await col('school_info').updateOne({ id: 1 }, { $set: { photo: `school-photo.${type.ext}` } });
      await audit(req.user.id, 'school_photo_updated', null, req.ip);
      req.flash('success', 'School photo updated. It now appears on the home page.');
      res.redirect('/hm/school');
    } catch (e) {
      next(e);
    }
  });
});

router.post('/school/photo/delete', async (req, res) => {
  await col('files').deleteOne({ _id: PHOTO_ID });
  await col('school_info').updateOne({ id: 1 }, { $set: { photo: null } });
  req.flash('success', 'School photo removed. The home page shows the default illustration.');
  res.redirect('/hm/school');
});

/* ---------------- Users ---------------- */

const LIST_FIELDS = ['id', 'username', 'full_name', 'phone', 'is_active', 'last_login'];

router.get('/users', async (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : 'student';
  const q = str(req.query.q, 50);
  const classId = toInt(req.query.class_id);
  const rx = q ? containsRx(q) : null;
  let users;
  if (role === 'student') {
    const filter = { role: 'student' };
    if (classId) filter.class_id = classId;
    if (rx) filter.$or = [{ full_name: rx }, { username: rx }, { admission_no: rx }];
    const docs = await col('users').find(filter, { projection: { _id: 0, password_hash: 0 } }).toArray();
    const classes = await byIds('classes', docs.map((d) => d.class_id));
    users = docs.map((d) => {
      const c = classes.get(d.class_id);
      return { ...pick(d, [...LIST_FIELDS, 'admission_no', 'roll_no']), class_name: c ? c.name : null, section: c ? c.section : null };
    }).sort((a, b) => {
      // Students without a class first (as SQL sorts NULL first), then class order, roll number, name.
      if (!a.class_name || !b.class_name) return (a.class_name ? 1 : 0) - (b.class_name ? 1 : 0) || A.byRollThenName(a, b);
      return classSort(a, b) || A.byRollThenName(a, b);
    }).slice(0, 500);
  } else if (role === 'parent') {
    const filter = { role: 'parent' };
    if (rx) filter.$or = [{ full_name: rx }, { username: rx }, { phone: rx }];
    const docs = (await col('users').find(filter, { projection: { _id: 0, password_hash: 0 } }).toArray()).sort(byName).slice(0, 500);
    const links = await col('parent_student').find({ parent_id: { $in: docs.map((d) => d.id) } }).toArray();
    const kids = await byIds('users', links.map((l) => l.student_id), { id: 1, full_name: 1 });
    users = docs.map((d) => {
      const names = links.filter((l) => l.parent_id === d.id && kids.has(l.student_id)).map((l) => kids.get(l.student_id).full_name);
      return { ...pick(d, LIST_FIELDS), children: names.length ? names.join(', ') : null };
    });
  } else {
    const filter = { role };
    if (rx) filter.$or = [{ full_name: rx }, { username: rx }, { employee_id: rx }];
    const docs = await col('users').find(filter, { projection: { _id: 0, password_hash: 0 } }).toArray();
    users = docs.sort(byName).slice(0, 500).map((d) => pick(d, [...LIST_FIELDS, 'employee_id', 'designation']));
  }
  res.render('headmaster/users', { title: 'Users', role, users, q, classId, classes: await A.allClasses(), ROLES });
});

function emptyUser(role) {
  return { role, username: '', full_name: '', phone: '', email: '', admission_no: '', class_id: '', roll_no: '', dob: '', gender: '', category: '', apaar_id: '', aadhaar_last4: '', is_cwsn: 0, is_bpl: 0, address: '', employee_id: '', designation: '', qualification: '', joining_date: '', children: '', relation: '' };
}

async function renderUserForm(res, v, error, isEdit) {
  res.status(error ? 400 : 200).render('headmaster/user_form', {
    title: isEdit ? 'Edit User' : 'Add User', v, error, isEdit, classes: await A.allClasses(), CATEGORIES, GENDERS,
  });
}

/** Reads and validates the user form. Returns { v, error }. */
async function readUserForm(body, role, isEdit) {
  const v = emptyUser(role);
  for (const k of Object.keys(v)) if (k !== 'role') v[k] = str(body[k], k === 'address' ? 500 : 120);
  v.username = v.username.toLowerCase();
  v.is_cwsn = body.is_cwsn === '1' ? 1 : 0;
  v.is_bpl = body.is_bpl === '1' ? 1 : 0;
  let error = null;
  if (!isEdit && !/^[a-z0-9._-]{3,30}$/.test(v.username)) error = 'Username must be 3-30 characters: letters, numbers, dot, dash or underscore.';
  else if (!v.full_name) error = 'Full name is required.';
  else if (v.phone && !/^[6-9]\d{9}$/.test(v.phone)) error = 'Enter a valid 10-digit Indian mobile number.';
  else if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) error = 'Enter a valid email address.';
  else if (role === 'student') {
    if (!v.admission_no) error = 'Admission number is required.';
    else if (!toInt(v.class_id)) error = 'Please select a class.';
    else if (!(await col('classes').findOne({ id: toInt(v.class_id) }))) error = 'Please select a class.';
    else if (v.dob && !isValidDate(v.dob)) error = 'Enter a valid date of birth.';
    else if (v.gender && !GENDERS[v.gender]) error = 'Invalid gender.';
    else if (v.category && !CATEGORIES[v.category]) error = 'Invalid category.';
    else if (v.apaar_id && !/^\d{12}$/.test(v.apaar_id)) error = 'APAAR ID must be 12 digits.';
    else if (v.aadhaar_last4 && !/^\d{4}$/.test(v.aadhaar_last4)) error = 'Enter only the last 4 digits of Aadhaar.';
  } else if (role === 'teacher' || role === 'headmaster') {
    if (v.joining_date && !isValidDate(v.joining_date)) error = 'Enter a valid joining date.';
  }
  return { v, error };
}

/** Role-specific fields from the form, as stored on the user document. */
function roleFields(role, v) {
  if (role === 'student') {
    return {
      ...clean({
        admission_no: v.admission_no, class_id: toInt(v.class_id), roll_no: toInt(v.roll_no), dob: v.dob, gender: v.gender,
        category: v.category, apaar_id: v.apaar_id, aadhaar_last4: v.aadhaar_last4, address: v.address,
      }),
      is_cwsn: v.is_cwsn, is_bpl: v.is_bpl,
    };
  }
  if (role === 'teacher' || role === 'headmaster') {
    return clean({ employee_id: v.employee_id, designation: v.designation, qualification: v.qualification, joining_date: v.joining_date });
  }
  return {};
}

function friendlyDbError(err) {
  const key = dupKey(err);
  if (key === 'username') return 'That username is already taken.';
  if (key === 'admission_no') return 'That admission number already exists.';
  if (key === 'employee_id') return 'That employee ID already exists.';
  throw err;
}

async function linkChildren(parentId, list, relation) {
  const missing = [];
  for (const adm of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const s = await studentByAdmission(adm);
    if (s) {
      await col('parent_student').updateOne(
        { parent_id: parentId, student_id: s.id },
        { $setOnInsert: { parent_id: parentId, student_id: s.id, relation: relation || null } },
        { upsert: true },
      );
    } else {
      missing.push(adm);
    }
  }
  return missing;
}

router.get('/users/new', async (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : 'student';
  const v = emptyUser(role);
  if (req.query.class_id) v.class_id = String(toInt(req.query.class_id) || '');
  await renderUserForm(res, v, null, false);
});

router.post('/users', async (req, res) => {
  const role = ROLES.includes(req.body.role) ? req.body.role : null;
  if (!role) return res.redirect('/hm/users');
  const { v, error } = await readUserForm(req.body, role, false);
  if (error) return renderUserForm(res, v, error, false);
  const tempPassword = generatePassword();
  let id;
  try {
    // The account and its student/teacher details are one document, so this is a single atomic insert.
    id = await insertWithId('users', {
      username: v.username, password_hash: await bcrypt.hash(tempPassword, 10), role, full_name: v.full_name,
      phone: v.phone || null, email: v.email || null, is_active: 1, must_change_password: 1, last_login: null, created_at: nowLocal(),
      ...roleFields(role, v),
    });
  } catch (err) {
    return renderUserForm(res, v, friendlyDbError(err), false);
  }
  const missing = role === 'parent' ? await linkChildren(id, v.children, v.relation) : [];
  await audit(req.user.id, 'user_created', `${role} ${v.username}`, req.ip);
  req.flash('success', `Account created. Username: ${v.username} — Temporary password: ${tempPassword} (shown only once; the user must change it at first login).`);
  if (missing.length) req.flash('error', `These admission numbers were not found and were not linked: ${missing.join(', ')}`);
  res.redirect(`/hm/users/${id}`);
});

async function loadEditableUser(id) {
  const u = await col('users').findOne({ id }, { projection: { _id: 0, password_hash: 0, must_change_password: 0 } });
  if (!u) return null;
  const base = pick(u, ['id', 'username', 'role', 'full_name', 'phone', 'email', 'is_active', 'last_login', 'created_at']);
  if (u.role === 'student') return { ...base, user_id: u.id, ...pick(u, A.STUDENT_FIELDS) };
  if (u.role === 'teacher' || u.role === 'headmaster') return { ...base, user_id: u.id, ...pick(u, TEACHER_FIELDS) };
  return base;
}

router.get('/users/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const u = await loadEditableUser(id);
  if (!u) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'User not found.' });
  const data = { title: u.full_name, u, overview: null, children: [], assignments: [], classTeacherOf: [], timetable: null };
  if (u.role === 'student') data.overview = await A.studentOverview(id, monthParam(req.query.month));
  if (u.role === 'parent') data.children = await A.childrenOf(id);
  if (u.role === 'teacher' || u.role === 'headmaster') {
    [data.assignments, data.classTeacherOf, data.timetable] = await Promise.all([
      A.teacherAssignments(id), A.classTeacherOf(id), A.timetableForTeacher(id),
    ]);
  }
  res.render('headmaster/user_detail', data);
});

router.get('/users/:id/edit', async (req, res) => {
  const u = await loadEditableUser(toInt(req.params.id));
  if (!u) return res.redirect('/hm/users');
  const v = { ...emptyUser(u.role), ...Object.fromEntries(Object.entries(u).map(([k, val]) => [k, val ?? ''])) };
  await renderUserForm(res, v, null, true);
});

router.post('/users/:id', async (req, res) => {
  const existing = await loadEditableUser(toInt(req.params.id));
  if (!existing) return res.redirect('/hm/users');
  const { v, error } = await readUserForm(req.body, existing.role, true);
  v.id = existing.id;
  v.username = existing.username;
  if (error) return renderUserForm(res, v, error, true);
  try {
    await col('users').updateOne({ id: existing.id }, {
      $set: { full_name: v.full_name, phone: v.phone || null, email: v.email || null, ...roleFields(existing.role, v) },
    });
  } catch (err) {
    return renderUserForm(res, v, friendlyDbError(err), true);
  }
  await audit(req.user.id, 'user_updated', existing.username, req.ip);
  req.flash('success', 'Details saved.');
  res.redirect(`/hm/users/${existing.id}`);
});

router.post('/users/:id/reset-password', async (req, res) => {
  const u = await col('users').findOne({ id: toInt(req.params.id) }, { projection: { id: 1, username: 1 } });
  if (!u) return res.redirect('/hm/users');
  const temp = generatePassword();
  await col('users').updateOne({ id: u.id }, { $set: { password_hash: await bcrypt.hash(temp, 10), must_change_password: 1 } });
  await destroyUserSessions(u.id, req.sessionID);
  await audit(req.user.id, 'password_reset', u.username, req.ip);
  req.flash('success', `Password reset for ${u.username}. Temporary password: ${temp} (shown only once).`);
  res.redirect(`/hm/users/${u.id}`);
});

router.post('/users/:id/toggle-active', async (req, res) => {
  const u = await col('users').findOne({ id: toInt(req.params.id) }, { projection: { id: 1, username: 1, is_active: 1 } });
  if (!u) return res.redirect('/hm/users');
  if (u.id === req.user.id) {
    req.flash('error', 'You cannot deactivate your own account.');
    return res.redirect(`/hm/users/${u.id}`);
  }
  await col('users').updateOne({ id: u.id }, { $set: { is_active: u.is_active ? 0 : 1 } });
  if (u.is_active) await destroyUserSessions(u.id);
  await audit(req.user.id, u.is_active ? 'user_deactivated' : 'user_activated', u.username, req.ip);
  req.flash('success', u.is_active ? 'Account deactivated. The user can no longer sign in.' : 'Account activated.');
  res.redirect(`/hm/users/${u.id}`);
});

router.post('/users/:id/children', async (req, res) => {
  const p = await col('users').findOne({ id: toInt(req.params.id), role: 'parent' }, { projection: { id: 1 } });
  if (!p) return res.redirect('/hm/users?role=parent');
  const missing = await linkChildren(p.id, str(req.body.admission_no, 200), str(req.body.relation, 30));
  if (missing.length) req.flash('error', `Admission number not found: ${missing.join(', ')}`);
  else req.flash('success', 'Child linked to parent account.');
  res.redirect(`/hm/users/${p.id}`);
});

router.post('/users/:id/children/:sid/delete', async (req, res) => {
  await col('parent_student').deleteOne({ parent_id: toInt(req.params.id), student_id: toInt(req.params.sid) });
  req.flash('success', 'Child unlinked.');
  res.redirect(`/hm/users/${toInt(req.params.id)}`);
});

/* ---------------- Classes, subjects, timetable ---------------- */

async function teachersList() {
  const rows = await col('users').find({ role: STAFF, is_active: 1 }, { projection: { _id: 0, id: 1, full_name: 1 } }).toArray();
  return rows.sort(byName);
}

/** Only ids of existing staff members are stored as teacher references. */
async function staffIdOrNull(id) {
  if (!id) return null;
  return (await col('users').findOne({ id, role: STAFF }, { projection: { id: 1 } })) ? id : null;
}

router.get('/classes', async (req, res) => {
  const [classes, teachers] = await Promise.all([A.allClasses(), teachersList()]);
  res.render('headmaster/classes', { title: 'Classes', classes, teachers });
});

router.post('/classes', async (req, res) => {
  const name = str(req.body.name, 10);
  const section = str(req.body.section, 5).toUpperCase() || 'A';
  if (!name) {
    req.flash('error', 'Class name is required.');
    return res.redirect('/hm/classes');
  }
  try {
    await insertWithId('classes', { name, section, class_teacher_id: await staffIdOrNull(toInt(req.body.class_teacher_id)) });
    req.flash('success', `Class ${name}-${section} created.`);
  } catch (err) {
    if (!dupKey(err)) throw err;
    req.flash('error', `Class ${name}-${section} already exists.`);
  }
  res.redirect('/hm/classes');
});

router.get('/classes/:id', async (req, res) => {
  const cls = await col('classes').findOne({ id: toInt(req.params.id) }, { projection: { _id: 0 } });
  if (!cls) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Class not found.' });
  const ct = cls.class_teacher_id ? await col('users').findOne({ id: cls.class_teacher_id }, { projection: { full_name: 1 } }) : null;
  cls.class_teacher_id = cls.class_teacher_id ?? null;
  cls.class_teacher_name = ct ? ct.full_name : null;
  const links = await col('class_subjects').find({ class_id: cls.id }).toArray();
  const [subjectMap, teacherMap, subjects, teachers, students, timetable] = await Promise.all([
    byIds('subjects', links.map((l) => l.subject_id)),
    byIds('users', links.map((l) => l.teacher_id), { id: 1, full_name: 1 }),
    col('subjects').find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray(),
    teachersList(),
    A.studentsInClass(cls.id),
    A.timetableForClass(cls.id),
  ]);
  const classSubjects = links.filter((l) => subjectMap.has(l.subject_id)).map((l) => ({
    subject_id: l.subject_id, subject_name: subjectMap.get(l.subject_id).name,
    teacher_name: (teacherMap.get(l.teacher_id) || {}).full_name || null, teacher_id: l.teacher_id ?? null,
  })).sort((a, b) => a.subject_name.localeCompare(b.subject_name));
  res.render('headmaster/class_detail', {
    title: `Class ${cls.name}-${cls.section}`,
    cls, classSubjects, subjects, teachers, students, timetable,
    DAYS, PERIODS,
  });
});

router.post('/classes/:id/class-teacher', async (req, res) => {
  const id = toInt(req.params.id);
  await col('classes').updateOne({ id }, { $set: { class_teacher_id: await staffIdOrNull(toInt(req.body.class_teacher_id)) } });
  req.flash('success', 'Class teacher updated.');
  res.redirect(`/hm/classes/${id}`);
});

router.post('/classes/:id/subjects', async (req, res) => {
  const id = toInt(req.params.id);
  const subjectId = toInt(req.body.subject_id);
  const [cls, subject] = await Promise.all([col('classes').findOne({ id }), subjectId ? col('subjects').findOne({ id: subjectId }) : null]);
  if (cls && subject) {
    await col('class_subjects').updateOne(
      { class_id: id, subject_id: subjectId },
      { $set: { teacher_id: await staffIdOrNull(toInt(req.body.teacher_id)) } },
      { upsert: true },
    );
    req.flash('success', 'Subject assignment saved.');
  }
  res.redirect(`/hm/classes/${id}`);
});

router.post('/classes/:id/subjects/:sid/delete', async (req, res) => {
  const id = toInt(req.params.id);
  await col('class_subjects').deleteOne({ class_id: id, subject_id: toInt(req.params.sid) });
  req.flash('success', 'Subject removed from class.');
  res.redirect(`/hm/classes/${id}`);
});

router.post('/classes/:id/timetable', async (req, res) => {
  const id = toInt(req.params.id);
  const day = toInt(req.body.day);
  const period = toInt(req.body.period);
  const subjectId = toInt(req.body.subject_id);
  const teacherId = await staffIdOrNull(toInt(req.body.teacher_id));
  if (!(day >= 1 && day <= 6 && period >= 1 && period <= 8)) {
    req.flash('error', 'Choose a valid day and period.');
    return res.redirect(`/hm/classes/${id}#timetable`);
  }
  if (!subjectId) {
    await col('timetable').deleteOne({ class_id: id, day, period });
    req.flash('success', 'Period cleared.');
    return res.redirect(`/hm/classes/${id}#timetable`);
  }
  if (!(await col('classes').findOne({ id })) || !(await col('subjects').findOne({ id: subjectId }))) {
    req.flash('error', 'Class or subject not found.');
    return res.redirect('/hm/classes');
  }
  if (teacherId) {
    const busy = await col('timetable').find({ teacher_id: teacherId, day, period, class_id: { $ne: id } }).toArray();
    const clash = busy.length ? await col('classes').findOne({ id: { $in: busy.map((b) => b.class_id) } }) : null;
    if (clash) {
      req.flash('error', `That teacher already has Class ${clash.name}-${clash.section} on ${DAYS[day]}, period ${period}.`);
      return res.redirect(`/hm/classes/${id}#timetable`);
    }
  }
  await col('timetable').updateOne({ class_id: id, day, period }, { $set: { subject_id: subjectId, teacher_id: teacherId } }, { upsert: true });
  req.flash('success', `Timetable updated for ${DAYS[day]}, period ${period}.`);
  res.redirect(`/hm/classes/${id}#timetable`);
});

router.post('/classes/:id/delete', async (req, res) => {
  const id = toInt(req.params.id);
  const n = await col('users').countDocuments({ role: 'student', class_id: id });
  if (n > 0) {
    req.flash('error', 'Move or remove all students from this class before deleting it.');
    return res.redirect(`/hm/classes/${id}`);
  }
  // Same clean-up the old foreign keys did (ON DELETE CASCADE).
  await Promise.all(['class_subjects', 'homework', 'timetable', 'notices'].map((c) => col(c).deleteMany({ class_id: id })));
  await col('classes').deleteOne({ id });
  req.flash('success', 'Class deleted.');
  res.redirect('/hm/classes');
});

router.get('/subjects', async (req, res) => {
  const [list, usage] = await Promise.all([
    col('subjects').find({}, { projection: { _id: 0 } }).toArray(),
    col('class_subjects').aggregate([{ $group: { _id: '$subject_id', n: { $sum: 1 } } }]).toArray(),
  ]);
  const counts = new Map(usage.map((u) => [u._id, u.n]));
  const subjects = list.map((s) => ({ ...s, code: s.code ?? null, class_count: counts.get(s.id) || 0 })).sort((a, b) => a.name.localeCompare(b.name));
  res.render('headmaster/subjects', { title: 'Subjects', subjects });
});

router.post('/subjects', async (req, res) => {
  const name = str(req.body.name, 60);
  if (!name) {
    req.flash('error', 'Subject name is required.');
    return res.redirect('/hm/subjects');
  }
  try {
    await insertWithId('subjects', { name, code: str(req.body.code, 10) || null });
    req.flash('success', 'Subject added.');
  } catch (err) {
    if (!dupKey(err)) throw err;
    req.flash('error', 'A subject with that name already exists.');
  }
  res.redirect('/hm/subjects');
});

/* ---------------- Exams ---------------- */

router.get('/exams', async (req, res) => {
  const [list, marked] = await Promise.all([
    col('exams').find({}, { projection: { _id: 0 } }).sort({ academic_year: -1, exam_date: -1, id: -1 }).toArray(),
    col('marks').aggregate([
      { $group: { _id: { exam: '$exam_id', student: '$student_id' } } },
      { $group: { _id: '$_id.exam', n: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const counts = new Map(marked.map((m) => [m._id, m.n]));
  const exams = list.map((e) => ({ ...e, exam_date: e.exam_date || null, students_with_marks: counts.get(e.id) || 0 }));
  res.render('headmaster/exams', { title: 'Exams', exams, year: academicYear() });
});

router.post('/exams', async (req, res) => {
  const name = str(req.body.name, 80);
  const max = toInt(req.body.max_marks);
  const date = str(req.body.exam_date, 10);
  const year = /^\d{4}-\d{2}$/.test(req.body.academic_year) ? req.body.academic_year : academicYear();
  if (!name || !(max > 0 && max <= 1000) || (date && !isValidDate(date))) {
    req.flash('error', 'Exam name, maximum marks (1-1000) and a valid date are required.');
    return res.redirect('/hm/exams');
  }
  await insertWithId('exams', { name, max_marks: max, exam_date: date || null, academic_year: year });
  req.flash('success', 'Exam created. Subject teachers can now enter marks.');
  res.redirect('/hm/exams');
});

router.post('/exams/:id/delete', async (req, res) => {
  const id = toInt(req.params.id);
  if (await col('marks').findOne({ exam_id: id })) {
    req.flash('error', 'Marks have already been entered for this exam, so it cannot be deleted.');
  } else {
    await col('exams').deleteOne({ id });
    req.flash('success', 'Exam deleted.');
  }
  res.redirect('/hm/exams');
});

/* ---------------- Attendance reports ---------------- */

const EMPTY_COUNTS = { present: 0, absent: 0, leave: 0, total: 0 };

router.get('/reports/attendance', async (req, res) => {
  const today = localDate();
  const from = isValidDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
  const to = isValidDate(req.query.to) ? req.query.to : today;
  const classId = toInt(req.query.class_id);
  const classes = await A.allClasses();
  const range = { $gte: from, $lte: to };
  let rows;
  if (classId) {
    const students = await A.studentsInClass(classId);
    const counts = await A.attendanceCounts({ student_id: { $in: students.map((s) => s.id) }, date: range });
    rows = students.map((s) => {
      const c = counts.get(s.id) || EMPTY_COUNTS;
      return { id: s.id, full_name: s.full_name, admission_no: s.admission_no, roll_no: s.roll_no ?? null, present: c.present, absent: c.absent, leave: c.leave, total: c.total };
    });
  } else {
    const students = await col('users').find({ role: 'student', is_active: 1, class_id: { $ne: null } }, { projection: { id: 1, class_id: 1 } }).toArray();
    const counts = await A.attendanceCounts({ student_id: { $in: students.map((s) => s.id) }, date: range });
    rows = classes.map((cls) => {
      const r = { id: cls.id, name: cls.name, section: cls.section, students: 0, ...EMPTY_COUNTS };
      for (const s of students) {
        if (s.class_id !== cls.id) continue;
        r.students++;
        const c = counts.get(s.id);
        if (c) for (const k of Object.keys(EMPTY_COUNTS)) r[k] += c[k];
      }
      return r;
    });
  }
  rows = rows.map((r) => ({ ...r, percent: percent(r.present, r.total) }));

  if (req.query.format === 'csv') {
    const header = classId
      ? ['Roll No', 'Admission No', 'Name', 'Present', 'Absent', 'Leave', 'Days Marked', 'Attendance %']
      : ['Class', 'Students', 'Present', 'Absent', 'Leave', 'Records', 'Attendance %'];
    const lines = [header.join(',')].concat(rows.map((r) => (classId
      ? [r.roll_no, r.admission_no, r.full_name, r.present, r.absent, r.leave, r.total, r.percent ?? '']
      : [`${r.name}-${r.section}`, r.students, r.present, r.absent, r.leave, r.total, r.percent ?? '']).map(csvEscape).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_to_${to}${classId ? `_class${classId}` : ''}.csv"`);
    return res.send(`\uFEFF${lines.join('\r\n')}`);
  }
  res.render('headmaster/report_attendance', {
    title: 'Attendance Reports', rows, from, to, classId, classes,
    lowAttendance: await A.lowAttendance(),
  });
});

/* ---------------- Staff attendance ---------------- */

router.get('/staff-attendance', async (req, res) => {
  const date = isValidDate(req.query.date) && req.query.date <= localDate() ? req.query.date : localDate();
  const monthStart = `${date.slice(0, 7)}-01`;
  const people = (await col('users').find({ role: STAFF, is_active: 1 }, { projection: { _id: 0, id: 1, full_name: 1, designation: 1 } }).toArray()).sort(byName);
  const ids = people.map((p) => p.id);
  const [todayRows, monthRows] = await Promise.all([
    col('teacher_attendance').find({ teacher_id: { $in: ids }, date }).toArray(),
    col('teacher_attendance').aggregate([
      { $match: { teacher_id: { $in: ids }, date: { $gte: monthStart, $lte: date } } },
      { $group: {
        _id: '$teacher_id',
        present: { $sum: { $cond: [{ $eq: ['$status', 'P'] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ['$status', 'A'] }, 1, 0] } },
        leave: { $sum: { $cond: [{ $eq: ['$status', 'L'] }, 1, 0] } },
      } },
    ]).toArray(),
  ]);
  const onDate = new Map(todayRows.map((r) => [r.teacher_id, r]));
  const month = new Map(monthRows.map((r) => [r._id, r]));
  const staff = people.map((p) => {
    const r = onDate.get(p.id);
    return { id: p.id, full_name: p.full_name, designation: p.designation ?? null, status: r ? r.status : null, check_in_time: r ? r.check_in_time ?? null : null };
  });
  const monthly = people.map((p) => {
    const m = month.get(p.id) || { present: 0, absent: 0, leave: 0 };
    return { id: p.id, full_name: p.full_name, present: m.present, absent: m.absent, leave: m.leave };
  });
  res.render('headmaster/staff_attendance', { title: 'Staff Attendance', date, staff, monthly });
});

router.post('/staff-attendance', async (req, res) => {
  const date = isValidDate(req.body.date) && req.body.date <= localDate() ? req.body.date : null;
  if (!date) {
    req.flash('error', 'Invalid date.');
    return res.redirect('/hm/staff-attendance');
  }
  const staffIds = await col('users').distinct('id', { role: STAFF, is_active: 1 });
  const ops = [];
  for (const id of staffIds) {
    const status = req.body[`status_${id}`];
    if (!['P', 'A', 'L'].includes(status)) continue;
    // An existing check-in time is kept; a new "present" record gets the current time.
    ops.push({ updateOne: {
      filter: { teacher_id: id, date },
      update: { $set: { status }, $setOnInsert: { check_in_time: status === 'P' ? localTime() : null } },
      upsert: true,
    } });
  }
  if (ops.length) await col('teacher_attendance').bulkWrite(ops, { ordered: false });
  req.flash('success', 'Staff attendance saved.');
  res.redirect(`/hm/staff-attendance?date=${date}`);
});

/* ---------------- Mid-Day Meal (PM POSHAN) ---------------- */

router.get('/mdm', async (req, res) => {
  const date = isValidDate(req.query.date) ? req.query.date : localDate();
  const monthStart = `${localDate().slice(0, 7)}-01`;
  const [existing, activeIds, list, monthAgg] = await Promise.all([
    col('midday_meals').findOne({ date }, { projection: { _id: 0 } }),
    activeStudentIds(),
    col('midday_meals').find({}, { projection: { _id: 0 } }).sort({ date: -1 }).limit(60).toArray(),
    col('midday_meals').aggregate([
      { $match: { date: { $gte: monthStart } } },
      { $group: { _id: null, days: { $sum: 1 }, meals: { $sum: '$meals_served' }, present: { $sum: '$students_present' } } },
    ]).toArray(),
  ]);
  const presentToday = await col('attendance').countDocuments({ date, status: 'P', student_id: { $in: activeIds } });
  const names = await byIds('users', list.map((m) => m.recorded_by), { id: 1, full_name: 1 });
  const records = list.map((m) => ({ ...m, recorded_by_name: (names.get(m.recorded_by) || {}).full_name || null }));
  const month = monthAgg[0] ? { days: monthAgg[0].days, meals: monthAgg[0].meals, present: monthAgg[0].present } : { days: 0, meals: 0, present: 0 };
  res.render('headmaster/mdm', { title: 'Mid-Day Meal (PM POSHAN)', date, existing, presentToday, records, month });
});

router.post('/mdm', async (req, res) => {
  const date = str(req.body.date, 10);
  const menu = str(req.body.menu, 300);
  const present = toInt(req.body.students_present, 0);
  const served = toInt(req.body.meals_served, 0);
  if (!isValidDate(date) || date > localDate() || !menu || present < 0 || served < 0) {
    req.flash('error', 'A valid date (not in the future), menu and non-negative counts are required.');
    return res.redirect('/hm/mdm');
  }
  await col('midday_meals').updateOne({ date }, {
    $set: {
      menu, students_present: present, meals_served: served, quality_checked: req.body.quality_checked === '1' ? 1 : 0,
      remarks: str(req.body.remarks, 500) || null, recorded_by: req.user.id,
    },
  }, { upsert: true });
  req.flash('success', `Mid-day meal record saved for ${date}.`);
  res.redirect('/hm/mdm');
});

/* ---------------- Scholarships ---------------- */

router.get('/scholarships', async (req, res) => {
  const status = SCHOLARSHIP_STATUS.includes(req.query.status) ? req.query.status : null;
  const list = await col('scholarships').find(status ? { status } : {}, { projection: { _id: 0 } }).sort({ id: -1 }).limit(500).toArray();
  const students = await byIds('users', list.map((s) => s.student_id), { id: 1, full_name: 1, admission_no: 1, category: 1, class_id: 1, role: 1 });
  const classes = await byIds('classes', [...students.values()].map((s) => s.class_id));
  const rows = list.filter((sc) => students.has(sc.student_id) && students.get(sc.student_id).role === 'student').map((sc) => {
    const s = students.get(sc.student_id);
    const c = classes.get(s.class_id);
    return {
      ...sc, full_name: s.full_name, admission_no: s.admission_no, category: s.category ?? null,
      class_name: c ? c.name : null, section: c ? c.section : null,
    };
  });
  const summary = (await col('scholarships').aggregate([
    { $match: { academic_year: academicYear() } },
    { $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: { $ifNull: ['$amount', 0] } } } },
  ]).toArray()).map((r) => ({ status: r._id, n: r.n, amount: r.amount }));
  res.render('headmaster/scholarships', { title: 'Scholarships', rows, summary, status, SCHEMES, SCHOLARSHIP_STATUS, year: academicYear() });
});

router.post('/scholarships', async (req, res) => {
  const s = await studentByAdmission(str(req.body.admission_no, 30));
  const scheme = str(req.body.scheme_name, 150);
  const status = SCHOLARSHIP_STATUS.includes(req.body.status) ? req.body.status : 'applied';
  const amount = req.body.amount ? Number(req.body.amount) : null;
  const appliedOn = isValidDate(req.body.applied_on) ? req.body.applied_on : localDate();
  if (!s || !scheme || (amount !== null && !(amount >= 0))) {
    req.flash('error', s ? 'Scheme name and a valid amount are required.' : 'No student found with that admission number.');
    return res.redirect('/hm/scholarships');
  }
  await insertWithId('scholarships', {
    student_id: s.id, scheme_name: scheme, amount, academic_year: academicYear(), status, applied_on: appliedOn, remarks: str(req.body.remarks, 300) || null,
  });
  req.flash('success', 'Scholarship application recorded.');
  res.redirect('/hm/scholarships');
});

router.post('/scholarships/:id/status', async (req, res) => {
  const status = SCHOLARSHIP_STATUS.includes(req.body.status) ? req.body.status : null;
  if (status) {
    const set = { status };
    const remarks = str(req.body.remarks, 300);
    if (remarks) set.remarks = remarks; // blank keeps the existing remarks
    await col('scholarships').updateOne({ id: toInt(req.params.id) }, { $set: set });
    req.flash('success', 'Scholarship status updated.');
  }
  res.redirect('/hm/scholarships');
});

/* ---------------- Entitlements (free textbooks, uniforms...) ---------------- */

router.get('/entitlements', async (req, res) => {
  const year = academicYear();
  const [classes, students] = await Promise.all([
    A.allClasses(),
    col('users').find({ role: 'student', is_active: 1 }, { projection: { id: 1, class_id: 1 } }).toArray(),
  ]);
  const classOf = new Map(students.map((s) => [s.id, s.class_id]));
  const given = await col('entitlements').find({ academic_year: year, student_id: { $in: students.map((s) => s.id) } }, { projection: { student_id: 1, item: 1 } }).toArray();
  const tally = new Map();
  for (const e of given) {
    const key = `${classOf.get(e.student_id)}|${e.item}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  const matrix = classes.map((c) => ({
    ...c,
    items: Object.fromEntries(ITEMS.map((it) => [it, tally.get(`${c.id}|${it}`) || 0])),
  }));
  res.render('headmaster/entitlements', { title: 'Free Textbooks & Uniforms', matrix, ITEMS, year, today: localDate() });
});

router.post('/entitlements', async (req, res) => {
  const item = ITEMS.includes(req.body.item) ? req.body.item : null;
  const date = isValidDate(req.body.distributed_on) ? req.body.distributed_on : localDate();
  const year = academicYear();
  if (!item) {
    req.flash('error', 'Choose an item.');
    return res.redirect('/hm/entitlements');
  }
  let targets = [];
  const adm = str(req.body.admission_no, 30);
  if (adm) {
    const s = await studentByAdmission(adm);
    if (!s) {
      req.flash('error', 'No student found with that admission number.');
      return res.redirect('/hm/entitlements');
    }
    targets = [s.id];
  } else if (toInt(req.body.class_id)) {
    targets = (await A.studentsInClass(toInt(req.body.class_id))).map((s) => s.id);
  }
  let added = 0;
  for (const studentId of targets) {
    // Like INSERT OR IGNORE: a student receives each item at most once per academic year.
    // The id is only used if the record is new; unused ids just leave a gap in the numbering.
    const r = await col('entitlements').updateOne(
      { student_id: studentId, item, academic_year: year },
      { $setOnInsert: { id: await nextId('entitlements'), distributed_on: date, recorded_by: req.user.id } },
      { upsert: true },
    );
    if (r.upsertedCount) added++;
  }
  req.flash('success', `${item}: recorded for ${added} student(s). ${targets.length - added} already had it this year.`);
  res.redirect('/hm/entitlements');
});

/* ---------------- Grievances ---------------- */

router.get('/grievances', async (req, res) => {
  const status = ['open', 'in_progress', 'resolved'].includes(req.query.status) ? req.query.status : null;
  const list = await col('grievances').aggregate([
    { $match: status ? { status } : {} },
    { $addFields: { resolvedLast: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } } },
    { $sort: { resolvedLast: 1, id: -1 } },
    { $limit: 300 },
    { $project: { _id: 0, resolvedLast: 0 } },
  ]).toArray();
  const names = await byIds('users', [...list.map((g) => g.raised_by), ...list.map((g) => g.responded_by)], { id: 1, full_name: 1 });
  const rows = list.map((g) => ({
    ...g,
    raised_by_name: (names.get(g.raised_by) || {}).full_name || null,
    responded_by_name: (names.get(g.responded_by) || {}).full_name || null,
  }));
  res.render('headmaster/grievances', { title: 'Grievances & Suggestions', rows, status });
});

router.post('/grievances/:id', async (req, res) => {
  const status = ['open', 'in_progress', 'resolved'].includes(req.body.status) ? req.body.status : 'in_progress';
  await col('grievances').updateOne({ id: toInt(req.params.id) }, {
    $set: { status, response: str(req.body.response, 2000) || null, responded_by: req.user.id, updated_at: nowLocal() },
  });
  req.flash('success', 'Response saved.');
  res.redirect('/hm/grievances');
});

/* ---------------- Self-registrations: headmaster verifies teachers (and student/parent requests with no class teacher) ---------------- */

require('./registrationReview')(router, '/hm/registrations');

/* ---------------- Audit log ---------------- */

router.get('/audit', async (req, res) => {
  const list = await col('audit_log').find({}, { projection: { _id: 0 } }).sort({ id: -1 }).limit(300).toArray();
  const users = await byIds('users', list.map((a) => a.user_id), { id: 1, full_name: 1, username: 1, role: 1 });
  const rows = list.map((a) => {
    const u = users.get(a.user_id);
    return { ...a, full_name: u ? u.full_name : null, username: u ? u.username : null, role: u ? u.role : null };
  });
  res.render('headmaster/audit', { title: 'Audit Log', rows });
});

module.exports = router;
module.exports.dashboard = dashboard;
