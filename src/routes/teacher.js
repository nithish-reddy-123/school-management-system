'use strict';
const express = require('express');
const { col, byIds, insertWithId } = require('../db');
const { requireRole } = require('../middleware/auth');
const A = require('../services/academics');
const { str, toInt, isValidDate, localDate, localTime, nowLocal, academicYear, addDays, dayOfWeek, monthParam } = require('../utils');

const router = express.Router();
router.use(requireRole('teacher'));

/** Ids of all students (active or not) currently in the given classes. */
async function studentIdsInClasses(classIds) {
  if (!classIds.length) return [];
  return col('users').distinct('id', { role: 'student', class_id: { $in: classIds } });
}

async function todaysPeriodsForTeacher(teacherId, today) {
  const dow = dayOfWeek(today);
  if (dow < 1 || dow > 6) return [];
  const slots = await col('timetable').find({ teacher_id: teacherId, day: dow }).sort({ period: 1 }).toArray();
  const [classes, subjects] = await Promise.all([byIds('classes', slots.map((s) => s.class_id)), byIds('subjects', slots.map((s) => s.subject_id))]);
  return slots.filter((s) => classes.has(s.class_id)).map((s) => {
    const c = classes.get(s.class_id);
    return { period: s.period, subject: (subjects.get(s.subject_id) || {}).name || null, class_name: c.name, section: c.section };
  });
}

async function dashboard(req, res) {
  const today = localDate();
  const tid = req.user.id;
  const own = await A.classTeacherOf(tid);
  const myClasses = await Promise.all(own.map(async (c) => {
    const ids = await col('users').distinct('id', { role: 'student', class_id: c.id, is_active: 1 });
    const allIds = await studentIdsInClasses([c.id]);
    const [marked, present] = await Promise.all([
      col('attendance').countDocuments({ student_id: { $in: allIds }, date: today }),
      col('attendance').countDocuments({ student_id: { $in: allIds }, date: today, status: 'P' }),
    ]);
    return { ...c, students: ids.length, marked, present };
  }));
  const classStudentIds = await studentIdsInClasses(own.map((c) => c.id));
  const [todaysPeriods, pendingLeaves, checkin, assignments, lowAttendance, notices, events] = await Promise.all([
    todaysPeriodsForTeacher(tid, today),
    col('leave_requests').countDocuments({ student_id: { $in: classStudentIds }, status: 'pending' }),
    col('teacher_attendance').findOne({ teacher_id: tid, date: today }, { projection: { _id: 0 } }),
    A.teacherAssignments(tid),
    A.lowAttendance({ classIds: myClasses.map((c) => c.id) }),
    A.noticesFor(req.user, 5),
    A.upcomingEvents(5),
  ]);
  res.render('teacher/dashboard', {
    title: 'Teacher Dashboard',
    today, checkin, myClasses, todaysPeriods, pendingLeaves, assignments, lowAttendance, notices, events,
  });
}

router.post('/checkin', async (req, res) => {
  // First check-in of the day wins; later clicks do not change the recorded time.
  await col('teacher_attendance').updateOne(
    { teacher_id: req.user.id, date: localDate() },
    { $setOnInsert: { status: 'P', check_in_time: localTime() } },
    { upsert: true },
  );
  req.flash('success', `Checked in at ${localTime()}.`);
  res.redirect('/dashboard');
});

/* ---------------- Attendance (class teacher) ---------------- */

router.get('/attendance', async (req, res) => {
  const classes = await A.classTeacherOf(req.user.id);
  const classId = classes.some((c) => c.id === toInt(req.query.class_id)) ? toInt(req.query.class_id) : (classes[0] && classes[0].id);
  const today = localDate();
  const date = isValidDate(req.query.date) && req.query.date <= today ? req.query.date : today;
  let students = [];
  let markedCount = 0;
  if (classId) {
    const ids = await studentIdsInClasses([classId]);
    const [att, leaves, list] = await Promise.all([
      col('attendance').find({ student_id: { $in: ids }, date }).toArray(),
      col('leave_requests').distinct('student_id', { student_id: { $in: ids }, status: 'approved', from_date: { $lte: date }, to_date: { $gte: date } }),
      A.studentsInClass(classId),
    ]);
    const existing = Object.fromEntries(att.map((r) => [r.student_id, r.status]));
    const onLeave = new Set(leaves);
    students = list.map((s) => ({
      ...s, status: existing[s.id] || (onLeave.has(s.id) ? 'L' : null), approvedLeave: onLeave.has(s.id),
    }));
    markedCount = att.length;
  }
  const holiday = await col('events').findOne({ type: 'holiday', date });
  res.render('teacher/attendance', {
    title: 'Mark Attendance', classes, classId, date, today, students,
    markedCount,
    warning: dayOfWeek(date) === 0 ? 'The selected date is a Sunday.' : holiday ? `The selected date is a holiday: ${holiday.title}.` : null,
  });
});

router.post('/attendance', async (req, res) => {
  const classId = toInt(req.body.class_id);
  const date = str(req.body.date, 10);
  if (!(await A.classTeacherOf(req.user.id)).some((c) => c.id === classId)) {
    req.flash('error', 'Only the class teacher can mark attendance for this class.');
    return res.redirect('/teacher/attendance');
  }
  if (!isValidDate(date) || date > localDate()) {
    req.flash('error', 'Attendance cannot be marked for a future date.');
    return res.redirect(`/teacher/attendance?class_id=${classId}`);
  }
  const ops = [];
  for (const s of await A.studentsInClass(classId)) {
    const status = req.body[`status_${s.id}`];
    if (!['P', 'A', 'L'].includes(status)) continue;
    ops.push({ updateOne: { filter: { student_id: s.id, date }, update: { $set: { status, marked_by: req.user.id } }, upsert: true } });
  }
  // Upserts are idempotent, so re-submitting after a partial failure saves the remaining rows.
  if (ops.length) await col('attendance').bulkWrite(ops, { ordered: false });
  req.flash('success', `Attendance saved for ${ops.length} student(s) on ${date}.`);
  res.redirect(`/teacher/attendance?class_id=${classId}&date=${date}`);
});

/* ---------------- Marks entry (subject teacher) ---------------- */

router.get('/marks', async (req, res) => {
  const [assignments, exams] = await Promise.all([
    A.teacherAssignments(req.user.id),
    col('exams').find({ academic_year: academicYear() }, { projection: { _id: 0 } }).sort({ exam_date: 1, id: 1 }).toArray(),
  ]);
  const examId = toInt(req.query.exam_id);
  const [classId, subjectId] = String(req.query.assignment || '').split('-').map((x) => toInt(x));
  const assignment = assignments.find((a) => a.class_id === classId && a.subject_id === subjectId) || null;
  const exam = exams.find((e) => e.id === examId) || null;
  let students = [];
  if (assignment && exam) {
    const rows = await col('marks').find({ exam_id: exam.id, subject_id: subjectId }).toArray();
    const existing = Object.fromEntries(rows.map((r) => [r.student_id, r.marks_obtained]));
    students = (await A.studentsInClass(classId)).map((s) => ({ ...s, marks: existing[s.id] ?? '' }));
  }
  res.render('teacher/marks', { title: 'Marks Entry', assignments, exams, exam, assignment, students });
});

router.post('/marks', async (req, res) => {
  const examId = toInt(req.body.exam_id);
  const classId = toInt(req.body.class_id);
  const subjectId = toInt(req.body.subject_id);
  const [exam, assignments] = await Promise.all([col('exams').findOne({ id: examId }), A.teacherAssignments(req.user.id)]);
  const allowed = assignments.some((a) => a.class_id === classId && a.subject_id === subjectId);
  const back = `/teacher/marks?exam_id=${examId}&assignment=${classId}-${subjectId}`;
  if (!exam || !allowed) {
    req.flash('error', 'You can only enter marks for subjects assigned to you.');
    return res.redirect('/teacher/marks');
  }
  const invalid = [];
  const ops = [];
  let saved = 0;
  for (const s of await A.studentsInClass(classId)) {
    const key = { exam_id: examId, student_id: s.id, subject_id: subjectId };
    const raw = String(req.body[`marks_${s.id}`] ?? '').trim();
    if (raw === '') {
      ops.push({ deleteOne: { filter: key } });
      continue;
    }
    const m = Number(raw);
    if (!Number.isFinite(m) || m < 0 || m > exam.max_marks) {
      invalid.push(s.full_name);
      continue;
    }
    ops.push({ updateOne: { filter: key, update: { $set: { marks_obtained: Math.round(m * 10) / 10, entered_by: req.user.id } }, upsert: true } });
    saved++;
  }
  if (ops.length) await col('marks').bulkWrite(ops, { ordered: false });
  if (invalid.length) req.flash('error', `Marks must be between 0 and ${exam.max_marks}. Not saved for: ${invalid.join(', ')}`);
  req.flash('success', `Marks saved for ${saved} student(s).`);
  res.redirect(back);
});

/* ---------------- Homework ---------------- */

router.get('/homework', async (req, res) => {
  const list = await col('homework').find({ teacher_id: req.user.id }, { projection: { _id: 0 } }).sort({ id: -1 }).limit(100).toArray();
  const [subjects, classes, assignments] = await Promise.all([
    byIds('subjects', list.map((h) => h.subject_id)), byIds('classes', list.map((h) => h.class_id)), A.teacherAssignments(req.user.id),
  ]);
  const rows = list.filter((h) => subjects.has(h.subject_id) && classes.has(h.class_id)).map((h) => {
    const c = classes.get(h.class_id);
    return { ...h, due_date: h.due_date || null, subject_name: subjects.get(h.subject_id).name, class_name: c.name, section: c.section };
  });
  res.render('teacher/homework', { title: 'Homework', rows, assignments, today: localDate() });
});

router.post('/homework', async (req, res) => {
  const [classId, subjectId] = String(req.body.assignment || '').split('-').map((x) => toInt(x));
  const allowed = (await A.teacherAssignments(req.user.id)).some((a) => a.class_id === classId && a.subject_id === subjectId);
  const title = str(req.body.title, 150);
  const due = str(req.body.due_date, 10);
  if (!allowed || !title || (due && !isValidDate(due))) {
    req.flash('error', 'Choose one of your class/subject assignments, a title and a valid due date.');
    return res.redirect('/teacher/homework');
  }
  await insertWithId('homework', {
    class_id: classId, subject_id: subjectId, teacher_id: req.user.id, title,
    description: str(req.body.description, 3000) || null, due_date: due || null, created_at: nowLocal(),
  });
  req.flash('success', 'Homework posted. Students and parents can see it now.');
  res.redirect('/teacher/homework');
});

router.post('/homework/:id/delete', async (req, res) => {
  const r = await col('homework').deleteOne({ id: toInt(req.params.id), teacher_id: req.user.id });
  req.flash(r.deletedCount ? 'success' : 'error', r.deletedCount ? 'Homework deleted.' : 'Homework not found.');
  res.redirect('/teacher/homework');
});

/* ---------------- Students ---------------- */

router.get('/students', async (req, res) => {
  const classes = await A.teacherClasses(req.user.id);
  const classId = classes.some((c) => c.id === toInt(req.query.class_id)) ? toInt(req.query.class_id) : (classes[0] && classes[0].id);
  let students = [];
  if (classId) {
    const list = await A.studentsInClass(classId);
    students = await Promise.all(list.map(async (s) => ({ ...s, att: await A.attendanceSummary(s.id) })));
  }
  res.render('teacher/students', { title: 'My Students', classes, classId, students });
});

router.get('/students/:id', async (req, res) => {
  const id = toInt(req.params.id);
  if (!(await A.teacherCanViewStudent(req.user.id, id))) {
    return res.status(403).render('error', { title: 'Access denied', status: 403, message: 'This student is not in any of your classes.' });
  }
  const overview = await A.studentOverview(id, monthParam(req.query.month));
  res.render('teacher/student_detail', { title: overview.student.full_name, overview });
});

/* ---------------- Leave requests ---------------- */

/** Leave request `id` if it belongs to a student in one of this teacher's own classes. */
async function ownLeave(teacherId, id) {
  const lr = await col('leave_requests').findOne({ id });
  if (!lr) return null;
  const s = await col('users').findOne({ id: lr.student_id, role: 'student' }, { projection: { class_id: 1 } });
  if (!s || !s.class_id) return null;
  const cls = await col('classes').findOne({ id: s.class_id, class_teacher_id: teacherId });
  return cls ? lr : null;
}

router.get('/leaves', async (req, res) => {
  const classes = await col('classes').find({ class_teacher_id: req.user.id }).toArray();
  const students = classes.length
    ? await col('users').find({ role: 'student', class_id: { $in: classes.map((c) => c.id) } }, { projection: { _id: 0, id: 1, full_name: 1, roll_no: 1, class_id: 1 } }).toArray()
    : [];
  const studentMap = new Map(students.map((s) => [s.id, s]));
  const classMap = new Map(classes.map((c) => [c.id, c]));
  const list = students.length
    ? await col('leave_requests').aggregate([
      { $match: { student_id: { $in: students.map((s) => s.id) } } },
      { $addFields: { notPending: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } } },
      { $sort: { notPending: 1, from_date: -1, id: -1 } },
      { $limit: 200 },
      { $project: { _id: 0, notPending: 0 } },
    ]).toArray()
    : [];
  const parents = await byIds('users', list.map((l) => l.requested_by), { id: 1, full_name: 1, phone: 1 });
  const rows = list.map((lr) => {
    const s = studentMap.get(lr.student_id);
    const c = classMap.get(s.class_id);
    const p = parents.get(lr.requested_by);
    return {
      ...lr, student_name: s.full_name, roll_no: s.roll_no ?? null, class_name: c.name, section: c.section,
      parent_name: p ? p.full_name : null, parent_phone: p ? p.phone || null : null,
    };
  });
  res.render('teacher/leaves', { title: 'Leave Applications', rows });
});

router.post('/leaves/:id', async (req, res) => {
  const status = ['approved', 'rejected'].includes(req.body.status) ? req.body.status : null;
  const lr = await ownLeave(req.user.id, toInt(req.params.id));
  if (!lr || !status) {
    req.flash('error', 'Leave application not found.');
    return res.redirect('/teacher/leaves');
  }
  await col('leave_requests').updateOne({ id: lr.id }, { $set: { status, reviewed_by: req.user.id, reviewed_at: nowLocal() } });
  if (status === 'approved') {
    // Convert already-recorded absences in the leave period into approved leave; fill unmarked days with leave.
    const end = lr.to_date < localDate() ? lr.to_date : localDate();
    const ops = [];
    for (let d = lr.from_date; d <= end; d = addDays(d, 1)) {
      if (dayOfWeek(d) === 0) continue;
      const key = { student_id: lr.student_id, date: d };
      ops.push({ updateOne: { filter: key, update: { $setOnInsert: { status: 'L', marked_by: req.user.id } }, upsert: true } });
      ops.push({ updateOne: { filter: { ...key, status: 'A' }, update: { $set: { status: 'L' } } } });
    }
    if (ops.length) await col('attendance').bulkWrite(ops, { ordered: true });
  }
  req.flash('success', `Leave ${status}.`);
  res.redirect('/teacher/leaves');
});

router.get('/timetable', async (req, res) => {
  res.render('teacher/timetable', { title: 'My Timetable', timetable: await A.timetableForTeacher(req.user.id) });
});

/* ---------------- Self-registrations: class teacher verifies students and parents of their class ---------------- */

require('./registrationReview')(router, '/teacher/registrations');

module.exports = router;
module.exports.dashboard = dashboard;
