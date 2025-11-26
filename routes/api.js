const express = require("express");
const {
  db,
  monthKey,
  ensureStudentLogin,
  refreshQrToken,
  generateQrToken,
  DB_FILE,
  DEFAULT_STUDENT_PASSWORD,
} = require("../db");
const {
  requireAdmin,
  requireStudent,
  requireAuth,
} = require("../middleware/auth");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const GRADE_OPTIONS = ["Grade 6", "Grade 7", "Grade 8", "O/L"];

function validateGrade(grade) {
  if (!GRADE_OPTIONS.includes(grade)) {
    throw new Error("Invalid grade");
  }
  return grade;
}

function toId(value, label = "id") {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`Invalid ${label}`);
  }
  return num;
}

function getClassIdForGrade(grade) {
  const cls = db
    .prepare("SELECT id FROM classes WHERE name = ?")
    .get(grade);
  if (!cls) throw new Error(`Class not configured for ${grade}`);
  return cls.id;
}

router.use(requireAuth);

// ---------- STUDENTS ----------
router.get("/students", requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, (
        SELECT GROUP_CONCAT(c.name, ', ')
        FROM enrollments e
        JOIN classes c ON c.id = e.class_id
        WHERE e.student_id = s.id
      ) AS classes
      FROM students s
      ORDER BY s.created_at DESC`
    )
    .all();
  res.json(rows);
});

router.post("/students", requireAdmin, (req, res) => {
  const { name, phone, grade } = req.body;
  if (!name || !phone || !grade) {
    return res.status(400).json({ error: "Name, phone and grade are required" });
  }
  try {
    validateGrade(grade);
    const token = generateQrToken();
    const info = db
      .prepare(
        "INSERT INTO students(name, phone, grade, qr_token) VALUES(?,?,?,?)"
      )
      .run(name.trim(), phone.trim(), grade, token);
    ensureStudentLogin(info.lastInsertRowid, phone.trim());
    const student = db
      .prepare("SELECT * FROM students WHERE id = ?")
      .get(info.lastInsertRowid);
    res.status(201).json(student);
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT") {
      return res.status(400).json({ error: "Phone already exists" });
    }
    res.status(400).json({ error: err.message });
  }
});

router.put("/students/:id", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id, "student_id");
    const { name, phone, grade } = req.body;
    if (!name || !phone || !grade) throw new Error("Missing fields");
    validateGrade(grade);
    db.prepare(
      "UPDATE students SET name=?, phone=?, grade=? WHERE id=?"
    ).run(name.trim(), phone.trim(), grade, id);
    db.prepare(
      "UPDATE users SET username=? WHERE student_id=? AND role='student'"
    ).run(phone.trim(), id);
    const updated = db
      .prepare("SELECT * FROM students WHERE id=?")
      .get(id);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/students/:id", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id, "student_id");
    db.prepare("DELETE FROM students WHERE id=?").run(id);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/students/:id/reset-password", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id, "student_id");
    const user = db
      .prepare("SELECT username FROM users WHERE student_id=?")
      .get(id);
    if (!user) return res.status(404).json({ error: "Login not found" });
    const bcrypt = require("bcrypt");
    const hash = bcrypt.hashSync(DEFAULT_STUDENT_PASSWORD, 10);
    db.prepare("UPDATE users SET password_hash=? WHERE student_id=?").run(
      hash,
      id
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/students/:id/qr", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id, "student_id");
    const token = refreshQrToken(id);
    res.json({ qr_token: token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- CLASSES ----------
router.get("/classes", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM classes ORDER BY name").all();
  res.json(rows);
});

router.post("/classes", requireAdmin, (req, res) => {
  try {
    const { name, monthly_fee } = req.body;
    if (!name) throw new Error("Name required");
    const fee = Number(monthly_fee || 0);
    if (fee < 0 || !Number.isFinite(fee)) throw new Error("Invalid fee");
    const info = db
      .prepare("INSERT INTO classes(name, monthly_fee) VALUES(?,?)")
      .run(name.trim(), fee);
    const cls = db
      .prepare("SELECT * FROM classes WHERE id = ?")
      .get(info.lastInsertRowid);
    res.status(201).json(cls);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/classes/:id", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id, "class_id");
    const { name, monthly_fee } = req.body;
    if (!name) throw new Error("Name required");
    const fee = Number(monthly_fee || 0);
    if (fee < 0 || !Number.isFinite(fee)) throw new Error("Invalid fee");
    db.prepare("UPDATE classes SET name=?, monthly_fee=? WHERE id=?").run(
      name.trim(),
      fee,
      id
    );
    const cls = db
      .prepare("SELECT * FROM classes WHERE id=?")
      .get(id);
    res.json(cls);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/classes/:id", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id, "class_id");
    db.prepare("DELETE FROM classes WHERE id=?").run(id);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- ENROLLMENTS ----------
router.post("/enrollments", requireAdmin, (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    db.prepare(
      "INSERT OR IGNORE INTO enrollments(student_id,class_id) VALUES(?,?)"
    ).run(student_id, class_id);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/enrollments", requireAdmin, (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    db.prepare("DELETE FROM enrollments WHERE student_id=? AND class_id=?").run(
      student_id,
      class_id
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/classes/:id/students", requireAdmin, (req, res) => {
  try {
    const class_id = toId(req.params.id, "class_id");
    const rows = db
      .prepare(
        `SELECT s.* FROM enrollments e
         JOIN students s ON s.id = e.student_id
         WHERE e.class_id = ?
         ORDER BY s.name`
      )
      .all(class_id);
    res.json(rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- ATTENDANCE ----------
router.get("/attendance", requireAdmin, (req, res) => {
  try {
    const class_id = toId(req.query.class_id, "class_id");
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const enrolled = db
      .prepare(
        `SELECT s.id, s.name, s.phone, s.grade,
                CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS present
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         LEFT JOIN attendance a ON a.student_id = s.id AND a.date = ? AND a.class_id = e.class_id
         WHERE e.class_id = ?
         ORDER BY s.name`
      )
      .all(date, class_id);
    res.json({ date, students: enrolled });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/attendance/mark", requireAdmin, (req, res) => {
  try {
    const { student_id, phone, class_id, date } = req.body;
    let student;
    if (student_id) {
      student = db
        .prepare("SELECT * FROM students WHERE id=?")
        .get(student_id);
    } else if (phone) {
      student = db
        .prepare("SELECT * FROM students WHERE phone=?")
        .get(phone.trim());
    }
    if (!student) throw new Error("Student not found");
    const resolvedClass = class_id
      ? toId(class_id, "class_id")
      : getClassIdForGrade(student.grade);
    const day = date || new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT OR IGNORE INTO attendance(student_id,class_id,date) VALUES(?,?,?)"
    ).run(student.id, resolvedClass, day);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/attendance/toggle", requireAdmin, (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    const date = req.body.date || new Date().toISOString().slice(0, 10);
    const present = req.body.present === true || req.body.present === "true";
    if (present) {
      db.prepare(
        "INSERT OR IGNORE INTO attendance(student_id,class_id,date) VALUES(?,?,?)"
      ).run(student_id, class_id, date);
    } else {
      db.prepare(
        "DELETE FROM attendance WHERE student_id=? AND class_id=? AND date=?"
      ).run(student_id, class_id, date);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- PAYMENTS / FINANCE ----------
router.post("/payments", requireAdmin, (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    const month = req.body.month || monthKey();
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must be YYYY-MM");
    const amount = Number(req.body.amount || 0);
    if (amount <= 0 || !Number.isFinite(amount)) throw new Error("Amount required");
    const method = (req.body.method || "cash").trim();
    db.prepare(
      `INSERT INTO payments(student_id,class_id,month,amount,method)
       VALUES(?,?,?,?,?)
       ON CONFLICT(student_id,class_id,month)
       DO UPDATE SET amount=excluded.amount, method=excluded.method`
    ).run(student_id, class_id, month, amount, method);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/unpaid", requireAdmin, (req, res) => {
  try {
    const month = req.query.month || monthKey();
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must be YYYY-MM");
    const rows = db
      .prepare(
        `SELECT c.name AS class_name, s.name AS student_name, s.phone
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         JOIN classes c ON c.id = e.class_id
         LEFT JOIN payments p
           ON p.student_id = e.student_id AND p.class_id = e.class_id AND p.month = ?
         WHERE p.id IS NULL
         ORDER BY c.name, s.name`
      )
      .all(month);
    res.json({ month, rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/finance", requireAdmin, (req, res) => {
  try {
    const month = req.query.month || monthKey();
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must be YYYY-MM");
    const rows = db
      .prepare(
        `SELECT c.id, c.name, COUNT(p.id) AS payments, COALESCE(SUM(p.amount),0) AS total
         FROM classes c
         LEFT JOIN payments p ON p.class_id = c.id AND p.month = ?
         GROUP BY c.id
         ORDER BY c.name`
      )
      .all(month);
    const overall = rows.reduce((sum, row) => sum + row.total, 0);
    res.json({ month, rows, overall });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- QR SCAN ----------
router.post("/scan", requireAdmin, (req, res) => {
  try {
    const { token } = req.body;
    if (!token) throw new Error("QR token required");
    const student = db
      .prepare("SELECT * FROM students WHERE qr_token = ?")
      .get(token.trim());
    if (!student) throw new Error("Student not found for QR");
    const class_id = getClassIdForGrade(student.grade);
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT OR IGNORE INTO attendance(student_id,class_id,date) VALUES(?,?,?)"
    ).run(student.id, class_id, today);
    const month = monthKey();
    const paid = db
      .prepare(
        "SELECT id FROM payments WHERE student_id=? AND class_id=? AND month=?"
      )
      .get(student.id, class_id, month);
    res.json({
      status: "ok",
      studentName: student.name,
      className: student.grade,
      paidThisMonth: Boolean(paid),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- DASHBOARD SUMMARY ----------
router.get("/dashboard/summary", requireAdmin, (req, res) => {
  const totalStudents = db.prepare("SELECT COUNT(*) as c FROM students").get().c;
  const totalPayments = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE month = ?"
    )
    .get(monthKey());
  const todayAttendance = db
    .prepare(
      "SELECT COUNT(*) as c FROM attendance WHERE date = ?"
    )
    .get(new Date().toISOString().slice(0, 10));
  res.json({
    students: totalStudents,
    revenueThisMonth: totalPayments.total,
    attendanceToday: todayAttendance.c,
  });
});

// ---------- EXAM (shared) ----------
router.get("/exam/slots", (req, res) => {
  const slots = db
    .prepare(
      `SELECT es.*, (
        SELECT COUNT(*) FROM exam_bookings eb WHERE eb.slot_id = es.id
      ) AS booked_count
      FROM exam_slots es
      ORDER BY es.id`
    )
    .all();
  res.json(slots);
});

router.get("/exam/slots/:id/layout", (req, res) => {
  try {
    const slot_id = toId(req.params.id, "slot_id");
    const slot = db
      .prepare("SELECT * FROM exam_slots WHERE id = ?")
      .get(slot_id);
    if (!slot) return res.status(404).json({ error: "Slot not found" });
    const bookings = db
      .prepare(
        "SELECT * FROM exam_bookings WHERE slot_id=? ORDER BY seat_index, seat_pos"
      )
      .all(slot_id);
    res.json({ slot, bookings, seat_count: slot.max_seats, max_per_seat: 4 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- STUDENT EXAM ACTIONS ----------
router.post("/exam/book", requireStudent, (req, res) => {
  try {
    const studentId = req.session.user.studentId;
    const seat_index = toId(req.body.seat_index, "seat_index");
    const seat_pos = toId(req.body.seat_pos, "seat_pos");
    const slot_id = toId(req.body.slot_id, "slot_id");
    if (seat_pos < 1 || seat_pos > 4) throw new Error("Seat position 1-4");
    const student = db
      .prepare("SELECT name, grade FROM students WHERE id=?")
      .get(studentId);
    if (!student) throw new Error("Student missing");
    if (!["Grade 7", "Grade 8"].includes(student.grade)) {
      throw new Error("Only Grade 7/8 students can book");
    }
    const existing = db
      .prepare("SELECT id FROM exam_bookings WHERE student_id=?")
      .get(studentId);
    if (existing) throw new Error("You already booked a seat");
    const slot = db
      .prepare("SELECT * FROM exam_slots WHERE id=?")
      .get(slot_id);
    if (!slot) throw new Error("Slot not found");
    if (seat_index > slot.max_seats) throw new Error("Seat exceeds capacity");
    db.prepare(
      `INSERT INTO exam_bookings(slot_id, seat_index, seat_pos, student_name, student_class, student_id)
       VALUES(?,?,?,?,?,?)`
    ).run(slot_id, seat_index, seat_pos, student.name, student.grade, studentId);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT") {
      return res.status(400).json({ error: "Seat already taken" });
    }
    res.status(400).json({ error: err.message });
  }
});

router.get("/student/me", requireStudent, (req, res) => {
  const student = db
    .prepare("SELECT * FROM students WHERE id=?")
    .get(req.session.user.studentId);
  res.json(student);
});

router.get("/student/exam/booking", requireStudent, (req, res) => {
  const booking = db
    .prepare(
      `SELECT eb.*, es.label
       FROM exam_bookings eb
       JOIN exam_slots es ON es.id = eb.slot_id
       WHERE eb.student_id = ?`
    )
    .get(req.session.user.studentId);
  res.json(booking || null);
});

router.delete("/student/exam/booking", requireStudent, (req, res) => {
  db.prepare("DELETE FROM exam_bookings WHERE student_id=?").run(
    req.session.user.studentId
  );
  res.json({ ok: true });
});

// ---------- EXAM ADMIN ----------
router.get("/exam/admin/slots/:id/bookings", requireAdmin, (req, res) => {
  try {
    const slot_id = toId(req.params.id, "slot_id");
    const rows = db
      .prepare(
        `SELECT eb.*, s.phone
         FROM exam_bookings eb
         LEFT JOIN students s ON s.id = eb.student_id
         WHERE eb.slot_id=?
         ORDER BY seat_index, seat_pos`
      )
      .all(slot_id);
    res.json(rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/exam/admin/bookings/:id", requireAdmin, (req, res) => {
  try {
    const id = toId(req.params.id, "booking_id");
    db.prepare("DELETE FROM exam_bookings WHERE id=?").run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- SETTINGS ----------
router.get("/settings/export-db", requireAdmin, (req, res) => {
  const filePath = DB_FILE;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "DB not found" });
  }
  res.download(filePath, path.basename(filePath));
});

module.exports = router;
