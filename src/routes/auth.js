'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const { col, audit } = require('../db');
const { destroyUserSessions } = require('../sessionStore');
const { LANGS } = require('../i18n');
const { str, passwordProblem, nowLocal } = require('../utils');

const router = express.Router();

// Hash used when the username does not exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => res.status(429).render('auth/login', {
    title: 'Login', username: str(req.body && req.body.username, 50), role: roleParam(req.body && req.body.role), roles: ROLES,
    error: 'Too many failed attempts. Please wait 15 minutes and try again.',
  }),
});

const ROLES = ['student', 'parent', 'teacher', 'headmaster'];
const roleParam = (v) => (ROLES.includes(v) ? v : null);

/** Promise wrappers for express-session's callback API. */
const regenerate = (req) => new Promise((ok, fail) => req.session.regenerate((e) => (e ? fail(e) : ok())));
const save = (req) => new Promise((ok, fail) => req.session.save((e) => (e ? fail(e) : ok())));

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Login', username: '', role: roleParam(req.query.role), roles: ROLES, error: null });
});

router.post('/login', loginLimiter, async (req, res) => {
  const username = str(req.body.username, 50).toLowerCase();
  const password = String(req.body.password || '').slice(0, 200);
  const role = roleParam(req.body.role);
  const user = username ? await col('users').findOne({ username }) : null;
  const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  const fail = async (error, details) => {
    await audit(user ? user.id : null, 'login_failed', details, req.ip);
    return res.status(401).render('auth/login', { title: 'Login', username, role, roles: ROLES, error });
  };

  if (!user) {
    // Self-registered users get a clear status message (only when their password is correct).
    const reg = username
      ? await col('registrations').find({ username, status: { $ne: 'approved' } }).sort({ id: -1 }).limit(1).next()
      : null;
    if (reg && bcrypt.compareSync(password, reg.password_hash)) {
      return fail(res.locals.t(reg.status === 'pending' ? 'pendingApproval' : 'registrationRejected'), `username=${username} registration ${reg.status}`);
    }
  }
  if (!user || !ok) return fail('Invalid username or password.', `username=${username}`);
  if (!user.is_active) return fail('This account has been deactivated. Please contact the school office.', `username=${username} inactive`);
  // The role chosen on the login page must match the account, so e.g. a student cannot use the teacher portal.
  if (role && user.role !== role) {
    return fail(res.locals.t('wrongRole', { role: res.locals.t(role) }), `username=${username} chose role=${role}`);
  }

  const lang = req.session.lang;
  // New session ID on login prevents session fixation.
  await regenerate(req);
  req.session.userId = user.id;
  req.session.lang = lang;
  await col('users').updateOne({ id: user.id }, { $set: { last_login: nowLocal() } });
  await audit(user.id, 'login', null, req.ip);
  await save(req);
  res.redirect('/dashboard');
});

router.post('/logout', async (req, res) => {
  if (req.user) await audit(req.user.id, 'logout', null, req.ip);
  req.session.destroy(() => {
    res.clearCookie('sms.sid');
    res.redirect('/login');
  });
});

router.get('/change-password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('auth/change_password', { title: 'Change Password', error: null });
});

router.post('/change-password', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '').slice(0, 200);
  const confirm = String(req.body.confirm_password || '');
  const row = await col('users').findOne({ id: req.user.id }, { projection: { password_hash: 1 } });
  let error = null;
  if (!bcrypt.compareSync(current, row.password_hash)) error = 'Current password is incorrect.';
  else if (next !== confirm) error = 'New passwords do not match.';
  else if (next === current) error = 'New password must be different from the current password.';
  else error = passwordProblem(next, req.user.username);
  if (error) return res.status(400).render('auth/change_password', { title: 'Change Password', error });

  await col('users').updateOne({ id: req.user.id }, { $set: { password_hash: bcrypt.hashSync(next, 10), must_change_password: 0 } });
  // Sign out other devices by removing every other session for this user.
  await destroyUserSessions(req.user.id, req.sessionID);
  await audit(req.user.id, 'password_changed', null, req.ip);
  req.flash('success', 'Password changed successfully.');
  res.redirect('/dashboard');
});

router.get('/lang/:code', (req, res) => {
  if (LANGS.includes(req.params.code)) req.session.lang = req.params.code;
  let back = '/';
  try {
    const ref = new URL(req.get('referer') || '');
    if (ref.host === req.get('host')) back = ref.pathname + ref.search;
  } catch {
    /* no or invalid referer */
  }
  res.redirect(back);
});

module.exports = router;
