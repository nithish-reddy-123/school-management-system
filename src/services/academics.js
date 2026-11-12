'use strict';
const { col, byIds, classSort } = require('../db');
const { localDate, academicYear, grade, percent, DAYS, PERIODS } = require('../utils');

const NO_SECRETS = { _id: 0, password_hash: 0 };
const STUDENT_FIELDS = ['admission_no', 'class_id', 'roll_no', 'dob', 'gender', 'category', 'apaar_id', 'aadhaar_last4', 'is_cwsn', 'is_bpl', 'address'];

function academicYearStart(d = new Date()) {
  return `${academicYear(d).slice(0, 4)}-04-01`;
}

function classLabel(c) {
  if (!c) return '-';
  const name = c.class_name ?? c.name;
  return name ? `Class ${name}-${c.section}` : '-';
}

/** Sort by roll number (blank rolls first, like SQL) then name. */
function byRollThenName(a, b) {
  const ra = a.roll_no ?? -Infinity;
  const rb = b.roll_no ?? -Infinity;
  return ra - rb || String(a.full_name).localeCompare(String(b.full_name));
}

/** Count active students per class id. */
async function studentCountsByClass() {
  const rows = await col('users').aggregate([
    { $match: { role: 'student', is_active: 1, class_id: { $ne: null } } },
    { $group: { _id: '$class_id', n: { $sum: 1 } } },
  ]).toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

async function allClasses() {
  const classes = await col('classes').find({}, { projection: { _id: 0 } }).toArray();
  const [teachers, counts] = await Promise.all([byIds('users', classes.map((c) => c.class_teacher_id), { full_name: 1, id: 1 }), studentCountsByClass()]);
  return classes.map((c) => ({
    ...c,
    class_teacher_name: (teachers.get(c.class_teacher_id) || {}).full_name || null,
    student_count: counts.get(c.id) || 0,
  })).sort(classSort);
}

async function studentRecord(studentId) {
  const u = await col('users').findOne({ id: studentId, role: 'student' }, { projection: NO_SECRETS });
  if (!u) return null;
  for (const f of STUDENT_FIELDS) if (u[f] === undefined) u[f] = null;
  const cls = u.class_id ? await col('classes').findOne({ id: u.class_id }) : null;
  const ct = cls && cls.class_teacher_id ? await col('users').findOne({ id: cls.class_teacher_id }, { projection: { full_name: 1 } }) : null;
  return {
    ...u,
    class_name: cls ? cls.name : null,
    section: cls ? cls.section : null,
    class_teacher_id: cls ? cls.class_teacher_id : null,
    class_teacher_name: ct ? ct.full_name : null,
  };
}

async function studentsInClass(classId) {
  const rows = await col('users').find(
    { role: 'student', class_id: classId, is_active: 1 },
    { projection: { _id: 0, id: 1, full_name: 1, username: 1, admission_no: 1, roll_no: 1, gender: 1, category: 1 } },
  ).toArray();
  return rows.sort(byRollThenName);
}

async function parentsOf(studentId) {
  const links = await col('parent_student').find({ student_id: studentId }).toArray();
  const parents = await byIds('users', links.map((l) => l.parent_id), { id: 1, full_name: 1, phone: 1, username: 1 });
  return links.filter((l) => parents.has(l.parent_id)).map((l) => {
    const p = parents.get(l.parent_id);
    return { id: p.id, full_name: p.full_name, phone: p.phone || null, username: p.username, relation: l.relation || null };
  });
}

async function childrenOf(parentId) {
  const links = await col('parent_student').find({ parent_id: parentId }).toArray();
  const kids = (await col('users').find({ id: { $in: links.map((l) => l.student_id) }, role: 'student', is_active: 1 }).toArray());
  const classes = await byIds('classes', kids.map((k) => k.class_id));
  const relation = new Map(links.map((l) => [l.student_id, l.relation || null]));
  return kids.map((k) => {
    const c = classes.get(k.class_id);
    return {
      id: k.id, full_name: k.full_name, admission_no: k.admission_no, roll_no: k.roll_no ?? null, class_id: k.class_id ?? null,
      class_name: c ? c.name : null, section: c ? c.section : null, relation: relation.get(k.id),
    };
  }).sort((a, b) => a.full_name.localeCompare(b.full_name));
}

async function isParentOf(parentId, studentId) {
  return !!(await col('parent_student').findOne({ parent_id: parentId, student_id: studentId }));
}

/** Classes a teacher is linked to as class teacher or subject teacher. */
async function teacherClasses(teacherId) {
  const subjectClassIds = await col('class_subjects').distinct('class_id', { teacher_id: teacherId });
  const classes = await col('classes').find(
    { $or: [{ class_teacher_id: teacherId }, { id: { $in: subjectClassIds } }] },
    { projection: { _id: 0, id: 1, name: 1, section: 1, class_teacher_id: 1 } },
  ).toArray();
  return classes.map((c) => ({ id: c.id, name: c.name, section: c.section, is_class_teacher: c.class_teacher_id === teacherId ? 1 : 0 })).sort(classSort);
}

async function classTeacherOf(teacherId) {
  const rows = await col('classes').find({ class_teacher_id: teacherId }, { projection: { _id: 0, id: 1, name: 1, section: 1 } }).toArray();
  return rows.sort(classSort);
}

async function teacherAssignments(teacherId) {
  const links = await col('class_subjects').find({ teacher_id: teacherId }).toArray();
  const [classes, subjects] = await Promise.all([byIds('classes', links.map((l) => l.class_id)), byIds('subjects', links.map((l) => l.subject_id))]);
  return links.filter((l) => classes.has(l.class_id) && subjects.has(l.subject_id)).map((l) => {
    const c = classes.get(l.class_id);
    return { class_id: l.class_id, subject_id: l.subject_id, class_name: c.name, section: c.section, subject_name: subjects.get(l.subject_id).name };
  }).sort((a, b) => classSort(a, b) || a.subject_name.localeCompare(b.subject_name));
}

async function teacherCanViewStudent(teacherId, studentId) {
  const s = await col('users').findOne({ id: studentId, role: 'student' }, { projection: { class_id: 1 } });
  if (!s || !s.class_id) return false;
  return (await teacherClasses(teacherId)).some((c) => c.id === s.class_id);
}

/** Present / absent / leave counts per student for a date range. Map studentId -> counts. */
async function attendanceCounts(match) {
  const rows = await col('attendance').aggregate([
    { $match: match },
    { $group: {
      _id: '$student_id',
      present: { $sum: { $cond: [{ $eq: ['$status', 'P'] }, 1, 0] } },
      absent: { $sum: { $cond: [{ $eq: ['$status', 'A'] }, 1, 0] } },
      leave: { $sum: { $cond: [{ $eq: ['$status', 'L'] }, 1, 0] } },
      total: { $sum: 1 },
    } },
  ]).toArray();
  return new Map(rows.map((r) => [r._id, r]));
}

async function attendanceSummary(studentId, from = academicYearStart(), to = localDate()) {
  const r = (await attendanceCounts({ student_id: studentId, date: { $gte: from, $lte: to } })).get(studentId)
    || { present: 0, absent: 0, leave: 0, total: 0 };
  return { present: r.present, absent: r.absent, leave: r.leave, total: r.total, percent: percent(r.present, r.total) };
}

/** Builds a Monday-first month calendar with attendance status and holidays. */
async function attendanceCalendar(studentId, month) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const last = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const [att, hol] = await Promise.all([
    col('attendance').find({ student_id: studentId, date: { $gte: first, $lte: last } }).toArray(),
    col('events').find({ type: 'holiday', date: { $gte: first, $lte: last } }).toArray(),
  ]);
  const statusByDate = Object.fromEntries(att.map((r) => [r.date, r.status]));
  const holidays = Object.fromEntries(hol.map((r) => [r.date, r.title]));
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday = 0
  const cells = Array(offset).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    cells.push({ date, day: d, status: statusByDate[date] || null, holiday: holidays[date] || null, sunday: new Date(y, m - 1, d).getDay() === 0 });
  }
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const values = Object.values(statusByDate);
  const present = values.filter((v) => v === 'P').length;
  return {
    month, weeks,
    label: new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }),
    prev: localDate(new Date(y, m - 2, 1)).slice(0, 7),
    next: localDate(new Date(y, m, 1)).slice(0, 7),
    summary: { present, absent: values.filter((v) => v === 'A').length, leave: values.filter((v) => v === 'L').length, total: values.length, percent: percent(present, values.length) },
  };
}

/** Report card grouped by exam, with per-subject grade, totals and rank within the student's current class. */
async function reportCard(studentId) {
  const student = await col('users').findOne({ id: studentId }, { projection: { class_id: 1 } });
  const marks = await col('marks').find({ student_id: studentId }).toArray();
  if (!marks.length) return [];
  const [exams, subjects] = await Promise.all([byIds('exams', marks.map((m) => m.exam_id)), byIds('subjects', marks.map((m) => m.subject_id))]);
  const rows = marks.filter((m) => exams.has(m.exam_id) && subjects.has(m.subject_id)).map((m) => {
    const e = exams.get(m.exam_id);
    return { exam_id: e.id, exam_name: e.name, max_marks: e.max_marks, exam_date: e.exam_date || null, academic_year: e.academic_year, subject: subjects.get(m.subject_id).name, marks_obtained: m.marks_obtained };
  }).sort((a, b) => String(a.exam_date || '').localeCompare(String(b.exam_date || '')) || a.exam_id - b.exam_id || a.subject.localeCompare(b.subject));

  const list = [];
  const byExam = new Map();
  for (const r of rows) {
    let ex = byExam.get(r.exam_id);
    if (!ex) {
      ex = { id: r.exam_id, name: r.exam_name, max_marks: r.max_marks, exam_date: r.exam_date, academic_year: r.academic_year, subjects: [], total: 0, maxTotal: 0, rank: null };
      byExam.set(r.exam_id, ex);
      list.push(ex);
    }
    const p = percent(r.marks_obtained, r.max_marks);
    ex.subjects.push({ subject: r.subject, marks: r.marks_obtained, percent: p, grade: grade(p) });
    ex.total += r.marks_obtained;
    ex.maxTotal += r.max_marks;
  }

  // Rank = 1 + number of classmates with a higher total in the same exam.
  let totals = [];
  if (student && student.class_id) {
    const classmates = await col('users').distinct('id', { role: 'student', class_id: student.class_id });
    totals = await col('marks').aggregate([
      { $match: { exam_id: { $in: list.map((e) => e.id) }, student_id: { $in: classmates } } },
      { $group: { _id: { exam: '$exam_id', student: '$student_id' }, total: { $sum: '$marks_obtained' } } },
    ]).toArray();
  }
  for (const ex of list) {
    ex.percent = percent(ex.total, ex.maxTotal);
    ex.grade = grade(ex.percent);
    if (student && student.class_id) ex.rank = totals.filter((t) => t._id.exam === ex.id && t.total > ex.total).length + 1;
  }
  return list;
}

function timetableGrid(rows) {
  const grid = {};
  for (let d = 1; d <= 6; d++) grid[d] = {};
  for (const r of rows) if (grid[r.day]) grid[r.day][r.period] = r;
  return { grid, days: DAYS, periods: PERIODS };
}

async function timetableForClass(classId) {
  const slots = await col('timetable').find({ class_id: classId }).toArray();
  const [subjects, teachers] = await Promise.all([byIds('subjects', slots.map((s) => s.subject_id)), byIds('users', slots.map((s) => s.teacher_id), { id: 1, full_name: 1 })]);
  return timetableGrid(slots.map((s) => ({
    day: s.day, period: s.period, subject: (subjects.get(s.subject_id) || {}).name || null, teacher: (teachers.get(s.teacher_id) || {}).full_name || null,
  })));
}

async function timetableForTeacher(teacherId) {
  const slots = await col('timetable').find({ teacher_id: teacherId }).toArray();
  const [subjects, classes] = await Promise.all([byIds('subjects', slots.map((s) => s.subject_id)), byIds('classes', slots.map((s) => s.class_id))]);
  return timetableGrid(slots.filter((s) => classes.has(s.class_id)).map((s) => {
    const c = classes.get(s.class_id);
    return { day: s.day, period: s.period, subject: (subjects.get(s.subject_id) || {}).name || null, teacher: `Class ${c.name}-${c.section}` };
  }));
}

/** Adds posted_by_name, class_name and section to notices. */
async function withNoticeNames(notices) {
  const [users, classes] = await Promise.all([byIds('users', notices.map((n) => n.posted_by), { id: 1, full_name: 1 }), byIds('classes', notices.map((n) => n.class_id))]);
  return notices.map((n) => {
    const c = classes.get(n.class_id);
    return { ...n, class_id: n.class_id ?? null, posted_by_name: (users.get(n.posted_by) || {}).full_name || null, class_name: c ? c.name : null, section: c ? c.section : null };
  });
}

async function noticesFor(user, limit = 50) {
  let filter;
  switch (user.role) {
    case 'headmaster':
      filter = {};
      break;
    case 'teacher': {
      const myClasses = (await teacherClasses(user.id)).map((c) => c.id);
      filter = { $or: [{ audience: { $in: ['all', 'staff'] } }, { posted_by: user.id }, { class_id: { $in: myClasses } }] };
      break;
    }
    case 'student': {
      const me = await col('users').findOne({ id: user.id }, { projection: { class_id: 1 } });
      filter = { audience: { $in: ['all', 'students', 'students_parents'] }, $or: [{ class_id: null }, { class_id: (me && me.class_id) ?? null }] };
      break;
    }
    case 'parent': {
      const kids = await col('parent_student').distinct('student_id', { parent_id: user.id });
      const classIds = (await col('users').distinct('class_id', { id: { $in: kids } })).filter((x) => x !== null);
      filter = { audience: { $in: ['all', 'parents', 'students_parents'] }, $or: [{ class_id: null }, { class_id: { $in: classIds } }] };
      break;
    }
    default:
      return [];
  }
  const rows = await col('notices').find(filter, { projection: { _id: 0 } }).sort({ created_at: -1, id: -1 }).limit(limit).toArray();
  return withNoticeNames(rows);
}

async function homeworkForClass(classId, limit = 50) {
  const rows = await col('homework').aggregate([
    { $match: { class_id: classId } },
    { $addFields: { sortKey: { $ifNull: ['$due_date', '$created_at'] } } },
    { $sort: { sortKey: -1, id: -1 } },
    { $limit: limit },
    { $project: { _id: 0, sortKey: 0 } },
  ]).toArray();
  const [subjects, teachers] = await Promise.all([byIds('subjects', rows.map((h) => h.subject_id)), byIds('users', rows.map((h) => h.teacher_id), { id: 1, full_name: 1 })]);
  return rows.filter((h) => subjects.has(h.subject_id)).map((h) => ({
    ...h, due_date: h.due_date || null, subject_name: subjects.get(h.subject_id).name, teacher_name: (teachers.get(h.teacher_id) || {}).full_name || null,
  }));
}

async function upcomingEvents(limit = 5) {
  return col('events').find({ date: { $gte: localDate() } }, { projection: { _id: 0 } }).sort({ date: 1, id: 1 }).limit(limit).toArray();
}

/** Active students below the attendance threshold this academic year (needs at least minDays marked). */
async function lowAttendance({ classIds = null, threshold = 75, minDays = 5 } = {}) {
  if (classIds && !classIds.length) return [];
  const filter = { role: 'student', is_active: 1 };
  if (classIds) filter.class_id = { $in: classIds };
  const students = await col('users').find(filter, { projection: { _id: 0, id: 1, full_name: 1, admission_no: 1, class_id: 1 } }).toArray();
  if (!students.length) return [];
  const counts = await attendanceCounts({ student_id: { $in: students.map((s) => s.id) }, date: { $gte: academicYearStart() } });
  const classes = await byIds('classes', students.map((s) => s.class_id));
  return students.map((s) => {
    const c = counts.get(s.id);
    if (!c || c.total < minDays || (c.present * 100) / c.total >= threshold) return null;
    const cls = classes.get(s.class_id);
    return {
      id: s.id, full_name: s.full_name, admission_no: s.admission_no, class_name: cls ? cls.name : null, section: cls ? cls.section : null,
      present: c.present, total: c.total, percent: Math.round((c.present * 1000) / c.total) / 10,
    };
  }).filter(Boolean).sort((a, b) => a.percent - b.percent);
}

async function scholarshipsOf(studentId) {
  return col('scholarships').find({ student_id: studentId }, { projection: { _id: 0 } }).sort({ academic_year: -1, id: -1 }).toArray();
}

async function entitlementsOf(studentId) {
  return col('entitlements').find({ student_id: studentId }, { projection: { _id: 0 } }).sort({ academic_year: -1, item: 1 }).toArray();
}

/** Everything shown on a single student's overview page (used by headmaster, teacher and parent views). */
async function studentOverview(studentId, month) {
  const student = await studentRecord(studentId);
  if (!student) return null;
  const [parents, summary, calendar, exams, scholarships, entitlements, homework] = await Promise.all([
    parentsOf(studentId), attendanceSummary(studentId), attendanceCalendar(studentId, month), reportCard(studentId),
    scholarshipsOf(studentId), entitlementsOf(studentId), student.class_id ? homeworkForClass(student.class_id, 10) : [],
  ]);
  return { student, parents, summary, calendar, exams, scholarships, entitlements, homework };
}

module.exports = {
  academicYearStart, classLabel, allClasses, studentRecord, studentsInClass, parentsOf, childrenOf,
  isParentOf, teacherClasses, classTeacherOf, teacherAssignments, teacherCanViewStudent,
  attendanceSummary, attendanceCounts, attendanceCalendar, reportCard, timetableForClass, timetableForTeacher,
  noticesFor, homeworkForClass, upcomingEvents, lowAttendance, scholarshipsOf, entitlementsOf, studentOverview,
  byRollThenName, STUDENT_FIELDS,
};
