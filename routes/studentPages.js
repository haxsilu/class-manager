const express = require("express");
const { requireStudent } = require("../middleware/auth");
const { db } = require("../db");

const router = express.Router();

router.get("/exam", requireStudent, (req, res) => {
  const student = db
    .prepare("SELECT * FROM students WHERE id = ?")
    .get(req.session.user.studentId);
  res.render("student/exam", {
    user: req.session.user,
    student,
  });
});

router.get("/profile", requireStudent, (req, res) => {
  const student = db
    .prepare("SELECT * FROM students WHERE id = ?")
    .get(req.session.user.studentId);
  res.render("student/profile", {
    user: req.session.user,
    student,
  });
});

module.exports = router;