'use strict';
const express = require('express');
const { all } = require('../db');
const { requireRole } = require('../middleware/auth');
const A = require('../services/academics');
const { localDate, dayOfWeek, monthParam } = require('../utils');

const router = express.Router();
router.use(requireRole('student'));

function dashboard(req, res) {
  const student = A.studentRecord(req.user.id);
  const dow = dayOfWeek(localDate());
  const todaysPeriods = student.class_id && dow >= 1 && dow <= 6
    ? all(`SELECT t.period, sub.name AS subject, u.full_name AS teacher FROM timetable t
        LEFT JOIN subjects sub ON sub.id = t.subject_id LEFT JOIN users u ON u.id = t.teacher_id
        WHERE t.class_id = ? AND t.day = ? ORDER BY t.period`, student.class_id, dow)
    : [];
  const exams = A.reportCard(req.user.id);
  res.render('student/dashboard', {
    title: 'Student Dashboard',
    student,
    summary: A.attendanceSummary(req.user.id),
    todaysPeriods,
    homework: student.class_id ? A.homeworkForClass(student.class_id, 5) : [],
    latestExam: exams[exams.length - 1] || null,
    notices: A.noticesFor(req.user, 5),
    events: A.upcomingEvents(5),
    scholarships: A.scholarshipsOf(req.user.id),
    entitlements: A.entitlementsOf(req.user.id),
    today: localDate(),
  });
}

router.get('/attendance', (req, res) => {
  res.render('student/attendance', {
    title: 'My Attendance',
    summary: A.attendanceSummary(req.user.id),
    calendar: A.attendanceCalendar(req.user.id, monthParam(req.query.month)),
  });
});

router.get('/report-card', (req, res) => {
  res.render('student/report_card', {
    title: 'Report Card',
    student: A.studentRecord(req.user.id),
    exams: A.reportCard(req.user.id),
    summary: A.attendanceSummary(req.user.id),
  });
});

router.get('/homework', (req, res) => {
  const student = A.studentRecord(req.user.id);
  res.render('student/homework', {
    title: 'Homework',
    homework: student.class_id ? A.homeworkForClass(student.class_id, 100) : [],
    today: localDate(),
  });
});

router.get('/timetable', (req, res) => {
  const student = A.studentRecord(req.user.id);
  res.render('student/timetable', {
    title: 'Class Timetable',
    student,
    timetable: student.class_id ? A.timetableForClass(student.class_id) : null,
  });
});

module.exports = router;
module.exports.dashboard = dashboard;
