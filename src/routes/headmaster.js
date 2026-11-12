'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { one, all, run, tx, audit, UPLOAD_DIR } = require('../db');
const { requireRole, verifyCsrf, csrfFailed } = require('../middleware/auth');
const A = require('../services/academics');
const {
  str, toInt, isValidDate, localDate, localTime, academicYear, generatePassword, csvEscape, percent,
  monthParam, dayOfWeek, CATEGORIES, GENDERS, DAYS, PERIODS,
} = require('../utils');

const router = express.Router();
router.use(requireRole('headmaster'));

const ROLES = ['student', 'teacher', 'parent', 'headmaster'];
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

function isHoliday(date) {
  return dayOfWeek(date) === 0 || !!one("SELECT 1 AS h FROM events WHERE type = 'holiday' AND date = ?", date);
}

/* ---------------- Dashboard ---------------- */

function dashboard(req, res) {
  const today = localDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  const counts = one(`SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'student' AND is_active = 1) AS students,
      (SELECT COUNT(*) FROM users WHERE role = 'teacher' AND is_active = 1) AS teachers,
      (SELECT COUNT(*) FROM users WHERE role = 'parent' AND is_active = 1) AS parents,
      (SELECT COUNT(*) FROM classes) AS classes,
      (SELECT COUNT(*) FROM grievances WHERE status != 'resolved') AS open_grievances,
      (SELECT COUNT(*) FROM scholarships WHERE status IN ('applied','verified')) AS pending_scholarships,
      (SELECT COUNT(*) FROM leave_requests WHERE status = 'pending') AS pending_leaves`);
  const att = one(`SELECT COUNT(*) AS total, COALESCE(SUM(a.status = 'P'), 0) AS present
    FROM attendance a JOIN users u ON u.id = a.student_id WHERE a.date = ? AND u.is_active = 1`, today);
  const staff = one(`SELECT COALESCE(SUM(ta.status = 'P'), 0) AS present,
      (SELECT COUNT(*) FROM users WHERE role IN ('teacher','headmaster') AND is_active = 1) AS total
    FROM teacher_attendance ta JOIN users u ON u.id = ta.teacher_id WHERE ta.date = ? AND u.is_active = 1`, today);
  const unmarked = all(`SELECT c.id, c.name, c.section, u.full_name AS class_teacher_name
    FROM classes c LEFT JOIN users u ON u.id = c.class_teacher_id
    WHERE EXISTS (SELECT 1 FROM students s JOIN users su ON su.id = s.user_id WHERE s.class_id = c.id AND su.is_active = 1)
      AND NOT EXISTS (SELECT 1 FROM attendance a JOIN students s ON s.user_id = a.student_id WHERE s.class_id = c.id AND a.date = ?)
    ORDER BY CAST(c.name AS INTEGER), c.section`, today);
  const gender = all(`SELECT s.gender AS k, COUNT(*) AS n FROM students s JOIN users u ON u.id = s.user_id
    WHERE u.is_active = 1 GROUP BY s.gender`);
  const category = all(`SELECT s.category AS k, COUNT(*) AS n FROM students s JOIN users u ON u.id = s.user_id
    WHERE u.is_active = 1 GROUP BY s.category`);
  const classAttendance = all(`SELECT c.id, c.name, c.section, COUNT(a.student_id) AS total, COALESCE(SUM(a.status = 'P'), 0) AS present
    FROM classes c LEFT JOIN students s ON s.class_id = c.id
    LEFT JOIN attendance a ON a.student_id = s.user_id AND a.date >= ?
    GROUP BY c.id ORDER BY CAST(c.name AS INTEGER), c.section`, monthStart)
    .map((r) => ({ ...r, percent: percent(r.present, r.total) }));
  res.render('headmaster/dashboard', {
    title: 'Headmaster Dashboard',
    today, counts, staff, unmarked, gender, category, classAttendance,
    att: { ...att, percent: percent(att.present, att.total) },
    holiday: isHoliday(today),
    mdmToday: one('SELECT * FROM midday_meals WHERE date = ?', today),
    lowAttendance: A.lowAttendance().slice(0, 10),
    notices: A.noticesFor(req.user, 5),
    events: A.upcomingEvents(5),
    CATEGORIES, GENDERS,
  });
}

/* ---------------- School profile ---------------- */

router.get('/school', (req, res) => {
  res.render('headmaster/school', { title: 'School Profile' });
});

router.post('/school', (req, res) => {
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
  run(`UPDATE school_info SET name = ?, name_hi = ?, name_te = ?, udise_code = ?, address = ?, block = ?, district = ?, state = ?,
      board = ?, medium = ?, phone = ?, email = ?, timings = ?, about = ?, facilities = ? WHERE id = 1`,
  name, f('name_hi'), f('name_te'), udise, f('address', 500), f('block'), f('district'), f('state'), f('board'), f('medium'),
  f('phone', 20), f('email'), f('timings', 120), f('about', 2000), f('facilities', 2000));
  audit(req.user.id, 'school_profile_updated', null, req.ip);
  req.flash('success', 'School profile updated.');
  res.redirect('/hm/school');
});

/* School photo shown on the public landing page. Kept in memory, checked by file signature, then written to disk. */
const PHOTO_TYPES = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 5 } }).single('photo');

function removeOldPhotos() {
  for (const t of PHOTO_TYPES) fs.rmSync(path.join(UPLOAD_DIR, `school-photo.${t.ext}`), { force: true });
}

router.post('/school/photo', (req, res) => {
  photoUpload(req, res, (err) => {
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
    removeOldPhotos();
    const name = `school-photo.${type.ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), req.file.buffer);
    run('UPDATE school_info SET photo = ? WHERE id = 1', name);
    audit(req.user.id, 'school_photo_updated', null, req.ip);
    req.flash('success', 'School photo updated. It now appears on the home page.');
    res.redirect('/hm/school');
  });
});

router.post('/school/photo/delete', (req, res) => {
  removeOldPhotos();
  run('UPDATE school_info SET photo = NULL WHERE id = 1');
  req.flash('success', 'School photo removed. The home page shows the default illustration.');
  res.redirect('/hm/school');
});

/* ---------------- Users ---------------- */

router.get('/users', (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : 'student';
  const q = str(req.query.q, 50);
  const classId = toInt(req.query.class_id);
  const like = `%${q}%`;
  let users;
  if (role === 'student') {
    users = all(`SELECT u.id, u.username, u.full_name, u.phone, u.is_active, u.last_login,
        s.admission_no, s.roll_no, c.name AS class_name, c.section
      FROM users u JOIN students s ON s.user_id = u.id LEFT JOIN classes c ON c.id = s.class_id
      WHERE u.role = 'student' AND (? IS NULL OR s.class_id = ?)
        AND (u.full_name LIKE ? OR u.username LIKE ? OR s.admission_no LIKE ?)
      ORDER BY CAST(c.name AS INTEGER), c.section, s.roll_no, u.full_name LIMIT 500`, classId, classId, like, like, like);
  } else if (role === 'parent') {
    users = all(`SELECT u.id, u.username, u.full_name, u.phone, u.is_active, u.last_login,
        (SELECT GROUP_CONCAT(su.full_name, ', ') FROM parent_student ps JOIN users su ON su.id = ps.student_id WHERE ps.parent_id = u.id) AS children
      FROM users u WHERE u.role = 'parent' AND (u.full_name LIKE ? OR u.username LIKE ? OR COALESCE(u.phone,'') LIKE ?)
      ORDER BY u.full_name LIMIT 500`, like, like, like);
  } else {
    users = all(`SELECT u.id, u.username, u.full_name, u.phone, u.is_active, u.last_login, t.employee_id, t.designation
      FROM users u LEFT JOIN teachers t ON t.user_id = u.id
      WHERE u.role = ? AND (u.full_name LIKE ? OR u.username LIKE ? OR COALESCE(t.employee_id,'') LIKE ?)
      ORDER BY u.full_name LIMIT 500`, role, like, like, like);
  }
  res.render('headmaster/users', { title: 'Users', role, users, q, classId, classes: A.allClasses(), ROLES });
});

function emptyUser(role) {
  return { role, username: '', full_name: '', phone: '', email: '', admission_no: '', class_id: '', roll_no: '', dob: '', gender: '', category: '', apaar_id: '', aadhaar_last4: '', is_cwsn: 0, is_bpl: 0, address: '', employee_id: '', designation: '', qualification: '', joining_date: '', children: '', relation: '' };
}

function renderUserForm(res, v, error, isEdit) {
  res.status(error ? 400 : 200).render('headmaster/user_form', {
    title: isEdit ? 'Edit User' : 'Add User', v, error, isEdit, classes: A.allClasses(), CATEGORIES, GENDERS,
  });
}

/** Reads and validates the user form. Returns { v, error }. */
function readUserForm(body, role, isEdit) {
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

function friendlyDbError(err) {
  const m = String(err.message);
  if (m.includes('users.username')) return 'That username is already taken.';
  if (m.includes('students.admission_no')) return 'That admission number already exists.';
  if (m.includes('teachers.employee_id')) return 'That employee ID already exists.';
  throw err;
}

function linkChildren(parentId, list, relation) {
  const missing = [];
  for (const adm of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const s = one('SELECT user_id FROM students WHERE admission_no = ?', adm);
    if (s) run('INSERT OR IGNORE INTO parent_student (parent_id, student_id, relation) VALUES (?, ?, ?)', parentId, s.user_id, relation || null);
    else missing.push(adm);
  }
  return missing;
}

router.get('/users/new', (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : 'student';
  const v = emptyUser(role);
  if (req.query.class_id) v.class_id = String(toInt(req.query.class_id) || '');
  renderUserForm(res, v, null, false);
});

router.post('/users', (req, res) => {
  const role = ROLES.includes(req.body.role) ? req.body.role : null;
  if (!role) return res.redirect('/hm/users');
  const { v, error } = readUserForm(req.body, role, false);
  if (error) return renderUserForm(res, v, error, false);
  const tempPassword = generatePassword();
  let id;
  let missing = [];
  try {
    id = tx(() => {
      const r = run(`INSERT INTO users (username, password_hash, role, full_name, phone, email, must_change_password)
        VALUES (?, ?, ?, ?, ?, ?, 1)`, v.username, bcrypt.hashSync(tempPassword, 10), role, v.full_name, v.phone, v.email);
      const uid = Number(r.lastInsertRowid);
      if (role === 'student') {
        run(`INSERT INTO students (user_id, admission_no, class_id, roll_no, dob, gender, category, apaar_id, aadhaar_last4, is_cwsn, is_bpl, address)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, uid, v.admission_no, toInt(v.class_id), toInt(v.roll_no), v.dob, v.gender, v.category,
        v.apaar_id, v.aadhaar_last4, v.is_cwsn, v.is_bpl, v.address);
      } else if (role === 'teacher' || role === 'headmaster') {
        run('INSERT INTO teachers (user_id, employee_id, designation, qualification, joining_date) VALUES (?, ?, ?, ?, ?)',
          uid, v.employee_id, v.designation, v.qualification, v.joining_date);
      } else if (role === 'parent') {
        missing = linkChildren(uid, v.children, v.relation);
      }
      return uid;
    });
  } catch (err) {
    return renderUserForm(res, v, friendlyDbError(err), false);
  }
  audit(req.user.id, 'user_created', `${role} ${v.username}`, req.ip);
  req.flash('success', `Account created. Username: ${v.username} — Temporary password: ${tempPassword} (shown only once; the user must change it at first login).`);
  if (missing.length) req.flash('error', `These admission numbers were not found and were not linked: ${missing.join(', ')}`);
  res.redirect(`/hm/users/${id}`);
});

function loadEditableUser(id) {
  const u = one('SELECT id, username, role, full_name, phone, email, is_active, last_login, created_at FROM users WHERE id = ?', id);
  if (!u) return null;
  const extra = u.role === 'student'
    ? one('SELECT * FROM students WHERE user_id = ?', id)
    : (u.role === 'teacher' || u.role === 'headmaster') ? one('SELECT * FROM teachers WHERE user_id = ?', id) : null;
  return { ...u, ...(extra || {}) };
}

router.get('/users/:id', (req, res) => {
  const id = toInt(req.params.id);
  const u = loadEditableUser(id);
  if (!u) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'User not found.' });
  const data = { title: u.full_name, u, overview: null, children: [], assignments: [], classTeacherOf: [], timetable: null };
  if (u.role === 'student') data.overview = A.studentOverview(id, monthParam(req.query.month));
  if (u.role === 'parent') data.children = A.childrenOf(id);
  if (u.role === 'teacher' || u.role === 'headmaster') {
    data.assignments = A.teacherAssignments(id);
    data.classTeacherOf = A.classTeacherOf(id);
    data.timetable = A.timetableForTeacher(id);
  }
  res.render('headmaster/user_detail', data);
});

router.get('/users/:id/edit', (req, res) => {
  const u = loadEditableUser(toInt(req.params.id));
  if (!u) return res.redirect('/hm/users');
  const v = { ...emptyUser(u.role), ...Object.fromEntries(Object.entries(u).map(([k, val]) => [k, val ?? ''])) };
  renderUserForm(res, v, null, true);
});

router.post('/users/:id', (req, res) => {
  const existing = loadEditableUser(toInt(req.params.id));
  if (!existing) return res.redirect('/hm/users');
  const { v, error } = readUserForm(req.body, existing.role, true);
  v.id = existing.id;
  v.username = existing.username;
  if (error) return renderUserForm(res, v, error, true);
  try {
    tx(() => {
      run('UPDATE users SET full_name = ?, phone = ?, email = ? WHERE id = ?', v.full_name, v.phone, v.email, existing.id);
      if (existing.role === 'student') {
        run(`UPDATE students SET admission_no = ?, class_id = ?, roll_no = ?, dob = ?, gender = ?, category = ?, apaar_id = ?,
            aadhaar_last4 = ?, is_cwsn = ?, is_bpl = ?, address = ? WHERE user_id = ?`,
        v.admission_no, toInt(v.class_id), toInt(v.roll_no), v.dob, v.gender, v.category, v.apaar_id, v.aadhaar_last4,
        v.is_cwsn, v.is_bpl, v.address, existing.id);
      } else if (existing.role === 'teacher' || existing.role === 'headmaster') {
        run(`INSERT INTO teachers (user_id, employee_id, designation, qualification, joining_date) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET employee_id = excluded.employee_id, designation = excluded.designation,
          qualification = excluded.qualification, joining_date = excluded.joining_date`,
        existing.id, v.employee_id, v.designation, v.qualification, v.joining_date);
      }
    });
  } catch (err) {
    return renderUserForm(res, v, friendlyDbError(err), true);
  }
  audit(req.user.id, 'user_updated', existing.username, req.ip);
  req.flash('success', 'Details saved.');
  res.redirect(`/hm/users/${existing.id}`);
});

router.post('/users/:id/reset-password', (req, res) => {
  const u = one('SELECT id, username FROM users WHERE id = ?', toInt(req.params.id));
  if (!u) return res.redirect('/hm/users');
  const temp = generatePassword();
  run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', bcrypt.hashSync(temp, 10), u.id);
  run("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid != ?", u.id, req.sessionID);
  audit(req.user.id, 'password_reset', u.username, req.ip);
  req.flash('success', `Password reset for ${u.username}. Temporary password: ${temp} (shown only once).`);
  res.redirect(`/hm/users/${u.id}`);
});

router.post('/users/:id/toggle-active', (req, res) => {
  const u = one('SELECT id, username, is_active FROM users WHERE id = ?', toInt(req.params.id));
  if (!u) return res.redirect('/hm/users');
  if (u.id === req.user.id) {
    req.flash('error', 'You cannot deactivate your own account.');
    return res.redirect(`/hm/users/${u.id}`);
  }
  run('UPDATE users SET is_active = ? WHERE id = ?', u.is_active ? 0 : 1, u.id);
  if (u.is_active) run("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?", u.id);
  audit(req.user.id, u.is_active ? 'user_deactivated' : 'user_activated', u.username, req.ip);
  req.flash('success', u.is_active ? 'Account deactivated. The user can no longer sign in.' : 'Account activated.');
  res.redirect(`/hm/users/${u.id}`);
});

router.post('/users/:id/children', (req, res) => {
  const p = one("SELECT id FROM users WHERE id = ? AND role = 'parent'", toInt(req.params.id));
  if (!p) return res.redirect('/hm/users?role=parent');
  const missing = linkChildren(p.id, str(req.body.admission_no, 200), str(req.body.relation, 30));
  if (missing.length) req.flash('error', `Admission number not found: ${missing.join(', ')}`);
  else req.flash('success', 'Child linked to parent account.');
  res.redirect(`/hm/users/${p.id}`);
});

router.post('/users/:id/children/:sid/delete', (req, res) => {
  run('DELETE FROM parent_student WHERE parent_id = ? AND student_id = ?', toInt(req.params.id), toInt(req.params.sid));
  req.flash('success', 'Child unlinked.');
  res.redirect(`/hm/users/${toInt(req.params.id)}`);
});

/* ---------------- Classes, subjects, timetable ---------------- */

function teachersList() {
  return all("SELECT id, full_name FROM users WHERE role IN ('teacher','headmaster') AND is_active = 1 ORDER BY full_name");
}

router.get('/classes', (req, res) => {
  res.render('headmaster/classes', { title: 'Classes', classes: A.allClasses(), teachers: teachersList() });
});

router.post('/classes', (req, res) => {
  const name = str(req.body.name, 10);
  const section = str(req.body.section, 5).toUpperCase() || 'A';
  if (!name) {
    req.flash('error', 'Class name is required.');
    return res.redirect('/hm/classes');
  }
  try {
    run('INSERT INTO classes (name, section, class_teacher_id) VALUES (?, ?, ?)', name, section, toInt(req.body.class_teacher_id));
    req.flash('success', `Class ${name}-${section} created.`);
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) throw err;
    req.flash('error', `Class ${name}-${section} already exists.`);
  }
  res.redirect('/hm/classes');
});

router.get('/classes/:id', (req, res) => {
  const cls = one('SELECT c.*, u.full_name AS class_teacher_name FROM classes c LEFT JOIN users u ON u.id = c.class_teacher_id WHERE c.id = ?', toInt(req.params.id));
  if (!cls) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Class not found.' });
  const classSubjects = all(`SELECT cs.subject_id, s.name AS subject_name, u.full_name AS teacher_name, cs.teacher_id
    FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id LEFT JOIN users u ON u.id = cs.teacher_id
    WHERE cs.class_id = ? ORDER BY s.name`, cls.id);
  res.render('headmaster/class_detail', {
    title: `Class ${cls.name}-${cls.section}`,
    cls, classSubjects,
    subjects: all('SELECT * FROM subjects ORDER BY name'),
    teachers: teachersList(),
    students: A.studentsInClass(cls.id),
    timetable: A.timetableForClass(cls.id),
    DAYS, PERIODS,
  });
});

router.post('/classes/:id/class-teacher', (req, res) => {
  const id = toInt(req.params.id);
  run('UPDATE classes SET class_teacher_id = ? WHERE id = ?', toInt(req.body.class_teacher_id), id);
  req.flash('success', 'Class teacher updated.');
  res.redirect(`/hm/classes/${id}`);
});

router.post('/classes/:id/subjects', (req, res) => {
  const id = toInt(req.params.id);
  const subjectId = toInt(req.body.subject_id);
  if (subjectId) {
    run(`INSERT INTO class_subjects (class_id, subject_id, teacher_id) VALUES (?, ?, ?)
      ON CONFLICT(class_id, subject_id) DO UPDATE SET teacher_id = excluded.teacher_id`, id, subjectId, toInt(req.body.teacher_id));
    req.flash('success', 'Subject assignment saved.');
  }
  res.redirect(`/hm/classes/${id}`);
});

router.post('/classes/:id/subjects/:sid/delete', (req, res) => {
  const id = toInt(req.params.id);
  run('DELETE FROM class_subjects WHERE class_id = ? AND subject_id = ?', id, toInt(req.params.sid));
  req.flash('success', 'Subject removed from class.');
  res.redirect(`/hm/classes/${id}`);
});

router.post('/classes/:id/timetable', (req, res) => {
  const id = toInt(req.params.id);
  const day = toInt(req.body.day);
  const period = toInt(req.body.period);
  const subjectId = toInt(req.body.subject_id);
  const teacherId = toInt(req.body.teacher_id);
  if (!(day >= 1 && day <= 6 && period >= 1 && period <= 8)) {
    req.flash('error', 'Choose a valid day and period.');
    return res.redirect(`/hm/classes/${id}#timetable`);
  }
  if (!subjectId) {
    run('DELETE FROM timetable WHERE class_id = ? AND day = ? AND period = ?', id, day, period);
    req.flash('success', 'Period cleared.');
    return res.redirect(`/hm/classes/${id}#timetable`);
  }
  if (teacherId) {
    const clash = one(`SELECT c.name, c.section FROM timetable t JOIN classes c ON c.id = t.class_id
      WHERE t.teacher_id = ? AND t.day = ? AND t.period = ? AND t.class_id != ?`, teacherId, day, period, id);
    if (clash) {
      req.flash('error', `That teacher already has Class ${clash.name}-${clash.section} on ${DAYS[day]}, period ${period}.`);
      return res.redirect(`/hm/classes/${id}#timetable`);
    }
  }
  run(`INSERT INTO timetable (class_id, day, period, subject_id, teacher_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(class_id, day, period) DO UPDATE SET subject_id = excluded.subject_id, teacher_id = excluded.teacher_id`,
  id, day, period, subjectId, teacherId);
  req.flash('success', `Timetable updated for ${DAYS[day]}, period ${period}.`);
  res.redirect(`/hm/classes/${id}#timetable`);
});

router.post('/classes/:id/delete', (req, res) => {
  const id = toInt(req.params.id);
  const n = one('SELECT COUNT(*) AS n FROM students WHERE class_id = ?', id).n;
  if (n > 0) {
    req.flash('error', 'Move or remove all students from this class before deleting it.');
    return res.redirect(`/hm/classes/${id}`);
  }
  run('DELETE FROM classes WHERE id = ?', id);
  req.flash('success', 'Class deleted.');
  res.redirect('/hm/classes');
});

router.get('/subjects', (req, res) => {
  const subjects = all(`SELECT s.*, (SELECT COUNT(*) FROM class_subjects cs WHERE cs.subject_id = s.id) AS class_count
    FROM subjects s ORDER BY s.name`);
  res.render('headmaster/subjects', { title: 'Subjects', subjects });
});

router.post('/subjects', (req, res) => {
  const name = str(req.body.name, 60);
  if (!name) {
    req.flash('error', 'Subject name is required.');
    return res.redirect('/hm/subjects');
  }
  try {
    run('INSERT INTO subjects (name, code) VALUES (?, ?)', name, str(req.body.code, 10));
    req.flash('success', 'Subject added.');
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) throw err;
    req.flash('error', 'A subject with that name already exists.');
  }
  res.redirect('/hm/subjects');
});

/* ---------------- Exams ---------------- */

router.get('/exams', (req, res) => {
  const exams = all(`SELECT e.*, (SELECT COUNT(DISTINCT student_id) FROM marks m WHERE m.exam_id = e.id) AS students_with_marks
    FROM exams e ORDER BY e.academic_year DESC, e.exam_date DESC, e.id DESC`);
  res.render('headmaster/exams', { title: 'Exams', exams, year: academicYear() });
});

router.post('/exams', (req, res) => {
  const name = str(req.body.name, 80);
  const max = toInt(req.body.max_marks);
  const date = str(req.body.exam_date, 10);
  const year = /^\d{4}-\d{2}$/.test(req.body.academic_year) ? req.body.academic_year : academicYear();
  if (!name || !(max > 0 && max <= 1000) || (date && !isValidDate(date))) {
    req.flash('error', 'Exam name, maximum marks (1-1000) and a valid date are required.');
    return res.redirect('/hm/exams');
  }
  run('INSERT INTO exams (name, max_marks, exam_date, academic_year) VALUES (?, ?, ?, ?)', name, max, date, year);
  req.flash('success', 'Exam created. Subject teachers can now enter marks.');
  res.redirect('/hm/exams');
});

router.post('/exams/:id/delete', (req, res) => {
  const id = toInt(req.params.id);
  if (one('SELECT 1 AS x FROM marks WHERE exam_id = ? LIMIT 1', id)) {
    req.flash('error', 'Marks have already been entered for this exam, so it cannot be deleted.');
  } else {
    run('DELETE FROM exams WHERE id = ?', id);
    req.flash('success', 'Exam deleted.');
  }
  res.redirect('/hm/exams');
});

/* ---------------- Attendance reports ---------------- */

router.get('/reports/attendance', (req, res) => {
  const today = localDate();
  const from = isValidDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
  const to = isValidDate(req.query.to) ? req.query.to : today;
  const classId = toInt(req.query.class_id);
  const classes = A.allClasses();
  let rows;
  if (classId) {
    rows = all(`SELECT u.id, u.full_name, s.admission_no, s.roll_no,
        COALESCE(SUM(a.status = 'P'), 0) AS present, COALESCE(SUM(a.status = 'A'), 0) AS absent,
        COALESCE(SUM(a.status = 'L'), 0) AS leave, COUNT(a.student_id) AS total
      FROM students s JOIN users u ON u.id = s.user_id
      LEFT JOIN attendance a ON a.student_id = s.user_id AND a.date BETWEEN ? AND ?
      WHERE s.class_id = ? AND u.is_active = 1
      GROUP BY u.id ORDER BY s.roll_no, u.full_name`, from, to, classId);
  } else {
    rows = all(`SELECT c.id, c.name, c.section, COUNT(DISTINCT s.user_id) AS students,
        COALESCE(SUM(a.status = 'P'), 0) AS present, COALESCE(SUM(a.status = 'A'), 0) AS absent,
        COALESCE(SUM(a.status = 'L'), 0) AS leave, COUNT(a.student_id) AS total
      FROM classes c LEFT JOIN students s ON s.class_id = c.id
      LEFT JOIN users u ON u.id = s.user_id AND u.is_active = 1
      LEFT JOIN attendance a ON a.student_id = u.id AND a.date BETWEEN ? AND ?
      GROUP BY c.id ORDER BY CAST(c.name AS INTEGER), c.section`, from, to);
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
    lowAttendance: A.lowAttendance(),
  });
});

/* ---------------- Staff attendance ---------------- */

router.get('/staff-attendance', (req, res) => {
  const date = isValidDate(req.query.date) && req.query.date <= localDate() ? req.query.date : localDate();
  const staff = all(`SELECT u.id, u.full_name, t.designation, ta.status, ta.check_in_time
    FROM users u LEFT JOIN teachers t ON t.user_id = u.id
    LEFT JOIN teacher_attendance ta ON ta.teacher_id = u.id AND ta.date = ?
    WHERE u.role IN ('teacher','headmaster') AND u.is_active = 1 ORDER BY u.full_name`, date);
  const monthStart = `${date.slice(0, 7)}-01`;
  const monthly = all(`SELECT u.id, u.full_name, COALESCE(SUM(ta.status = 'P'), 0) AS present, COALESCE(SUM(ta.status = 'A'), 0) AS absent,
      COALESCE(SUM(ta.status = 'L'), 0) AS leave
    FROM users u LEFT JOIN teacher_attendance ta ON ta.teacher_id = u.id AND ta.date BETWEEN ? AND ?
    WHERE u.role IN ('teacher','headmaster') AND u.is_active = 1 GROUP BY u.id ORDER BY u.full_name`, monthStart, date);
  res.render('headmaster/staff_attendance', { title: 'Staff Attendance', date, staff, monthly });
});

router.post('/staff-attendance', (req, res) => {
  const date = isValidDate(req.body.date) && req.body.date <= localDate() ? req.body.date : null;
  if (!date) {
    req.flash('error', 'Invalid date.');
    return res.redirect('/hm/staff-attendance');
  }
  const staffIds = all("SELECT id FROM users WHERE role IN ('teacher','headmaster') AND is_active = 1").map((r) => r.id);
  tx(() => {
    for (const id of staffIds) {
      const status = req.body[`status_${id}`];
      if (!['P', 'A', 'L'].includes(status)) continue;
      run(`INSERT INTO teacher_attendance (teacher_id, date, status, check_in_time) VALUES (?, ?, ?, ?)
        ON CONFLICT(teacher_id, date) DO UPDATE SET status = excluded.status`, id, date, status, status === 'P' ? localTime() : null);
    }
  });
  req.flash('success', 'Staff attendance saved.');
  res.redirect(`/hm/staff-attendance?date=${date}`);
});

/* ---------------- Mid-Day Meal (PM POSHAN) ---------------- */

router.get('/mdm', (req, res) => {
  const date = isValidDate(req.query.date) ? req.query.date : localDate();
  const existing = one('SELECT * FROM midday_meals WHERE date = ?', date);
  const presentToday = one(`SELECT COUNT(*) AS n FROM attendance a JOIN users u ON u.id = a.student_id
    WHERE a.date = ? AND a.status = 'P' AND u.is_active = 1`, date).n;
  const records = all(`SELECT m.*, u.full_name AS recorded_by_name FROM midday_meals m
    LEFT JOIN users u ON u.id = m.recorded_by ORDER BY m.date DESC LIMIT 60`);
  const monthStart = `${localDate().slice(0, 7)}-01`;
  const month = one(`SELECT COUNT(*) AS days, COALESCE(SUM(meals_served), 0) AS meals, COALESCE(SUM(students_present), 0) AS present
    FROM midday_meals WHERE date >= ?`, monthStart);
  res.render('headmaster/mdm', { title: 'Mid-Day Meal (PM POSHAN)', date, existing, presentToday, records, month });
});

router.post('/mdm', (req, res) => {
  const date = str(req.body.date, 10);
  const menu = str(req.body.menu, 300);
  const present = toInt(req.body.students_present, 0);
  const served = toInt(req.body.meals_served, 0);
  if (!isValidDate(date) || date > localDate() || !menu || present < 0 || served < 0) {
    req.flash('error', 'A valid date (not in the future), menu and non-negative counts are required.');
    return res.redirect('/hm/mdm');
  }
  run(`INSERT INTO midday_meals (date, menu, students_present, meals_served, quality_checked, remarks, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET menu = excluded.menu, students_present = excluded.students_present,
      meals_served = excluded.meals_served, quality_checked = excluded.quality_checked, remarks = excluded.remarks, recorded_by = excluded.recorded_by`,
  date, menu, present, served, req.body.quality_checked === '1' ? 1 : 0, str(req.body.remarks, 500), req.user.id);
  req.flash('success', `Mid-day meal record saved for ${date}.`);
  res.redirect('/hm/mdm');
});

/* ---------------- Scholarships ---------------- */

router.get('/scholarships', (req, res) => {
  const status = SCHOLARSHIP_STATUS.includes(req.query.status) ? req.query.status : null;
  const rows = all(`SELECT sc.*, u.full_name, s.admission_no, s.category, c.name AS class_name, c.section
    FROM scholarships sc JOIN users u ON u.id = sc.student_id JOIN students s ON s.user_id = sc.student_id
    LEFT JOIN classes c ON c.id = s.class_id
    WHERE (? IS NULL OR sc.status = ?) ORDER BY sc.id DESC LIMIT 500`, status, status);
  const summary = all('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM scholarships WHERE academic_year = ? GROUP BY status', academicYear());
  res.render('headmaster/scholarships', { title: 'Scholarships', rows, summary, status, SCHEMES, SCHOLARSHIP_STATUS, year: academicYear() });
});

router.post('/scholarships', (req, res) => {
  const s = one('SELECT user_id FROM students WHERE admission_no = ?', str(req.body.admission_no, 30));
  const scheme = str(req.body.scheme_name, 150);
  const status = SCHOLARSHIP_STATUS.includes(req.body.status) ? req.body.status : 'applied';
  const amount = req.body.amount ? Number(req.body.amount) : null;
  const appliedOn = isValidDate(req.body.applied_on) ? req.body.applied_on : localDate();
  if (!s || !scheme || (amount !== null && !(amount >= 0))) {
    req.flash('error', s ? 'Scheme name and a valid amount are required.' : 'No student found with that admission number.');
    return res.redirect('/hm/scholarships');
  }
  run('INSERT INTO scholarships (student_id, scheme_name, amount, academic_year, status, applied_on, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)',
    s.user_id, scheme, amount, academicYear(), status, appliedOn, str(req.body.remarks, 300));
  req.flash('success', 'Scholarship application recorded.');
  res.redirect('/hm/scholarships');
});

router.post('/scholarships/:id/status', (req, res) => {
  const status = SCHOLARSHIP_STATUS.includes(req.body.status) ? req.body.status : null;
  if (status) {
    run('UPDATE scholarships SET status = ?, remarks = COALESCE(?, remarks) WHERE id = ?', status, str(req.body.remarks, 300), toInt(req.params.id));
    req.flash('success', 'Scholarship status updated.');
  }
  res.redirect('/hm/scholarships');
});

/* ---------------- Entitlements (free textbooks, uniforms...) ---------------- */

router.get('/entitlements', (req, res) => {
  const year = academicYear();
  const classes = A.allClasses();
  const byClass = all(`SELECT s.class_id, e.item, COUNT(*) AS n FROM entitlements e JOIN students s ON s.user_id = e.student_id
    JOIN users u ON u.id = s.user_id WHERE e.academic_year = ? AND u.is_active = 1 GROUP BY s.class_id, e.item`, year);
  const matrix = classes.map((c) => ({
    ...c,
    items: Object.fromEntries(ITEMS.map((it) => [it, (byClass.find((r) => r.class_id === c.id && r.item === it) || { n: 0 }).n])),
  }));
  res.render('headmaster/entitlements', { title: 'Free Textbooks & Uniforms', matrix, ITEMS, year, today: localDate() });
});

router.post('/entitlements', (req, res) => {
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
    const s = one('SELECT user_id FROM students WHERE admission_no = ?', adm);
    if (!s) {
      req.flash('error', 'No student found with that admission number.');
      return res.redirect('/hm/entitlements');
    }
    targets = [s.user_id];
  } else if (toInt(req.body.class_id)) {
    targets = A.studentsInClass(toInt(req.body.class_id)).map((s) => s.id);
  }
  let added = 0;
  tx(() => {
    for (const id of targets) {
      added += Number(run(`INSERT OR IGNORE INTO entitlements (student_id, item, academic_year, distributed_on, recorded_by)
        VALUES (?, ?, ?, ?, ?)`, id, item, year, date, req.user.id).changes);
    }
  });
  req.flash('success', `${item}: recorded for ${added} student(s). ${targets.length - added} already had it this year.`);
  res.redirect('/hm/entitlements');
});

/* ---------------- Grievances ---------------- */

router.get('/grievances', (req, res) => {
  const status = ['open', 'in_progress', 'resolved'].includes(req.query.status) ? req.query.status : null;
  const rows = all(`SELECT g.*, u.full_name AS raised_by_name, r.full_name AS responded_by_name
    FROM grievances g LEFT JOIN users u ON u.id = g.raised_by LEFT JOIN users r ON r.id = g.responded_by
    WHERE (? IS NULL OR g.status = ?) ORDER BY (g.status = 'resolved'), g.id DESC LIMIT 300`, status, status);
  res.render('headmaster/grievances', { title: 'Grievances & Suggestions', rows, status });
});

router.post('/grievances/:id', (req, res) => {
  const status = ['open', 'in_progress', 'resolved'].includes(req.body.status) ? req.body.status : 'in_progress';
  run("UPDATE grievances SET status = ?, response = ?, responded_by = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    status, str(req.body.response, 2000), req.user.id, toInt(req.params.id));
  req.flash('success', 'Response saved.');
  res.redirect('/hm/grievances');
});

/* ---------------- Self-registrations: headmaster verifies teachers (and student/parent requests with no class teacher) ---------------- */

require('./registrationReview')(router, '/hm/registrations');

/* ---------------- Audit log ---------------- */

router.get('/audit', (req, res) => {
  const rows = all(`SELECT a.*, u.full_name, u.username, u.role FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT 300`);
  res.render('headmaster/audit', { title: 'Audit Log', rows });
});

module.exports = router;
module.exports.dashboard = dashboard;
