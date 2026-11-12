'use strict';
const express = require('express');
const { col, byIds, insertWithId } = require('../db');
const { requireRole } = require('../middleware/auth');
const A = require('../services/academics');
const { str, toInt, isValidDate, localDate, nowLocal, monthParam, addDays } = require('../utils');

const router = express.Router();
router.use(requireRole('parent'));

async function dashboard(req, res) {
  const today = localDate();
  const children = await Promise.all((await A.childrenOf(req.user.id)).map(async (c) => {
    const [exams, summary, homeworkRows, att] = await Promise.all([
      A.reportCard(c.id),
      A.attendanceSummary(c.id),
      c.class_id ? col('homework').find({ class_id: c.class_id, due_date: { $gte: today } }).sort({ due_date: 1 }).limit(5).toArray() : [],
      col('attendance').findOne({ student_id: c.id, date: today }),
    ]);
    const subjects = await byIds('subjects', homeworkRows.map((h) => h.subject_id));
    return {
      ...c,
      summary,
      latestExam: exams[exams.length - 1] || null,
      homework: homeworkRows.filter((h) => subjects.has(h.subject_id)).map((h) => ({ title: h.title, due_date: h.due_date, subject_name: subjects.get(h.subject_id).name })),
      todayStatus: att ? att.status : null,
    };
  }));
  const [notices, events] = await Promise.all([A.noticesFor(req.user, 5), A.upcomingEvents(5)]);
  res.render('parent/dashboard', { title: 'Parent Dashboard', children, notices, events });
}

router.get('/child/:id', async (req, res) => {
  const id = toInt(req.params.id);
  if (!await A.isParentOf(req.user.id, id)) {
    return res.status(403).render('error', { title: 'Access denied', status: 403, message: 'This student is not linked to your account.' });
  }
  const overview = await A.studentOverview(id, monthParam(req.query.month));
  if (!overview) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Student not found.' });
  res.render('parent/child', { title: overview.student.full_name, overview });
});

router.get('/leave', async (req, res) => {
  const kids = await col('parent_student').distinct('student_id', { parent_id: req.user.id });
  const leaves = await col('leave_requests').find({ student_id: { $in: kids } }, { projection: { _id: 0 } }).sort({ id: -1 }).limit(100).toArray();
  const users = await byIds('users', [...leaves.map((l) => l.student_id), ...leaves.map((l) => l.reviewed_by)], { id: 1, full_name: 1 });
  const rows = leaves.filter((l) => users.has(l.student_id)).map((l) => ({
    ...l, student_name: users.get(l.student_id).full_name, reviewed_by_name: (users.get(l.reviewed_by) || {}).full_name || null,
  }));
  res.render('parent/leave', { title: 'Leave Applications', rows, children: await A.childrenOf(req.user.id), today: localDate() });
});

router.post('/leave', async (req, res) => {
  const studentId = toInt(req.body.student_id);
  const from = str(req.body.from_date, 10);
  const to = str(req.body.to_date, 10);
  const reason = str(req.body.reason, 1000);
  const earliest = addDays(localDate(), -7);
  let error = null;
  if (!await A.isParentOf(req.user.id, studentId)) error = 'Please choose your child.';
  else if (!isValidDate(from) || !isValidDate(to) || to < from) error = 'Enter a valid date range.';
  else if (from < earliest) error = 'Leave can be applied for at most 7 days in the past.';
  else if (addDays(from, 30) < to) error = 'A single application can cover at most 30 days.';
  else if (!reason) error = 'Please give a reason.';
  if (error) {
    req.flash('error', error);
    return res.redirect('/parent/leave');
  }
  await insertWithId('leave_requests', {
    student_id: studentId, requested_by: req.user.id, from_date: from, to_date: to, reason,
    status: 'pending', reviewed_by: null, reviewed_at: null, created_at: nowLocal(),
  });
  req.flash('success', 'Leave application sent to the class teacher.');
  res.redirect('/parent/leave');
});

module.exports = router;
module.exports.dashboard = dashboard;
