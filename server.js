// server.js
// -----------------------------------------------------------------------------
// Class Payment System Backend (Single File Version)
// Tech stack:
//   - Node.js (ESM)
//   - Express
//   - SQLite via better-sqlite3
//
// Features:
//   - Students CRUD
//   - Classes CRUD
//   - Enrollments (students <-> classes)
//   - Payments by month (YYYY-MM)
//   - Unpaid students per class and month
//   - Simple analytics (per student, per class)
//   - Defensive input validation & error handling
//   - Well-structured service layer in a single file
// -----------------------------------------------------------------------------

import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

// -----------------------------------------------------------------------------
// Runtime setup
// -----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, 'class_payments.db');
const PORT = Number(process.env.PORT || 5050);

// -----------------------------------------------------------------------------
// Database initialization
// -----------------------------------------------------------------------------
function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = wal');

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS students (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      phone      TEXT UNIQUE,
      notes      TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      monthly_fee INTEGER NOT NULL CHECK (monthly_fee >= 0),
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      student_id  INTEGER NOT NULL,
      class_id    INTEGER NOT NULL,
      enrolled_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (student_id, class_id),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id)   REFERENCES classes(id)   ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id   INTEGER NOT NULL,
      month      TEXT    NOT NULL, -- YYYY-MM
      amount     INTEGER NOT NULL CHECK (amount >= 0),
      method     TEXT    NOT NULL DEFAULT 'cash', -- cash|bank|online|other
      paid_at    TEXT    DEFAULT (datetime('now')),
      UNIQUE (student_id, class_id, month),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id)   REFERENCES classes(id)   ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_students_name ON students(name);
    CREATE INDEX IF NOT EXISTS idx_classes_name  ON classes(name);
    CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(month);
    CREATE INDEX IF NOT EXISTS idx_enroll_class ON enrollments(class_id);
  `);

  return db;
}

const db = openDb();

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Convert value to integer ID, or throw.
 */
function toId(value, fieldName = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return n;
}

/**
 * Format month as YYYY-MM.
 */
function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Validate YYYY-MM format.
 */
function isValidMonth(m) {
  return typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
}

/**
 * Helper to send JSON error responses.
 */
function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

// -----------------------------------------------------------------------------
// Service layer: Students
// -----------------------------------------------------------------------------
class StudentService {
  /**
   * @param {Database} db
   */
  constructor(db) {
    this.db = db;
    this.insert = db.prepare(`
      INSERT INTO students(name, phone, notes)
      VALUES (?, ?, ?)
    `);
    this.updateStmt = db.prepare(`
      UPDATE students SET name=?, phone=?, notes=? WHERE id=?
    `);
    this.deleteStmt = db.prepare(`DELETE FROM students WHERE id=?`);
    this.findByIdStmt = db.prepare(`SELECT * FROM students WHERE id=?`);
    this.listStmt = db.prepare(`
      SELECT * FROM students ORDER BY name COLLATE NOCASE
    `);
  }

  create({ name, phone, notes }) {
    if (!name || !name.trim()) throw new Error('Name is required');
    const info = this.insert.run(name.trim(), phone || null, notes || null);
    return this.findById(info.lastInsertRowid);
  }

  update(id, { name, phone, notes }) {
    if (!name || !name.trim()) throw new Error('Name is required');
    this.updateStmt.run(name.trim(), phone || null, notes || null, id);
    return this.findById(id);
  }

  delete(id) {
    this.deleteStmt.run(id);
  }

  findById(id) {
    return this.findByIdStmt.get(id);
  }

  list() {
    return this.listStmt.all();
  }
}

// -----------------------------------------------------------------------------
// Service layer: Classes
// -----------------------------------------------------------------------------
class ClassService {
  constructor(db) {
    this.db = db;
    this.insert = db.prepare(`
      INSERT INTO classes(name, monthly_fee, is_active)
      VALUES (?, ?, 1)
    `);
    this.updateStmt = db.prepare(`
      UPDATE classes SET name=?, monthly_fee=?, is_active=? WHERE id=?
    `);
    this.deleteStmt = db.prepare(`DELETE FROM classes WHERE id=?`);
    this.findByIdStmt = db.prepare(`SELECT * FROM classes WHERE id=?`);
    this.listStmt = db.prepare(`
      SELECT * FROM classes ORDER BY is_active DESC, name COLLATE NOCASE
    `);
  }

  create({ name, monthly_fee }) {
    if (!name || !name.trim()) throw new Error('Class name is required');
    const fee = Number(monthly_fee);
    if (!Number.isFinite(fee) || fee < 0) throw new Error('Invalid monthly fee');
    const info = this.insert.run(name.trim(), fee);
    return this.findById(info.lastInsertRowid);
  }

  update(id, { name, monthly_fee, is_active = 1 }) {
    if (!name || !name.trim()) throw new Error('Class name is required');
    const fee = Number(monthly_fee);
    const active = is_active ? 1 : 0;
    if (!Number.isFinite(fee) || fee < 0) throw new Error('Invalid monthly fee');
    this.updateStmt.run(name.trim(), fee, active, id);
    return this.findById(id);
  }

  delete(id) {
    this.deleteStmt.run(id);
  }

  findById(id) {
    return this.findByIdStmt.get(id);
  }

  list() {
    return this.listStmt.all();
  }
}

// -----------------------------------------------------------------------------
// Service layer: Enrollments
// -----------------------------------------------------------------------------
class EnrollmentService {
  constructor(db) {
    this.db = db;
    this.enrollStmt = db.prepare(`
      INSERT INTO enrollments(student_id, class_id)
      VALUES (?, ?)
    `);
    this.unenrollStmt = db.prepare(`
      DELETE FROM enrollments WHERE student_id=? AND class_id=?
    `);
    this.studentsByClassStmt = db.prepare(`
      SELECT s.*
      FROM enrollments e
      JOIN students s ON s.id = e.student_id
      WHERE e.class_id=?
      ORDER BY s.name COLLATE NOCASE
    `);
    this.classesByStudentStmt = db.prepare(`
      SELECT c.*
      FROM enrollments e
      JOIN classes c ON c.id = e.class_id
      WHERE e.student_id=?
      ORDER BY c.name COLLATE NOCASE
    `);
  }

  enroll(studentId, classId) {
    const tx = this.db.transaction(() => {
      this.enrollStmt.run(studentId, classId);
    });
    tx();
  }

  unenroll(studentId, classId) {
    this.unenrollStmt.run(studentId, classId);
  }

  studentsInClass(classId) {
    return this.studentsByClassStmt.all(classId);
  }

  classesOfStudent(studentId) {
    return this.classesByStudentStmt.all(studentId);
  }
}

// -----------------------------------------------------------------------------
// Service layer: Payments
// -----------------------------------------------------------------------------
class PaymentService {
  constructor(db) {
    this.db = db;
    this.insertOrUpdate = db.prepare(`
      INSERT INTO payments(student_id, class_id, month, amount, method)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(student_id, class_id, month)
      DO UPDATE SET amount = excluded.amount, method = excluded.method
    `);
    this.byStudentMonthStmt = db.prepare(`
      SELECT p.*, c.name AS class_name
      FROM payments p
      JOIN classes c ON c.id = p.class_id
      WHERE p.student_id=? AND p.month=?
      ORDER BY c.name COLLATE NOCASE
    `);
    this.unpaidStmt = db.prepare(`
      SELECT
        c.id   AS class_id,
        c.name AS class_name,
        s.id   AS student_id,
        s.name AS student_name,
        s.phone
      FROM enrollments e
      JOIN students s ON s.id = e.student_id
      JOIN classes  c ON c.id = e.class_id
      LEFT JOIN payments p
             ON p.student_id = e.student_id
            AND p.class_id   = e.class_id
            AND p.month      = ?
      WHERE p.id IS NULL
      ORDER BY c.name COLLATE NOCASE, s.name COLLATE NOCASE
    `);
    this.byClassMonthStmt = db.prepare(`
      SELECT
        c.id   AS class_id,
        c.name AS class_name,
        COUNT(p.id)         AS payments_count,
        COALESCE(SUM(p.amount), 0) AS total_amount
      FROM classes c
      LEFT JOIN payments p
             ON p.class_id = c.id
            AND p.month    = ?
      GROUP BY c.id
      ORDER BY c.name COLLATE NOCASE
    `);
  }

  recordPayment({ student_id, class_id, month, amount, method = 'cash' }) {
    const sId = toId(student_id, 'student_id');
    const cId = toId(class_id, 'class_id');
    if (!isValidMonth(month)) throw new Error('Invalid month. Use YYYY-MM.');
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) throw new Error('Invalid amount');
    const mtd = String(method || 'cash');

    this.insertOrUpdate.run(sId, cId, month, amt, mtd);
  }

  paymentsForStudentMonth(studentId, month) {
    if (!isValidMonth(month)) throw new Error('Invalid month format');
    return this.byStudentMonthStmt.all(studentId, month);
  }

  unpaidForMonth(month) {
    if (!isValidMonth(month)) throw new Error('Invalid month format');
    return this.unpaidStmt.all(month);
  }

  summaryByClass(month) {
    if (!isValidMonth(month)) throw new Error('Invalid month format');
    return this.byClassMonthStmt.all(month);
  }
}

// -----------------------------------------------------------------------------
// Instantiate services
// -----------------------------------------------------------------------------
const students = new StudentService(db);
const classesSrv = new ClassService(db);
const enrollments = new EnrollmentService(db);
const payments = new PaymentService(db);

// -----------------------------------------------------------------------------
// Express app
// -----------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    db: DB_PATH,
  });
});

// -----------------------------------------------------------------------------
// Student routes
// -----------------------------------------------------------------------------

app.get('/students', (req, res) => {
  res.json(students.list());
});

app.post('/students', (req, res) => {
  try {
    const student = students.create(req.body);
    res.status(201).json(student);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.get('/students/:id', (req, res) => {
  try {
    const id = toId(req.params.id);
    const s = students.findById(id);
    if (!s) return sendError(res, 404, 'Student not found');
    res.json(s);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.put('/students/:id', (req, res) => {
  try {
    const id = toId(req.params.id);
    const s = students.update(id, req.body);
    res.json(s);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.delete('/students/:id', (req, res) => {
  try {
    const id = toId(req.params.id);
    students.delete(id);
    res.status(204).end();
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// -----------------------------------------------------------------------------
// Class routes
// -----------------------------------------------------------------------------

app.get('/classes', (req, res) => {
  res.json(classesSrv.list());
});

app.post('/classes', (req, res) => {
  try {
    const c = classesSrv.create(req.body);
    res.status(201).json(c);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.get('/classes/:id', (req, res) => {
  try {
    const id = toId(req.params.id);
    const c = classesSrv.findById(id);
    if (!c) return sendError(res, 404, 'Class not found');
    res.json(c);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.put('/classes/:id', (req, res) => {
  try {
    const id = toId(req.params.id);
    const c = classesSrv.update(id, req.body);
    res.json(c);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.delete('/classes/:id', (req, res) => {
  try {
    const id = toId(req.params.id);
    classesSrv.delete(id);
    res.status(204).end();
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// -----------------------------------------------------------------------------
// Enrollment routes
// -----------------------------------------------------------------------------

app.post('/enrollments', (req, res) => {
  try {
    const studentId = toId(req.body.student_id, 'student_id');
    const classId = toId(req.body.class_id, 'class_id');
    enrollments.enroll(studentId, classId);
    res.status(201).json({ ok: true });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.delete('/enrollments', (req, res) => {
  try {
    const studentId = toId(req.body.student_id, 'student_id');
    const classId = toId(req.body.class_id, 'class_id');
    enrollments.unenroll(studentId, classId);
    res.status(204).end();
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.get('/classes/:id/students', (req, res) => {
  try {
    const classId = toId(req.params.id, 'class_id');
    const list = enrollments.studentsInClass(classId);
    res.json(list);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.get('/students/:id/classes', (req, res) => {
  try {
    const studentId = toId(req.params.id, 'student_id');
    const list = enrollments.classesOfStudent(studentId);
    res.json(list);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// -----------------------------------------------------------------------------
// Payment routes
// -----------------------------------------------------------------------------

// Record or update a payment
app.post('/payments', (req, res) => {
  try {
    payments.recordPayment(req.body);
    res.status(201).json({ ok: true });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Get payments for a student in a month
app.get('/students/:id/payments', (req, res) => {
  try {
    const studentId = toId(req.params.id, 'student_id');
    const month = req.query.month || monthKey();
    const list = payments.paymentsForStudentMonth(studentId, month);
    res.json({ student_id: studentId, month, payments: list });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Get unpaid students (by class & student) for a month
app.get('/unpaid', (req, res) => {
  try {
    const month = req.query.month || monthKey();
    const rows = payments.unpaidForMonth(month);
    res.json({ month, rows });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Summary by class for a month
app.get('/finance', (req, res) => {
  try {
    const month = req.query.month || monthKey();
    const rows = payments.summaryByClass(month);
    const total = rows.reduce((sum, r) => sum + (r.total_amount || 0), 0);
    res.json({ month, rows, total });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Class Payment System running on http://localhost:${PORT}`);
  console.log(`🗄  Using DB file: ${DB_PATH}`);
});
