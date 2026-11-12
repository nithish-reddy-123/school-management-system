'use strict';
const session = require('express-session');
const { col } = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;

function expiryOf(sess) {
  const exp = sess && sess.cookie && sess.cookie.expires;
  return exp ? new Date(exp) : new Date(Date.now() + DAY_MS);
}

/**
 * express-session store backed by the `sessions` collection, so logins survive restarts and redeploys.
 * The session is stored as JSON text (keeps express-session's exact format); `userId` is copied out so other
 * sessions of a user can be signed out. A TTL index on `expires` lets MongoDB delete expired sessions itself.
 */
class MongoSessionStore extends session.Store {
  get(sid, cb) {
    col('sessions').findOne({ sid })
      .then((row) => cb(null, row && row.expires > new Date() ? JSON.parse(row.sess) : null))
      .catch(cb);
  }

  set(sid, sess, cb) {
    col('sessions').replaceOne(
      { sid },
      { sid, sess: JSON.stringify(sess), userId: sess.userId || null, expires: expiryOf(sess) },
      { upsert: true },
    ).then(() => cb && cb(null)).catch((err) => cb && cb(err));
  }

  touch(sid, sess, cb) {
    col('sessions').updateOne({ sid }, { $set: { expires: expiryOf(sess) } })
      .then(() => cb && cb(null)).catch((err) => cb && cb(err));
  }

  destroy(sid, cb) {
    col('sessions').deleteOne({ sid })
      .then(() => cb && cb(null)).catch((err) => cb && cb(err));
  }
}

/** Signs a user out everywhere, optionally keeping one session (the current one). */
async function destroyUserSessions(userId, exceptSid = null) {
  const filter = { userId };
  if (exceptSid) filter.sid = { $ne: exceptSid };
  await col('sessions').deleteMany(filter);
}

module.exports = MongoSessionStore;
module.exports.destroyUserSessions = destroyUserSessions;
