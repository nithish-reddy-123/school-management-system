'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { one, all, run, audit, UPLOAD_DIR } = require('../db');
const { quoteOfTheDay, allQuotes } = require('../quotes');
const { requireLogin, requireRole } = require('../middleware/auth');
const A = require('../services/academics');
const { str, toInt, isValidDate, academicYear } = require('../utils');

const router = express.Router();

const AUDIENCES = {
  all: 'Everyone',
  staff: 'Staff only',
  students: 'Students',
  parents: 'Parents',
  students_parents: 'Students & Parents',
};
const EVENT_TYPES = { holiday: 'Holiday', exam: 'Examination', event: 'School Event', ptm: 'Parent-Teacher Meeting', smc: 'SMC Meeting' };
const GRIEVANCE_CATEGORIES = ['Academics', 'Infrastructure / Toilets / Drinking Water', 'Mid-Day Meal', 'Safety / Bullying', 'Staff Conduct', 'Scholarship / Entitlements', 'Suggestion', 'Other'];

/* ---------------- Public landing page ---------------- */

router.get('/', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const lang = res.locals.lang;
  const counts = one(`SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'student' AND is_active = 1) AS students,
      (SELECT COUNT(*) FROM users WHERE role IN ('teacher','headmaster') AND is_active = 1) AS teachers,
      (SELECT COUNT(*) FROM classes) AS classes`);
  const school = res.locals.school;
  res.render('landing', {
    title: res.locals.t('home'),
    hasPhoto: hasSchoolPhoto(),
    counts,
    quote: quoteOfTheDay(lang),
    quotes: allQuotes(lang),
    events: A.upcomingEvents(6),
    facilities: String(school.facilities || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    eventTypes: EVENT_TYPES,
  });
});

// Public school photo uploaded by the headmaster (falls back to the built-in illustration).
router.get('/school-photo', (req, res) => {
  const photo = one('SELECT photo FROM school_info WHERE id = 1');
  const file = photo && photo.photo ? path.join(UPLOAD_DIR, path.basename(photo.photo)) : null;
  res.set('Cache-Control', 'public, max-age=300');
  if (!file || !fs.existsSync(file)) {
    // Default: the animated school illustration (same artwork that is inlined on the home page).
    res.type('image/svg+xml');
    return res.render('partials/school_scene');
  }
  res.sendFile(file);
});

function hasSchoolPhoto() {
  const photo = one('SELECT photo FROM school_info WHERE id = 1');
  return !!(photo && photo.photo && fs.existsSync(path.join(UPLOAD_DIR, path.basename(photo.photo))));
}

router.get('/dashboard', requireLogin, (req, res) => {
  const handlers = {
    headmaster: () => require('./headmaster').dashboard,
    teacher: () => require('./teacher').dashboard,
    student: () => require('./student').dashboard,
    parent: () => require('./parent').dashboard,
  };
  return handlers[req.user.role]()(req, res);
});

router.get('/profile', requireLogin, (req, res) => {
  const u = req.user;
  const data = { title: 'My Profile', details: null, teacher: null, children: [] };
  if (u.role === 'student') data.details = A.studentRecord(u.id);
  if (u.role === 'teacher' || u.role === 'headmaster') {
    data.teacher = one('SELECT * FROM teachers WHERE user_id = ?', u.id);
    data.classes = A.teacherClasses(u.id);
  }
  if (u.role === 'parent') data.children = A.childrenOf(u.id);
  res.render('common/profile', data);
});

/* ---------------- Notices ---------------- */

function noticeClassesFor(user) {
  if (user.role === 'headmaster') return A.allClasses();
  if (user.role === 'teacher') return A.teacherClasses(user.id);
  return [];
}

router.get('/notices', requireLogin, (req, res) => {
  res.render('common/notices', {
    title: 'Notices',
    notices: A.noticesFor(req.user, 100),
    canPost: ['headmaster', 'teacher'].includes(req.user.role),
    classes: noticeClassesFor(req.user),
    audiences: AUDIENCES,
  });
});

router.post('/notices', requireRole('headmaster', 'teacher'), (req, res) => {
  const title = str(req.body.title, 150);
  const body = str(req.body.body, 4000);
  let audience = str(req.body.audience, 20);
  let classId = toInt(req.body.class_id);
  if (!title || !body) {
    req.flash('error', 'Title and message are required.');
    return res.redirect('/notices');
  }
  if (!AUDIENCES[audience]) audience = 'all';
  if (req.user.role === 'teacher') {
    // Teachers can only address students/parents of classes they teach.
    if (!classId || !A.teacherClasses(req.user.id).some((c) => c.id === classId)) {
      req.flash('error', 'Please choose one of your classes.');
      return res.redirect('/notices');
    }
    if (!['students', 'parents', 'students_parents'].includes(audience)) audience = 'students_parents';
  } else if (classId && !one('SELECT id FROM classes WHERE id = ?', classId)) {
    classId = null;
  }
  run('INSERT INTO notices (title, body, audience, class_id, posted_by) VALUES (?, ?, ?, ?, ?)', title, body, audience, classId, req.user.id);
  req.flash('success', 'Notice published.');
  res.redirect('/notices');
});

router.post('/notices/:id/delete', requireRole('headmaster', 'teacher'), (req, res) => {
  const notice = one('SELECT * FROM notices WHERE id = ?', toInt(req.params.id));
  if (notice && (req.user.role === 'headmaster' || notice.posted_by === req.user.id)) {
    run('DELETE FROM notices WHERE id = ?', notice.id);
    req.flash('success', 'Notice deleted.');
  } else {
    req.flash('error', 'You cannot delete this notice.');
  }
  res.redirect('/notices');
});

/* ---------------- Academic calendar ---------------- */

router.get('/calendar', requireLogin, (req, res) => {
  const year = academicYear();
  const start = `${year.slice(0, 4)}-04-01`;
  const end = `${Number(year.slice(0, 4)) + 1}-03-31`;
  const events = all('SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date', start, end);
  const months = [];
  for (const e of events) {
    const key = e.date.slice(0, 7);
    let m = months.find((x) => x.key === key);
    if (!m) {
      const [y, mo] = key.split('-').map(Number);
      m = { key, label: new Date(y, mo - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }), events: [] };
      months.push(m);
    }
    m.events.push(e);
  }
  res.render('common/calendar', { title: 'Academic Calendar', months, year, types: EVENT_TYPES, canEdit: req.user.role === 'headmaster' });
});

router.post('/calendar', requireRole('headmaster'), (req, res) => {
  const title = str(req.body.title, 150);
  const date = str(req.body.date, 10);
  const type = EVENT_TYPES[req.body.type] ? req.body.type : 'event';
  if (!title || !isValidDate(date)) {
    req.flash('error', 'Event title and a valid date are required.');
    return res.redirect('/calendar');
  }
  run('INSERT INTO events (title, date, type, description) VALUES (?, ?, ?, ?)', title, date, type, str(req.body.description, 1000));
  req.flash('success', 'Event added to calendar.');
  res.redirect('/calendar');
});

router.post('/calendar/:id/delete', requireRole('headmaster'), (req, res) => {
  run('DELETE FROM events WHERE id = ?', toInt(req.params.id));
  req.flash('success', 'Event removed.');
  res.redirect('/calendar');
});

/* ---------------- Grievances (raise & track own) ---------------- */

router.get('/grievances', requireRole('teacher', 'student', 'parent'), (req, res) => {
  const mine = all('SELECT * FROM grievances WHERE raised_by = ? ORDER BY id DESC', req.user.id);
  res.render('common/grievances', { title: 'Grievances & Suggestions', mine, categories: GRIEVANCE_CATEGORIES });
});

router.post('/grievances', requireRole('teacher', 'student', 'parent'), (req, res) => {
  const category = GRIEVANCE_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  const subject = str(req.body.subject, 150);
  const description = str(req.body.description, 4000);
  const anonymous = req.body.anonymous === '1';
  if (!subject || !description) {
    req.flash('error', 'Subject and description are required.');
    return res.redirect('/grievances');
  }
  // Anonymous submissions intentionally store no user reference so they cannot be traced back.
  run('INSERT INTO grievances (raised_by, raised_role, category, subject, description) VALUES (?, ?, ?, ?, ?)',
    anonymous ? null : req.user.id, req.user.role, category, subject, description);
  if (!anonymous) audit(req.user.id, 'grievance_raised', subject, req.ip);
  req.flash('success', anonymous
    ? 'Submitted anonymously. It will not appear in your list because it is not linked to your account.'
    : 'Submitted. You can track the response below.');
  res.redirect('/grievances');
});

module.exports = router;
module.exports.AUDIENCES = AUDIENCES;
module.exports.EVENT_TYPES = EVENT_TYPES;
