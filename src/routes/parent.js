'use strict';
const express = require('express');
const { all, run } = require('../db');
const { requireRole } = require('../middleware/auth');
const A = require('../services/academics');
const { str, toInt, isValidDate, localDate, monthParam, addDays } = require('../utils');

const router = express.Router();
router.use(requireRole('parent'));

function dashboard(req, res) {
  const today = localDate();
  const children = A.childrenOf(req.user.id).map((c) => {
    const exams = A.reportCard(c.id);
    return {
      ...c,
      summary: A.attendanceSummary(c.id),
      latestExam: exams[exams.length - 1] || null,
      homework: c.class_id ? all('SELECT h.title, h.due_date, sub.name AS subject_name FROM homework h JOIN subjects sub ON sub.id = h.subject_id WHERE h.class_id = ? AND h.due_date >= ? ORDER BY h.due_date LIMIT 5', c.class_id, today) : [],
      todayStatus: (all('SELECT status FROM attendance WHERE student_id = ? AND date = ?', c.id, today)[0] || {}).status || null,
    };
  });
  res.render('parent/dashboard', {
    title: 'Parent Dashboard',
    children,
    notices: A.noticesFor(req.user, 5),
    events: A.upcomingEvents(5),
  });
}

router.get('/child/:id', (req, res) => {
  const id = toInt(req.params.id);
  if (!A.isParentOf(req.user.id, id)) {
    return res.status(403).render('error', { title: 'Access denied', status: 403, message: 'This student is not linked to your account.' });
  }
  const overview = A.studentOverview(id, monthParam(req.query.month));
  res.render('parent/child', { title: overview.student.full_name, overview });
});

router.get('/leave', (req, res) => {
  const rows = all(`SELECT lr.*, u.full_name AS student_name, r.full_name AS reviewed_by_name
    FROM leave_requests lr JOIN users u ON u.id = lr.student_id LEFT JOIN users r ON r.id = lr.reviewed_by
    WHERE lr.student_id IN (SELECT student_id FROM parent_student WHERE parent_id = ?)
    ORDER BY lr.id DESC LIMIT 100`, req.user.id);
  res.render('parent/leave', { title: 'Leave Applications', rows, children: A.childrenOf(req.user.id), today: localDate() });
});

router.post('/leave', (req, res) => {
  const studentId = toInt(req.body.student_id);
  const from = str(req.body.from_date, 10);
  const to = str(req.body.to_date, 10);
  const reason = str(req.body.reason, 1000);
  const earliest = addDays(localDate(), -7);
  let error = null;
  if (!A.isParentOf(req.user.id, studentId)) error = 'Please choose your child.';
  else if (!isValidDate(from) || !isValidDate(to) || to < from) error = 'Enter a valid date range.';
  else if (from < earliest) error = 'Leave can be applied for at most 7 days in the past.';
  else if (addDays(from, 30) < to) error = 'A single application can cover at most 30 days.';
  else if (!reason) error = 'Please give a reason.';
  if (error) {
    req.flash('error', error);
    return res.redirect('/parent/leave');
  }
  run('INSERT INTO leave_requests (student_id, requested_by, from_date, to_date, reason) VALUES (?, ?, ?, ?, ?)', studentId, req.user.id, from, to, reason);
  req.flash('success', 'Leave application sent to the class teacher.');
  res.redirect('/parent/leave');
});

module.exports = router;
module.exports.dashboard = dashboard;
