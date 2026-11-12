'use strict';
const express = require('express');
const { one, all, run, tx } = require('../db');
const { requireRole } = require('../middleware/auth');
const A = require('../services/academics');
const { str, toInt, isValidDate, localDate, localTime, academicYear, addDays, dayOfWeek, monthParam } = require('../utils');

const router = express.Router();
router.use(requireRole('teacher'));

function dashboard(req, res) {
  const today = localDate();
  const tid = req.user.id;
  const myClasses = A.classTeacherOf(tid).map((c) => {
    const s = one(`SELECT COUNT(*) AS students,
        (SELECT COUNT(*) FROM attendance a JOIN students st ON st.user_id = a.student_id WHERE st.class_id = ? AND a.date = ?) AS marked,
        (SELECT COUNT(*) FROM attendance a JOIN students st ON st.user_id = a.student_id WHERE st.class_id = ? AND a.date = ? AND a.status = 'P') AS present
      FROM students s JOIN users u ON u.id = s.user_id WHERE s.class_id = ? AND u.is_active = 1`, c.id, today, c.id, today, c.id);
    return { ...c, ...s };
  });
  const dow = dayOfWeek(today);
  const todaysPeriods = dow >= 1 && dow <= 6
    ? all(`SELECT t.period, sub.name AS subject, c.name AS class_name, c.section FROM timetable t
        JOIN classes c ON c.id = t.class_id LEFT JOIN subjects sub ON sub.id = t.subject_id
        WHERE t.teacher_id = ? AND t.day = ? ORDER BY t.period`, tid, dow)
    : [];
  const pendingLeaves = one(`SELECT COUNT(*) AS n FROM leave_requests lr JOIN students s ON s.user_id = lr.student_id
    JOIN classes c ON c.id = s.class_id WHERE c.class_teacher_id = ? AND lr.status = 'pending'`, tid).n;
  res.render('teacher/dashboard', {
    title: 'Teacher Dashboard',
    today,
    checkin: one('SELECT * FROM teacher_attendance WHERE teacher_id = ? AND date = ?', tid, today),
    myClasses,
    todaysPeriods,
    pendingLeaves,
    assignments: A.teacherAssignments(tid),
    lowAttendance: A.lowAttendance({ classIds: myClasses.map((c) => c.id) }),
    notices: A.noticesFor(req.user, 5),
    events: A.upcomingEvents(5),
  });
}

router.post('/checkin', (req, res) => {
  run(`INSERT INTO teacher_attendance (teacher_id, date, status, check_in_time) VALUES (?, ?, 'P', ?)
    ON CONFLICT(teacher_id, date) DO NOTHING`, req.user.id, localDate(), localTime());
  req.flash('success', `Checked in at ${localTime()}.`);
  res.redirect('/dashboard');
});

/* ---------------- Attendance (class teacher) ---------------- */

router.get('/attendance', (req, res) => {
  const classes = A.classTeacherOf(req.user.id);
  const classId = classes.some((c) => c.id === toInt(req.query.class_id)) ? toInt(req.query.class_id) : (classes[0] && classes[0].id);
  const today = localDate();
  const date = isValidDate(req.query.date) && req.query.date <= today ? req.query.date : today;
  let students = [];
  let markedCount = 0;
  if (classId) {
    const existing = Object.fromEntries(all(`SELECT a.student_id, a.status FROM attendance a JOIN students s ON s.user_id = a.student_id
      WHERE s.class_id = ? AND a.date = ?`, classId, date).map((r) => [r.student_id, r.status]));
    const onLeave = new Set(all(`SELECT lr.student_id FROM leave_requests lr JOIN students s ON s.user_id = lr.student_id
      WHERE s.class_id = ? AND lr.status = 'approved' AND ? BETWEEN lr.from_date AND lr.to_date`, classId, date).map((r) => r.student_id));
    students = A.studentsInClass(classId).map((s) => ({
      ...s, status: existing[s.id] || (onLeave.has(s.id) ? 'L' : null), approvedLeave: onLeave.has(s.id),
    }));
    markedCount = Object.keys(existing).length;
  }
  const holiday = one("SELECT title FROM events WHERE type = 'holiday' AND date = ?", date);
  res.render('teacher/attendance', {
    title: 'Mark Attendance', classes, classId, date, today, students,
    markedCount,
    warning: dayOfWeek(date) === 0 ? 'The selected date is a Sunday.' : holiday ? `The selected date is a holiday: ${holiday.title}.` : null,
  });
});

router.post('/attendance', (req, res) => {
  const classId = toInt(req.body.class_id);
  const date = str(req.body.date, 10);
  if (!A.classTeacherOf(req.user.id).some((c) => c.id === classId)) {
    req.flash('error', 'Only the class teacher can mark attendance for this class.');
    return res.redirect('/teacher/attendance');
  }
  if (!isValidDate(date) || date > localDate()) {
    req.flash('error', 'Attendance cannot be marked for a future date.');
    return res.redirect(`/teacher/attendance?class_id=${classId}`);
  }
  const students = A.studentsInClass(classId);
  let saved = 0;
  tx(() => {
    for (const s of students) {
      const status = req.body[`status_${s.id}`];
      if (!['P', 'A', 'L'].includes(status)) continue;
      run(`INSERT INTO attendance (student_id, date, status, marked_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`,
      s.id, date, status, req.user.id);
      saved++;
    }
  });
  req.flash('success', `Attendance saved for ${saved} student(s) on ${date}.`);
  res.redirect(`/teacher/attendance?class_id=${classId}&date=${date}`);
});

/* ---------------- Marks entry (subject teacher) ---------------- */

router.get('/marks', (req, res) => {
  const assignments = A.teacherAssignments(req.user.id);
  const exams = all('SELECT * FROM exams WHERE academic_year = ? ORDER BY exam_date, id', academicYear());
  const examId = toInt(req.query.exam_id);
  const [classId, subjectId] = String(req.query.assignment || '').split('-').map((x) => toInt(x));
  const assignment = assignments.find((a) => a.class_id === classId && a.subject_id === subjectId) || null;
  const exam = exams.find((e) => e.id === examId) || null;
  let students = [];
  if (assignment && exam) {
    const existing = Object.fromEntries(all('SELECT student_id, marks_obtained FROM marks WHERE exam_id = ? AND subject_id = ?', exam.id, subjectId)
      .map((r) => [r.student_id, r.marks_obtained]));
    students = A.studentsInClass(classId).map((s) => ({ ...s, marks: existing[s.id] ?? '' }));
  }
  res.render('teacher/marks', { title: 'Marks Entry', assignments, exams, exam, assignment, students });
});

router.post('/marks', (req, res) => {
  const examId = toInt(req.body.exam_id);
  const classId = toInt(req.body.class_id);
  const subjectId = toInt(req.body.subject_id);
  const exam = one('SELECT * FROM exams WHERE id = ?', examId);
  const allowed = A.teacherAssignments(req.user.id).some((a) => a.class_id === classId && a.subject_id === subjectId);
  const back = `/teacher/marks?exam_id=${examId}&assignment=${classId}-${subjectId}`;
  if (!exam || !allowed) {
    req.flash('error', 'You can only enter marks for subjects assigned to you.');
    return res.redirect('/teacher/marks');
  }
  const invalid = [];
  let saved = 0;
  tx(() => {
    for (const s of A.studentsInClass(classId)) {
      const raw = String(req.body[`marks_${s.id}`] ?? '').trim();
      if (raw === '') {
        run('DELETE FROM marks WHERE exam_id = ? AND student_id = ? AND subject_id = ?', examId, s.id, subjectId);
        continue;
      }
      const m = Number(raw);
      if (!Number.isFinite(m) || m < 0 || m > exam.max_marks) {
        invalid.push(s.full_name);
        continue;
      }
      run(`INSERT INTO marks (exam_id, student_id, subject_id, marks_obtained, entered_by) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(exam_id, student_id, subject_id) DO UPDATE SET marks_obtained = excluded.marks_obtained, entered_by = excluded.entered_by`,
      examId, s.id, subjectId, Math.round(m * 10) / 10, req.user.id);
      saved++;
    }
  });
  if (invalid.length) req.flash('error', `Marks must be between 0 and ${exam.max_marks}. Not saved for: ${invalid.join(', ')}`);
  req.flash('success', `Marks saved for ${saved} student(s).`);
  res.redirect(back);
});

/* ---------------- Homework ---------------- */

router.get('/homework', (req, res) => {
  const rows = all(`SELECT h.*, sub.name AS subject_name, c.name AS class_name, c.section FROM homework h
    JOIN subjects sub ON sub.id = h.subject_id JOIN classes c ON c.id = h.class_id
    WHERE h.teacher_id = ? ORDER BY h.id DESC LIMIT 100`, req.user.id);
  res.render('teacher/homework', { title: 'Homework', rows, assignments: A.teacherAssignments(req.user.id), today: localDate() });
});

router.post('/homework', (req, res) => {
  const [classId, subjectId] = String(req.body.assignment || '').split('-').map((x) => toInt(x));
  const allowed = A.teacherAssignments(req.user.id).some((a) => a.class_id === classId && a.subject_id === subjectId);
  const title = str(req.body.title, 150);
  const due = str(req.body.due_date, 10);
  if (!allowed || !title || (due && !isValidDate(due))) {
    req.flash('error', 'Choose one of your class/subject assignments, a title and a valid due date.');
    return res.redirect('/teacher/homework');
  }
  run('INSERT INTO homework (class_id, subject_id, teacher_id, title, description, due_date) VALUES (?, ?, ?, ?, ?, ?)',
    classId, subjectId, req.user.id, title, str(req.body.description, 3000), due);
  req.flash('success', 'Homework posted. Students and parents can see it now.');
  res.redirect('/teacher/homework');
});

router.post('/homework/:id/delete', (req, res) => {
  const r = run('DELETE FROM homework WHERE id = ? AND teacher_id = ?', toInt(req.params.id), req.user.id);
  req.flash(r.changes ? 'success' : 'error', r.changes ? 'Homework deleted.' : 'Homework not found.');
  res.redirect('/teacher/homework');
});

/* ---------------- Students ---------------- */

router.get('/students', (req, res) => {
  const classes = A.teacherClasses(req.user.id);
  const classId = classes.some((c) => c.id === toInt(req.query.class_id)) ? toInt(req.query.class_id) : (classes[0] && classes[0].id);
  const students = classId
    ? A.studentsInClass(classId).map((s) => ({ ...s, att: A.attendanceSummary(s.id) }))
    : [];
  res.render('teacher/students', { title: 'My Students', classes, classId, students });
});

router.get('/students/:id', (req, res) => {
  const id = toInt(req.params.id);
  if (!A.teacherCanViewStudent(req.user.id, id)) {
    return res.status(403).render('error', { title: 'Access denied', status: 403, message: 'This student is not in any of your classes.' });
  }
  const overview = A.studentOverview(id, monthParam(req.query.month));
  res.render('teacher/student_detail', { title: overview.student.full_name, overview });
});

/* ---------------- Leave requests ---------------- */

router.get('/leaves', (req, res) => {
  const rows = all(`SELECT lr.*, u.full_name AS student_name, s.roll_no, c.name AS class_name, c.section, p.full_name AS parent_name, p.phone AS parent_phone
    FROM leave_requests lr JOIN users u ON u.id = lr.student_id JOIN students s ON s.user_id = lr.student_id
    JOIN classes c ON c.id = s.class_id LEFT JOIN users p ON p.id = lr.requested_by
    WHERE c.class_teacher_id = ? ORDER BY (lr.status != 'pending'), lr.from_date DESC LIMIT 200`, req.user.id);
  res.render('teacher/leaves', { title: 'Leave Applications', rows });
});

router.post('/leaves/:id', (req, res) => {
  const status = ['approved', 'rejected'].includes(req.body.status) ? req.body.status : null;
  const lr = one(`SELECT lr.* FROM leave_requests lr JOIN students s ON s.user_id = lr.student_id
    JOIN classes c ON c.id = s.class_id WHERE lr.id = ? AND c.class_teacher_id = ?`, toInt(req.params.id), req.user.id);
  if (!lr || !status) {
    req.flash('error', 'Leave application not found.');
    return res.redirect('/teacher/leaves');
  }
  tx(() => {
    run("UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?", status, req.user.id, lr.id);
    if (status === 'approved') {
      // Convert already-recorded absences in the leave period into approved leave.
      const end = lr.to_date < localDate() ? lr.to_date : localDate();
      for (let d = lr.from_date; d <= end; d = addDays(d, 1)) {
        if (dayOfWeek(d) === 0) continue;
        run(`INSERT INTO attendance (student_id, date, status, marked_by) VALUES (?, ?, 'L', ?)
          ON CONFLICT(student_id, date) DO UPDATE SET status = 'L' WHERE attendance.status = 'A'`, lr.student_id, d, req.user.id);
      }
    }
  });
  req.flash('success', `Leave ${status}.`);
  res.redirect('/teacher/leaves');
});

router.get('/timetable', (req, res) => {
  res.render('teacher/timetable', { title: 'My Timetable', timetable: A.timetableForTeacher(req.user.id) });
});

/* ---------------- Self-registrations: class teacher verifies students and parents of their class ---------------- */

require('./registrationReview')(router, '/teacher/registrations');

module.exports = router;
module.exports.dashboard = dashboard;
