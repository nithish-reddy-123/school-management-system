'use strict';
const session = require('express-session');
const { one, run } = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Persists express-session data in the app's SQLite database so logins survive restarts. */
class SQLiteStore extends session.Store {
  constructor() {
    super();
    this.pruneTimer = setInterval(() => this.prune(), 15 * 60 * 1000);
    this.pruneTimer.unref();
  }

  expiry(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    return exp ? new Date(exp).getTime() : Date.now() + DAY_MS;
  }

  get(sid, cb) {
    try {
      const row = one('SELECT sess, expires FROM sessions WHERE sid = ?', sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      return cb(null, JSON.parse(row.sess));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      run(
        `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
        sid, JSON.stringify(sess), this.expiry(sess),
      );
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      run('UPDATE sessions SET expires = ? WHERE sid = ?', this.expiry(sess), sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      run('DELETE FROM sessions WHERE sid = ?', sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  prune() {
    try {
      run('DELETE FROM sessions WHERE expires < ?', Date.now());
    } catch {
      /* ignore */
    }
  }
}

module.exports = SQLiteStore;
