'use strict';
/* Loads demo data into MongoDB. Usage: npm run seed        (only on an empty database)
 *                                      npm run seed:reset  (DELETES all school data in the configured database first) */
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { connect, close, col, dbInfo, bumpCounter, COLLECTIONS } = require('./db');
const { localDate, nowLocal, addDays, academicYear, dayOfWeek } = require('./utils');

// Deterministic pseudo-random numbers so demo data is the same every time.
let seed = 20260405;
function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Builds all demo documents in memory. Returns { collectionName: [docs] }. */
function buildDemoData() {
  const today = localDate();
  const now = nowLocal();
  const year = academicYear();
  const Y = Number(year.slice(0, 4));
  const hash = bcrypt.hashSync(PASSWORD, 10);
  const data = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
  const ids = {};
  const add = (name, doc) => {
    const id = (ids[name] = (ids[name] || 0) + 1);
    data[name].push({ id, ...doc });
    return id;
  };
  const addRow = (name, doc) => data[name].push(doc); // collections keyed by their natural key (no numeric id)

  data.school_info.push({
    id: 1,
    name: 'Zilla Parishad High School',
    name_hi: 'ज़िला परिषद उच्च विद्यालय',
    name_te: 'జిల్లా పరిషత్ ఉన్నత పాఠశాల',
    udise_code: '36000000001', address: 'Telangana', block: null, district: null, state: 'Telangana',
    board: 'Board of Secondary Education, Telangana', medium: 'Telugu & English', phone: null, email: 'zphs@example.in',
    timings: 'Monday to Saturday, 9:00 AM – 4:00 PM',
    about: 'Our Zilla Parishad High School offers free education from Class 6 to Class 10 with trained teachers, a daily hot mid-day meal and support for every child to learn, play and grow with confidence.',
    facilities: ['Smart classrooms with projector', 'Library with 3,000+ books', 'Science and computer labs', 'Playground and sports equipment',
      'RO drinking water and separate toilets for girls and boys', 'Ramp and support for children with special needs', 'Kitchen garden for the mid-day meal'].join('\n'),
    photo: null,
  });

  const user = (username, role, name, phone = null, extra = {}) => add('users', {
    username, password_hash: hash, role, full_name: name, phone, email: null,
    is_active: 1, must_change_password: 0, last_login: null, created_at: now, ...extra,
  });

  // Staff
  const hm = user('headmaster', 'headmaster', 'Dr. Ramesh Chandra Verma', '9876500001',
    { employee_id: 'EMP1001', designation: 'Headmaster', qualification: 'M.Sc., B.Ed., Ph.D.', joining_date: '2012-07-01' });
  const staff = [
    ['teacher1', 'Sunita Sharma', 'EMP1002', 'TGT Mathematics', 'M.Sc. Mathematics, B.Ed.'],
    ['teacher2', 'Rajesh Kumar Yadav', 'EMP1003', 'TGT Hindi', 'M.A. Hindi, B.Ed.'],
    ['teacher3', 'Fatima Begum', 'EMP1004', 'TGT English', 'M.A. English, B.Ed.'],
    ['teacher4', 'Anil Kumar Meena', 'EMP1005', 'TGT Science', 'M.Sc. Physics, B.Ed.'],
    ['teacher5', 'Pooja Gupta', 'EMP1006', 'TGT Social Science', 'M.A. History, B.Ed.'],
  ];
  const T = staff.map(([u, n, emp, des, q], i) => user(u, 'teacher', n, `98765000${String(i + 2).padStart(2, '0')}`,
    { employee_id: emp, designation: des, qualification: q, joining_date: `${2014 + i}-07-01` }));

  // Subjects, classes, subject teachers
  const subjectDefs = [['Hindi', 'HIN', T[1]], ['English', 'ENG', T[2]], ['Mathematics', 'MAT', T[0]], ['Science', 'SCI', T[3]], ['Social Science', 'SST', T[4]], ['Sanskrit', 'SAN', T[1]]];
  const S = subjectDefs.map(([n, c]) => add('subjects', { name: n, code: c }));
  const C = [['6', T[0]], ['7', T[1]], ['8', T[2]]].map(([n, ct]) => add('classes', { name: n, section: 'A', class_teacher_id: ct }));
  for (const c of C) subjectDefs.forEach((d, i) => addRow('class_subjects', { class_id: c, subject_id: S[i], teacher_id: d[2] }));

  // Timetable: rotation offset per class guarantees no teacher is double-booked.
  C.forEach((c, ci) => {
    for (let d = 1; d <= 6; d++) {
      for (let p = 1; p <= 6; p++) {
        const k = (p - 1 + d + ci * 2) % 6;
        addRow('timetable', { class_id: c, day: d, period: p, subject_id: S[k], teacher_id: subjectDefs[k][2] });
      }
    }
  });

  // Students: [name, gender, category]
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
    const age = 11 + ci;
    const dob = `${Y - age}-${String(1 + (i % 12)).padStart(2, '0')}-${String(5 + (i % 20)).padStart(2, '0')}`;
    const id = user(`student${i + 1}`, 'student', n, null, {
      admission_no: `${Y - ci}${String(i + 1).padStart(3, '0')}`, class_id: C[ci], roll_no: (i % 8) + 1, dob, gender: g, category: cat,
      apaar_id: String(100000000000 + i * 7919 * 1013), aadhaar_last4: String(1000 + i * 373).slice(-4),
      is_cwsn: i === 13 ? 1 : 0, is_bpl: i % 3 === 0 ? 1 : 0, address: `Ward ${1 + (i % 9)}, Telangana`,
    });
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
    for (const [k, rel] of kids) addRow('parent_student', { parent_id: id, student_id: students[k].id, relation: rel });
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
  for (const [t, d, ty] of events) add('events', { title: t, date: d, type: ty, description: null });
  const holidays = new Set(events.filter((e) => e[2] === 'holiday').map((e) => e[1]));

  // Attendance for the last ~45 school days. Class 8-A is left unmarked today to show the dashboard alert.
  const schoolDays = [];
  for (let d = addDays(today, -63); d <= today; d = addDays(d, 1)) {
    if (dayOfWeek(d) !== 0 && !holidays.has(d)) schoolDays.push(d);
  }
  const presentOn = {};
  for (const d of schoolDays) {
    for (const s of students) {
      if (d === today && s.ci === 2) continue;
      const r = rand();
      const status = r < s.presence ? 'P' : r < s.presence + 0.03 ? 'L' : 'A';
      if (status === 'P') presentOn[d] = (presentOn[d] || 0) + 1;
      addRow('attendance', { student_id: s.id, date: d, status, marked_by: T[s.ci] });
    }
    for (const t of [hm, ...T]) {
      if (d === today && t === T[4]) continue;
      const r = rand();
      addRow('teacher_attendance', { teacher_id: t, date: d, status: r < 0.94 ? 'P' : 'L', check_in_time: r < 0.94 ? `09:${String(Math.floor(rand() * 20)).padStart(2, '0')}` : null });
    }
  }

  // Mid-day meal log for the last 20 school days
  const menus = ['Dal, Chawal, Mixed Sabzi', 'Roti, Aloo-Matar Sabzi, Kheer', 'Vegetable Khichdi, Seasonal Fruit', 'Rajma Chawal, Salad', 'Roti, Chana Dal, Halwa', 'Tehri, Milk'];
  for (const d of schoolDays.slice(-20)) {
    if (d === today) continue;
    const present = presentOn[d] || 0;
    addRow('midday_meals', { date: d, menu: menus[dayOfWeek(d) - 1], students_present: present, meals_served: present - Math.floor(rand() * 2), quality_checked: 1, remarks: null, recorded_by: hm });
  }

  // Exams and marks
  const exams = [['Periodic Test 1', 50, addDays(today, -90)], ['Half Yearly Examination', 80, addDays(today, -35)], ['Periodic Test 2', 50, addDays(today, 20)]]
    .map(([n, m, d]) => ({ id: add('exams', { name: n, max_marks: m, exam_date: d, academic_year: year }), max: m, date: d }));
  for (const ex of exams.filter((e) => e.date < today)) {
    for (const s of students) {
      S.forEach((sub, i) => {
        const raw = (s.ability + (rand() - 0.5) * 0.25) * ex.max;
        const m = Math.max(5, Math.min(ex.max, Math.round(raw)));
        addRow('marks', { exam_id: ex.id, student_id: s.id, subject_id: sub, marks_obtained: m, entered_by: subjectDefs[i][2] });
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
    add('homework', { class_id: C[ci], subject_id: S[si], teacher_id: subjectDefs[si][2], title, description: desc, due_date: addDays(today, due), created_at: now });
  }

  // Notices
  const notices = [
    ['APAAR ID and Aadhaar seeding', 'Parents are requested to submit consent forms for APAAR ID generation and ensure Aadhaar details are updated with the class teacher.', 'all', null, hm],
    ['Parent-Teacher Meeting', `PTM will be held on ${addDays(today, 7)} from 10:00 AM to 1:00 PM. Report cards of the Half Yearly Examination will be discussed.`, 'parents', null, hm],
    ['UDISE+ data submission', 'All class teachers must verify student data (category, CWSN, Aadhaar/APAAR status) before the UDISE+ deadline.', 'staff', null, hm],
    ['Swachhta Pakhwada drawing competition', 'Students of classes 6 to 8 can participate. Submit entries to the art teacher.', 'students', null, hm],
    ['Maths class test on Friday', 'A short test on Fractions and Decimals will be held on Friday. Bring geometry box.', 'students_parents', C[0], T[0]],
  ];
  for (const [t, b, a, c, by] of notices) add('notices', { title: t, body: b, audience: a, class_id: c, posted_by: by, created_at: now });

  // Scholarships for eligible categories
  const statuses = ['applied', 'verified', 'sanctioned', 'disbursed'];
  const schemeFor = { SC: 'Pre-Matric Scholarship for SC Students', ST: 'Pre-Matric Scholarship for ST Students', OBC: 'Pre-Matric Scholarship for OBC Students' };
  students.filter((s) => schemeFor[s.cat]).slice(0, 10).forEach((s, i) => {
    add('scholarships', { student_id: s.id, scheme_name: schemeFor[s.cat], amount: s.cat === 'OBC' ? 1500 : 3500, academic_year: year, status: statuses[i % 4], applied_on: addDays(today, -60 + i), remarks: null });
  });

  // Free textbooks for everyone, uniforms for classes 6 and 7
  const distDate = addDays(today, -100) > `${Y}-04-01` ? addDays(today, -100) : `${Y}-04-10`;
  for (const s of students) {
    add('entitlements', { student_id: s.id, item: 'Free Textbooks', academic_year: year, distributed_on: distDate, recorded_by: hm });
    if (s.ci < 2) add('entitlements', { student_id: s.id, item: 'School Uniform', academic_year: year, distributed_on: distDate, recorded_by: hm });
  }

  // Leave requests
  add('leave_requests', {
    student_id: students[0].id, requested_by: P[0], from_date: addDays(today, 1), to_date: addDays(today, 2),
    reason: "Going to grandparents' village for a family function.", status: 'pending', reviewed_by: null, reviewed_at: null, created_at: now,
  });
  add('leave_requests', {
    student_id: students[8].id, requested_by: P[0], from_date: addDays(today, -12), to_date: addDays(today, -11),
    reason: 'Fever, doctor advised rest.', status: 'approved', reviewed_by: T[1], reviewed_at: now, created_at: now,
  });

  // Grievances
  add('grievances', {
    raised_by: P[1], raised_role: 'parent', category: 'Infrastructure / Toilets / Drinking Water', subject: 'RO water purifier not working',
    description: 'The drinking water purifier near class 6 has not been working for a week.', status: 'in_progress',
    response: 'Complaint registered with the Block Education Office; technician visit scheduled this week.', responded_by: hm, created_at: now, updated_at: now,
  });
  add('grievances', {
    raised_by: null, raised_role: 'student', category: 'Safety / Bullying', subject: 'Senior students teasing during lunch break',
    description: 'Some senior boys tease younger students near the playground during lunch. Please ask a teacher to be present.',
    status: 'open', response: null, responded_by: null, created_at: now, updated_at: null,
  });

  return { data, ids };
}

const PASSWORD = 'Pass@123';

async function main() {
  const reset = process.argv.includes('--reset');
  const { host, dbName } = dbInfo();
  const db = await connect();
  if (await col('users').findOne({}) && !reset) {
    console.error(`The database "${dbName}" on ${host} already has users.`);
    console.error('Run "npm run seed:reset" to DELETE all school data in that database and load the demo data.');
    process.exitCode = 1;
    return;
  }
  if (reset) {
    // Only this application's collections in the configured database are removed.
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const name of COLLECTIONS) if (existing.has(name)) await db.collection(name).drop();
    await close();
    await connect(); // recreates the indexes
  }
  const { data, ids } = buildDemoData();
  for (const [name, docs] of Object.entries(data)) {
    if (docs.length) await col(name).insertMany(docs, { ordered: true });
  }
  for (const [name, max] of Object.entries(ids)) await bumpCounter(name, max);
  console.log(`Demo data loaded into "${dbName}" on ${host}`);
  console.log(`All demo accounts use the password: ${PASSWORD}`);
  console.log('  headmaster | teacher1 .. teacher5 | student1 .. student24 | parent1 .. parent5');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => close());
