'use strict';
const { one, all } = require('../db');
const { localDate, academicYear, grade, percent, DAYS, PERIODS } = require('../utils');

function academicYearStart(d = new Date()) {
  return `${academicYear(d).slice(0, 4)}-04-01`;
}

function classLabel(c) {
  if (!c) return '-';
  const name = c.class_name ?? c.name;
  return name ? `Class ${name}-${c.section}` : '-';
}

function allClasses() {
  return all(`SELECT c.*, u.full_name AS class_teacher_name,
      (SELECT COUNT(*) FROM students s JOIN users su ON su.id = s.user_id WHERE s.class_id = c.id AND su.is_active = 1) AS student_count
    FROM classes c LEFT JOIN users u ON u.id = c.class_teacher_id
    ORDER BY CAST(c.name AS INTEGER), c.name, c.section`);
}

function studentRecord(studentId) {
  return one(`SELECT u.id, u.username, u.full_name, u.phone, u.email, u.is_active, u.last_login,
      s.admission_no, s.class_id, s.roll_no, s.dob, s.gender, s.category, s.apaar_id, s.aadhaar_last4,
      s.is_cwsn, s.is_bpl, s.address,
      c.name AS class_name, c.section, c.class_teacher_id, ct.full_name AS class_teacher_name
    FROM users u JOIN students s ON s.user_id = u.id
    LEFT JOIN classes c ON c.id = s.class_id
    LEFT JOIN users ct ON ct.id = c.class_teacher_id
    WHERE u.id = ?`, studentId);
}

function studentsInClass(classId) {
  return all(`SELECT u.id, u.full_name, u.username, s.admission_no, s.roll_no, s.gender, s.category
    FROM students s JOIN users u ON u.id = s.user_id
    WHERE s.class_id = ? AND u.is_active = 1
    ORDER BY s.roll_no, u.full_name`, classId);
}

function parentsOf(studentId) {
  return all(`SELECT u.id, u.full_name, u.phone, u.username, ps.relation
    FROM parent_student ps JOIN users u ON u.id = ps.parent_id WHERE ps.student_id = ?`, studentId);
}

function childrenOf(parentId) {
  return all(`SELECT u.id, u.full_name, s.admission_no, s.roll_no, s.class_id, c.name AS class_name, c.section, ps.relation
    FROM parent_student ps
    JOIN users u ON u.id = ps.student_id
    JOIN students s ON s.user_id = u.id
    LEFT JOIN classes c ON c.id = s.class_id
    WHERE ps.parent_id = ? AND u.is_active = 1
    ORDER BY u.full_name`, parentId);
}

function isParentOf(parentId, studentId) {
  return !!one('SELECT 1 AS ok FROM parent_student WHERE parent_id = ? AND student_id = ?', parentId, studentId);
}

/** Classes a teacher is linked to as class teacher or subject teacher. */
function teacherClasses(teacherId) {
  return all(`SELECT c.id, c.name, c.section, (c.class_teacher_id = ?) AS is_class_teacher
    FROM classes c
    WHERE c.class_teacher_id = ? OR c.id IN (SELECT class_id FROM class_subjects WHERE teacher_id = ?)
    ORDER BY CAST(c.name AS INTEGER), c.name, c.section`, teacherId, teacherId, teacherId);
}

function classTeacherOf(teacherId) {
  return all(`SELECT id, name, section FROM classes WHERE class_teacher_id = ?
    ORDER BY CAST(name AS INTEGER), name, section`, teacherId);
}

function teacherAssignments(teacherId) {
  return all(`SELECT cs.class_id, cs.subject_id, c.name AS class_name, c.section, sub.name AS subject_name
    FROM class_subjects cs JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
    WHERE cs.teacher_id = ?
    ORDER BY CAST(c.name AS INTEGER), c.section, sub.name`, teacherId);
}

function teacherCanViewStudent(teacherId, studentId) {
  const s = one('SELECT class_id FROM students WHERE user_id = ?', studentId);
  if (!s || !s.class_id) return false;
  return teacherClasses(teacherId).some((c) => c.id === s.class_id);
}

function attendanceSummary(studentId, from = academicYearStart(), to = localDate()) {
  const r = one(`SELECT COALESCE(SUM(status = 'P'), 0) AS present, COALESCE(SUM(status = 'A'), 0) AS absent,
      COALESCE(SUM(status = 'L'), 0) AS leave, COUNT(*) AS total
    FROM attendance WHERE student_id = ? AND date >= ? AND date <= ?`, studentId, from, to);
  return { ...r, percent: percent(r.present, r.total) };
}

/** Builds a Monday-first month calendar with attendance status and holidays. */
function attendanceCalendar(studentId, month) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const last = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const statusByDate = Object.fromEntries(
    all('SELECT date, status FROM attendance WHERE student_id = ? AND date BETWEEN ? AND ?', studentId, first, last)
      .map((r) => [r.date, r.status]),
  );
  const holidays = Object.fromEntries(
    all("SELECT date, title FROM events WHERE type = 'holiday' AND date BETWEEN ? AND ?", first, last)
      .map((r) => [r.date, r.title]),
  );
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

/** Report card grouped by exam, with per-subject grade, totals and rank within current class. */
function reportCard(studentId) {
  const student = one('SELECT class_id FROM students WHERE user_id = ?', studentId);
  const rows = all(`SELECT e.id AS exam_id, e.name AS exam_name, e.max_marks, e.exam_date, e.academic_year,
      sub.name AS subject, m.marks_obtained
    FROM marks m JOIN exams e ON e.id = m.exam_id JOIN subjects sub ON sub.id = m.subject_id
    WHERE m.student_id = ?
    ORDER BY e.exam_date, e.id, sub.name`, studentId);
  const exams = [];
  const byId = new Map();
  for (const r of rows) {
    let ex = byId.get(r.exam_id);
    if (!ex) {
      ex = { id: r.exam_id, name: r.exam_name, max_marks: r.max_marks, exam_date: r.exam_date, academic_year: r.academic_year, subjects: [], total: 0, maxTotal: 0 };
      byId.set(r.exam_id, ex);
      exams.push(ex);
    }
    const p = percent(r.marks_obtained, r.max_marks);
    ex.subjects.push({ subject: r.subject, marks: r.marks_obtained, percent: p, grade: grade(p) });
    ex.total += r.marks_obtained;
    ex.maxTotal += r.max_marks;
  }
  for (const ex of exams) {
    ex.percent = percent(ex.total, ex.maxTotal);
    ex.grade = grade(ex.percent);
    ex.rank = null;
    if (student && student.class_id) {
      const better = one(`SELECT COUNT(*) AS n FROM (
          SELECT m.student_id, SUM(m.marks_obtained) AS total FROM marks m
          JOIN students s ON s.user_id = m.student_id
          WHERE m.exam_id = ? AND s.class_id = ? GROUP BY m.student_id
        ) WHERE total > ?`, ex.id, student.class_id, ex.total);
      ex.rank = better.n + 1;
    }
  }
  return exams;
}

function timetableGrid(rows) {
  const grid = {};
  for (let d = 1; d <= 6; d++) grid[d] = {};
  for (const r of rows) grid[r.day][r.period] = r;
  return { grid, days: DAYS, periods: PERIODS };
}

function timetableForClass(classId) {
  return timetableGrid(all(`SELECT t.day, t.period, sub.name AS subject, u.full_name AS teacher
    FROM timetable t LEFT JOIN subjects sub ON sub.id = t.subject_id LEFT JOIN users u ON u.id = t.teacher_id
    WHERE t.class_id = ?`, classId));
}

function timetableForTeacher(teacherId) {
  return timetableGrid(all(`SELECT t.day, t.period, sub.name AS subject, 'Class ' || c.name || '-' || c.section AS teacher
    FROM timetable t JOIN classes c ON c.id = t.class_id LEFT JOIN subjects sub ON sub.id = t.subject_id
    WHERE t.teacher_id = ?`, teacherId));
}

function noticesFor(user, limit = 50) {
  const base = `SELECT n.*, u.full_name AS posted_by_name, c.name AS class_name, c.section
    FROM notices n LEFT JOIN users u ON u.id = n.posted_by LEFT JOIN classes c ON c.id = n.class_id`;
  const tail = ' ORDER BY n.created_at DESC, n.id DESC LIMIT ?';
  switch (user.role) {
    case 'headmaster':
      return all(base + tail, limit);
    case 'teacher':
      return all(`${base} WHERE n.audience IN ('all','staff') OR n.posted_by = ?
        OR n.class_id IN (SELECT id FROM classes WHERE class_teacher_id = ? UNION SELECT class_id FROM class_subjects WHERE teacher_id = ?)${tail}`,
      user.id, user.id, user.id, limit);
    case 'student':
      return all(`${base} WHERE n.audience IN ('all','students','students_parents')
        AND (n.class_id IS NULL OR n.class_id = (SELECT class_id FROM students WHERE user_id = ?))${tail}`, user.id, limit);
    case 'parent':
      return all(`${base} WHERE n.audience IN ('all','parents','students_parents')
        AND (n.class_id IS NULL OR n.class_id IN (SELECT s.class_id FROM parent_student ps JOIN students s ON s.user_id = ps.student_id WHERE ps.parent_id = ?))${tail}`,
      user.id, limit);
    default:
      return [];
  }
}

function homeworkForClass(classId, limit = 50) {
  return all(`SELECT h.*, sub.name AS subject_name, u.full_name AS teacher_name
    FROM homework h JOIN subjects sub ON sub.id = h.subject_id LEFT JOIN users u ON u.id = h.teacher_id
    WHERE h.class_id = ? ORDER BY COALESCE(h.due_date, h.created_at) DESC, h.id DESC LIMIT ?`, classId, limit);
}

function upcomingEvents(limit = 5) {
  return all('SELECT * FROM events WHERE date >= ? ORDER BY date LIMIT ?', localDate(), limit);
}

/** Students below the attendance threshold this academic year (needs at least minDays marked). */
function lowAttendance({ classIds = null, threshold = 75, minDays = 5 } = {}) {
  const filter = classIds && classIds.length ? `AND s.class_id IN (${classIds.map(() => '?').join(',')})` : '';
  if (classIds && !classIds.length) return [];
  return all(`SELECT u.id, u.full_name, s.admission_no, c.name AS class_name, c.section,
      SUM(a.status = 'P') AS present, COUNT(a.id) AS total, ROUND(SUM(a.status = 'P') * 100.0 / COUNT(a.id), 1) AS percent
    FROM students s JOIN users u ON u.id = s.user_id
    LEFT JOIN classes c ON c.id = s.class_id
    JOIN attendance a ON a.student_id = s.user_id AND a.date >= ?
    WHERE u.is_active = 1 ${filter}
    GROUP BY u.id HAVING COUNT(a.id) >= ? AND SUM(a.status = 'P') * 100.0 / COUNT(a.id) < ?
    ORDER BY percent`, academicYearStart(), ...(classIds || []), minDays, threshold);
}

function scholarshipsOf(studentId) {
  return all('SELECT * FROM scholarships WHERE student_id = ? ORDER BY academic_year DESC, id DESC', studentId);
}

function entitlementsOf(studentId) {
  return all('SELECT * FROM entitlements WHERE student_id = ? ORDER BY academic_year DESC, item', studentId);
}

/** Everything shown on a single student's overview page (used by headmaster, teacher and parent views). */
function studentOverview(studentId, month) {
  const student = studentRecord(studentId);
  if (!student) return null;
  return {
    student,
    parents: parentsOf(studentId),
    summary: attendanceSummary(studentId),
    calendar: attendanceCalendar(studentId, month),
    exams: reportCard(studentId),
    scholarships: scholarshipsOf(studentId),
    entitlements: entitlementsOf(studentId),
    homework: student.class_id ? homeworkForClass(student.class_id, 10) : [],
  };
}

module.exports = {
  academicYearStart, classLabel, allClasses, studentRecord, studentsInClass, parentsOf, childrenOf,
  isParentOf, teacherClasses, classTeacherOf, teacherAssignments, teacherCanViewStudent,
  attendanceSummary, attendanceCalendar, reportCard, timetableForClass, timetableForTeacher,
  noticesFor, homeworkForClass, upcomingEvents, lowAttendance, scholarshipsOf, entitlementsOf, studentOverview,
};
