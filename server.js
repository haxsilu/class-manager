// server.js
// Complete Class Management System with Authentication & Role-Based Access
// Backend: Node.js (CommonJS), Express, SQLite (better-sqlite3), express-session, bcrypt
// Frontend: HTML+CSS+Vanilla JS with html5-qrcode for QR scanning

const express = require("express");
const Database = require("better-sqlite3");
const session = require("express-session");
const bcrypt = require("bcrypt");
const path = require("path");
const QRCode = require("qrcode");

// ---------- Runtime setup ----------
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "class_manager.db");
const PORT = Number(process.env.PORT || 5050);
const SESSION_SECRET = process.env.SESSION_SECRET || "class-manager-secret-key-change-in-production";

// ---------- Database ----------
function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = wal");
  db.pragma("foreign_keys = ON");

  db.exec(`
    -- USERS table for authentication
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('admin', 'student')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- STUDENTS table with grade and qr_token
    CREATE TABLE IF NOT EXISTS students (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      phone      TEXT UNIQUE,
      grade      TEXT,
      qr_token   TEXT UNIQUE,
      user_id    INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    -- CLASSES table
    CREATE TABLE IF NOT EXISTS classes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      monthly_fee INTEGER NOT NULL CHECK (monthly_fee >= 0),
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- ENROLLMENTS table
    CREATE TABLE IF NOT EXISTS enrollments (
      student_id  INTEGER NOT NULL,
      class_id    INTEGER NOT NULL,
      enrolled_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (student_id, class_id),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id)   REFERENCES classes(id) ON DELETE CASCADE
    );

    -- PAYMENTS table
    CREATE TABLE IF NOT EXISTS payments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id   INTEGER NOT NULL,
      month      TEXT    NOT NULL, -- YYYY-MM
      amount     INTEGER NOT NULL CHECK (amount >= 0),
      method     TEXT    NOT NULL DEFAULT 'cash',
      paid_at    TEXT    DEFAULT (datetime('now')),
      UNIQUE(student_id, class_id, month),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id)   REFERENCES classes(id) ON DELETE CASCADE
    );

    -- ATTENDANCE table
    CREATE TABLE IF NOT EXISTS attendance (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id   INTEGER NOT NULL,
      date       TEXT    NOT NULL, -- YYYY-MM-DD
      method     TEXT    NOT NULL DEFAULT 'qr', -- 'qr' or 'manual'
      created_at TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id)   REFERENCES classes(id) ON DELETE CASCADE
    );

    -- EXAM_SLOTS table
    CREATE TABLE IF NOT EXISTS exam_slots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time   TEXT NOT NULL,
      max_seats  INTEGER NOT NULL CHECK (max_seats > 0)
    );

    -- EXAM_BOOKINGS table
    CREATE TABLE IF NOT EXISTS exam_bookings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id       INTEGER NOT NULL,
      seat_index    INTEGER NOT NULL,
      seat_pos      INTEGER NOT NULL,
      student_id    INTEGER,
      student_name  TEXT NOT NULL,
      student_class TEXT NOT NULL,
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE (slot_id, seat_index, seat_pos),
      FOREIGN KEY (slot_id) REFERENCES exam_slots(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_students_name ON students(name);
    CREATE INDEX IF NOT EXISTS idx_students_qr_token ON students(qr_token);
    CREATE INDEX IF NOT EXISTS idx_classes_name ON classes(name);
    CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(month);
    CREATE INDEX IF NOT EXISTS idx_enroll_class ON enrollments(class_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
    CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);
  `);

  // Seed admin account if missing
  const adminExists = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (!adminExists) {
    const hashedPassword = bcrypt.hashSync("admin123", 10);
    db.prepare("INSERT INTO users(username, password, role) VALUES(?, ?, 'admin')").run("admin", hashedPassword);
  }

  // Seed default classes if missing
  const existingClasses = db
    .prepare("SELECT name FROM classes")
    .all()
    .map((r) => r.name);
  ["Grade 6", "Grade 7", "Grade 8", "O/L"].forEach((title) => {
    if (!existingClasses.includes(title)) {
      db.prepare("INSERT INTO classes(name, monthly_fee) VALUES(?, 2000)").run(title);
    }
  });

  // Seed exam slots if missing
  const examCount = db.prepare("SELECT COUNT(*) AS c FROM exam_slots").get().c;
  if (examCount === 0) {
    db.prepare("INSERT INTO exam_slots(label,start_time,end_time,max_seats) VALUES (?,?,?,?)").run(
      "Session 1 – 2:00 PM to 5:00 PM",
      "2025-12-05 14:00",
      "2025-12-05 17:00",
      25
    );
    db.prepare("INSERT INTO exam_slots(label,start_time,end_time,max_seats) VALUES (?,?,?,?)").run(
      "Session 2 – 5:30 PM to 8:30 PM",
      "2025-12-05 17:30",
      "2025-12-05 20:30",
      24
    );
  }

  return db;
}

const db = openDb();

// ---------- Helpers ----------
function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return y + "-" + m;
}

function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function isValidMonth(m) {
  return typeof m === "string" && /^\d{4}-\d{2}$/.test(m);
}

function toId(val, field = "id") {
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("Invalid " + field);
  }
  return n;
}

function sendError(res, code, msg) {
  res.status(code).json({ error: msg });
}

function generateQRToken() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// ---------- Prepared statements ----------
const userStmt = {
  findByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  findById: db.prepare("SELECT * FROM users WHERE id = ?"),
  create: db.prepare("INSERT INTO users(username, password, role) VALUES(?, ?, ?)"),
};

const studentStmt = {
  list: db.prepare("SELECT s.*, u.username FROM students s LEFT JOIN users u ON s.user_id = u.id ORDER BY s.name COLLATE NOCASE"),
  find: db.prepare("SELECT s.*, u.username FROM students s LEFT JOIN users u ON s.user_id = u.id WHERE s.id=?"),
  findByQRToken: db.prepare("SELECT s.*, u.username FROM students s LEFT JOIN users u ON s.user_id = u.id WHERE s.qr_token=?"),
  insert: db.prepare("INSERT INTO students(name, phone, grade, qr_token, user_id) VALUES(?, ?, ?, ?, ?)"),
  update: db.prepare("UPDATE students SET name=?, phone=?, grade=? WHERE id=?"),
  delete: db.prepare("DELETE FROM students WHERE id=?"),
};

const classStmt = {
  list: db.prepare("SELECT * FROM classes ORDER BY name COLLATE NOCASE"),
  find: db.prepare("SELECT * FROM classes WHERE id=?"),
  insert: db.prepare("INSERT INTO classes(name,monthly_fee) VALUES(?,?)"),
  update: db.prepare("UPDATE classes SET monthly_fee=? WHERE id=?"),
};

const enrollStmt = {
  enroll: db.prepare("INSERT INTO enrollments(student_id,class_id) VALUES(?,?)"),
  unenroll: db.prepare("DELETE FROM enrollments WHERE student_id=? AND class_id=?"),
  studentsInClass: db.prepare(`
    SELECT s.*, u.username
    FROM enrollments e
    JOIN students s ON s.id = e.student_id
    LEFT JOIN users u ON s.user_id = u.id
    WHERE e.class_id=?
    ORDER BY s.name COLLATE NOCASE
  `),
};

const paymentStmt = {
  upsert: db.prepare(`
    INSERT INTO payments(student_id,class_id,month,amount,method)
    VALUES (?,?,?,?,?)
    ON CONFLICT(student_id,class_id,month)
    DO UPDATE SET amount=excluded.amount, method=excluded.method
  `),
  unpaid: db.prepare(`
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
  `),
  summaryByClass: db.prepare(`
    SELECT
      c.id   AS class_id,
      c.name AS class_name,
      COUNT(p.id)               AS payments_count,
      COALESCE(SUM(p.amount),0) AS total_amount
    FROM classes c
    LEFT JOIN payments p
           ON p.class_id = c.id
          AND p.month    = ?
    GROUP BY c.id
    ORDER BY c.name COLLATE NOCASE
  `),
  checkPayment: db.prepare(`
    SELECT * FROM payments
    WHERE student_id=? AND class_id=? AND month=?
  `),
};

const attendanceStmt = {
  record: db.prepare("INSERT INTO attendance(student_id, class_id, date, method) VALUES(?, ?, ?, ?)"),
  list: db.prepare(`
    SELECT a.*, s.name AS student_name, c.name AS class_name
    FROM attendance a
    JOIN students s ON s.id = a.student_id
    JOIN classes c ON c.id = a.class_id
    WHERE a.date = ?
    ORDER BY a.created_at DESC
  `),
  byStudent: db.prepare(`
    SELECT a.*, c.name AS class_name
    FROM attendance a
    JOIN classes c ON c.id = a.class_id
    WHERE a.student_id = ?
    ORDER BY a.date DESC, a.created_at DESC
  `),
};

const examStmt = {
  listSlots: db.prepare("SELECT * FROM exam_slots ORDER BY id"),
  findSlot: db.prepare("SELECT * FROM exam_slots WHERE id=?"),
  bookingsBySlot: db.prepare("SELECT * FROM exam_bookings WHERE slot_id=? ORDER BY seat_index, seat_pos"),
  insertBooking: db.prepare(`
    INSERT INTO exam_bookings(slot_id,seat_index,seat_pos,student_id,student_name,student_class)
    VALUES (?,?,?,?,?,?)
  `),
  findBooking: db.prepare("SELECT * FROM exam_bookings WHERE slot_id=? AND student_id=?"),
};

// ---------- Express app ----------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }, // 24 hours
  })
);

// ---------- Middleware ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

function requireStudent(req, res, next) {
  if (!req.session.userId || req.session.role !== "student") {
    return res.status(403).json({ error: "Student access required" });
  }
  next();
}

// ---------- Authentication Routes ----------
app.post("/api/login", async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
      return sendError(res, 400, "Username, password, and role are required");
    }

    const user = userStmt.findByUsername.get(username);
    if (!user) {
      return sendError(res, 401, "Invalid credentials");
    }

    if (user.role !== role) {
      return sendError(res, 403, "Invalid role");
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return sendError(res, 401, "Invalid credentials");
    }

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.username = user.username;

    res.json({ ok: true, role: user.role, userId: user.id });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return sendError(res, 500, "Logout failed");
    }
    res.json({ ok: true });
  });
});

app.get("/api/session", requireAuth, (req, res) => {
  res.json({
    userId: req.session.userId,
    role: req.session.role,
    username: req.session.username,
  });
});

// ---------- Admin API Routes ----------

// Students
app.get("/api/admin/students", requireAdmin, (req, res) => {
  try {
    res.json(studentStmt.list.all());
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.post("/api/admin/students", requireAdmin, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const phone = (req.body.phone || "").trim() || null;
    const grade = (req.body.grade || "").trim() || null;

    if (!name) throw new Error("Name is required");

    // Create student user account if phone provided
    let userId = null;
    if (phone) {
      const existingUser = userStmt.findByUsername.get(phone);
      if (!existingUser) {
        const hashedPassword = await bcrypt.hash("1234", 10);
        const userInfo = userStmt.create.run(phone, hashedPassword, "student");
        userId = userInfo.lastInsertRowid;
      } else {
        userId = existingUser.id;
      }
    }

    const qrToken = generateQRToken();
    const info = studentStmt.insert.run(name, phone, grade, qrToken, userId);
    const student = studentStmt.find.get(info.lastInsertRowid);
    res.status(201).json(student);
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT") {
      return sendError(res, 400, "Phone number already exists");
    }
    sendError(res, 400, e.message);
  }
});

app.put("/api/admin/students/:id", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id);
    const name = (req.body.name || "").trim();
    const phone = (req.body.phone || "").trim() || null;
    const grade = (req.body.grade || "").trim() || null;

    if (!name) throw new Error("Name is required");

    studentStmt.update.run(name, phone, grade, id);
    const student = studentStmt.find.get(id);
    res.json(student);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.delete("/api/admin/students/:id", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id);
    studentStmt.delete.run(id);
    res.status(204).end();
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Classes
app.get("/api/admin/classes", requireAdmin, (req, res) => {
  try {
    res.json(classStmt.list.all());
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.post("/api/admin/classes", requireAdmin, (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const fee = Number(req.body.monthly_fee);
    if (!name) throw new Error("Class name required");
    if (!Number.isFinite(fee) || fee < 0) throw new Error("Invalid fee");
    const info = classStmt.insert.run(name, fee);
    const c = classStmt.find.get(info.lastInsertRowid);
    res.status(201).json(c);
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT") {
      return sendError(res, 400, "Class name already exists");
    }
    sendError(res, 400, e.message);
  }
});

app.put("/api/admin/classes/:id", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id);
    const fee = Number(req.body.monthly_fee);
    if (!Number.isFinite(fee) || fee < 0) throw new Error("Invalid fee");
    classStmt.update.run(fee, id);
    const c = classStmt.find.get(id);
    res.json(c);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Enrollments
app.post("/api/admin/enrollments", requireAdmin, (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    enrollStmt.enroll.run(student_id, class_id);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT") {
      return sendError(res, 400, "Student already enrolled in this class");
    }
    sendError(res, 400, e.message);
  }
});

app.delete("/api/admin/enrollments", requireAdmin, (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    enrollStmt.unenroll.run(student_id, class_id);
    res.status(204).end();
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.get("/api/admin/classes/:id/students", requireAdmin, (req, res) => {
  try {
    const class_id = toId(req.params.id, "class_id");
    res.json(enrollStmt.studentsInClass.all(class_id));
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Payments
app.post("/api/admin/payments", requireAdmin, (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    const month = req.body.month || monthKey();
    const amount = Number(req.body.amount);
    const method = (req.body.method || "cash").trim() || "cash";

    if (!isValidMonth(month)) throw new Error("Invalid month (YYYY-MM)");
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid amount");

    paymentStmt.upsert.run(student_id, class_id, month, amount, method);
    res.status(201).json({ ok: true });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Unpaid & Finance
app.get("/api/admin/unpaid", requireAdmin, (req, res) => {
  try {
    const month = req.query.month || monthKey();
    if (!isValidMonth(month)) throw new Error("Invalid month (YYYY-MM)");
    const rows = paymentStmt.unpaid.all(month);
    res.json({ month, rows });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.get("/api/admin/finance", requireAdmin, (req, res) => {
  try {
    const month = req.query.month || monthKey();
    if (!isValidMonth(month)) throw new Error("Invalid month (YYYY-MM)");
    const rows = paymentStmt.summaryByClass.all(month);
    const total = rows.reduce((sum, r) => sum + (r.total_amount || 0), 0);
    res.json({ month, rows, total });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// QR Code Generation
app.get("/api/admin/students/:id/qrcode", requireAdmin, async (req, res) => {
  try {
    const id = toId(req.params.id);
    const student = studentStmt.find.get(id);
    if (!student) {
      return sendError(res, 404, "Student not found");
    }
    if (!student.qr_token) {
      return sendError(res, 400, "Student has no QR token");
    }

    const qrDataURL = await QRCode.toDataURL(student.qr_token);
    res.json({ qr_code: qrDataURL, token: student.qr_token });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// QR Scanner - Verify token and record attendance
app.post("/api/admin/attendance/qr", requireAdmin, (req, res) => {
  try {
    const { qr_token, class_id, date } = req.body;
    if (!qr_token) throw new Error("QR token required");
    const classId = toId(class_id, "class_id");
    const attendanceDate = date || dateKey();

    const student = studentStmt.findByQRToken.get(qr_token);
    if (!student) {
      return sendError(res, 404, "Invalid QR code");
    }

    // Check if already marked
    const existing = db.prepare(`
      SELECT * FROM attendance WHERE student_id=? AND class_id=? AND date=?
    `).get(student.id, classId, attendanceDate);

    if (existing) {
      return sendError(res, 400, "Attendance already recorded for this date");
    }

    // Check payment status
    const currentMonth = monthKey();
    const payment = paymentStmt.checkPayment.get(student.id, classId, currentMonth);

    attendanceStmt.record.run(student.id, classId, attendanceDate, "qr");
    res.json({
      ok: true,
      student: { id: student.id, name: student.name, phone: student.phone },
      payment_status: payment ? "paid" : "unpaid",
    });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Manual Attendance
app.post("/api/admin/attendance/manual", requireAdmin, (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    const date = req.body.date || dateKey();

    // Check if already marked
    const existing = db.prepare("SELECT * FROM attendance WHERE student_id=? AND class_id=? AND date=?").get(student_id, class_id, date);
    if (existing) {
      return sendError(res, 400, "Attendance already recorded for this date");
    }

    attendanceStmt.record.run(student_id, class_id, date, "manual");
    res.status(201).json({ ok: true });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Attendance List
app.get("/api/admin/attendance", requireAdmin, (req, res) => {
  try {
    const date = req.query.date || dateKey();
    res.json(attendanceStmt.list.all(date));
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Exam Admin - View seat layout
app.get("/api/admin/exam/slots", requireAdmin, (req, res) => {
  try {
    res.json(examStmt.listSlots.all());
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.get("/api/admin/exam/slots/:id/layout", requireAdmin, (req, res) => {
  try {
    const slotId = toId(req.params.id, "slot_id");
    const slot = examStmt.findSlot.get(slotId);
    if (!slot) return sendError(res, 404, "Slot not found");
    const bookings = examStmt.bookingsBySlot.all(slotId);
    res.json({
      slot: slot,
      seat_count: slot.max_seats,
      max_per_seat: 4,
      bookings: bookings,
    });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Dashboard stats
app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  try {
    const totalStudents = db.prepare("SELECT COUNT(*) AS c FROM students").get().c;
    const totalClasses = db.prepare("SELECT COUNT(*) AS c FROM classes").get().c;
    const currentMonth = monthKey();
    const totalPayments = db.prepare("SELECT COUNT(*) AS c FROM payments WHERE month=?").get(currentMonth).c;
    const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE month=?").get(currentMonth).t;
    const todayAttendance = db.prepare("SELECT COUNT(*) AS c FROM attendance WHERE date=?").get(dateKey()).c;

    res.json({
      total_students: totalStudents,
      total_classes: totalClasses,
      current_month_payments: totalPayments,
      current_month_revenue: totalRevenue,
      today_attendance: todayAttendance,
    });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// ---------- Student API Routes ----------

// Get student's own info
app.get("/api/student/info", requireStudent, (req, res) => {
  try {
    const student = db.prepare("SELECT * FROM students WHERE user_id=?").get(req.session.userId);
    if (!student) {
      return sendError(res, 404, "Student profile not found");
    }
    res.json(student);
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// Exam slots
app.get("/api/student/exam/slots", requireStudent, (req, res) => {
  try {
    res.json(examStmt.listSlots.all());
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.get("/api/student/exam/slots/:id/layout", requireStudent, (req, res) => {
  try {
    const slotId = toId(req.params.id, "slot_id");
    const slot = examStmt.findSlot.get(slotId);
    if (!slot) return sendError(res, 404, "Slot not found");
    const bookings = examStmt.bookingsBySlot.all(slotId);
    res.json({
      slot: slot,
      seat_count: slot.max_seats,
      max_per_seat: 4,
      bookings: bookings,
    });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// Book exam seat
app.post("/api/student/exam/book", requireStudent, (req, res) => {
  try {
    const student = db.prepare("SELECT * FROM students WHERE user_id=?").get(req.session.userId);
    if (!student) {
      return sendError(res, 404, "Student profile not found");
    }

    // Only Grade 7 and Grade 8 can book
    if (student.grade !== "Grade 7" && student.grade !== "Grade 8") {
      return sendError(res, 403, "Only Grade 7 and Grade 8 students can book exam seats");
    }

    const slotId = toId(req.body.slot_id, "slot_id");
    const seatIndex = Number(req.body.seat_index);
    const seatPos = Number(req.body.seat_pos);

    const slot = examStmt.findSlot.get(slotId);
    if (!slot) throw new Error("Slot not found");

    // Check if already booked
    const existing = examStmt.findBooking.get(slotId, student.id);
    if (existing) {
      return sendError(res, 400, "You have already booked a seat for this session");
    }

    if (!Number.isInteger(seatIndex) || seatIndex < 1 || seatIndex > slot.max_seats) {
      throw new Error("Invalid seat index");
    }
    if (!Number.isInteger(seatPos) || seatPos < 1 || seatPos > 4) {
      throw new Error("Invalid seat position");
    }

    examStmt.insertBooking.run(slotId, seatIndex, seatPos, student.id, student.name, student.grade);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e && (e.code === "SQLITE_CONSTRAINT" || String(e.message).indexOf("UNIQUE") !== -1)) {
      return sendError(res, 400, "This seat position is already booked");
    }
    sendError(res, 400, e.message);
  }
});

// ---------- Health Check ----------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    db: DB_PATH,
    ts: new Date().toISOString(),
  });
});

// ---------- Frontend HTML ----------
const LOGIN_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Login - Class Management System</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    *{box-sizing:border-box;}
    body{
      font-family:system-ui, sans-serif;
      background:#020617;
      color:#e5e7eb;
      margin:0;
      display:flex;
      align-items:center;
      justify-content:center;
      min-height:100vh;
      padding:1rem;
    }
    .login-container{
      background:#0f172a;
      border:1px solid #1f2937;
      border-radius:1rem;
      padding:2rem;
      max-width:400px;
      width:100%;
    }
    h1{
      margin:0 0 1.5rem;
      text-align:center;
      color:#f9fafb;
    }
    .role-tabs{
      display:flex;
      gap:.5rem;
      margin-bottom:1.5rem;
    }
    .role-tab{
      flex:1;
      padding:.6rem;
      background:#1f2937;
      border:none;
      color:#e5e7eb;
      border-radius:.5rem;
      cursor:pointer;
      font-size:.9rem;
    }
    .role-tab.active{
      background:#2563eb;
    }
    .form-group{
      margin-bottom:1rem;
    }
    label{
      display:block;
      margin-bottom:.4rem;
      font-size:.85rem;
      color:#9ca3af;
    }
    input{
      width:100%;
      padding:.6rem;
      background:#020617;
      border:1px solid #374151;
      border-radius:.5rem;
      color:#e5e7eb;
      font-size:1rem;
    }
    input:focus{
      outline:none;
      border-color:#2563eb;
    }
    button.primary{
      width:100%;
      padding:.7rem;
      background:#2563eb;
      color:#f9fafb;
      border:none;
      border-radius:.5rem;
      font-size:1rem;
      cursor:pointer;
      margin-top:.5rem;
    }
    button.primary:hover{
      background:#1d4ed8;
    }
    #error{
      color:#fca5a5;
      font-size:.85rem;
      margin-top:.5rem;
      text-align:center;
    }
    footer{
      margin-top:2rem;
      text-align:center;
      font-size:.8rem;
      color:#64748b;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>Class Management System</h1>
    <div class="role-tabs">
      <button class="role-tab active" data-role="admin">Admin</button>
      <button class="role-tab" data-role="student">Student</button>
    </div>
    <form id="login-form">
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="username" required autocomplete="username"/>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="password" required autocomplete="current-password"/>
      </div>
      <button type="submit" class="primary">Login</button>
      <div id="error"></div>
    </form>
    <footer>Created by Pulindu Pansilu</footer>
  </div>
  <script>
    let currentRole = 'admin';
    document.querySelectorAll('.role-tab').forEach(btn => {
      btn.addEventListener('click', function() {
        currentRole = this.getAttribute('data-role');
        document.querySelectorAll('.role-tab').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
      });
    });
    document.getElementById('login-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const errorEl = document.getElementById('error');
      errorEl.textContent = '';
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, role: currentRole })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');
        if (currentRole === 'admin') {
          window.location.href = '/admin';
        } else {
          window.location.href = '/student';
        }
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  </script>
</body>
</html>`;

const ADMIN_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Admin Dashboard - Class Management System</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    *{box-sizing:border-box;}
    body{
      font-family:system-ui, sans-serif;
      background:#020617;
      color:#e5e7eb;
      margin:0;
    }
    .container{
      max-width:1400px;
      margin:0 auto;
      padding:1rem;
    }
    header{
      display:flex;
      justify-content:space-between;
      align-items:center;
      margin-bottom:1rem;
      flex-wrap:wrap;
      gap:1rem;
    }
    h1{margin:0;color:#f9fafb;}
    .user-info{
      display:flex;
      align-items:center;
      gap:1rem;
    }
    .logout-btn{
      background:#dc2626;
      color:#f9fafb;
      border:none;
      padding:.5rem 1rem;
      border-radius:.5rem;
      cursor:pointer;
    }
    .tabs{
      display:flex;
      flex-wrap:wrap;
      gap:.5rem;
      margin-bottom:1rem;
      border-bottom:1px solid #1f2937;
      padding-bottom:.5rem;
    }
    .tab-btn{
      border:none;
      background:transparent;
      color:#9ca3af;
      padding:.5rem 1rem;
      border-radius:.5rem;
      cursor:pointer;
      font-size:.9rem;
    }
    .tab-btn.active{
      background:#2563eb;
      color:#f9fafb;
    }
    section{display:none;margin-top:1rem;}
    section.active{display:block;}
    .card{
      background:#0f172a;
      border:1px solid #1f2937;
      border-radius:.8rem;
      padding:1.5rem;
      margin-bottom:1rem;
    }
    h2{margin:0 0 1rem;color:#f9fafb;}
    h3{margin:0 0 .8rem;color:#e5e7eb;font-size:1.1rem;}
    .row{
      display:flex;
      flex-wrap:wrap;
      gap:1rem;
      margin-bottom:1rem;
    }
    .grow{flex:1 1 200px;}
    label{
      display:block;
      margin-bottom:.4rem;
      font-size:.85rem;
      color:#9ca3af;
    }
    input,select,textarea{
      width:100%;
      padding:.5rem;
      background:#020617;
      border:1px solid #374151;
      border-radius:.5rem;
      color:#e5e7eb;
      font-size:.9rem;
    }
    button.primary{
      background:#2563eb;
      color:#f9fafb;
      border:none;
      border-radius:.5rem;
      padding:.6rem 1.2rem;
      cursor:pointer;
      font-size:.9rem;
      margin-top:.5rem;
    }
    button.primary:hover{background:#1d4ed8;}
    button.danger{
      background:#dc2626;
      color:#f9fafb;
      border:none;
      border-radius:.4rem;
      padding:.3rem .7rem;
      cursor:pointer;
      font-size:.8rem;
    }
    table{
      width:100%;
      border-collapse:collapse;
      margin-top:1rem;
      font-size:.85rem;
    }
    th,td{
      border-bottom:1px solid #1f2937;
      padding:.6rem;
      text-align:left;
    }
    th{color:#9ca3af;font-weight:600;}
    .status{
      margin-bottom:1rem;
      font-size:.85rem;
      color:#93c5fd;
    }
    .status.error{color:#fca5a5;}
    .stats-grid{
      display:grid;
      grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));
      gap:1rem;
      margin-bottom:1rem;
    }
    .stat-card{
      background:#1f2937;
      padding:1rem;
      border-radius:.6rem;
      text-align:center;
    }
    .stat-value{
      font-size:2rem;
      font-weight:bold;
      color:#2563eb;
    }
    .stat-label{
      font-size:.85rem;
      color:#9ca3af;
      margin-top:.3rem;
    }
    #qr-scanner-container{
      max-width:500px;
      margin:1rem 0;
    }
    #qr-reader{
      width:100%;
      border:2px solid #374151;
      border-radius:.5rem;
    }
    .qr-code-display{
      max-width:200px;
      margin:1rem 0;
    }
    .qr-code-display img{
      width:100%;
      border:1px solid #374151;
      border-radius:.5rem;
    }
    footer{
      margin-top:2rem;
      text-align:center;
      font-size:.8rem;
      color:#64748b;
    }
    @media(max-width:768px){
      table{display:block;overflow-x:auto;white-space:nowrap;}
      .tabs{flex-direction:column;}
    }
    .seat-layout{
      margin-top:1rem;
      display:flex;
      flex-direction:column;
      gap:.5rem;
      max-height:500px;
      overflow:auto;
      border:1px solid #1f2937;
      border-radius:.6rem;
      padding:1rem;
      background:#0f172a;
    }
    .bench-row{
      display:flex;
      align-items:center;
      gap:.6rem;
    }
    .bench-label{
      width:80px;
      font-size:.8rem;
      color:#9ca3af;
    }
    .bench{
      flex:1;
      background:#78350f;
      border-radius:.4rem;
      height:40px;
      display:flex;
      overflow:hidden;
    }
    .bench-segment{
      flex:1;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:.75rem;
      color:#e5e7eb;
      border-right:1px solid rgba(15,23,42,0.7);
    }
    .bench-segment:last-child{border-right:none;}
    .bench-segment.empty{color:#d1d5db80;}
    .bench-segment.booked.grade7{background:#1d4ed8;}
    .bench-segment.booked.grade8{background:#16a34a;}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Admin Dashboard</h1>
      <div class="user-info">
        <span id="username-display"></span>
        <button class="logout-btn" id="logout-btn">Logout</button>
      </div>
    </header>
    <div class="status" id="status"></div>
    <div class="tabs">
      <button class="tab-btn active" data-tab="dashboard">Dashboard</button>
      <button class="tab-btn" data-tab="students">Students</button>
      <button class="tab-btn" data-tab="classes">Classes</button>
      <button class="tab-btn" data-tab="enrollments">Enrollments</button>
      <button class="tab-btn" data-tab="qr-scanner">QR Scanner</button>
      <button class="tab-btn" data-tab="attendance">Attendance</button>
      <button class="tab-btn" data-tab="payments">Payments</button>
      <button class="tab-btn" data-tab="unpaid">Unpaid</button>
      <button class="tab-btn" data-tab="finance">Finance</button>
      <button class="tab-btn" data-tab="exam-admin">Exam Admin</button>
      <button class="tab-btn" data-tab="settings">Settings</button>
    </div>

    <!-- Dashboard -->
    <section id="tab-dashboard" class="active">
      <div class="card">
        <h2>Dashboard</h2>
        <div class="stats-grid" id="dashboard-stats"></div>
      </div>
    </section>

    <!-- Students -->
    <section id="tab-students">
      <div class="card">
        <h2>Add Student</h2>
        <div class="row">
          <div class="grow"><label>Name<br><input id="stu-name"></label></div>
          <div class="grow"><label>Phone<br><input id="stu-phone"></label></div>
          <div class="grow"><label>Grade<br><input id="stu-grade"></label></div>
        </div>
        <button class="primary" id="btn-add-student">Add Student</button>
      </div>
      <div class="card">
        <h3>Student List</h3>
        <table id="students-table">
          <thead><tr><th>ID</th><th>Name</th><th>Phone</th><th>Grade</th><th>QR Code</th><th>Actions</th></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- Classes -->
    <section id="tab-classes">
      <div class="card">
        <h2>Add Class</h2>
        <div class="row">
          <div class="grow"><label>Name<br><input id="class-name"></label></div>
          <div class="grow"><label>Monthly Fee<br><input id="class-fee" type="number" value="2000"></label></div>
        </div>
        <button class="primary" id="btn-add-class">Add Class</button>
      </div>
      <div class="card">
        <h3>Class List</h3>
        <table id="classes-table">
          <thead><tr><th>ID</th><th>Name</th><th>Monthly Fee</th><th>Actions</th></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- Enrollments -->
    <section id="tab-enrollments">
      <div class="card">
        <h2>Enroll Student</h2>
        <div class="row">
          <div class="grow"><label>Student<br><select id="enroll-student"></select></label></div>
          <div class="grow"><label>Class<br><select id="enroll-class"></select></label></div>
        </div>
        <button class="primary" id="btn-enroll">Enroll</button>
      </div>
      <div class="card">
        <h3>Students in Class</h3>
        <div class="row">
          <div class="grow"><label>Class<br><select id="enroll-view-class"></select></label></div>
        </div>
        <table id="enroll-table">
          <thead><tr><th>ID</th><th>Name</th><th>Phone</th><th>Grade</th><th>Actions</th></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- QR Scanner -->
    <section id="tab-qr-scanner">
      <div class="card">
        <h2>QR Code Scanner</h2>
        <div class="row">
          <div class="grow"><label>Class<br><select id="qr-class"></select></label></div>
          <div class="grow"><label>Date (YYYY-MM-DD)<br><input id="qr-date"></label></div>
        </div>
        <div id="qr-scanner-container">
          <div id="qr-reader"></div>
        </div>
        <div id="qr-result"></div>
      </div>
    </section>

    <!-- Attendance -->
    <section id="tab-attendance">
      <div class="card">
        <h2>Manual Attendance</h2>
        <div class="row">
          <div class="grow"><label>Student<br><select id="att-student"></select></label></div>
          <div class="grow"><label>Class<br><select id="att-class"></select></label></div>
          <div class="grow"><label>Date (YYYY-MM-DD)<br><input id="att-date"></label></div>
        </div>
        <button class="primary" id="btn-mark-attendance">Mark Attendance</button>
      </div>
      <div class="card">
        <h3>Today's Attendance</h3>
        <table id="attendance-table">
          <thead><tr><th>Student</th><th>Class</th><th>Method</th><th>Time</th></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- Payments -->
    <section id="tab-payments">
      <div class="card">
        <h2>Record Payment</h2>
        <div class="row">
          <div class="grow"><label>Student<br><select id="pay-student"></select></label></div>
          <div class="grow"><label>Class<br><select id="pay-class"></select></label></div>
        </div>
        <div class="row">
          <div class="grow"><label>Month (YYYY-MM)<br><input id="pay-month"></label></div>
          <div class="grow"><label>Amount<br><input id="pay-amount" type="number" value="2000"></label></div>
          <div class="grow"><label>Method<br><select id="pay-method"><option>cash</option><option>bank</option><option>online</option></select></label></div>
        </div>
        <button class="primary" id="btn-pay">Save Payment</button>
      </div>
    </section>

    <!-- Unpaid -->
    <section id="tab-unpaid">
      <div class="card">
        <h2>Unpaid Students</h2>
        <div class="row">
          <div class="grow"><label>Month (YYYY-MM)<br><input id="unpaid-month"></label></div>
        </div>
        <button class="primary" id="btn-load-unpaid">Load Unpaid</button>
      </div>
      <div class="card">
        <table id="unpaid-table">
          <thead><tr><th>Class</th><th>Student</th><th>Phone</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- Finance -->
    <section id="tab-finance">
      <div class="card">
        <h2>Finance Summary</h2>
        <div class="row">
          <div class="grow"><label>Month (YYYY-MM)<br><input id="fin-month"></label></div>
        </div>
        <button class="primary" id="btn-load-finance">Load Summary</button>
      </div>
      <div class="card">
        <table id="finance-table">
          <thead><tr><th>Class</th><th>Payments</th><th>Total (Rs.)</th></tr></thead>
          <tbody></tbody>
          <tfoot><tr><td colspan="2" style="text-align:right">Total</td><td id="finance-total"></td></tr></tfoot>
        </table>
      </div>
    </section>

    <!-- Exam Admin -->
    <section id="tab-exam-admin">
      <div class="card">
        <h2>Exam Seat Layout (Read-Only)</h2>
        <div class="row">
          <div class="grow"><label>Session<br><select id="exam-admin-slot"></select></label></div>
        </div>
        <div class="seat-layout" id="exam-admin-layout"></div>
      </div>
    </section>

    <!-- Settings -->
    <section id="tab-settings">
      <div class="card">
        <h2>Settings</h2>
        <p>Database: <code>${DB_PATH}</code></p>
        <button class="primary" id="btn-download-db">Download Database</button>
      </div>
    </section>

    <footer>Created by Pulindu Pansilu</footer>
  </div>

  <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
  <script>
    (function(){
      function $(id){return document.getElementById(id);}
      const statusEl = $("status");
      let html5QrCode = null;

      function setStatus(msg, isError){
        statusEl.textContent = msg || "";
        statusEl.className = "status" + (isError ? " error" : "");
      }

      async function api(url, options){
        options = options || {};
        options.headers = options.headers || {};
        if(options.body && typeof options.body !== "string"){
          options.body = JSON.stringify(options.body);
        }
        options.headers["Content-Type"] = "application/json";
        const res = await fetch(url, options);
        const data = await res.json();
        if(!res.ok) throw new Error(data.error || "HTTP " + res.status);
        return data;
      }

      function switchTab(tabId){
        document.querySelectorAll(".tab-btn").forEach(b => {
          b.classList.toggle("active", b.getAttribute("data-tab") === tabId);
        });
        document.querySelectorAll("section").forEach(s => {
          s.classList.toggle("active", s.id === "tab-" + tabId);
        });
        if(tabId === "qr-scanner"){
          setTimeout(initQRScanner, 100);
        } else if(html5QrCode){
          html5QrCode.stop();
          html5QrCode = null;
        }
      }

      document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", function(){
          switchTab(this.getAttribute("data-tab"));
        });
      });

      // Check session
      api("/api/session").then(data => {
        $("username-display").textContent = "Logged in as: " + (data.username || "Admin");
      }).catch(() => {
        window.location.href = "/";
      });

      $("logout-btn").addEventListener("click", async () => {
        await api("/api/logout", {method: "POST"});
        window.location.href = "/";
      });

      // Dashboard
      async function loadDashboard(){
        try{
          const data = await api("/api/admin/dashboard");
          $("dashboard-stats").innerHTML = \`
            <div class="stat-card">
              <div class="stat-value">\${data.total_students}</div>
              <div class="stat-label">Total Students</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">\${data.total_classes}</div>
              <div class="stat-label">Total Classes</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">\${data.current_month_payments}</div>
              <div class="stat-label">Payments This Month</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">Rs. \${data.current_month_revenue}</div>
              <div class="stat-label">Revenue This Month</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">\${data.today_attendance}</div>
              <div class="stat-label">Today's Attendance</div>
            </div>
          \`;
        } catch(e){
          setStatus("Error loading dashboard: " + e.message, true);
        }
      }

      // Students
      async function loadStudents(){
        try{
          const data = await api("/api/admin/students");
          const tbody = $("students-table").querySelector("tbody");
          tbody.innerHTML = data.map(s => \`
            <tr>
              <td>\${s.id}</td>
              <td>\${s.name}</td>
              <td>\${s.phone || ""}</td>
              <td>\${s.grade || ""}</td>
              <td><button class="primary" onclick="showQRCode(\${s.id})">Show QR</button></td>
              <td><button class="danger" onclick="deleteStudent(\${s.id})">Delete</button></td>
            </tr>
          \`).join("");

          const opts = data.map(s => \`<option value="\${s.id}">\${s.name}</option>\`).join("");
          $("enroll-student").innerHTML = opts;
          $("pay-student").innerHTML = opts;
          $("att-student").innerHTML = opts;
        } catch(e){
          setStatus("Error loading students: " + e.message, true);
        }
      }

      window.showQRCode = async function(studentId){
        try{
          const data = await api(\`/api/admin/students/\${studentId}/qrcode\`);
          const modal = document.createElement("div");
          modal.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:1000;";
          modal.innerHTML = \`
            <div style="background:#0f172a;padding:2rem;border-radius:1rem;text-align:center;">
              <img src="\${data.qr_code}" style="max-width:300px;margin-bottom:1rem;"/>
              <p style="color:#9ca3af;font-size:.85rem;">Token: \${data.token}</p>
              <button class="primary" onclick="this.closest('div').parentElement.remove()">Close</button>
            </div>
          \`;
          document.body.appendChild(modal);
        } catch(e){
          setStatus("Error loading QR code: " + e.message, true);
        }
      };

      window.deleteStudent = async function(id){
        if(!confirm("Delete this student?")) return;
        try{
          await api(\`/api/admin/students/\${id}\`, {method: "DELETE"});
          setStatus("Student deleted");
          loadStudents();
        } catch(e){
          setStatus(e.message, true);
        }
      };

      $("btn-add-student").addEventListener("click", async () => {
        try{
          await api("/api/admin/students", {
            method: "POST",
            body: {
              name: $("stu-name").value.trim(),
              phone: $("stu-phone").value.trim() || null,
              grade: $("stu-grade").value.trim() || null
            }
          });
          $("stu-name").value = "";
          $("stu-phone").value = "";
          $("stu-grade").value = "";
          setStatus("Student added");
          loadStudents();
        } catch(e){
          setStatus(e.message, true);
        }
      });

      // Classes
      async function loadClasses(){
        try{
          const data = await api("/api/admin/classes");
          const tbody = $("classes-table").querySelector("tbody");
          tbody.innerHTML = data.map(c => \`
            <tr>
              <td>\${c.id}</td>
              <td>\${c.name}</td>
              <td>Rs. \${c.monthly_fee}</td>
              <td><button class="primary" onclick="editClassFee(\${c.id}, \${c.monthly_fee})">Edit Fee</button></td>
            </tr>
          \`).join("");

          const opts = data.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join("");
          $("enroll-class").innerHTML = opts;
          $("enroll-view-class").innerHTML = opts;
          $("pay-class").innerHTML = opts;
          $("att-class").innerHTML = opts;
          $("qr-class").innerHTML = opts;
        } catch(e){
          setStatus("Error loading classes: " + e.message, true);
        }
      }

      window.editClassFee = async function(id, currentFee){
        const newFee = prompt("Enter new monthly fee:", currentFee);
        if(!newFee || isNaN(newFee)) return;
        try{
          await api(\`/api/admin/classes/\${id}\`, {
            method: "PUT",
            body: {monthly_fee: Number(newFee)}
          });
          setStatus("Fee updated");
          loadClasses();
        } catch(e){
          setStatus(e.message, true);
        }
      };

      $("btn-add-class").addEventListener("click", async () => {
        try{
          await api("/api/admin/classes", {
            method: "POST",
            body: {
              name: $("class-name").value.trim(),
              monthly_fee: Number($("class-fee").value || 0)
            }
          });
          $("class-name").value = "";
          $("class-fee").value = "2000";
          setStatus("Class added");
          loadClasses();
        } catch(e){
          setStatus(e.message, true);
        }
      });

      // Enrollments
      $("btn-enroll").addEventListener("click", async () => {
        try{
          await api("/api/admin/enrollments", {
            method: "POST",
            body: {
              student_id: Number($("enroll-student").value),
              class_id: Number($("enroll-class").value)
            }
          });
          setStatus("Student enrolled");
          loadStudentsInClass();
        } catch(e){
          setStatus(e.message, true);
        }
      });

      async function loadStudentsInClass(){
        const classId = $("enroll-view-class").value;
        if(!classId) return;
        try{
          const data = await api(\`/api/admin/classes/\${classId}/students\`);
          const tbody = $("enroll-table").querySelector("tbody");
          tbody.innerHTML = data.map(s => \`
            <tr>
              <td>\${s.id}</td>
              <td>\${s.name}</td>
              <td>\${s.phone || ""}</td>
              <td>\${s.grade || ""}</td>
              <td><button class="danger" onclick="unenrollStudent(\${s.id}, \${classId})">Unenroll</button></td>
            </tr>
          \`).join("");
        } catch(e){
          setStatus(e.message, true);
        }
      }

      window.unenrollStudent = async function(studentId, classId){
        if(!confirm("Unenroll this student?")) return;
        try{
          await api("/api/admin/enrollments", {
            method: "DELETE",
            body: {student_id: studentId, class_id: classId}
          });
          setStatus("Student unenrolled");
          loadStudentsInClass();
        } catch(e){
          setStatus(e.message, true);
        }
      };

      $("enroll-view-class").addEventListener("change", loadStudentsInClass);

      // QR Scanner
      async function initQRScanner(){
        if(html5QrCode) return;
        const qrReader = $("qr-reader");
        qrReader.innerHTML = "";
        try{
          html5QrCode = new Html5Qrcode("qr-reader");
          await html5QrCode.start(
            {facingMode: "environment"},
            {
              fps: 10,
              qrbox: {width: 250, height: 250}
            },
            async (decodedText) => {
              try{
                const classId = $("qr-class").value;
                const date = $("qr-date").value || new Date().toISOString().slice(0,10);
                if(!classId){
                  setStatus("Select a class first", true);
                  return;
                }
                const result = await api("/api/admin/attendance/qr", {
                  method: "POST",
                  body: {qr_token: decodedText, class_id: classId, date: date}
                });
                $("qr-result").innerHTML = \`
                  <div style="margin-top:1rem;padding:1rem;background:#1f2937;border-radius:.5rem;">
                    <p><strong>Student:</strong> \${result.student.name}</p>
                    <p><strong>Phone:</strong> \${result.student.phone || "N/A"}</p>
                    <p><strong>Payment Status:</strong> <span style="color:\${result.payment_status === 'paid' ? '#16a34a' : '#fca5a5'}">\${result.payment_status}</span></p>
                  </div>
                \`;
                setStatus("Attendance recorded successfully");
                loadAttendance();
              } catch(e){
                setStatus(e.message, true);
              }
            }
          );
        } catch(e){
          setStatus("QR Scanner error: " + e.message, true);
        }
      }

      // Attendance
      $("btn-mark-attendance").addEventListener("click", async () => {
        try{
          await api("/api/admin/attendance/manual", {
            method: "POST",
            body: {
              student_id: Number($("att-student").value),
              class_id: Number($("att-class").value),
              date: $("att-date").value || new Date().toISOString().slice(0,10)
            }
          });
          setStatus("Attendance marked");
          loadAttendance();
        } catch(e){
          setStatus(e.message, true);
        }
      });

      async function loadAttendance(){
        try{
          const date = $("att-date").value || new Date().toISOString().slice(0,10);
          const data = await api(\`/api/admin/attendance?date=\${date}\`);
          const tbody = $("attendance-table").querySelector("tbody");
          tbody.innerHTML = data.map(a => \`
            <tr>
              <td>\${a.student_name}</td>
              <td>\${a.class_name}</td>
              <td>\${a.method}</td>
              <td>\${a.created_at}</td>
            </tr>
          \`).join("");
        } catch(e){
          setStatus("Error loading attendance: " + e.message, true);
        }
      }

      // Payments
      $("btn-pay").addEventListener("click", async () => {
        try{
          await api("/api/admin/payments", {
            method: "POST",
            body: {
              student_id: Number($("pay-student").value),
              class_id: Number($("pay-class").value),
              month: $("pay-month").value || new Date().toISOString().slice(0,7),
              amount: Number($("pay-amount").value || 0),
              method: $("pay-method").value
            }
          });
          setStatus("Payment saved");
        } catch(e){
          setStatus(e.message, true);
        }
      });

      // Unpaid
      $("btn-load-unpaid").addEventListener("click", async () => {
        try{
          const month = $("unpaid-month").value || new Date().toISOString().slice(0,7);
          const data = await api(\`/api/admin/unpaid?month=\${encodeURIComponent(month)}\`);
          const tbody = $("unpaid-table").querySelector("tbody");
          tbody.innerHTML = data.rows.map(r => \`
            <tr>
              <td>\${r.class_name}</td>
              <td>\${r.student_name}</td>
              <td>\${r.phone || ""}</td>
            </tr>
          \`).join("");
          setStatus("Loaded unpaid for " + data.month);
        } catch(e){
          setStatus(e.message, true);
        }
      });

      // Finance
      $("btn-load-finance").addEventListener("click", async () => {
        try{
          const month = $("fin-month").value || new Date().toISOString().slice(0,7);
          const data = await api(\`/api/admin/finance?month=\${encodeURIComponent(month)}\`);
          const tbody = $("finance-table").querySelector("tbody");
          tbody.innerHTML = data.rows.map(r => \`
            <tr>
              <td>\${r.class_name}</td>
              <td>\${r.payments_count}</td>
              <td>Rs. \${r.total_amount}</td>
            </tr>
          \`).join("");
          $("finance-total").textContent = "Rs. " + data.total;
          setStatus("Loaded finance for " + data.month);
        } catch(e){
          setStatus(e.message, true);
        }
      });

      // Exam Admin
      async function loadExamAdminSlots(){
        try{
          const data = await api("/api/admin/exam/slots");
          $("exam-admin-slot").innerHTML = data.map(s => \`<option value="\${s.id}">\${s.label}</option>\`).join("");
          if(data.length){
            $("exam-admin-slot").value = data[0].id;
            loadExamAdminLayout();
          }
        } catch(e){
          setStatus("Error loading exam slots: " + e.message, true);
        }
      }

      async function loadExamAdminLayout(){
        const slotId = $("exam-admin-slot").value;
        if(!slotId) return;
        try{
          const data = await api(\`/api/admin/exam/slots/\${slotId}/layout\`);
          renderSeatLayout($("exam-admin-layout"), data);
        } catch(e){
          setStatus("Error loading layout: " + e.message, true);
        }
      }

      function renderSeatLayout(container, data){
        const maxSeats = data.seat_count;
        const bookings = data.bookings || [];
        const map = {};
        bookings.forEach(b => {
          map[b.seat_index + "-" + b.seat_pos] = b;
        });
        let html = "";
        for(let i=1; i<=maxSeats; i++){
          html += \`<div class="bench-row"><div class="bench-label">Seat \${i}</div><div class="bench">\`;
          for(let p=1; p<=4; p++){
            const key = i + "-" + p;
            const b = map[key];
            let cls = "bench-segment";
            let text = "Pos " + p;
            if(b){
              cls += " booked";
              if(b.student_class === "Grade 7") cls += " grade7";
              else if(b.student_class === "Grade 8") cls += " grade8";
              text = b.student_name;
            } else {
              cls += " empty";
            }
            html += \`<div class="\${cls}">\${text}</div>\`;
          }
          html += "</div></div>";
        }
        container.innerHTML = html;
      }

      $("exam-admin-slot").addEventListener("change", loadExamAdminLayout);

      // Settings
      $("btn-download-db").addEventListener("click", () => {
        window.location.href = "/api/admin/download-db";
      });

      // Defaults
      const todayMonth = new Date().toISOString().slice(0,7);
      const todayDate = new Date().toISOString().slice(0,10);
      ["pay-month", "unpaid-month", "fin-month"].forEach(id => {
        if($(id)) $(id).value = todayMonth;
      });
      ["qr-date", "att-date"].forEach(id => {
        if($(id)) $(id).value = todayDate;
      });

      // Initial load
      Promise.all([loadDashboard(), loadStudents(), loadClasses(), loadExamAdminSlots()]).then(() => {
        setStatus("Ready");
      }).catch(e => {
        setStatus("Error loading initial data: " + e.message, true);
      });
    })();
  </script>
</body>
</html>`;

const STUDENT_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Student Portal - Exam Booking</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    *{box-sizing:border-box;}
    body{
      font-family:system-ui, sans-serif;
      background:#020617;
      color:#e5e7eb;
      margin:0;
    }
    .container{
      max-width:1200px;
      margin:0 auto;
      padding:1rem;
    }
    header{
      display:flex;
      justify-content:space-between;
      align-items:center;
      margin-bottom:1rem;
      flex-wrap:wrap;
      gap:1rem;
    }
    h1{margin:0;color:#f9fafb;}
    .logout-btn{
      background:#dc2626;
      color:#f9fafb;
      border:none;
      padding:.5rem 1rem;
      border-radius:.5rem;
      cursor:pointer;
    }
    .card{
      background:#0f172a;
      border:1px solid #1f2937;
      border-radius:.8rem;
      padding:1.5rem;
      margin-bottom:1rem;
    }
    h2{margin:0 0 1rem;color:#f9fafb;}
    .row{
      display:flex;
      flex-wrap:wrap;
      gap:1rem;
      margin-bottom:1rem;
    }
    .grow{flex:1 1 200px;}
    label{
      display:block;
      margin-bottom:.4rem;
      font-size:.85rem;
      color:#9ca3af;
    }
    input,select{
      width:100%;
      padding:.5rem;
      background:#020617;
      border:1px solid #374151;
      border-radius:.5rem;
      color:#e5e7eb;
      font-size:.9rem;
    }
    button.primary{
      background:#2563eb;
      color:#f9fafb;
      border:none;
      border-radius:.5rem;
      padding:.6rem 1.2rem;
      cursor:pointer;
      font-size:.9rem;
      margin-top:.5rem;
    }
    button.primary:hover{background:#1d4ed8;}
    button.primary:disabled{
      background:#64748b;
      cursor:not-allowed;
    }
    .status{
      margin-bottom:1rem;
      font-size:.85rem;
      color:#93c5fd;
    }
    .status.error{color:#fca5a5;}
    .seat-layout{
      margin-top:1rem;
      display:flex;
      flex-direction:column;
      gap:.5rem;
      max-height:500px;
      overflow:auto;
      border:1px solid #1f2937;
      border-radius:.6rem;
      padding:1rem;
      background:#0f172a;
    }
    .bench-row{
      display:flex;
      align-items:center;
      gap:.6rem;
    }
    .bench-label{
      width:80px;
      font-size:.8rem;
      color:#9ca3af;
    }
    .bench{
      flex:1;
      background:#78350f;
      border-radius:.4rem;
      height:40px;
      display:flex;
      overflow:hidden;
    }
    .bench-segment{
      flex:1;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:.75rem;
      color:#e5e7eb;
      border-right:1px solid rgba(15,23,42,0.7);
      cursor:pointer;
    }
    .bench-segment:last-child{border-right:none;}
    .bench-segment.empty{color:#d1d5db80;}
    .bench-segment.empty:hover{background:#92400e;}
    .bench-segment.booked{cursor:not-allowed;}
    .bench-segment.booked.grade7{background:#1d4ed8;}
    .bench-segment.booked.grade8{background:#16a34a;}
    .bench-segment.selected{
      outline:3px solid #facc15;
      outline-offset:-3px;
    }
    #seat-info{
      margin-top:1rem;
      padding:1rem;
      background:#1f2937;
      border-radius:.5rem;
      font-size:.9rem;
    }
    #seat-legend{
      margin-top:1rem;
      font-size:.85rem;
      color:#9ca3af;
    }
    #seat-legend span{
      display:inline-flex;
      align-items:center;
      margin-right:1rem;
      gap:.4rem;
    }
    .legend-box{
      width:16px;
      height:16px;
      border-radius:3px;
      display:inline-block;
    }
    .legend-grade7{background:#1d4ed8;}
    .legend-grade8{background:#16a34a;}
    .legend-empty{background:#78350f;border:1px solid #111827;}
    footer{
      margin-top:2rem;
      text-align:center;
      font-size:.8rem;
      color:#64748b;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Main Exam Booking</h1>
      <button class="logout-btn" id="logout-btn">Logout</button>
    </header>
    <div class="status" id="status"></div>
    <div class="card">
      <h2>Book Your Exam Seat</h2>
      <p style="font-size:.85rem;color:#9ca3af;margin-bottom:1rem;">
        Only Grade 7 and Grade 8 students can book exam seats. Each bench has 4 positions.
      </p>
      <div class="row">
        <div class="grow">
          <label>Session<br><select id="exam-slot"></select></label>
        </div>
      </div>
      <div id="seat-info"></div>
      <div id="seat-legend">
        <span><span class="legend-box legend-empty"></span>Empty</span>
        <span><span class="legend-box legend-grade7"></span>Grade 7</span>
        <span><span class="legend-box legend-grade8"></span>Grade 8</span>
      </div>
      <button class="primary" id="btn-book-seat" disabled>Confirm Booking</button>
    </div>
    <div class="card">
      <h3>Seat Layout (4 students per bench)</h3>
      <div class="seat-layout" id="seat-layout"></div>
    </div>
    <footer>Created by Pulindu Pansilu</footer>
  </div>
  <script>
    (function(){
      function $(id){return document.getElementById(id);}
      const statusEl = $("status");
      let selectedSeatIndex = null;
      let selectedSeatPos = null;
      let studentInfo = null;

      function setStatus(msg, isError){
        statusEl.textContent = msg || "";
        statusEl.className = "status" + (isError ? " error" : "");
      }

      async function api(url, options){
        options = options || {};
        options.headers = options.headers || {};
        if(options.body && typeof options.body !== "string"){
          options.body = JSON.stringify(options.body);
        }
        options.headers["Content-Type"] = "application/json";
        const res = await fetch(url, options);
        const data = await res.json();
        if(!res.ok) throw new Error(data.error || "HTTP " + res.status);
        return data;
      }

      // Check session and load student info
      async function init(){
        try{
          const sessionData = await api("/api/session");
          studentInfo = await api("/api/student/info");
          
          if(studentInfo.grade !== "Grade 7" && studentInfo.grade !== "Grade 8"){
            setStatus("Only Grade 7 and Grade 8 students can book exam seats", true);
            $("btn-book-seat").disabled = true;
            return;
          }

          await loadExamSlots();
        } catch(e){
          if(e.message.includes("401") || e.message.includes("403")){
            window.location.href = "/";
          } else {
            setStatus("Error: " + e.message, true);
          }
        }
      }

      $("logout-btn").addEventListener("click", async () => {
        await api("/api/logout", {method: "POST"});
        window.location.href = "/";
      });

      async function loadExamSlots(){
        try{
          const data = await api("/api/student/exam/slots");
          $("exam-slot").innerHTML = data.map(s => \`<option value="\${s.id}">\${s.label}</option>\`).join("");
          if(data.length){
            $("exam-slot").value = data[0].id;
            await loadSeatLayout();
          }
        } catch(e){
          setStatus("Error loading exam slots: " + e.message, true);
        }
      }

      async function loadSeatLayout(){
        const slotId = $("exam-slot").value;
        if(!slotId) return;
        try{
          selectedSeatIndex = null;
          selectedSeatPos = null;
          $("seat-info").textContent = "";
          $("btn-book-seat").disabled = true;
          const data = await api(\`/api/student/exam/slots/\${slotId}/layout\`);
          renderSeatLayout(data);
          setStatus("Loaded seat layout for " + data.slot.label);
        } catch(e){
          setStatus("Error loading seats: " + e.message, true);
        }
      }

      function renderSeatLayout(data){
        const layout = $("seat-layout");
        const maxSeats = data.seat_count;
        const bookings = data.bookings || [];
        const map = {};
        bookings.forEach(b => {
          map[b.seat_index + "-" + b.seat_pos] = b;
        });
        let html = "";
        for(let i=1; i<=maxSeats; i++){
          html += \`<div class="bench-row"><div class="bench-label">Seat \${i}</div><div class="bench">\`;
          for(let p=1; p<=4; p++){
            const key = i + "-" + p;
            const b = map[key];
            let cls = "bench-segment";
            let text = "Pos " + p;
            if(b){
              cls += " booked";
              if(b.student_class === "Grade 7") cls += " grade7";
              else if(b.student_class === "Grade 8") cls += " grade8";
              text = b.student_name;
            } else {
              cls += " empty";
            }
            html += \`<div class="\${cls}" data-seat="\${i}" data-pos="\${p}">\${text}</div>\`;
          }
          html += "</div></div>";
        }
        layout.innerHTML = html;

        layout.addEventListener("click", function(ev){
          const t = ev.target;
          if(!t.classList.contains("bench-segment")) return;
          if(t.classList.contains("booked")){
            setStatus("This seat is already booked", true);
            return;
          }
          if(!t.classList.contains("empty")) return;
          const seat = Number(t.getAttribute("data-seat"));
          const pos = Number(t.getAttribute("data-pos"));
          selectedSeatIndex = seat;
          selectedSeatPos = pos;
          document.querySelectorAll(".bench-segment").forEach(el => {
            el.classList.remove("selected");
          });
          t.classList.add("selected");
          $("seat-info").innerHTML = \`
            <strong>Selected:</strong> Seat \${seat} – Position \${pos}<br>
            <strong>Your Name:</strong> \${studentInfo.name}<br>
            <strong>Your Grade:</strong> \${studentInfo.grade}
          \`;
          $("btn-book-seat").disabled = false;
        });
      }

      $("exam-slot").addEventListener("change", loadSeatLayout);

      $("btn-book-seat").addEventListener("click", async () => {
        const slotId = Number($("exam-slot").value);
        if(!slotId || selectedSeatIndex === null || selectedSeatPos === null){
          setStatus("Please select a seat", true);
          return;
        }
        try{
          await api("/api/student/exam/book", {
            method: "POST",
            body: {
              slot_id: slotId,
              seat_index: selectedSeatIndex,
              seat_pos: selectedSeatPos
            }
          });
          setStatus("Seat booked successfully!");
          $("seat-info").textContent = "";
          $("btn-book-seat").disabled = true;
          selectedSeatIndex = null;
          selectedSeatPos = null;
          await loadSeatLayout();
        } catch(e){
          setStatus(e.message, true);
        }
      });

      init();
    })();
  </script>
</body>
</html>`;

// Serve frontend routes
app.get("/", (req, res) => {
  if (req.session.userId) {
    if (req.session.role === "admin") {
      return res.redirect("/admin");
    } else {
      return res.redirect("/student");
    }
  }
  res.type("html").send(LOGIN_HTML);
});

app.get("/admin", requireAdmin, (req, res) => {
  res.type("html").send(ADMIN_HTML);
});

app.get("/student", requireStudent, (req, res) => {
  res.type("html").send(STUDENT_HTML);
});

// Database download (admin only)
app.get("/api/admin/download-db", requireAdmin, (req, res) => {
  res.download(DB_PATH, "class_manager.db", (err) => {
    if (err) {
      res.status(500).json({ error: "Failed to download database" });
    }
  });
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log("✅ Class Management System running on port " + PORT);
  console.log("🗄  DB file:", DB_PATH);
  console.log("👤 Admin login: username=admin, password=admin123");
});
