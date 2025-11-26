const express = require("express");
const bcrypt = require("bcrypt");
const { db } = require("../db");

const router = express.Router();

router.get("/", (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === "admin") {
      return res.redirect("/admin/dashboard");
    }
    if (req.session.user.role === "student") {
      return res.redirect("/student/exam");
    }
  }
  res.render("login", { error: null });
});

router.post("/login", async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
      return res.status(400).render("login", {
        error: "Username, password and role are required.",
      });
    }
    const user = db
      .prepare(
        `SELECT u.*, s.name as student_name, s.grade, s.phone, s.id as student_id
         FROM users u
         LEFT JOIN students s ON s.id = u.student_id
         WHERE u.username = ?`
      )
      .get(username);
    if (!user) {
      return res.status(401).render("login", {
        error: "Invalid credentials.",
      });
    }
    if (user.role !== role) {
      return res.status(401).render("login", {
        error: "Role does not match this user.",
      });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).render("login", {
        error: "Invalid credentials.",
      });
    }

    const sessionUser = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
    if (user.role === "student") {
      sessionUser.studentId = user.student_id;
      sessionUser.name = user.student_name;
      sessionUser.grade = user.grade;
      sessionUser.phone = user.phone;
    }
    req.session.user = sessionUser;

    if (user.role === "admin") {
      return res.redirect("/admin/dashboard");
    }
    return res.redirect("/student/exam");
  } catch (err) {
    console.error("Login error", err);
    return res.status(500).render("login", {
      error: "Server error. Please try again.",
    });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

module.exports = router;
