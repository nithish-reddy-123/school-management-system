'use strict';
require('dotenv').config({ quiet: true });

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');

const { one, run, dbPath } = require('./db');
const SQLiteStore = require('./sessionStore');
const { locals, loadUser, csrf, enforcePasswordChange } = require('./middleware/auth');
const { generatePassword } = require('./utils');

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProd) {
    console.error('SESSION_SECRET must be set in production. See .env.example.');
    process.exit(1);
  }
  // Development convenience: keep a generated secret next to the database so logins survive restarts.
  const file = path.join(path.dirname(dbPath), '.session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

/** First run without demo data: create a default school record and one headmaster account. */
function bootstrap() {
  if (!one('SELECT id FROM school_info WHERE id = 1')) {
    run("INSERT INTO school_info (id, name, state) VALUES (1, 'Government School', 'India')");
  }
  if (!one('SELECT id FROM users LIMIT 1')) {
    const pw = generatePassword();
    run(`INSERT INTO users (username, password_hash, role, full_name, must_change_password)
      VALUES ('headmaster', ?, 'headmaster', 'Headmaster', 1)`, bcrypt.hashSync(pw, 10));
    console.log('\n  No users found. Created the first headmaster account:');
    console.log(`    username: headmaster   temporary password: ${pw}`);
    console.log('  (You will be asked to change it at first login. Run "npm run seed:reset" for demo data instead.)\n');
  }
}

bootstrap();

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
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: isProd ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 5000 }));
app.use(session({
  name: 'sms.sid',
  store: new SQLiteStore(),
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
  app.listen(PORT, () => {
    console.log(`School Management System running at http://localhost:${PORT}`);
  });
}

module.exports = app;
