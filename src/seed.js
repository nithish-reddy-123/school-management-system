'use strict';
/* Loads demo data. Usage: npm run seed        (only on an empty database)
 *                         npm run seed:reset  (DELETES all existing data first) */
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { db, one, all, run, tx, dbPath } = require('./db');
const { localDate, addDays, academicYear, dayOfWeek } = require('./utils');

const reset = process.argv.includes('--reset');
if (one('SELECT id FROM users LIMIT 1') && !reset) {
  console.error(`The database (${dbPath}) already has users.`);
  console.error('Run "npm run seed:reset" to DELETE all data and load the demo data.');
  process.exit(1);
}

// Deterministic pseudo-random numbers so demo data is the same every time.
let seed = 20260405;
function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const TABLES = ['registrations', 'audit_log', 'sessions', 'entitlements', 'scholarships', 'midday_meals', 'grievances', 'leave_requests', 'events',
  'notices', 'timetable', 'homework', 'marks', 'exams', 'teacher_attendance', 'attendance', 'parent_student', 'students',
  'class_subjects', 'subjects', 'classes', 'teachers', 'users', 'school_info'];

const today = localDate();
const year = academicYear();
const Y = Number(year.slice(0, 4));
const PASSWORD = 'Pass@123';
const hash = bcrypt.hashSync(PASSWORD, 10);

tx(() => {
  if (reset) {
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
    db.exec("DELETE FROM sqlite_sequence");
  }

  run(`INSERT INTO school_info (id, name, name_hi, name_te, udise_code, address, block, district, state, board, medium, phone, email, timings, about, facilities)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'Zilla Parishad High School', 'ज़िला परिषद उच्च विद्यालय', 'జిల్లా పరిషత్ ఉన్నత పాఠశాల',
  '36000000001', 'Telangana', null, null, 'Telangana', 'Board of Secondary Education, Telangana', 'Telugu & English', null,
  'zphs@example.in', 'Monday to Saturday, 9:00 AM – 4:00 PM',
  'Our Zilla Parishad High School offers free education from Class 6 to Class 10 with trained teachers, a daily hot mid-day meal and support for every child to learn, play and grow with confidence.',
  ['Smart classrooms with projector', 'Library with 3,000+ books', 'Science and computer labs', 'Playground and sports equipment',
    'RO drinking water and separate toilets for girls and boys', 'Ramp and support for children with special needs', 'Kitchen garden for the mid-day meal'].join('\n'));

  const user = (username, role, name, phone = null) =>
    Number(run(`INSERT INTO users (username, password_hash, role, full_name, phone, must_change_password)
      VALUES (?, ?, ?, ?, ?, 0)`, username, hash, role, name, phone).lastInsertRowid);

  // Staff
  const hm = user('headmaster', 'headmaster', 'Dr. Ramesh Chandra Verma', '9876500001');
  run("INSERT INTO teachers VALUES (?, 'EMP1001', 'Headmaster', 'M.Sc., B.Ed., Ph.D.', '2012-07-01')", hm);
  const staff = [
    ['teacher1', 'Sunita Sharma', 'EMP1002', 'TGT Mathematics', 'M.Sc. Mathematics, B.Ed.'],
    ['teacher2', 'Rajesh Kumar Yadav', 'EMP1003', 'TGT Hindi', 'M.A. Hindi, B.Ed.'],
    ['teacher3', 'Fatima Begum', 'EMP1004', 'TGT English', 'M.A. English, B.Ed.'],
    ['teacher4', 'Anil Kumar Meena', 'EMP1005', 'TGT Science', 'M.Sc. Physics, B.Ed.'],
    ['teacher5', 'Pooja Gupta', 'EMP1006', 'TGT Social Science', 'M.A. History, B.Ed.'],
  ];
  const T = staff.map(([u, n, emp, des, q], i) => {
    const id = user(u, 'teacher', n, `98765000${String(i + 2).padStart(2, '0')}`);
    run('INSERT INTO teachers VALUES (?, ?, ?, ?, ?)', id, emp, des, q, `${2014 + i}-07-01`);
    return id;
  });

  // Subjects, classes, subject teachers
  const subjectDefs = [['Hindi', 'HIN', T[1]], ['English', 'ENG', T[2]], ['Mathematics', 'MAT', T[0]], ['Science', 'SCI', T[3]], ['Social Science', 'SST', T[4]], ['Sanskrit', 'SAN', T[1]]];
  const S = subjectDefs.map(([n, c]) => Number(run('INSERT INTO subjects (name, code) VALUES (?, ?)', n, c).lastInsertRowid));
  const C = [['6', T[0]], ['7', T[1]], ['8', T[2]]].map(([n, ct]) => Number(run("INSERT INTO classes (name, section, class_teacher_id) VALUES (?, 'A', ?)", n, ct).lastInsertRowid));
  for (const c of C) subjectDefs.forEach((d, i) => run('INSERT INTO class_subjects VALUES (?, ?, ?)', c, S[i], d[2]));

  // Timetable: rotation offset per class guarantees no teacher is double-booked.
  C.forEach((c, ci) => {
    for (let d = 1; d <= 6; d++) {
      for (let p = 1; p <= 6; p++) {
        const k = (p - 1 + d + ci * 2) % 6;
        run('INSERT INTO timetable VALUES (?, ?, ?, ?, ?)', c, d, p, S[k], subjectDefs[k][2]);
      }
    }
  });

  // Students: [name, gender, category, cwsn, bpl]
  const names = [
    ['Aarav Kumar', 'M', 'OBC'], ['Priya Devi', 'F', 'SC'], ['Rohit Yadav', 'M', 'OBC'], ['Sana Khan', 'F', 'GEN'],
    ['Vikas Jatav', 'M', 'SC'], ['Neha Kumari', 'F', 'GEN'], ['Arjun Meena', 'M', 'ST'], ['Kajal Saini', 'F', 'OBC'],
    ['Ananya Kumari', 'F', 'OBC'], ['Mohit Prajapati', 'M', 'OBC'], ['Ritu Valmiki', 'F', 'SC'], ['Imran Ali', 'M', 'GEN'],
    ['Shivani Pal', 'F', 'OBC'], ['Deepak Bhil', 'M', 'ST'], ['Pooja Kashyap', 'F', 'EWS'], ['Rahul Gautam', 'M', 'SC'],
    ['Ayesha Salim', 'F', 'GEN'], ['Sunil Kushwaha', 'M', 'OBC'], ['Komal Rawat', 'F', 'GEN'], ['Karan Lodhi', 'M', 'OBC'],
    ['Muskan Bano', 'F', 'GEN'], ['Ajay Kori', 'M', 'SC'], ['Sapna Gond', 'F', 'ST'], ['Nitin Sharma', 'M', 'EWS'],
  ];
  const students = names.map(([n, g, cat], i) => {
    const ci = Math.floor(i / 8);
    const id = user(`student${i + 1}`, 'student', n);
    const age = 11 + ci;
    const dob = `${Y - age}-${String(1 + (i % 12)).padStart(2, '0')}-${String(5 + (i % 20)).padStart(2, '0')}`;
    run(`INSERT INTO students (user_id, admission_no, class_id, roll_no, dob, gender, category, apaar_id, aadhaar_last4, is_cwsn, is_bpl, address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, `${Y - ci}${String(i + 1).padStart(3, '0')}`, C[ci], (i % 8) + 1, dob, g, cat,
    String(100000000000 + i * 7919 * 1013), String(1000 + i * 373).slice(-4), i === 13 ? 1 : 0, i % 3 === 0 ? 1 : 0,
    `Ward ${1 + (i % 9)}, Telangana`);
    return { id, ci, ability: 0.45 + rand() * 0.5, presence: i === 4 ? 0.6 : i === 19 ? 0.68 : 0.86 + rand() * 0.13, cat };
  });

  // Parents
  const parents = [
    ['parent1', 'Mahesh Kumar', '9812300001', [[0, 'Father'], [8, 'Father']]],
    ['parent2', 'Geeta Devi', '9812300002', [[1, 'Mother']]],
    ['parent3', 'Ramkumar Prajapati', '9812300003', [[9, 'Father']]],
    ['parent4', 'Mohd. Salim', '9812300004', [[16, 'Father']]],
    ['parent5', 'Sushila Jatav', '9812300005', [[4, 'Mother']]],
  ];
  const P = parents.map(([u, n, ph, kids]) => {
    const id = user(u, 'parent', n, ph);
    for (const [k, rel] of kids) run('INSERT INTO parent_student VALUES (?, ?, ?)', id, students[k].id, rel);
    return id;
  });

  // Academic calendar
  const events = [
    ['International Yoga Day', `${Y}-06-21`, 'event'],
    ['Independence Day', `${Y}-08-15`, 'holiday'],
    ["Teachers' Day Celebration", `${Y}-09-05`, 'event'],
    ['Gandhi Jayanti', `${Y}-10-02`, 'holiday'],
    ["Children's Day (Bal Diwas)", `${Y}-11-14`, 'event'],
    ['Christmas', `${Y}-12-25`, 'holiday'],
    ['Republic Day', `${Y + 1}-01-26`, 'holiday'],
    ['Parent-Teacher Meeting', addDays(today, 7), 'ptm'],
    ['School Management Committee (SMC) Meeting', addDays(today, 14), 'smc'],
    ['Periodic Test 2 begins', addDays(today, 20), 'exam'],
    ['Annual Sports Day', addDays(today, 25), 'event'],
  ];
  for (const [t, d, ty] of events) run('INSERT INTO events (title, date, type) VALUES (?, ?, ?)', t, d, ty);
  const holidays = new Set(all("SELECT date FROM events WHERE type = 'holiday'").map((r) => r.date));

  // Attendance for the last ~45 school days. Class 8-A is left unmarked today to show the dashboard alert.
  const schoolDays = [];
  for (let d = addDays(today, -63); d <= today; d = addDays(d, 1)) {
    if (dayOfWeek(d) !== 0 && !holidays.has(d)) schoolDays.push(d);
  }
  for (const d of schoolDays) {
    for (const s of students) {
      if (d === today && s.ci === 2) continue;
      const r = rand();
      const status = r < s.presence ? 'P' : r < s.presence + 0.03 ? 'L' : 'A';
      run('INSERT INTO attendance (student_id, date, status, marked_by) VALUES (?, ?, ?, ?)', s.id, d, status, T[s.ci]);
    }
    for (const t of [hm, ...T]) {
      if (d === today && t === T[4]) continue;
      const r = rand();
      run('INSERT INTO teacher_attendance VALUES (?, ?, ?, ?)', t, d, r < 0.94 ? 'P' : 'L', r < 0.94 ? `09:${String(Math.floor(rand() * 20)).padStart(2, '0')}` : null);
    }
  }

  // Mid-day meal log for the last 20 school days
  const menus = ['Dal, Chawal, Mixed Sabzi', 'Roti, Aloo-Matar Sabzi, Kheer', 'Vegetable Khichdi, Seasonal Fruit', 'Rajma Chawal, Salad', 'Roti, Chana Dal, Halwa', 'Tehri, Milk'];
  for (const d of schoolDays.slice(-20)) {
    if (d === today) continue;
    const present = one("SELECT COUNT(*) AS n FROM attendance WHERE date = ? AND status = 'P'", d).n;
    run('INSERT INTO midday_meals VALUES (?, ?, ?, ?, 1, ?, ?)', d, menus[dayOfWeek(d) - 1], present, present - Math.floor(rand() * 2), null, hm);
  }

  // Exams and marks
  const exams = [['Periodic Test 1', 50, addDays(today, -90)], ['Half Yearly Examination', 80, addDays(today, -35)], ['Periodic Test 2', 50, addDays(today, 20)]]
    .map(([n, m, d]) => ({ id: Number(run('INSERT INTO exams (name, max_marks, exam_date, academic_year) VALUES (?, ?, ?, ?)', n, m, d, year).lastInsertRowid), max: m, date: d }));
  for (const ex of exams.filter((e) => e.date < today)) {
    for (const s of students) {
      S.forEach((sub, i) => {
        const raw = (s.ability + (rand() - 0.5) * 0.25) * ex.max;
        const m = Math.max(5, Math.min(ex.max, Math.round(raw)));
        run('INSERT INTO marks VALUES (?, ?, ?, ?, ?)', ex.id, s.id, sub, m, subjectDefs[i][2]);
      });
    }
  }

  // Homework
  const hw = [
    [0, 2, 'Exercise 5.2 – Fractions', 'Solve questions 1 to 10 in your notebook.', 2],
    [0, 3, 'Draw and label a plant cell', 'Use a pencil. Bring it in your practical file.', 3],
    [1, 0, 'निबंध: मेरा प्रिय त्योहार', '150 शब्दों में निबंध लिखिए।', 1],
    [1, 4, 'Map work: Rivers of India', 'Mark the major rivers on the outline map of India.', 4],
    [2, 1, 'Letter to the Principal', 'Write an application for sick leave (120 words).', 2],
    [2, 2, 'Linear Equations worksheet', 'Complete the worksheet given in class.', -1],
  ];
  for (const [ci, si, title, desc, due] of hw) {
    run('INSERT INTO homework (class_id, subject_id, teacher_id, title, description, due_date) VALUES (?, ?, ?, ?, ?, ?)', C[ci], S[si], subjectDefs[si][2], title, desc, addDays(today, due));
  }

  // Notices
  const notices = [
    ['APAAR ID and Aadhaar seeding', 'Parents are requested to submit consent forms for APAAR ID generation and ensure Aadhaar details are updated with the class teacher.', 'all', null, hm],
    ['Parent-Teacher Meeting', `PTM will be held on ${addDays(today, 7)} from 10:00 AM to 1:00 PM. Report cards of the Half Yearly Examination will be discussed.`, 'parents', null, hm],
    ['UDISE+ data submission', 'All class teachers must verify student data (category, CWSN, Aadhaar/APAAR status) before the UDISE+ deadline.', 'staff', null, hm],
    ['Swachhta Pakhwada drawing competition', 'Students of classes 6 to 8 can participate. Submit entries to the art teacher.', 'students', null, hm],
    ['Maths class test on Friday', 'A short test on Fractions and Decimals will be held on Friday. Bring geometry box.', 'students_parents', C[0], T[0]],
  ];
  for (const [t, b, a, c, by] of notices) run('INSERT INTO notices (title, body, audience, class_id, posted_by) VALUES (?, ?, ?, ?, ?)', t, b, a, c, by);

  // Scholarships for eligible categories
  const statuses = ['applied', 'verified', 'sanctioned', 'disbursed'];
  const schemeFor = { SC: 'Pre-Matric Scholarship for SC Students', ST: 'Pre-Matric Scholarship for ST Students', OBC: 'Pre-Matric Scholarship for OBC Students' };
  students.filter((s) => schemeFor[s.cat]).slice(0, 10).forEach((s, i) => {
    run('INSERT INTO scholarships (student_id, scheme_name, amount, academic_year, status, applied_on) VALUES (?, ?, ?, ?, ?, ?)',
      s.id, schemeFor[s.cat], s.cat === 'OBC' ? 1500 : 3500, year, statuses[i % 4], addDays(today, -60 + i));
  });

  // Free textbooks for everyone, uniforms for classes 6 and 7
  const distDate = addDays(today, -100) > `${Y}-04-01` ? addDays(today, -100) : `${Y}-04-10`;
  for (const s of students) {
    run('INSERT INTO entitlements (student_id, item, academic_year, distributed_on, recorded_by) VALUES (?, ?, ?, ?, ?)', s.id, 'Free Textbooks', year, distDate, hm);
    if (s.ci < 2) run('INSERT INTO entitlements (student_id, item, academic_year, distributed_on, recorded_by) VALUES (?, ?, ?, ?, ?)', s.id, 'School Uniform', year, distDate, hm);
  }

  // Leave requests
  run('INSERT INTO leave_requests (student_id, requested_by, from_date, to_date, reason) VALUES (?, ?, ?, ?, ?)',
    students[0].id, P[0], addDays(today, 1), addDays(today, 2), "Going to grandparents' village for a family function.");
  run(`INSERT INTO leave_requests (student_id, requested_by, from_date, to_date, reason, status, reviewed_by, reviewed_at)
    VALUES (?, ?, ?, ?, 'Fever, doctor advised rest.', 'approved', ?, datetime('now','localtime'))`,
  students[8].id, P[0], addDays(today, -12), addDays(today, -11), T[1]);

  // Grievances
  run(`INSERT INTO grievances (raised_by, raised_role, category, subject, description, status, response, responded_by, updated_at)
    VALUES (?, 'parent', 'Infrastructure / Toilets / Drinking Water', 'RO water purifier not working', 'The drinking water purifier near class 6 has not been working for a week.', 'in_progress',
    'Complaint registered with the Block Education Office; technician visit scheduled this week.', ?, datetime('now','localtime'))`, P[1], hm);
  run(`INSERT INTO grievances (raised_by, raised_role, category, subject, description)
    VALUES (NULL, 'student', 'Safety / Bullying', 'Senior students teasing during lunch break', 'Some senior boys tease younger students near the playground during lunch. Please ask a teacher to be present.')`);
});

console.log(`Demo data loaded into ${dbPath}`);
console.log(`All demo accounts use the password: ${PASSWORD}`);
console.log('  headmaster | teacher1 .. teacher5 | student1 .. student24 | parent1 .. parent5');
