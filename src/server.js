'use strict';
require('dotenv').config({ quiet: true });

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');

const { connect, col, dbInfo, insertWithId, dupKey } = require('./db');
const MongoSessionStore = require('./sessionStore');
const { locals, loadUser, csrf, enforcePasswordChange } = require('./middleware/auth');
const { generatePassword, nowLocal } = require('./utils');

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProd) {
    console.error('SESSION_SECRET must be set in production. See .env.example.');
    process.exit(1);
  }
  // Development convenience: keep a generated secret in data/ so logins survive restarts.
  const file = path.join(DATA_DIR, '.session-secret');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

/** First run without demo data: create a default school record, classes 6-10 and one headmaster account. */
async function bootstrap() {
  await col('school_info').updateOne({ id: 1 }, { $setOnInsert: { name: 'Government School', state: 'India', photo: null } }, { upsert: true });
  if (!(await col('classes').findOne({}))) {
    for (const name of ['6', '7', '8', '9', '10']) {
      try {
        await insertWithId('classes', { name, section: 'A', class_teacher_id: null });
      } catch (err) {
        if (!dupKey(err)) throw err; // another instance created it at the same time
      }
    }
  }
  if (!(await col('users').findOne({}))) {
    const pw = generatePassword();
    try {
      await insertWithId('users', {
        username: 'headmaster', password_hash: await bcrypt.hash(pw, 10), role: 'headmaster', full_name: 'Headmaster',
        phone: null, email: null, is_active: 1, must_change_password: 1, last_login: null, created_at: nowLocal(),
      });
      console.log('\n  No users found. Created the first headmaster account:');
      console.log(`    username: headmaster   temporary password: ${pw}`);
      console.log('  (You will be asked to change it at first login. Run "npm run seed:reset" for demo data instead.)\n');
    } catch (err) {
      if (!dupKey(err)) throw err;
    }
  }
}

async function initialize() {
  await connect();
  await bootstrap();
  const { host, dbName } = dbInfo();
  console.log(`Connected to MongoDB database "${dbName}" on ${host}`);
}

const ready = initialize();
ready.catch((err) => console.error(`Database initialization failed: ${err.message}`));

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // Browsers would try https://localhost for assets in local development otherwise.
      'upgrade-insecure-requests': isProd ? [] : null,
    },
  },
}));
// Cache-busting: CSS/JS URLs carry ?v=<hash of the file>, so browsers fetch new code immediately after
// an update but can still cache unchanged files for a long time.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const assetVersion = {};
for (const f of ['css/style.css', 'js/app.js', 'js/theme.js']) {
  assetVersion[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, f))).digest('hex').slice(0, 10);
}
app.locals.asset = (f) => `/${f}?v=${assetVersion[f] || '0'}`;
app.use((req, res, next) => ready.then(() => next()).catch(next));
app.use(express.static(PUBLIC_DIR, {
  maxAge: isProd ? '7d' : 0,
  setHeaders: (res, filePath) => {
    // Versioned CSS/JS can be cached for a year in production; HTML always revalidates.
    if (isProd && /\.(css|js)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 5000 }));
app.use(session({
  name: 'sms.sid',
  store: new MongoSessionStore(),
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 8 * 60 * 60 * 1000 },
}));

app.use(locals);
app.use(loadUser);
app.use(csrf);
app.use(enforcePasswordChange);

app.use(require('./routes/auth'));
app.use(require('./routes/register'));
app.use(require('./routes/common'));
app.use('/hm', require('./routes/headmaster'));
app.use('/teacher', require('./routes/teacher'));
app.use('/student', require('./routes/student'));
app.use('/parent', require('./routes/parent'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page not found', status: 404, message: 'The page you are looking for does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).render('error', { title: 'Something went wrong', status: 500, message: 'An unexpected error occurred. Please try again.' });
});

if (require.main === module) {
  ready.then(() => app.listen(PORT, () => {
    console.log(`School Management System running at http://localhost:${PORT}`);
  })).catch(() => {
    process.exitCode = 1;
  });
}

module.exports = app;
