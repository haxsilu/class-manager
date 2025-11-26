function wantsJson(req) {
  return req.headers.accept && req.headers.accept.includes("application/json") || req.originalUrl.startsWith("/api");
}

function deny(res, message = "Unauthorized") {
  if (res.headersSent) return;
  res.status(401).json({ error: message });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (wantsJson(req)) return deny(res);
  return res.redirect("/");
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === "admin") {
    return next();
  }
  if (wantsJson(req)) return deny(res, "Admin only");
  return res.redirect("/");
}

function requireStudent(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === "student") {
    return next();
  }
  if (wantsJson(req)) return deny(res, "Student only");
  return res.redirect("/");
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireStudent,
};
