'use strict';
const R = require('../services/registrations');
const A = require('../services/academics');
const { GENDERS } = require('../utils');

const STATUSES = ['pending', 'approved', 'rejected'];

/** Adds the review pages to a role router (headmaster at /hm/registrations, teacher at /teacher/registrations). */
module.exports = function mountRegistrationReview(router, base) {
  router.get('/registrations', async (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'pending';
    const [rows, counts, classes] = await Promise.all([R.listFor(req.user, status), R.countsFor(req.user), A.allClasses()]);
    res.render('common/registrations', {
      title: 'Registrations',
      base, status, rows, counts, classes,
      RELATION_LABEL: R.RELATION_LABEL,
      GENDERS,
    });
  });

  router.post('/registrations/:id/approve', async (req, res) => {
    try {
      const { userId, reg, notes } = await R.approve(req.params.id, req.user, req.body, req.ip);
      req.flash('success', `${reg.full_name} (${reg.role}) verified and approved. They can now log in as "${reg.username}" with the password they chose.`);
      notes.forEach((n) => req.flash('error', n));
      if (req.user.role === 'headmaster') return res.redirect(`/hm/users/${userId}`);
      return res.redirect(reg.role === 'student' ? `/teacher/students/${userId}` : `${base}?status=approved`);
    } catch (err) {
      if (!(err instanceof R.ReviewError)) throw err;
      req.flash('error', err.message);
      return res.redirect(base);
    }
  });

  router.post('/registrations/:id/reject', async (req, res) => {
    try {
      const reg = await R.reject(req.params.id, req.user, req.body.note, req.ip);
      req.flash('success', `Registration of ${reg.full_name} rejected.`);
    } catch (err) {
      if (!(err instanceof R.ReviewError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(base);
  });
};
