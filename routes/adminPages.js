const express = require("express");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

const tabs = [
  "dashboard",
  "students",
  "classes",
  "enrollments",
  "scanner",
  "attendance",
  "payments",
  "unpaid",
  "finance",
  "exam",
  "settings",
];

router.get("/", requireAdmin, (req, res) => {
  res.redirect("/admin/dashboard");
});

tabs.forEach((tab) => {
  router.get(`/${tab}`, requireAdmin, (req, res) => {
    res.render("admin/dashboard", {
      activeTab: tab,
      user: req.session.user,
    });
  });
});

module.exports = router;
