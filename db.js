const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const { customAlphabet } = require("nanoid");

const DB_FILE = process.env.DB_PATH || path.join(__dirname, "class_manager.db");
const QR_TOKEN = customAlphabet("23456789ABCDEFGHJKLMNPQRSTUVWXYZ", 16);
const generateQrToken = () => QR_TOKEN();
const DEFAULT_STUDENT_PASSWORD = process.env.DEFAULT_STUDENT_PASSWORD || "1234";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const db = new Database(DB_FILE);
db.pragma("journal_mode = wal");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  grade TEXT NOT NULL,
  qr_token TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  monthly_fee INTEGER NOT NULL DEFAULT 2000,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enrollments (
  student_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  enrolled_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, class_id),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(student_id, class_id, month),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(student_id, class_id, date),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exam_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  max_seats INTEGER NOT NULL CHECK (max_seats > 0)
);

CREATE TABLE IF NOT EXISTS exam_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL,
  seat_index INTEGER NOT NULL,
  seat_pos INTEGER NOT NULL,
  student_name TEXT NOT NULL,
  student_class TEXT NOT NULL,
  student_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(slot_id, seat_index, seat_pos),
  FOREIGN KEY (slot_id) REFERENCES exam_slots(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','student')),
  student_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);
`);

const defaultClasses = [
  { name: "Grade 6", monthly_fee: 2000 },
  { name: "Grade 7", monthly_fee: 2000 },
  { name: "Grade 8", monthly_fee: 2000 },
  { name: "O/L", monthly_fee: 2500 },
];

const classInsert = db.prepare(
  "INSERT OR IGNORE INTO classes(name, monthly_fee) VALUES(?, ?)"
);
defaultClasses.forEach((c) => classInsert.run(c.name, c.monthly_fee));

const slots = db.prepare("SELECT COUNT(*) as count FROM exam_slots").get();
if (!slots.count) {
  const insertSlot = db.prepare(
    "INSERT INTO exam_slots(label,start_time,end_time,max_seats) VALUES(?,?,?,?)"
  );
  insertSlot.run(
    "Session 1 – 2:00 PM to 5:00 PM",
    "2025-12-05T14:00:00",
    "2025-12-05T17:00:00",
    25
  );
  insertSlot.run(
    "Session 2 – 5:30 PM to 8:30 PM",
    "2025-12-05T17:30:00",
    "2025-12-05T20:30:00",
    24
  );
}

function seedAdmin() {
  const existingAdmin = db
    .prepare("SELECT id FROM users WHERE role='admin' LIMIT 1")
    .get();
  if (!existingAdmin) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    db.prepare(
      "INSERT INTO users(username,password_hash,role) VALUES(?,?,?)"
    ).run("admin", hash, "admin");
  }
}

function seedStudents() {
  const count = db.prepare("SELECT COUNT(*) as count FROM students").get();
  if (count.count) return;

  const students = [
    { name: "Nadun Perera", phone: "0711111111", grade: "Grade 7" },
    { name: "Sithmi Kariyawasam", phone: "0722222222", grade: "Grade 8" },
    { name: "Nimal Fernando", phone: "0733333333", grade: "Grade 6" },
  ];

  const insertStudent = db.prepare(
    "INSERT INTO students(name, phone, grade, qr_token) VALUES(?,?,?,?)"
  );
  const insertUser = db.prepare(
    "INSERT INTO users(username,password_hash,role,student_id) VALUES(?,?,?,?)"
  );

  students.forEach((s) => {
    const qrToken = generateQrToken();
    const info = insertStudent.run(s.name, s.phone, s.grade, qrToken);
    const studentId = info.lastInsertRowid;
    const hash = bcrypt.hashSync(DEFAULT_STUDENT_PASSWORD, 10);
    insertUser.run(s.phone, hash, "student", studentId);
  });
}

seedAdmin();
seedStudents();

function ensureStudentLogin(studentId, username) {
  const user = db
    .prepare("SELECT id FROM users WHERE student_id = ?")
    .get(studentId);
  if (user) return user.id;
  const hash = bcrypt.hashSync(DEFAULT_STUDENT_PASSWORD, 10);
  const info = db
    .prepare(
      "INSERT INTO users(username,password_hash,role,student_id) VALUES(?,?,?,?)"
    )
    .run(username, hash, "student", studentId);
  return info.lastInsertRowid;
}

function refreshQrToken(studentId) {
  const token = generateQrToken();
  db.prepare("UPDATE students SET qr_token = ? WHERE id = ?").run(
    token,
    studentId
  );
  return token;
}

function monthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

module.exports = {
  db,
  DB_FILE,
  monthKey,
  ensureStudentLogin,
  refreshQrToken,
  DEFAULT_STUDENT_PASSWORD,
  generateQrToken,
};
