'use strict';
/*
 * Self-registration review workflow.
 *  - Student  -> verified by the class teacher of the class they chose.
 *  - Parent   -> verified by the class teacher of a child's class (children matched by admission number).
 *  - Teacher  -> verified by the headmaster.
 * If no class teacher is available (class has none, or no child matched), the request falls back to the headmaster.
 */
const { one, all, run, tx, audit } = require('../db');
const { str, toInt } = require('../utils');

const RELATION_LABEL = { father: 'Father', mother: 'Mother', guardian: 'Guardian' };

class ReviewError extends Error {}

function parseDetails(r) {
  try {
    return JSON.parse(r.details || '{}');
  } catch {
    return {};
  }
}

function classWithTeacher(classId) {
  return classId ? one(`SELECT c.id, c.name, c.section, c.class_teacher_id, u.full_name AS class_teacher_name
    FROM classes c LEFT JOIN users u ON u.id = c.class_teacher_id AND u.is_active = 1 AND u.role = 'teacher'
    WHERE c.id = ?`, classId) : null;
}

/** Children listed by a parent, matched to students by admission number. */
function matchChildren(d) {
  return String(d.children || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10).map((adm) => {
    const s = one(`SELECT u.id, u.full_name, s.class_id FROM students s JOIN users u ON u.id = s.user_id
      WHERE s.admission_no = ? AND u.is_active = 1`, adm);
    return { adm, student: s || null, cls: s ? classWithTeacher(s.class_id) : null };
  });
}

/** Who is allowed to verify this request. */
function routeOf(r, d = parseDetails(r)) {
  if (r.role === 'teacher') return { reviewers: [], toHeadmaster: true, label: 'Headmaster' };
  if (r.role === 'student') {
    const cls = classWithTeacher(d.class_id);
    if (cls && cls.class_teacher_name) {
      return { reviewers: [cls.class_teacher_id], toHeadmaster: false, label: `Class teacher ${cls.class_teacher_name} (Class ${cls.name}-${cls.section})` };
    }
    return { reviewers: [], toHeadmaster: true, label: 'Headmaster (the class has no class teacher)' };
  }
  const withTeacher = matchChildren(d).filter((c) => c.cls && c.cls.class_teacher_name);
  if (withTeacher.length) {
    const unique = [...new Map(withTeacher.map((c) => [c.cls.class_teacher_id, c.cls])).values()];
    return {
      reviewers: unique.map((c) => c.class_teacher_id),
      toHeadmaster: false,
      label: unique.map((c) => `Class teacher ${c.class_teacher_name} (Class ${c.name}-${c.section})`).join(' or '),
    };
  }
  return { reviewers: [], toHeadmaster: true, label: 'Headmaster (no matching child with a class teacher)' };
}

function canReview(r, user) {
  if (r.status !== 'pending' || !user) return false;
  const route = routeOf(r);
  if (user.role === 'headmaster') return route.toHeadmaster;
  if (user.role === 'teacher') return route.reviewers.includes(user.id);
  return false;
}

/** Adds everything a reviewer needs: class, matched children, conflicts, routing and permission. */
function describe(r, viewer) {
  const d = parseDetails(r);
  const info = { ...r, d, warnings: [], route: routeOf(r, d) };
  info.canReview = canReview(r, viewer);
  if (r.status === 'pending' && one('SELECT 1 AS x FROM users WHERE username = ?', r.username)) {
    info.warnings.push(`Username "${r.username}" is already used by an existing account; ask the person to register again with another username.`);
  }
  if (r.role === 'student') {
    info.cls = classWithTeacher(d.class_id);
    if (d.admission_no) {
      const ex = one('SELECT u.full_name FROM students s JOIN users u ON u.id = s.user_id WHERE s.admission_no = ?', d.admission_no);
      if (ex) info.warnings.push(`Admission number ${d.admission_no} already belongs to ${ex.full_name}.`);
    }
  } else if (r.role === 'parent') {
    info.children = matchChildren(d);
    if (info.children.some((c) => !c.student)) info.warnings.push('Some admission numbers do not match any student.');
    if (viewer && viewer.role === 'teacher') {
      info.children.forEach((c) => { c.mine = !!(c.cls && c.cls.class_teacher_id === viewer.id); });
    }
  } else if (r.role === 'teacher' && d.employee_id) {
    if (one('SELECT 1 AS x FROM teachers WHERE employee_id = ?', d.employee_id)) info.warnings.push(`Employee ID ${d.employee_id} already exists.`);
  }
  return info;
}

/** Pending requests this user can act on. */
function pendingFor(user) {
  return all("SELECT * FROM registrations WHERE status = 'pending' ORDER BY id").filter((r) => canReview(r, user));
}

function pendingCount(user) {
  if (!user || !['headmaster', 'teacher'].includes(user.role)) return 0;
  if (user.role === 'teacher') {
    // Cheap pre-check so teachers without a class don't trigger the full routing logic on every page.
    if (!one('SELECT 1 AS x FROM classes WHERE class_teacher_id = ?', user.id)) return 0;
    if (!one("SELECT 1 AS x FROM registrations WHERE status = 'pending' AND role IN ('student','parent')")) return 0;
  }
  return pendingFor(user).length;
}

function friendlyDbError(err) {
  const m = String(err.message);
  if (m.includes('users.username')) return 'That username is already taken.';
  if (m.includes('students.admission_no')) return 'That admission number already exists.';
  if (m.includes('teachers.employee_id')) return 'That employee ID already exists.';
  throw err;
}

/** Creates the real account. Returns { userId, notes }. Throws ReviewError with a readable message. */
function approve(regId, user, body, ip) {
  const r = one("SELECT * FROM registrations WHERE id = ? AND status = 'pending'", toInt(regId));
  if (!r) throw new ReviewError('Registration not found or already reviewed.');
  if (!canReview(r, user)) throw new ReviewError('You are not the verifier for this registration.');
  const d = parseDetails(r);
  const notes = [];

  let classId = toInt(d.class_id);
  const admissionNo = str(body.admission_no, 30);
  if (r.role === 'student') {
    // Class teachers admit into their own class; the headmaster (fallback) may choose the class.
    if (user.role === 'headmaster') classId = toInt(body.class_id);
    if (!admissionNo || !classId) throw new ReviewError('Enter an admission number (and class) before approving a student.');
  }

  let children = [];
  if (r.role === 'parent') {
    const matched = matchChildren(d).filter((c) => c.student);
    // A class teacher can only vouch for children in their own class; others can be linked later by the headmaster.
    children = user.role === 'teacher' ? matched.filter((c) => c.cls && c.cls.class_teacher_id === user.id) : matched;
    const skipped = matched.filter((c) => !children.includes(c));
    if (skipped.length) notes.push(`Not linked (other class teacher's student): ${skipped.map((c) => c.student.full_name).join(', ')}. The headmaster can link them from the parent's page.`);
    const unmatched = matchChildren(d).filter((c) => !c.student);
    if (unmatched.length) notes.push(`Admission number not found: ${unmatched.map((c) => c.adm).join(', ')}.`);
  }

  let userId;
  try {
    userId = tx(() => {
      const u = run(`INSERT INTO users (username, password_hash, role, full_name, phone, email, must_change_password)
        VALUES (?, ?, ?, ?, ?, ?, 0)`, r.username, r.password_hash, r.role, r.full_name, r.phone, r.email);
      const uid = Number(u.lastInsertRowid);
      if (r.role === 'student') {
        run('INSERT INTO students (user_id, admission_no, class_id, roll_no, dob, gender, address) VALUES (?, ?, ?, ?, ?, ?, ?)',
          uid, admissionNo, classId, toInt(body.roll_no), d.dob, d.gender, d.address);
      } else if (r.role === 'teacher') {
        run('INSERT INTO teachers (user_id, employee_id, designation, qualification) VALUES (?, ?, ?, ?)',
          uid, str(body.employee_id, 30) || d.employee_id, str(body.designation, 80) || d.designation, d.qualification);
      } else {
        for (const c of children) {
          run('INSERT OR IGNORE INTO parent_student (parent_id, student_id, relation) VALUES (?, ?, ?)', uid, c.student.id, RELATION_LABEL[d.relation] || 'Guardian');
        }
      }
      run("UPDATE registrations SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now','localtime'), user_id = ? WHERE id = ?",
        user.id, uid, r.id);
      return uid;
    });
  } catch (err) {
    if (err instanceof ReviewError) throw err;
    throw new ReviewError(`Could not approve ${r.username}: ${friendlyDbError(err)}`);
  }
  audit(user.id, 'registration_approved', `${r.role} ${r.username}`, ip);
  return { userId, reg: r, notes };
}

function reject(regId, user, note, ip) {
  const r = one("SELECT * FROM registrations WHERE id = ? AND status = 'pending'", toInt(regId));
  if (!r) throw new ReviewError('Registration not found or already reviewed.');
  if (!canReview(r, user)) throw new ReviewError('You are not the verifier for this registration.');
  run("UPDATE registrations SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?",
    str(note, 300), user.id, r.id);
  audit(user.id, 'registration_rejected', `${r.role} ${r.username}`, ip);
  return r;
}

/** Rows for the review page. Headmaster sees everything; a teacher sees requests routed to them and those they reviewed. */
function listFor(user, status) {
  const rows = all(`SELECT r.*, u.full_name AS reviewed_by_name FROM registrations r LEFT JOIN users u ON u.id = r.reviewed_by
    WHERE r.status = ? ORDER BY r.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 300`, status);
  const visible = user.role === 'headmaster'
    ? rows
    : rows.filter((r) => (status === 'pending' ? canReview(r, user) : r.reviewed_by === user.id));
  return visible.map((r) => describe(r, user));
}

function countsFor(user) {
  if (user.role === 'headmaster') {
    return Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM registrations GROUP BY status').map((c) => [c.status, c.n]));
  }
  const reviewed = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM registrations WHERE reviewed_by = ? GROUP BY status', user.id).map((c) => [c.status, c.n]));
  return { ...reviewed, pending: pendingFor(user).length };
}

module.exports = { ReviewError, RELATION_LABEL, approve, reject, listFor, countsFor, pendingCount, describe };
