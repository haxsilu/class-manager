const path = require("path");
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const { DATA_DIR } = require("./storage");
require("./db"); // initialize schema & seed

const authRoutes = require("./routes/auth");
const adminPages = require("./routes/adminPages");
const studentPages = require("./routes/studentPages");
const apiRoutes = require("./routes/api");

const app = express();
const PORT = process.env.PORT || 5050;
const HOST = process.env.HOST || "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

if (isProduction) {
  app.set("trust proxy", 1); // respect X-Forwarded-* when behind Railway proxy
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    store: new SQLiteStore({
      dir: DATA_DIR,
      db: "sessions.db",
    }),
    secret: process.env.SESSION_SECRET || "change_this_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

app.use("/", authRoutes);
app.use("/admin", adminPages);
app.use("/student", studentPages);
app.use("/api", apiRoutes);

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.use((req, res) => {
  res.status(404);
  if (req.accepts("html")) {
    return res.render("404");
  }
  res.json({ error: "Not found" });
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`📦 Persisted data dir: ${DATA_DIR}`);
});
