# School Management System for Government Schools (India)

A web application for running a government school: attendance, marks, homework, notices, mid-day meals, scholarships, free entitlements and parent communication. It has separate, role-based logins for **Headmaster**, **Teacher**, **Student** and **Parent**.

Built with Node.js, Express 5, EJS (server-rendered pages) and SQLite (Node's built-in `node:sqlite`, so there is nothing to compile or install separately).

## Quick start

Requires Node.js 22.5 or newer (tested on 23.1).

```powershell
npm install
npm run seed      # loads demo data into data/school.db (only if the database is empty)
npm start         # http://localhost:3000
```

`npm run seed:reset` deletes **all** data and reloads the demo data. `npm run dev` restarts the server automatically when files change.

### Demo accounts (password `Pass@123` for all)

| Role | Usernames | Notes |
|---|---|---|
| Headmaster | `headmaster` | Full administration |
| Teacher | `teacher1` … `teacher5` | `teacher1` is class teacher of 6-A, `teacher2` of 7-A, `teacher3` of 8-A |
| Student | `student1` … `student24` | 8 students each in classes 6-A, 7-A, 8-A |
| Parent | `parent1` … `parent5` | `parent1` has two children (6-A and 7-A) |

If you start the server on an empty database without seeding, it creates one `headmaster` account and prints a temporary password in the console.

## Features by role

**Headmaster**
- Dashboard: enrolment, today's student and staff attendance, classes that haven't marked attendance, missing mid-day meal entry, low-attendance students, class-wise attendance bars, UDISE+ style gender/category breakdown
- User management: admit students, add teachers and parents, link parents to children, edit records, reset passwords (temporary password shown once), activate/deactivate accounts
- Classes, sections, subjects, class teachers, subject teachers
- Timetable editor that blocks double-booking a teacher in the same period
- Exams (per academic year, April–March)
- Attendance reports by date range and class, with CSV download (opens in Excel) and print
- Staff attendance register
- **PM POSHAN mid-day meal register**: daily menu, students present (pre-filled from attendance), meals served, food-tasting check, monthly totals
- **Scholarship tracker** (pre-matric SC/ST/OBC/minority, NMMSS, etc.) with status: applied → verified → sanctioned → disbursed
- **Free entitlements**: textbooks, uniforms, bags, shoes, bicycles; record for a whole class at once; class-wise distribution matrix
- Grievance box: respond and update status
- Academic calendar: holidays, exams, PTM, SMC meetings
- School profile (name in English and Hindi, UDISE+ code, block, district, board)
- Audit log of sign-ins, failed sign-ins, account changes and password resets

**Teacher**
- Self check-in for staff attendance
- Daily attendance for the class they are class teacher of (one-click "mark all present", holiday/Sunday warning, approved leave pre-filled)
- Marks entry only for subjects assigned to them, with live CBSE-style grades
- Homework posting, class notices to students/parents
- Student profiles with attendance calendar and report card
- Approve/reject parents' leave applications (approved leave turns "Absent" into "Leave")
- Personal timetable

**Student**
- Dashboard with attendance %, latest result, today's periods, homework due
- Month-by-month attendance calendar
- Printable report card with grade and class rank
- Homework, class timetable, notices, calendar, benefits received

**Parent**
- Card for each child: today's attendance, year attendance %, latest grade, homework due, below-75% warning
- Full child view: attendance calendar, report card, scholarships, entitlements
- Online leave application to the class teacher
- Notices for their children's classes, calendar, grievances

**Public home page** (`/`, no login needed)
- School photo (uploaded by the headmaster under School Profile; a built-in illustration is shown until then), name, UDISE+ code, board, and student/teacher/class counts
- "Thought for the day" quote for children (changes daily) and a wall of inspiring quotes from Kalam, Vivekananda, Gandhi, Tagore, Ambedkar, Gurajada Apparao and the Hitopadesha, in the selected language
- "Login as" cards for Student, Parent, Teacher and Headmaster
- About the school, facilities, timings, contact, child helpline 1098 / emergency 112, RTE admissions note
- Government schemes for students and upcoming calendar events

**Role-based login**
- The login page has Student / Parent / Teacher / Headmaster tabs (`/login?role=teacher` etc.). If a role is chosen, the account must belong to that role, so a student account cannot sign in through the teacher portal.

**Self-registration with headmaster approval** (`/register?role=student|parent|teacher`)
- Students give their class, date of birth and guardian details. Parents give their children's admission numbers. Teachers give their employee ID and designation. Everyone chooses a username and password.
- Requests are stored separately and **cannot log in until they are verified**. Each request goes to one verifier:

  | Registration | Verified by |
  |---|---|
  | Student | Class teacher of the class the student chose (enters the admission number and roll number) |
  | Parent | Class teacher of a child's class (children matched by admission number). A class teacher links only children from their own class; the headmaster can link the others later. |
  | Teacher | Headmaster |

  If the class has no class teacher, or none of a parent's admission numbers match a student, the request goes to the headmaster instead.
- Teachers and the headmaster each have a **Registrations** page with a menu badge and a dashboard alert. It shows only the requests they can act on, plus a history of the ones they verified. The headmaster can also see requests waiting for class teachers, read-only.
- The review screen shows warnings for duplicate admission numbers, employee IDs or usernames. Reviewers can approve, or reject with a reason.
- People with pending or rejected requests see a clear message at login. Headmaster accounts cannot be self-registered.
- Protection: at most 5 registrations per hour per IP, a hidden honeypot field against bots, and the same password rules as normal accounts.

**Everyone**
- English / Hindi / Telugu interface (navigation, home page, login and main labels). School name can be entered in all three languages.

**Interface & experience**
- Clean, modern design system with a light/dark theme toggle (remembers your choice; also follows the OS setting by default).
- Grouped sidebar navigation with icons, a collapsible icon rail on desktop, and a slide-in drawer on mobile.
- Command palette: press Ctrl/⌘ + K (or `/`) to search and jump to any page.
- A top progress bar and smooth page transitions make navigation feel instant; an animated school illustration on the home page and login screen, an animated "How it works" story, scroll-reveal cards and count-up numbers. All motion respects the "reduce motion" OS setting and can be paused.
- Toast notifications, in-page confirmation dialogs, password show/hide, loading states on buttons, a "back to top" button, and SVG icons throughout.
- Every page works even if JavaScript is disabled (progressive enhancement); the layout is fully responsive down to small phones.
- Grievance & suggestion box with an anonymous option (anonymous entries store no link to the user)
- Mobile-friendly layout, print styles

## Security

- Passwords hashed with bcrypt; minimum 8 characters with letters and numbers
- New accounts and resets get a random temporary password and must set their own at first login
- Role checks on every route, plus ownership checks: parents only see their linked children, teachers only their classes and assigned subjects, students only themselves
- CSRF token on every form, session ID regenerated at login, HTTP-only `SameSite=Lax` cookies (`Secure` in production)
- Login rate limit (10 failed attempts per 15 minutes per IP) and constant-time handling of unknown usernames
- Changing or resetting a password signs out other sessions; deactivating a user signs them out immediately
- Helmet security headers with a strict Content-Security-Policy (no inline scripts)
- Parameterised SQL everywhere; CSV export guards against spreadsheet formula injection
- Only the last 4 digits of Aadhaar are stored; APAAR ID is masked on screen

## Configuration

Copy `.env.example` to `.env`:

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `SESSION_SECRET` | **Required in production.** Long random string |
| `NODE_ENV` | Set to `production` behind HTTPS to enable secure cookies |
| `TRUST_PROXY` | Set to `1` when running behind a reverse proxy (nginx etc.) |
| `DB_PATH` | Optional custom SQLite file location |

In development, a session secret is generated and saved to `data/.session-secret`.

**Backups:** all data lives in `data/school.db`. Stop the server and copy the `data` folder to back up.

## Project structure

```
src/
  server.js            app setup, security middleware, first-run bootstrap
  db.js                SQLite schema and query helpers
  seed.js              demo data
  sessionStore.js      sessions stored in SQLite
  i18n.js              English/Hindi labels
  utils.js             dates, grading, validation helpers
  middleware/auth.js   login, role checks, CSRF, flash messages, navigation
  services/academics.js  attendance, report card, timetable and notice queries
  routes/              auth, common, headmaster, teacher, student, parent
views/                 EJS templates (partials/, headmaster/, teacher/, student/, parent/, common/, auth/)
public/                CSS and a small progressive-enhancement script
```

## Possible next steps

- SMS/WhatsApp alerts to parents for absence (needs an SMS gateway account)
- Bulk student import from a CSV/Excel file
- Library, transport and fee modules (for schools that need them)
- Full Hindi translation of every page and more regional languages
