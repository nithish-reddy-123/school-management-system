'use strict';
const express = require('express');
const { col, insertWithId, audit } = require('../db');
const { quoteOfTheDay, allQuotes } = require('../quotes');
const { requireLogin, requireRole } = require('../middleware/auth');
const A = require('../services/academics');
const { str, toInt, isValidDate, academicYear, nowLocal } = require('../utils');

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

// The school photo is stored in MongoDB (`files` collection) so it survives restarts on hosts with ephemeral disks.
const PHOTO_ID = 'school-photo';

/* ---------------- Public landing page ---------------- */

router.get('/', async (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const lang = res.locals.lang;
  const [hasPhoto, events] = await Promise.all([hasSchoolPhoto(), A.upcomingEvents(6)]);
  const school = res.locals.school;
  res.render('landing', {
    title: res.locals.t('home'),
    hasPhoto,
    quote: quoteOfTheDay(lang),
    quotes: allQuotes(lang),
    events,
    facilities: String(school.facilities || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    eventTypes: EVENT_TYPES,
  });
});

// Public school photo uploaded by the headmaster (falls back to the built-in illustration).
router.get('/school-photo', async (req, res) => {
  const file = await col('files').findOne({ _id: PHOTO_ID });
  res.set('Cache-Control', 'public, max-age=300');
  if (!file || !file.data) {
    // Default: the animated school illustration (same artwork that is inlined on the home page).
    res.type('image/svg+xml');
    return res.render('partials/school_scene');
  }
  res.type(file.contentType || 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(file.data.buffer));
});

async function hasSchoolPhoto() {
  return (await col('files').countDocuments({ _id: PHOTO_ID }, { limit: 1 })) > 0;
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

router.get('/profile', requireLogin, async (req, res) => {
  const u = req.user;
  const data = { title: 'My Profile', details: null, teacher: null, children: [] };
  if (u.role === 'student') data.details = await A.studentRecord(u.id);
  if (u.role === 'teacher' || u.role === 'headmaster') {
    // Service record fields are stored on the user document.
    const t = await col('users').findOne({ id: u.id }, { projection: { _id: 0, employee_id: 1, designation: 1, qualification: 1, joining_date: 1 } });
    data.teacher = t && (t.employee_id || t.designation || t.qualification || t.joining_date) ? t : null;
    data.classes = await A.teacherClasses(u.id);
  }
  if (u.role === 'parent') data.children = await A.childrenOf(u.id);
  res.render('common/profile', data);
});

/* ---------------- Notices ---------------- */

async function noticeClassesFor(user) {
  if (user.role === 'headmaster') return A.allClasses();
  if (user.role === 'teacher') return A.teacherClasses(user.id);
  return [];
}

router.get('/notices', requireLogin, async (req, res) => {
  const [notices, classes] = await Promise.all([A.noticesFor(req.user, 100), noticeClassesFor(req.user)]);
  res.render('common/notices', {
    title: 'Notices',
    notices,
    canPost: ['headmaster', 'teacher'].includes(req.user.role),
    classes,
    audiences: AUDIENCES,
  });
});

router.post('/notices', requireRole('headmaster', 'teacher'), async (req, res) => {
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
    if (!classId || !(await A.teacherClasses(req.user.id)).some((c) => c.id === classId)) {
      req.flash('error', 'Please choose one of your classes.');
      return res.redirect('/notices');
    }
    if (!['students', 'parents', 'students_parents'].includes(audience)) audience = 'students_parents';
  } else if (classId && !(await col('classes').findOne({ id: classId }))) {
    classId = null;
  }
  await insertWithId('notices', { title, body, audience, class_id: classId, posted_by: req.user.id, created_at: nowLocal() });
  req.flash('success', 'Notice published.');
  res.redirect('/notices');
});

router.post('/notices/:id/delete', requireRole('headmaster', 'teacher'), async (req, res) => {
  const notice = await col('notices').findOne({ id: toInt(req.params.id) });
  if (notice && (req.user.role === 'headmaster' || notice.posted_by === req.user.id)) {
    await col('notices').deleteOne({ id: notice.id });
    req.flash('success', 'Notice deleted.');
  } else {
    req.flash('error', 'You cannot delete this notice.');
  }
  res.redirect('/notices');
});

/* ---------------- Academic calendar ---------------- */

router.get('/calendar', requireLogin, async (req, res) => {
  const year = academicYear();
  const start = `${year.slice(0, 4)}-04-01`;
  const end = `${Number(year.slice(0, 4)) + 1}-03-31`;
  const events = await col('events').find({ date: { $gte: start, $lte: end } }, { projection: { _id: 0 } }).sort({ date: 1, id: 1 }).toArray();
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

router.post('/calendar', requireRole('headmaster'), async (req, res) => {
  const title = str(req.body.title, 150);
  const date = str(req.body.date, 10);
  const type = EVENT_TYPES[req.body.type] ? req.body.type : 'event';
  if (!title || !isValidDate(date)) {
    req.flash('error', 'Event title and a valid date are required.');
    return res.redirect('/calendar');
  }
  await insertWithId('events', { title, date, type, description: str(req.body.description, 1000) || null });
  req.flash('success', 'Event added to calendar.');
  res.redirect('/calendar');
});

router.post('/calendar/:id/delete', requireRole('headmaster'), async (req, res) => {
  await col('events').deleteOne({ id: toInt(req.params.id) });
  req.flash('success', 'Event removed.');
  res.redirect('/calendar');
});

/* ---------------- Grievances (raise & track own) ---------------- */

router.get('/grievances', requireRole('teacher', 'student', 'parent'), async (req, res) => {
  const mine = await col('grievances').find({ raised_by: req.user.id }, { projection: { _id: 0 } }).sort({ id: -1 }).toArray();
  res.render('common/grievances', { title: 'Grievances & Suggestions', mine, categories: GRIEVANCE_CATEGORIES });
});

router.post('/grievances', requireRole('teacher', 'student', 'parent'), async (req, res) => {
  const category = GRIEVANCE_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  const subject = str(req.body.subject, 150);
  const description = str(req.body.description, 4000);
  const anonymous = req.body.anonymous === '1';
  if (!subject || !description) {
    req.flash('error', 'Subject and description are required.');
    return res.redirect('/grievances');
  }
  // Anonymous submissions intentionally store no user reference so they cannot be traced back.
  await insertWithId('grievances', {
    raised_by: anonymous ? null : req.user.id, raised_role: req.user.role, category, subject, description,
    status: 'open', response: null, responded_by: null, created_at: nowLocal(), updated_at: null,
  });
  if (!anonymous) await audit(req.user.id, 'grievance_raised', subject, req.ip);
  req.flash('success', anonymous
    ? 'Submitted anonymously. It will not appear in your list because it is not linked to your account.'
    : 'Submitted. You can track the response below.');
  res.redirect('/grievances');
});

module.exports = router;
module.exports.AUDIENCES = AUDIENCES;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.PHOTO_ID = PHOTO_ID;
