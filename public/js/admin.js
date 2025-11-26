(() => {
  const root = document.getElementById("admin-root");
  if (!root) return;

  const state = {
    students: [],
    classes: [],
    slots: [],
    selectedSlot: null,
  };

  const adminStatus = document.getElementById("admin-status");
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = new Date().toISOString().slice(0, 7);

  ["manual-date", "attendance-date"].forEach((id) => {
    const input = document.getElementById(id);
    if (input && !input.value) input.value = today;
  });
  ["payment-month", "unpaid-month", "finance-month"].forEach((id) => {
    const input = document.getElementById(id);
    if (input && !input.value) input.value = currentMonth;
  });

  function setStatus(msg, type = "info") {
    if (!adminStatus) return;
    adminStatus.textContent = msg || "";
    adminStatus.className = `status-banner ${type}`;
  }

  async function api(url, options = {}) {
    const opts = { ...options };
    opts.headers = opts.headers || {};
    if (opts.body && typeof opts.body !== "string") {
      opts.body = JSON.stringify(opts.body);
      opts.headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    return res.headers.get("content-type")?.includes("application/json")
      ? res.json()
      : res.text();
  }

  function showSection(tab) {
    document.querySelectorAll('[data-section]').forEach((section) => {
      section.style.display = section.dataset.section === tab ? "block" : "none";
    });
  }

  const currentTab = root.dataset.tab || "dashboard";
  showSection(currentTab);

  // ---------- STUDENTS ----------
  async function loadStudents() {
    state.students = await api("/api/students");
    renderStudents();
    populateStudentSelects();
  }

  function renderStudents() {
    const tbody = document.querySelector("#students-table tbody");
    if (!tbody) return;
    tbody.innerHTML = state.students
      .map(
        (s) => `
      <tr data-id="${s.id}">
        <td>${s.name}</td>
        <td>${s.grade}</td>
        <td>${s.phone}</td>
        <td><small>${s.qr_token}</small></td>
        <td>
          <button data-action="edit" data-id="${s.id}">Edit</button>
          <button data-action="qr" data-id="${s.id}">New QR</button>
          <button data-action="reset" data-id="${s.id}">Reset PW</button>
          <button data-action="delete" data-id="${s.id}" style="background:#b91c1c;">Delete</button>
        </td>
      </tr>`
      )
      .join("");
  }

  document
    .getElementById("btn-create-student")
    ?.addEventListener("click", async () => {
      try {
        const name = document.getElementById("student-name").value.trim();
        const phone = document.getElementById("student-phone").value.trim();
        const grade = document.getElementById("student-grade").value;
        if (!name || !phone) return setStatus("Name and phone required", "error");
        await api("/api/students", {
          method: "POST",
          body: { name, phone, grade },
        });
        document.getElementById("student-name").value = "";
        document.getElementById("student-phone").value = "";
        setStatus("Student added", "success");
        await loadStudents();
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

  document
    .getElementById("students-table")
    ?.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const id = Number(btn.dataset.id);
      const action = btn.dataset.action;
      if (!id || !action) return;
      try {
        if (action === "delete") {
          if (!confirm("Delete this student?")) return;
          await api(`/api/students/${id}`, { method: "DELETE" });
          setStatus("Student deleted", "success");
          await loadStudents();
        } else if (action === "qr") {
          const res = await api(`/api/students/${id}/qr`, { method: "POST" });
          setStatus("QR regenerated", "success");
          const student = state.students.find((s) => s.id === id);
          if (student) student.qr_token = res.qr_token;
          renderStudents();
        } else if (action === "edit") {
          const student = state.students.find((s) => s.id === id);
          if (!student) return;
          const name = prompt("Student name", student.name);
          if (!name) return;
          const phone = prompt("Phone", student.phone);
          if (!phone) return;
          const grade = prompt(
            "Grade (Grade 6/7/8/O/L)",
            student.grade
          );
          if (!grade) return;
          await api(`/api/students/${id}`, {
            method: "PUT",
            body: { name, phone, grade },
          });
          setStatus("Student updated", "success");
          await loadStudents();
        } else if (action === "reset") {
          await api(`/api/students/${id}/reset-password`, { method: "POST" });
          setStatus("Password reset to default", "success");
        }
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

  function populateStudentSelects() {
    const options = state.students
      .map((s) => `<option value="${s.id}">${s.name}</option>`)
      .join("");
    ["enroll-student", "payment-student"].forEach((id) => {
      const select = document.getElementById(id);
      if (select) select.innerHTML = options;
    });
  }

  // ---------- CLASSES ----------
  async function loadClasses() {
    state.classes = await api("/api/classes");
    renderClasses();
    populateClassSelects();
  }

  function renderClasses() {
    const tbody = document.querySelector("#classes-table tbody");
    if (!tbody) return;
    tbody.innerHTML = state.classes
      .map(
        (c) => `
      <tr>
        <td>${c.name}</td>
        <td>Rs. ${c.monthly_fee}</td>
        <td>
          <button data-class="${c.id}" data-act="edit">Edit</button>
          <button data-class="${c.id}" data-act="delete" style="background:#9f1239;">Delete</button>
        </td>
      </tr>`
      )
      .join("");
  }

  document
    .getElementById("btn-create-class")
    ?.addEventListener("click", async () => {
      try {
        const name = document.getElementById("class-name").value.trim();
        const fee = Number(document.getElementById("class-fee").value || 0);
        if (!name) return setStatus("Class name required", "error");
        await api("/api/classes", { method: "POST", body: { name, monthly_fee: fee } });
        setStatus("Class added", "success");
        document.getElementById("class-name").value = "";
        document.getElementById("class-fee").value = 2000;
        await loadClasses();
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

  document
    .getElementById("classes-table")
    ?.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const id = Number(btn.dataset.class);
      const act = btn.dataset.act;
      if (!id) return;
      try {
        if (act === "delete") {
          if (!confirm("Delete this class?")) return;
          await api(`/api/classes/${id}`, { method: "DELETE" });
          setStatus("Class deleted", "success");
          await loadClasses();
        } else if (act === "edit") {
          const cls = state.classes.find((c) => c.id === id);
          const name = prompt("Class name", cls?.name || "");
          if (!name) return;
          const fee = prompt("Monthly fee", cls?.monthly_fee || 0);
          await api(`/api/classes/${id}`, {
            method: "PUT",
            body: { name, monthly_fee: Number(fee) },
          });
          setStatus("Class updated", "success");
          await loadClasses();
        }
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

  function populateClassSelects() {
    const options = state.classes
      .map((c) => `<option value="${c.id}">${c.name}</option>`)
      .join("");
    [
      "enroll-class",
      "enroll-view-class",
      "payment-class",
      "attendance-class",
    ].forEach((id) => {
      const select = document.getElementById(id);
      if (select) select.innerHTML = options;
    });
  }

  // ---------- ENROLLMENTS ----------
  document
    .getElementById("btn-enroll")
    ?.addEventListener("click", async () => {
      try {
        const student_id = Number(document.getElementById("enroll-student").value);
        const class_id = Number(document.getElementById("enroll-class").value);
        if (!student_id || !class_id) return setStatus("Select student & class", "error");
        await api("/api/enrollments", { method: "POST", body: { student_id, class_id } });
        setStatus("Enrollment saved", "success");
        loadEnrollmentView();
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

  async function loadEnrollmentView() {
    const classId = document.getElementById("enroll-view-class")?.value;
    if (!classId) return;
    try {
      const rows = await api(`/api/classes/${classId}/students`);
      const tbody = document.querySelector("#enrolled-table tbody");
      if (!tbody) return;
      tbody.innerHTML = rows
        .map((s) => `<tr><td>${s.name}</td><td>${s.phone}</td><td>${s.grade}</td></tr>`)
        .join("");
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  document
    .getElementById("enroll-view-class")
    ?.addEventListener("change", loadEnrollmentView);

  // ---------- QR + manual attendance ----------
  function initQrScanner() {
    const target = document.getElementById("qr-reader");
    if (!target || !window.Html5Qrcode) return;
    const html5QrCode = new Html5Qrcode("qr-reader");
    const config = { fps: 10, qrbox: 250 };
    html5QrCode
      .start({ facingMode: "environment" }, config, async (token) => {
        try {
          const res = await api("/api/scan", { method: "POST", body: { token } });
          document.getElementById("scan-result").innerHTML = `
            <strong>${res.studentName}</strong><br/>
            ${res.className}<br/>
            Paid this month: ${res.paidThisMonth ? "✅" : "❌"}`;
          playBeep();
        } catch (err) {
          document.getElementById("scan-result").textContent = err.message;
        }
      })
      .catch((err) => console.warn(err));
  }

  function playBeep() {
    if (!window.AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 120);
  }

  document
    .getElementById("btn-manual-attendance")
    ?.addEventListener("click", async () => {
      try {
        const phone = document.getElementById("manual-phone").value.trim();
        const date = document.getElementById("manual-date").value;
        if (!phone) return setStatus("Phone required", "error");
        await api("/api/attendance/mark", {
          method: "POST",
          body: { phone, date },
        });
        setStatus("Attendance marked", "success");
        document.getElementById("manual-phone").value = "";
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

  // ---------- Attendance tab ----------
  document
    .getElementById("btn-load-attendance")
    ?.addEventListener("click", loadAttendance);

  async function loadAttendance() {
    try {
      const class_id = document.getElementById("attendance-class").value;
      const date = document.getElementById("attendance-date").value;
      if (!class_id) return setStatus("Select class", "error");
      const data = await api(`/api/attendance?class_id=${class_id}&date=${date}`);
      const tbody = document.querySelector("#attendance-table tbody");
      tbody.innerHTML = data.students
        .map(
          (s) => `
        <tr>
          <td>${s.name}</td>
          <td>${s.grade}</td>
          <td><input type="checkbox" data-student="${s.id}" ${s.present ? "checked" : ""}></td>
        </tr>`
        )
        .join("");
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  document
    .getElementById("attendance-table")
    ?.addEventListener("change", async (ev) => {
      if (ev.target.matches("input[type='checkbox']")) {
        try {
          const student_id = Number(ev.target.dataset.student);
          const class_id = document.getElementById("attendance-class").value;
          const date = document.getElementById("attendance-date").value;
          await api("/api/attendance/toggle", {
            method: "POST",
            body: { student_id, class_id, date, present: ev.target.checked },
          });
        } catch (err) {
          setStatus(err.message, "error");
        }
      }
    });

  // ---------- Payments ----------
  document
    .getElementById("btn-save-payment")
    ?.addEventListener("click", async () => {
      try {
        const student_id = Number(document.getElementById("payment-student").value);
        const class_id = Number(document.getElementById("payment-class").value);
        const month = document.getElementById("payment-month").value;
        const amount = Number(document.getElementById("payment-amount").value || 0);
        const method = document.getElementById("payment-method").value;
        await api("/api/payments", {
          method: "POST",
          body: { student_id, class_id, month, amount, method },
        });
        setStatus("Payment recorded", "success");
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

  // ---------- Unpaid ----------
  document
    .getElementById("btn-load-unpaid")
    ?.addEventListener("click", async () => {
      try {
        const month = document.getElementById("unpaid-month").value;
        const data = await api(`/api/unpaid?month=${month}`);
        const tbody = document.querySelector("#unpaid-table tbody");
        tbody.innerHTML = data.rows
          .map((r) => `<tr><td>${r.class_name}</td><td>${r.student_name}</td><td>${r.phone}</td></tr>`)
          .join("");
        setStatus(`Unpaid list for ${data.month}`, "success");
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

  // ---------- Finance ----------
  document
    .getElementById("btn-load-finance")
    ?.addEventListener("click", async () => {
      try {
        const month = document.getElementById("finance-month").value;
        const data = await api(`/api/finance?month=${month}`);
        const tbody = document.querySelector("#finance-table tbody");
        tbody.innerHTML = data.rows
          .map((r) => `<tr><td>${r.name}</td><td>${r.payments}</td><td>${r.total}</td></tr>`)
          .join("");
        document.getElementById("finance-total").textContent = data.overall;
        setStatus(`Finance summary for ${data.month}`, "success");
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

  // ---------- Dashboard ----------
  async function loadDashboard() {
    try {
      const summary = await api("/api/dashboard/summary");
      const container = document.getElementById("dashboard-cards");
      if (!container) return;
      container.innerHTML = `
        <div class="section-card"><p class="muted">Students</p><h3>${summary.students}</h3></div>
        <div class="section-card"><p class="muted">Revenue (this month)</p><h3>Rs. ${summary.revenueThisMonth}</h3></div>
        <div class="section-card"><p class="muted">Attendance today</p><h3>${summary.attendanceToday}</h3></div>`;
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  // ---------- Exam admin ----------
  async function loadSlots() {
    const previous = state.selectedSlot;
    state.slots = await api("/api/exam/slots");
    renderSlotCards();
    populateSlotSelect();
    if (state.slots.length) {
      const exists = state.slots.find((s) => s.id === previous);
      state.selectedSlot = exists ? exists.id : state.slots[0].id;
      const select = document.getElementById("exam-admin-slot");
      if (select) select.value = state.selectedSlot;
      loadSeatLayoutAdmin();
    }
  }

  function renderSlotCards() {
    const container = document.getElementById("exam-slots");
    if (!container) return;
    container.innerHTML = state.slots
      .map((slot) => {
        const bookings = Number(slot.booked_count || 0);
        return `<div class="section-card">
          <h3>${slot.label}</h3>
          <p class="muted">${slot.max_seats} benches (${slot.max_seats * 4} seats)</p>
          <p><strong>${bookings}</strong> seats booked</p>
        </div>`;
      })
      .join("");
  }

  function populateSlotSelect() {
    const select = document.getElementById("exam-admin-slot");
    if (!select) return;
    select.innerHTML = state.slots
      .map((slot) => `<option value="${slot.id}">${slot.label}</option>`)
      .join("");
  }

  document
    .getElementById("exam-admin-slot")
    ?.addEventListener("change", (ev) => {
      state.selectedSlot = Number(ev.target.value);
      loadSeatLayoutAdmin();
    });

  async function loadSeatLayoutAdmin() {
    if (!state.selectedSlot) return;
    try {
      const layout = await api(`/api/exam/slots/${state.selectedSlot}/layout`);
      const slot = state.slots.find((s) => s.id === state.selectedSlot);
      if (slot) slot.booked_count = layout.bookings.length;
      renderSlotCards();
      renderSeatLayout(layout, document.getElementById("exam-admin-layout"), true);
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  async function removeBooking(id) {
    if (!confirm("Clear this seat?")) return;
    await api(`/api/exam/admin/bookings/${id}`, { method: "DELETE" });
    setStatus("Seat cleared", "success");
    await loadSlots();
    await loadSeatLayoutAdmin();
  }

  function renderSeatLayout(data, container, admin = false) {
    if (!container) return;
    const maxSeats = data.seat_count;
    const map = {};
    (data.bookings || []).forEach((b) => {
      map[`${b.seat_index}-${b.seat_pos}`] = b;
    });
    let html = "";
    for (let i = 1; i <= maxSeats; i++) {
      html += `<div class="bench-row" style="display:flex;align-items:center;margin-bottom:0.4rem;">
        <div style="width:70px;color:#94a3b8;">Seat ${i}</div>
        <div class="bench" style="display:flex;flex:1;background:#78350f;border-radius:8px;overflow:hidden;">
      `;
      for (let p = 1; p <= 4; p++) {
        const key = `${i}-${p}`;
        const booking = map[key];
        const booked = Boolean(booking);
        const color = booking
          ? booking.student_class === "Grade 7"
            ? "#1d4ed8"
            : "#16a34a"
          : "transparent";
        html += `<div class="bench-segment" data-seat="${i}" data-pos="${p}" ${booking ? `data-booking="${booking.id}"` : ""}
          style="flex:1;padding:0.4rem;text-align:center;border-right:1px solid rgba(15,23,42,0.6);background:${color};cursor:${booked && admin ? "pointer" : "default"};">
          ${booking ? booking.student_name : "Empty"}
        </div>`;
      }
      html += `</div></div>`;
    }
    container.innerHTML = html;
    if (admin) {
      container.querySelectorAll(".bench-segment[data-booking]").forEach((el) => {
        el.addEventListener("click", () => removeBooking(el.dataset.booking));
      });
    }
  }

  // ---------- INIT ----------
  (async function init() {
    try {
      await Promise.all([loadStudents(), loadClasses(), loadDashboard(), loadSlots()]);
      loadEnrollmentView();
      if (currentTab === "scanner") {
        initQrScanner();
      }
      setStatus("Admin console ready", "success");
    } catch (err) {
      console.error(err);
      setStatus(err.message, "error");
    }
  })();
})();
