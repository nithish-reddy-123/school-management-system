'use strict';
const express = require('express');
const { col, byIds } = require('../db');
const { requireRole } = require('../middleware/auth');
const A = require('../services/academics');
const { localDate, dayOfWeek, monthParam } = require('../utils');

const router = express.Router();
router.use(requireRole('student'));

async function todaysPeriodsForClass(classId) {
  const dow = dayOfWeek(localDate());
  if (!classId || dow < 1 || dow > 6) return [];
  const slots = await col('timetable').find({ class_id: classId, day: dow }).sort({ period: 1 }).toArray();
  const [subjects, teachers] = await Promise.all([byIds('subjects', slots.map((s) => s.subject_id)), byIds('users', slots.map((s) => s.teacher_id), { id: 1, full_name: 1 })]);
  return slots.map((s) => ({ period: s.period, subject: (subjects.get(s.subject_id) || {}).name || null, teacher: (teachers.get(s.teacher_id) || {}).full_name || null }));
}

async function dashboard(req, res) {
  const student = await A.studentRecord(req.user.id);
  const [todaysPeriods, exams, summary, homework, notices, events, scholarships, entitlements] = await Promise.all([
    todaysPeriodsForClass(student.class_id),
    A.reportCard(req.user.id),
    A.attendanceSummary(req.user.id),
    student.class_id ? A.homeworkForClass(student.class_id, 5) : [],
    A.noticesFor(req.user, 5),
    A.upcomingEvents(5),
    A.scholarshipsOf(req.user.id),
    A.entitlementsOf(req.user.id),
  ]);
  res.render('student/dashboard', {
    title: 'Student Dashboard',
    student, summary, todaysPeriods, homework,
    latestExam: exams[exams.length - 1] || null,
    notices, events, scholarships, entitlements,
    today: localDate(),
  });
}

router.get('/attendance', async (req, res) => {
  const [summary, calendar] = await Promise.all([A.attendanceSummary(req.user.id), A.attendanceCalendar(req.user.id, monthParam(req.query.month))]);
  res.render('student/attendance', { title: 'My Attendance', summary, calendar });
});

router.get('/report-card', async (req, res) => {
  const [student, exams, summary] = await Promise.all([A.studentRecord(req.user.id), A.reportCard(req.user.id), A.attendanceSummary(req.user.id)]);
  res.render('student/report_card', { title: 'Report Card', student, exams, summary });
});

router.get('/homework', async (req, res) => {
  const student = await A.studentRecord(req.user.id);
  res.render('student/homework', {
    title: 'Homework',
    homework: student.class_id ? await A.homeworkForClass(student.class_id, 100) : [],
    today: localDate(),
  });
});

router.get('/timetable', async (req, res) => {
  const student = await A.studentRecord(req.user.id);
  res.render('student/timetable', {
    title: 'Class Timetable',
    student,
    timetable: student.class_id ? await A.timetableForClass(student.class_id) : null,
  });
});

module.exports = router;
module.exports.dashboard = dashboard;
