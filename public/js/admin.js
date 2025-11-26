document.addEventListener("DOMContentLoaded", () => {
  const state = {
    students: [],
    classes: [],
    examSlots: [],
    scanner: null,
    currentSlotAdmin: null,
    beep: createBeepSound(),
    lastScanText: "",
    lastScanAt: 0,
  };

  const els = {
    tabs: document.querySelectorAll("#admin-tabs .chip"),
    sections: document.querySelectorAll('[data-section]'),
    dashboardStats: document.getElementById("dashboard-stats"),
    studentForm: document.getElementById("student-form"),
    studentId: document.getElementById("student-id"),
    studentName: document.getElementById("student-name"),
    studentPhone: document.getElementById("student-phone"),
    studentGrade: document.getElementById("student-grade"),
    studentCancel: document.getElementById("student-cancel"),
    studentsTable: document.getElementById("students-table"),
    classForm: document.getElementById("class-form"),
    className: document.getElementById("class-name"),
    classFee: document.getElementById("class-fee"),
    classesTable: document.getElementById("classes-table"),
    enrollForm: document.getElementById("enroll-form"),
    enrollStudent: document.getElementById("enroll-student"),
    enrollClass: document.getElementById("enroll-class"),
    enrollViewClass: document.getElementById("enroll-view-class"),
    enrollmentsTable: document.getElementById("enrollments-table"),
    qrResult: document.getElementById("scan-result"),
    restartScanner: document.getElementById("restart-scanner"),
    attendanceForm: document.getElementById("attendance-filter"),
    attendanceClass: document.getElementById("attendance-class"),
    attendanceDate: document.getElementById("attendance-date"),
    attendanceTable: document.getElementById("attendance-table"),
    paymentForm: document.getElementById("payment-form"),
    paymentStudent: document.getElementById("payment-student"),
    paymentClass: document.getElementById("payment-class"),
    paymentMonth: document.getElementById("payment-month"),
    paymentAmount: document.getElementById("payment-amount"),
    paymentMethod: document.getElementById("payment-method"),
    unpaidForm: document.getElementById("unpaid-form"),
    unpaidMonth: document.getElementById("unpaid-month"),
    unpaidTable: document.getElementById("unpaid-table"),
    financeForm: document.getElementById("finance-form"),
    financeMonth: document.getElementById("finance-month"),
    financeTable: document.getElementById("finance-table"),
    financeTotal: document.getElementById("finance-total"),
    examSlotAdmin: document.getElementById("exam-slot-admin"),
    examLayoutAdmin: document.getElementById("exam-layout-admin"),
    refreshDashboard: document.getElementById("refresh-dashboard"),
    refreshStudents: document.getElementById("refresh-students"),
    logoutButtons: [
      document.getElementById("logout-btn"),
      document.getElementById("settings-logout"),
    ].filter(Boolean),
  };

  // Utility helpers
  function setActiveTab(target) {
    els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.target === target));
    els.sections.forEach((section) => {
      section.classList.toggle("show", section.dataset.section === target);
    });
  }

  function createBeepSound() {
    const audio = new Audio(
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQwAAAABAAgA//8AAP//AAD//wAA//8AAP//AAAAAA=="
    );
    audio.volume = 0.3;
    return audio;
  }

  async function fetchJSON(url, options = {}) {
    const opts = { ...options };
    opts.headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (opts.body && typeof opts.body !== "string") {
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    return res.json();
  }

  function optionList(items, valueKey = "id", labelKey = "name") {
    return items
      .map((item) => `<option value="${item[valueKey]}">${item[labelKey]}</option>`)
      .join("");
  }

  function renderStudents() {
    els.studentsTable.innerHTML = state.students
      .map((s) => {
        return `<tr>
          <td>${s.name}</td>
          <td>${s.phone}</td>
          <td>${s.grade}</td>
          <td><a href="/api/students/${s.id}/qr" target="_blank" class="btn-minor">QR Code</a></td>
          <td class="table-actions">
            <button class="btn-minor" data-action="edit" data-id="${s.id}">Edit</button>
            <button class="btn-ghost" data-action="delete" data-id="${s.id}">Delete</button>
          </td>
        </tr>`;
      })
      .join("");

    const options = optionList(state.students);
    els.enrollStudent.innerHTML = options;
    els.paymentStudent.innerHTML = options;
  }

  function renderClasses() {
    els.classesTable.innerHTML = state.classes
      .map((c) => {
        return `<tr>
          <td>${c.name}</td>
          <td>
            <input type="number" value="${c.monthly_fee}" data-id="${c.id}" class="class-fee-input" />
          </td>
          <td>
            <button class="btn-minor" data-action="save-fee" data-id="${c.id}">Update</button>
          </td>
        </tr>`;
      })
      .join("");

    const classOptions = optionList(state.classes);
    els.enrollClass.innerHTML = classOptions;
    els.enrollViewClass.innerHTML = classOptions;
    els.paymentClass.innerHTML = classOptions;
    els.attendanceClass.innerHTML = `<option value="">Select class</option>` + classOptions;
  }

  function renderStats(data) {
    els.dashboardStats.innerHTML = `
      <div class="stat-card"><h3>Students</h3><p>${data.studentCount}</p></div>
      <div class="stat-card"><h3>Classes</h3><p>${data.classCount}</p></div>
      <div class="stat-card"><h3>Attendance Today</h3><p>${data.attendanceToday}</p></div>
      <div class="stat-card"><h3>Unpaid (${data.month})</h3><p>${data.unpaidCount}</p></div>
      <div class="stat-card"><h3>Revenue (${data.month})</h3><p>Rs ${data.revenue}</p></div>`;
  }

  function renderSeatLayout(container, data) {
    if (!data) {
      container.innerHTML = "<p class=hint>No slot selected.</p>";
      return;
    }
    const map = new Map();
    (data.bookings || []).forEach((b) => {
      map.set(`${b.seat_index}-${b.seat_pos}`, b);
    });
    let html = "";
    for (let seat = 1; seat <= data.seat_count; seat += 1) {
      html += `<div class="seat-row"><div class="seat-label">Bench ${seat}</div><div class="bench">`;
      for (let pos = 1; pos <= data.max_per_seat; pos += 1) {
        const key = `${seat}-${pos}`;
        const booking = map.get(key);
        const gradeClass = booking ? `reserved ${booking.student_class === "Grade 7" ? "grade7" : "grade8"}` : "";
        html += `<div class="${gradeClass}">${booking ? booking.student_name : `Seat ${pos}`}</div>`;
      }
      html += "</div></div>";
    }
    container.innerHTML = html;
  }

  async function loadDashboard() {
    const data = await fetchJSON("/api/dashboard");
    renderStats(data);
  }

  async function loadStudents() {
    state.students = await fetchJSON("/api/students");
    renderStudents();
  }

  async function loadClasses() {
    state.classes = await fetchJSON("/api/classes");
    renderClasses();
    if (state.classes.length && !els.enrollViewClass.value) {
      els.enrollViewClass.value = state.classes[0].id;
      await loadEnrollmentsTable();
    }
  }

  async function loadEnrollmentsTable() {
    const classId = Number(els.enrollViewClass.value);
    if (!classId) {
      els.enrollmentsTable.innerHTML = "";
      return;
    }
    const data = await fetchJSON(`/api/classes/${classId}/students`);
    els.enrollmentsTable.innerHTML = data
      .map((student) => `<tr><td>${student.name}</td><td>${student.phone}</td><td>${student.grade}</td></tr>`)
      .join("");
  }

  async function loadAttendance() {
    const classId = Number(els.attendanceClass.value);
    const date = els.attendanceDate.value;
    if (!classId || !date) return;
    const data = await fetchJSON(`/api/attendance?class_id=${classId}&date=${date}`);
    els.attendanceTable.innerHTML = data.students
      .map((student) => {
        const presentClass = student.present ? "success" : "danger";
        const presentLabel = student.present ? "Present" : "Absent";
        return `<tr>
          <td>${student.name}</td>
          <td>${student.grade}</td>
          <td>
            <button class="btn-minor" data-action="toggle-attendance" data-id="${student.id}" data-present="${student.present}" data-class="${classId}">
              <span class="badge ${presentClass}">${presentLabel}</span>
            </button>
          </td>
        </tr>`;
      })
      .join("");
  }

  async function loadUnpaid() {
    const month = els.unpaidMonth.value;
    if (!month) return;
    const data = await fetchJSON(`/api/unpaid?month=${month}`);
    els.unpaidTable.innerHTML = data.rows
      .map((row) => `<tr><td>${row.class_name}</td><td>${row.student_name}</td><td>${row.phone || "-"}</td></tr>`)
      .join("");
  }

  async function loadFinance() {
    const month = els.financeMonth.value;
    if (!month) return;
    const data = await fetchJSON(`/api/finance?month=${month}`);
    els.financeTable.innerHTML = data.rows
      .map((row) => `<tr><td>${row.class_name}</td><td>${row.payments_count}</td><td>${row.total_amount}</td></tr>`)
      .join("");
    els.financeTotal.textContent = data.total;
  }

  async function loadExamSlotsAdmin() {
    const slots = await fetchJSON("/api/exam/slots");
    state.examSlots = slots;
    els.examSlotAdmin.innerHTML = optionList(slots);
    if (slots.length) {
      state.currentSlotAdmin = slots[0].id;
      els.examSlotAdmin.value = state.currentSlotAdmin;
      await loadExamLayout();
    }
  }

  async function loadExamLayout() {
    const slotId = Number(els.examSlotAdmin.value);
    if (!slotId) return;
    const layout = await fetchJSON(`/api/exam/slots/${slotId}/layout`);
    renderSeatLayout(els.examLayoutAdmin, layout);
  }

  async function startScanner() {
    if (!window.Html5Qrcode) {
      els.qrResult.textContent = "QR library not loaded.";
      return;
    }
    try {
      if (state.scanner) {
        await state.scanner.stop();
      }
      state.scanner = new Html5Qrcode("qr-reader");
      await state.scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        handleScan,
        () => {}
      );
    } catch (err) {
      els.qrResult.textContent = `Camera error: ${err.message}`;
    }
  }

  async function handleScan(decodedText) {
    if (!decodedText) return;
    const now = Date.now();
    if (state.lastScanText === decodedText && now - state.lastScanAt < 2000) {
      return;
    }
    state.lastScanText = decodedText;
    state.lastScanAt = now;
    try {
      const payload = await fetchJSON("/api/scan", {
        method: "POST",
        body: { token: decodedText },
      });
      const paymentBadge = payload.paymentStatus === "paid"
        ? '<span class="badge success">Paid</span>'
        : '<span class="badge danger">Unpaid</span>';
      els.qrResult.innerHTML = `
        <strong>${payload.student.name} (${payload.student.grade})</strong>
        <p>Class: ${payload.class.name}</p>
        <p>Attendance: ${payload.attendanceMarked ? "Marked" : "Already counted"}</p>
        <p>Payment: ${paymentBadge}</p>`;
      if (state.beep) {
        state.beep.currentTime = 0;
        state.beep.play().catch(() => {});
      }
    } catch (err) {
      els.qrResult.innerHTML = `<p class="badge danger">${err.message}</p>`;
    }
  }

  async function logout() {
    await fetch("/logout", { method: "POST" });
    window.location.href = "/";
  }

  // Event wiring
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setActiveTab(tab.dataset.target);
      if (tab.dataset.target === "scanner" && !state.scanner) {
        startScanner();
      }
    });
  });

  els.refreshDashboard?.addEventListener("click", loadDashboard);
  els.refreshStudents?.addEventListener("click", loadStudents);

  els.studentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: els.studentName.value.trim(),
      phone: els.studentPhone.value.trim(),
      grade: els.studentGrade.value,
    };
    try {
      if (!payload.name || !payload.phone || !payload.grade) {
        throw new Error("All fields are required");
      }
      if (els.studentId.value) {
        await fetchJSON(`/api/students/${els.studentId.value}`, {
          method: "PUT",
          body: payload,
        });
      } else {
        await fetchJSON("/api/students", { method: "POST", body: payload });
      }
      await loadStudents();
      els.studentForm.reset();
      els.studentId.value = "";
    } catch (err) {
      alert(err.message);
    }
  });

  els.studentCancel.addEventListener("click", () => {
    els.studentForm.reset();
    els.studentId.value = "";
  });

  els.studentsTable.addEventListener("click", async (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "edit") {
      const student = state.students.find((s) => String(s.id) === id);
      if (!student) return;
      els.studentId.value = student.id;
      els.studentName.value = student.name;
      els.studentPhone.value = student.phone;
      els.studentGrade.value = student.grade;
      setActiveTab("students");
    }
    if (btn.dataset.action === "delete") {
      if (!confirm("Delete this student?")) return;
      await fetchJSON(`/api/students/${id}`, { method: "DELETE" });
      loadStudents();
    }
  });

  els.classForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await fetchJSON("/api/classes", {
        method: "POST",
        body: { name: els.className.value.trim(), monthly_fee: Number(els.classFee.value) },
      });
      els.classForm.reset();
      await loadClasses();
    } catch (err) {
      alert(err.message);
    }
  });

  els.classesTable.addEventListener("click", async (event) => {
    const btn = event.target.closest("button");
    if (!btn || btn.dataset.action !== "save-fee") return;
    const id = btn.dataset.id;
    const input = btn.closest("tr").querySelector(".class-fee-input");
    const fee = Number(input.value);
    try {
      await fetchJSON(`/api/classes/${id}`, { method: "PUT", body: { monthly_fee: fee } });
      await loadClasses();
    } catch (err) {
      alert(err.message);
    }
  });

  els.enrollForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await fetchJSON("/api/enrollments", {
        method: "POST",
        body: {
          student_id: Number(els.enrollStudent.value),
          class_id: Number(els.enrollClass.value),
        },
      });
      await loadEnrollmentsTable();
    } catch (err) {
      alert(err.message);
    }
  });

  els.enrollViewClass.addEventListener("change", loadEnrollmentsTable);

  els.attendanceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await loadAttendance();
  });

  els.attendanceTable.addEventListener("click", async (event) => {
    const btn = event.target.closest("button");
    if (!btn || btn.dataset.action !== "toggle-attendance") return;
    const payload = {
      student_id: Number(btn.dataset.id),
      class_id: Number(btn.dataset.class),
      date: els.attendanceDate.value,
      present: btn.dataset.present !== "true",
    };
    await fetchJSON("/api/attendance/manual", { method: "POST", body: payload });
    await loadAttendance();
  });

  els.paymentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await fetchJSON("/api/payments", {
        method: "POST",
        body: {
          student_id: Number(els.paymentStudent.value),
          class_id: Number(els.paymentClass.value),
          month: els.paymentMonth.value,
          amount: Number(els.paymentAmount.value),
          method: els.paymentMethod.value,
        },
      });
      alert("Payment recorded");
    } catch (err) {
      alert(err.message);
    }
  });

  els.unpaidForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await loadUnpaid();
  });

  els.financeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await loadFinance();
  });

  els.examSlotAdmin.addEventListener("change", loadExamLayout);
  els.restartScanner.addEventListener("click", startScanner);
  els.logoutButtons.forEach((btn) => btn.addEventListener("click", logout));

  // Defaults
  const today = new Date();
  const monthValue = today.toISOString().slice(0, 7);
  if (els.paymentMonth) els.paymentMonth.value = monthValue;
  if (els.unpaidMonth) els.unpaidMonth.value = monthValue;
  if (els.financeMonth) els.financeMonth.value = monthValue;
  if (els.attendanceDate) els.attendanceDate.value = today.toISOString().slice(0, 10);

  // Initial load
  (async () => {
    try {
      await Promise.all([loadDashboard(), loadStudents(), loadClasses(), loadExamSlotsAdmin()]);
    } catch (err) {
      console.error(err);
    }
  })();
});
