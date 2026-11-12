'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const { one, all, run, audit } = require('../db');
const { str, toInt, isValidDate, localDate, passwordProblem, USERNAME_RE, PHONE_RE, EMAIL_RE } = require('../utils');

const router = express.Router();

// Headmasters are never self-registered; their accounts are created by the system or another headmaster.
const ROLES = ['student', 'parent', 'teacher'];
const RELATIONS = ['father', 'mother', 'guardian'];

// Only successful registrations count (validation errors return 400), so a typo doesn't lock anyone out.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipFailedRequests: true,
  handler: (req, res) => renderForm(req, res, roleOf(req.body && req.body.role), emptyForm(), res.locals.t('err_rate'), 429),
});

const roleOf = (v) => (ROLES.includes(v) ? v : 'student');

function emptyForm() {
  return {
    full_name: '', username: '', phone: '', email: '', class_id: '', dob: '', gender: '', admission_no: '',
    guardian_name: '', guardian_phone: '', address: '', children: '', relation: 'father',
    employee_id: '', designation: '', qualification: '',
  };
}

function renderForm(req, res, role, v, error, status = 200) {
  res.status(status).render('auth/register', {
    title: res.locals.t('register'),
    role, roles: ROLES, v, error, relations: RELATIONS,
    classes: all('SELECT id, name, section FROM classes ORDER BY CAST(name AS INTEGER), name, section'),
  });
}

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  renderForm(req, res, roleOf(req.query.role), emptyForm(), null);
});

router.post('/register', registerLimiter, (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const t = res.locals.t;
  const role = roleOf(req.body.role);
  const v = emptyForm();
  for (const k of Object.keys(v)) v[k] = str(req.body[k], k === 'address' ? 300 : 120);
  v.username = v.username.toLowerCase();
  const password = String(req.body.password || '').slice(0, 200);
  const confirm = String(req.body.confirm_password || '');

  // Honeypot: real users never see or fill this field; bots usually do. Pretend success and store nothing.
  if (str(req.body.website, 100)) {
    req.flash('success', t('registrationReceived'));
    return res.redirect(`/login?role=${role}`);
  }

  let error = null;
  if (!v.full_name) error = t('err_name');
  else if (!USERNAME_RE.test(v.username)) error = t('err_username');
  else if (one('SELECT 1 AS x FROM users WHERE username = ?', v.username)
    || one("SELECT 1 AS x FROM registrations WHERE username = ? AND status = 'pending'", v.username)) error = t('err_taken');
  else if ((role !== 'student' || v.phone) && !PHONE_RE.test(v.phone)) error = t('err_phone');
  else if (v.email && !EMAIL_RE.test(v.email)) error = t('err_email');
  else if (passwordProblem(password, v.username)) error = t('err_password');
  else if (password !== confirm) error = t('err_mismatch');
  else if (role === 'student') {
    const classId = toInt(v.class_id);
    if (!classId || !one('SELECT id FROM classes WHERE id = ?', classId)) error = t('err_class');
    else if (!isValidDate(v.dob) || v.dob >= localDate()) error = t('err_dob');
    else if (v.guardian_phone && !PHONE_RE.test(v.guardian_phone)) error = t('err_phone');
  } else if (role === 'parent') {
    if (!v.children.split(',').map((s) => s.trim()).filter(Boolean).length) error = t('err_children');
  }
  if (error) return renderForm(req, res, role, v, error, 400);

  const details = role === 'student'
    ? { class_id: toInt(v.class_id), dob: v.dob, gender: ['M', 'F', 'O'].includes(v.gender) ? v.gender : null, admission_no: v.admission_no, guardian_name: v.guardian_name, guardian_phone: v.guardian_phone, address: v.address }
    : role === 'parent'
      ? { children: v.children, relation: RELATIONS.includes(v.relation) ? v.relation : 'guardian' }
      : { employee_id: v.employee_id, designation: v.designation, qualification: v.qualification };

  try {
    run(`INSERT INTO registrations (role, username, password_hash, full_name, phone, email, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, role, v.username, bcrypt.hashSync(password, 10), v.full_name, v.phone, v.email, JSON.stringify(details), req.ip);
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) throw err;
    return renderForm(req, res, role, v, t('err_taken'), 400);
  }
  audit(null, 'registration_submitted', `${role} ${v.username}`, req.ip);
  req.flash('success', t('registrationReceived'));
  res.redirect(`/login?role=${role}`);
});

module.exports = router;
