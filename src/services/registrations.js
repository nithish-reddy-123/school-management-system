'use strict';
/*
 * Self-registration review workflow.
 *  - Student  -> verified by the class teacher of the class they chose.
 *  - Parent   -> verified by the class teacher of a child's class (children matched by admission number).
 *  - Teacher  -> verified by the headmaster.
 * If no class teacher is available (class has none, or no child matched), the request falls back to the headmaster.
 */
const { col, clean, insertWithId, dupKey, audit } = require('../db');
const { str, toInt, nowLocal } = require('../utils');

const RELATION_LABEL = { father: 'Father', mother: 'Mother', guardian: 'Guardian' };

class ReviewError extends Error {}

function parseDetails(r) {
  try {
    return JSON.parse(r.details || '{}');
  } catch {
    return {};
  }
}

async function classWithTeacher(classId) {
  if (!classId) return null;
  const c = await col('classes').findOne({ id: classId });
  if (!c) return null;
  const t = c.class_teacher_id ? await col('users').findOne({ id: c.class_teacher_id, is_active: 1, role: 'teacher' }) : null;
  return { id: c.id, name: c.name, section: c.section, class_teacher_id: c.class_teacher_id ?? null, class_teacher_name: t ? t.full_name : null };
}

/** Children listed by a parent, matched to students by admission number. */
async function matchChildren(d) {
  const list = String(d.children || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  return Promise.all(list.map(async (adm) => {
    const s = await col('users').findOne({ role: 'student', admission_no: adm, is_active: 1 }, { projection: { id: 1, full_name: 1, class_id: 1 } });
    return { adm, student: s ? { id: s.id, full_name: s.full_name, class_id: s.class_id } : null, cls: s ? await classWithTeacher(s.class_id) : null };
  }));
}

/** Who is allowed to verify this request. */
async function routeOf(r, d = parseDetails(r)) {
  if (r.role === 'teacher') return { reviewers: [], toHeadmaster: true, label: 'Headmaster' };
  if (r.role === 'student') {
    const cls = await classWithTeacher(d.class_id);
    if (cls && cls.class_teacher_name) {
      return { reviewers: [cls.class_teacher_id], toHeadmaster: false, label: `Class teacher ${cls.class_teacher_name} (Class ${cls.name}-${cls.section})` };
    }
    return { reviewers: [], toHeadmaster: true, label: 'Headmaster (the class has no class teacher)' };
  }
  const withTeacher = (await matchChildren(d)).filter((c) => c.cls && c.cls.class_teacher_name);
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

async function canReview(r, user, route) {
  if (r.status !== 'pending' || !user) return false;
  const rt = route || await routeOf(r);
  if (user.role === 'headmaster') return rt.toHeadmaster;
  if (user.role === 'teacher') return rt.reviewers.includes(user.id);
  return false;
}

/** Adds everything a reviewer needs: class, matched children, conflicts, routing and permission. */
async function describe(r, viewer) {
  const d = parseDetails(r);
  const route = await routeOf(r, d);
  const info = { ...r, d, warnings: [], route };
  info.canReview = await canReview(r, viewer, route);
  if (r.status === 'pending' && await col('users').findOne({ username: r.username })) {
    info.warnings.push(`Username "${r.username}" is already used by an existing account; ask the person to register again with another username.`);
  }
  if (r.role === 'student') {
    info.cls = await classWithTeacher(d.class_id);
    if (d.admission_no) {
      const ex = await col('users').findOne({ admission_no: d.admission_no });
      if (ex) info.warnings.push(`Admission number ${d.admission_no} already belongs to ${ex.full_name}.`);
    }
  } else if (r.role === 'parent') {
    info.children = await matchChildren(d);
    if (info.children.some((c) => !c.student)) info.warnings.push('Some admission numbers do not match any student.');
    if (viewer && viewer.role === 'teacher') {
      info.children.forEach((c) => { c.mine = !!(c.cls && c.cls.class_teacher_id === viewer.id); });
    }
  } else if (r.role === 'teacher' && d.employee_id) {
    if (await col('users').findOne({ employee_id: d.employee_id })) info.warnings.push(`Employee ID ${d.employee_id} already exists.`);
  }
  return info;
}

async function pendingRequests() {
  return col('registrations').find({ status: 'pending' }, { projection: { _id: 0 } }).sort({ id: 1 }).toArray();
}

/** Pending requests this user can act on. */
async function pendingFor(user) {
  const out = [];
  for (const r of await pendingRequests()) if (await canReview(r, user)) out.push(r);
  return out;
}

async function pendingCount(user) {
  if (!user || !['headmaster', 'teacher'].includes(user.role)) return 0;
  if (user.role === 'teacher') {
    // Cheap pre-checks so teachers without a class don't trigger the full routing logic on every page.
    if (!await col('classes').findOne({ class_teacher_id: user.id })) return 0;
    if (!await col('registrations').findOne({ status: 'pending', role: { $in: ['student', 'parent'] } })) return 0;
  } else if (!await col('registrations').findOne({ status: 'pending' })) return 0;
  return (await pendingFor(user)).length;
}

function friendlyDbError(err) {
  const key = dupKey(err);
  if (key === 'username') return 'That username is already taken.';
  if (key === 'admission_no') return 'That admission number already exists.';
  if (key === 'employee_id') return 'That employee ID already exists.';
  throw err;
}

/** Creates the real account. Returns { userId, reg, notes }. Throws ReviewError with a readable message. */
async function approve(regId, user, body, ip) {
  const r = await col('registrations').findOne({ id: toInt(regId), status: 'pending' });
  if (!r) throw new ReviewError('Registration not found or already reviewed.');
  if (!await canReview(r, user)) throw new ReviewError('You are not the verifier for this registration.');
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
    const all = await matchChildren(d);
    const matched = all.filter((c) => c.student);
    // A class teacher can only vouch for children in their own class; others can be linked later by the headmaster.
    children = user.role === 'teacher' ? matched.filter((c) => c.cls && c.cls.class_teacher_id === user.id) : matched;
    const skipped = matched.filter((c) => !children.includes(c));
    if (skipped.length) notes.push(`Not linked (other class teacher's student): ${skipped.map((c) => c.student.full_name).join(', ')}. The headmaster can link them from the parent's page.`);
    const unmatched = all.filter((c) => !c.student);
    if (unmatched.length) notes.push(`Admission number not found: ${unmatched.map((c) => c.adm).join(', ')}.`);
  }

  // The account (including student/teacher details) is one document, so creating it is a single atomic write.
  const doc = {
    username: r.username, password_hash: r.password_hash, role: r.role, full_name: r.full_name,
    phone: r.phone || null, email: r.email || null, is_active: 1, must_change_password: 0, last_login: null, created_at: nowLocal(),
  };
  if (r.role === 'student') {
    Object.assign(doc, clean({ admission_no: admissionNo, class_id: classId, roll_no: toInt(body.roll_no), dob: d.dob, gender: d.gender, category: null, apaar_id: null, aadhaar_last4: null, address: d.address }), { is_cwsn: 0, is_bpl: 0 });
  } else if (r.role === 'teacher') {
    Object.assign(doc, clean({ employee_id: str(body.employee_id, 30) || d.employee_id, designation: str(body.designation, 80) || d.designation, qualification: d.qualification, joining_date: null }));
  }
  let userId;
  try {
    userId = await insertWithId('users', doc);
  } catch (err) {
    throw new ReviewError(`Could not approve ${r.username}: ${friendlyDbError(err)}`);
  }
  for (const c of children) {
    await col('parent_student').updateOne(
      { parent_id: userId, student_id: c.student.id },
      { $setOnInsert: { parent_id: userId, student_id: c.student.id, relation: RELATION_LABEL[d.relation] || 'Guardian' } },
      { upsert: true },
    );
  }
  await col('registrations').updateOne({ id: r.id }, { $set: { status: 'approved', reviewed_by: user.id, reviewed_at: nowLocal(), user_id: userId } });
  await audit(user.id, 'registration_approved', `${r.role} ${r.username}`, ip);
  return { userId, reg: r, notes };
}

async function reject(regId, user, note, ip) {
  const r = await col('registrations').findOne({ id: toInt(regId), status: 'pending' });
  if (!r) throw new ReviewError('Registration not found or already reviewed.');
  if (!await canReview(r, user)) throw new ReviewError('You are not the verifier for this registration.');
  await col('registrations').updateOne({ id: r.id }, { $set: { status: 'rejected', review_note: str(note, 300) || null, reviewed_by: user.id, reviewed_at: nowLocal() } });
  await audit(user.id, 'registration_rejected', `${r.role} ${r.username}`, ip);
  return r;
}

/** Rows for the review page. Headmaster sees everything; a teacher sees requests routed to them and those they reviewed. */
async function listFor(user, status) {
  const rows = await col('registrations').find({ status }, { projection: { _id: 0 } }).sort({ id: status === 'pending' ? 1 : -1 }).limit(300).toArray();
  const reviewers = await col('users').find({ id: { $in: rows.map((r) => r.reviewed_by).filter(Boolean) } }, { projection: { id: 1, full_name: 1 } }).toArray();
  const names = new Map(reviewers.map((u) => [u.id, u.full_name]));
  const out = [];
  for (const r of rows) {
    r.reviewed_by_name = names.get(r.reviewed_by) || null;
    const visible = user.role === 'headmaster' || (status === 'pending' ? await canReview(r, user) : r.reviewed_by === user.id);
    if (visible) out.push(await describe(r, user));
  }
  return out;
}

async function countsFor(user) {
  const match = user.role === 'headmaster' ? {} : { reviewed_by: user.id };
  const rows = await col('registrations').aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
  const counts = Object.fromEntries(rows.map((c) => [c._id, c.n]));
  if (user.role !== 'headmaster') counts.pending = (await pendingFor(user)).length;
  return counts;
}

module.exports = { ReviewError, RELATION_LABEL, approve, reject, listFor, countsFor, pendingCount, describe };
