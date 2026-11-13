'use strict';
const crypto = require('node:crypto');
const { col } = require('../db');
const { translator, LANGS, LANG_NAMES } = require('../i18n');
const utils = require('../utils');
const { pendingCount } = require('../services/registrations');

const USER_FIELDS = { _id: 0, id: 1, username: 1, role: 1, full_name: 1, phone: 1, email: 1, is_active: 1, must_change_password: 1, last_login: 1 };

// Sidebar navigation grouped into sections: [sectionKey, [[href, labelKey, iconId], ...]]
const NAV = {
  headmaster: [
    ['sec_overview', [['/dashboard', 'dashboard', 'home']]],
    ['sec_people', [['/hm/users', 'users', 'users'], ['/hm/registrations', 'registrations', 'user-plus']]],
    ['sec_academics', [['/hm/classes', 'classes', 'school'], ['/hm/subjects', 'subjects', 'book'], ['/hm/exams', 'exams', 'clipboard'],
      ['/hm/reports/attendance', 'reports', 'chart'], ['/hm/staff-attendance', 'staffAttendance', 'user-check']]],
    ['sec_welfare', [['/hm/mdm', 'mdm', 'bowl'], ['/hm/scholarships', 'scholarships', 'cap'], ['/hm/entitlements', 'entitlements', 'backpack']]],
    ['sec_communication', [['/notices', 'notices', 'megaphone'], ['/calendar', 'calendar', 'calendar'], ['/hm/grievances', 'grievances', 'message']]],
    ['sec_admin', [['/hm/school', 'schoolProfile', 'landmark'], ['/hm/audit', 'auditLog', 'shield']]],
  ],
  teacher: [
    ['sec_overview', [['/dashboard', 'dashboard', 'home']]],
    ['sec_classroom', [['/teacher/attendance', 'attendance', 'check-square'], ['/teacher/marks', 'marks', 'pen'],
      ['/teacher/homework', 'homework', 'notebook'], ['/teacher/students', 'myStudents', 'users'], ['/teacher/timetable', 'timetable', 'clock']]],
    ['sec_requests', [['/teacher/leaves', 'leave', 'send'], ['/teacher/registrations', 'registrations', 'user-plus']]],
    ['sec_communication', [['/notices', 'notices', 'megaphone'], ['/calendar', 'calendar', 'calendar'], ['/grievances', 'grievances', 'message']]],
  ],
  student: [
    ['sec_overview', [['/dashboard', 'dashboard', 'home']]],
    ['sec_learning', [['/student/attendance', 'attendance', 'check-square'], ['/student/report-card', 'reportCard', 'file-text'],
      ['/student/homework', 'homework', 'notebook'], ['/student/timetable', 'timetable', 'clock']]],
    ['sec_school', [['/notices', 'notices', 'megaphone'], ['/calendar', 'calendar', 'calendar'], ['/grievances', 'grievances', 'message']]],
  ],
  parent: [
    ['sec_overview', [['/dashboard', 'myChildren', 'heart']]],
    ['sec_requests', [['/parent/leave', 'applyLeave', 'send']]],
    ['sec_school', [['/notices', 'notices', 'megaphone'], ['/calendar', 'calendar', 'calendar'], ['/grievances', 'grievances', 'message']]],
  ],
};

/** Inline SVG icon from the sprite. Names come from code only, never from user input. */
function icon(name, cls = '') {
  const safe = String(name).replace(/[^a-z0-9-]/g, '');
  return `<svg class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="/img/icons.svg#${safe}"/></svg>`;
}

function greetingKey(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? 'goodMorning' : h < 17 ? 'goodAfternoon' : 'goodEvening';
}
/** Shared template locals: language, translator, flash, school info, helpers. */
async function locals(req, res, next) {
  const lang = LANGS.includes(req.session.lang) ? req.session.lang : 'en';
  res.locals.lang = lang;
  res.locals.t = translator(lang);
  res.locals.currentPath = req.path;
  res.locals.utils = utils;
  res.locals.icon = icon;
  res.locals.greeting = greetingKey();
  res.locals.today = utils.localDate();
  res.locals.user = null;
  res.locals.nav = [];
  res.locals.crumb = null;
  res.locals.pendingRegistrations = 0;
  res.locals.csrfToken = '';
  const school = await col('school_info').findOne({ id: 1 }, { projection: { _id: 0 } }) || { name: '', udise_code: '', district: '', state: '' };
  res.locals.school = school;
  res.locals.schoolName = (lang === 'hi' && school.name_hi) || (lang === 'te' && school.name_te) || school.name;
  res.locals.hasPhoto = !!school.photo;
  res.locals.langNames = LANG_NAMES;
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  next();
}

/** Loads the signed-in user on every request and drops sessions of deactivated/deleted users. */
async function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.nav = [];
  if (req.session.userId) {
    const user = await col('users').findOne({ id: req.session.userId }, { projection: USER_FIELDS });
    if (!user || !user.is_active) {
      return req.session.destroy(() => res.redirect('/login'));
    }
    req.user = user;
    res.locals.user = user;
    // Only requests this user is the verifier for (teacher: own class; headmaster: teachers + unrouted).
    const pending = await pendingCount(user);
    res.locals.pendingRegistrations = pending;
    res.locals.nav = (NAV[user.role] || []).map(([section, items]) => ({
      section,
      items: items.map(([href, key, iconId]) => ({ href, key, icon: iconId, badge: key === 'registrations' && pending ? pending : null })),
    }));
    res.locals.crumb = crumbFor(res.locals.nav, req.path);
  }
  next();
}

/** Breadcrumb context for the current page, derived from the navigation (longest matching prefix wins). */
function crumbFor(nav, path) {
  let best = null;
  for (const group of nav) {
    for (const item of group.items) {
      const match = item.href === '/dashboard' ? path === '/dashboard' : path === item.href || path.startsWith(`${item.href}/`);
      if (match && (!best || item.href.length > best.href.length)) best = { section: group.section, ...item };
    }
  }
  if (best) best.isRoot = path === best.href;
  return best;
}

/** Users with a temporary password must set their own before doing anything else. */
function enforcePasswordChange(req, res, next) {
  const allowed = ['/change-password', '/logout', ...LANGS.map((l) => `/lang/${l}`)];
  if (req.user && req.user.must_change_password && !allowed.includes(req.path)) {
    return res.redirect('/change-password');
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', {
        title: 'Access denied',
        status: 403,
        message: 'Your role does not have permission to open this page.',
      });
    }
    next();
  };
}

// File-upload routes: their multipart body is parsed inside the route, which then calls verifyCsrf itself.
const MULTIPART_ROUTES = ['/hm/school/photo'];

function verifyCsrf(req) {
  const sent = Buffer.from(String((req.body && req.body._csrf) || ''));
  const expected = Buffer.from(req.session.csrfToken || '');
  return expected.length > 0 && sent.length === expected.length && crypto.timingSafeEqual(sent, expected);
}

function csrfFailed(res) {
  return res.status(403).render('error', {
    title: 'Session expired',
    status: 403,
    message: 'Your form session expired or the request was invalid. Please go back, refresh the page and try again.',
  });
}

/** Synchronizer-token CSRF protection for every state-changing request. */
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.is('multipart/form-data')) {
    // Only allow-listed upload routes may receive multipart bodies; everything else is rejected.
    return MULTIPART_ROUTES.includes(req.path) ? next() : csrfFailed(res);
  }
  if (!verifyCsrf(req)) return csrfFailed(res);
  next();
}

module.exports = { locals, loadUser, enforcePasswordChange, requireLogin, requireRole, csrf, verifyCsrf, csrfFailed };
