(function () {
  const grades = ["Grade 6", "Grade 7", "Grade 8", "O/L"];
  const state = {
    students: [],
    classes: [],
    scanner: null,
    scannerActive: false,
    lastScanToken: null,
    lastScanAt: 0,
  };

  const statusEl = document.getElementById("admin-status");
  const tabs = document.querySelectorAll("#admin-tabs button");
  const sections = document.querySelectorAll(".tab-section");
  const studentForm = document.getElementById("student-form");
  const studentCancelBtn = document.getElementById("student-cancel-edit");
  const studentsTable = document.querySelector("#students-table tbody");
  const classForm = document.getElementById("class-form");
  const classFeeForm = document.getElementById("class-fee-form");
  const enrollmentForm = document.getElementById("enrollment-form");
  const classViewSelect = document.getElementById("class-view-select");
  const enrollmentTable = document.querySelector("#enrollment-table tbody");
  const qrPreview = document.getElementById("qr-preview");
  const attendanceClassSelect = document.getElementById("attendance-class");
  const attendanceDate = document.getElementById("attendance-date");
  const attendanceTable = document.querySelector("#attendance-table tbody");
  const attendanceRefresh = document.getElementById("attendance-refresh");
  const paymentForm = document.getElementById("payment-form");
  const unpaidMonthInput = document.getElementById("unpaid-month");
  const unpaidBtn = document.getElementById("unpaid-load");
  const unpaidTable = document.querySelector("#unpaid-table tbody");
  const financeMonthInput = document.getElementById("finance-month");
  const financeBtn = document.getElementById("finance-load");
  const financeTable = document.querySelector("#finance-table tbody");
  const financeTotal = document.getElementById("finance-total");
  const dashboardCards = document.getElementById("dashboard-cards");
  const examSlotSelect = document.getElementById("exam-admin-slot");
  const examRefresh = document.getElementById("exam-admin-refresh");
  const examInfo = document.getElementById("exam-admin-info");
  const examLayout = document.getElementById("exam-admin-layout");
  const logoutBtn = document.getElementById("logout-btn");
  const scanResult = document.getElementById("scan-result");

  function setStatus(message, isError) {
    statusEl.textContent = message || "";
    statusEl.style.color = isError ? "#f87171" : "var(--muted)";
  }

  function switchTab(tabId) {
    tabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tabId));
    sections.forEach((section) => section.classList.toggle("active", section.id === `tab-${tabId}`));
    if (tabId === "scanner") {
      startScanner();
    } else {
      stopScanner();
    }
    if (tabId === "dashboard") loadDashboard();
    if (tabId === "exam-admin") loadExamAdmin();
  }

  tabs.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  function populateGradeSelect() {
    const select = studentForm.querySelector("select[name=grade]");
    select.innerHTML = grades.map((grade) => `<option value="${grade}">${grade}</option>`).join("");
  }

  function populateClassSelects() {
    const classSelects = [
      classFeeForm.querySelector("select[name=class_id]"),
      enrollmentForm.querySelector("select[name=class_id]"),
      classViewSelect,
      attendanceClassSelect,
      paymentForm.querySelector("select[name=class_id]"),
    ];
    const options = state.classes
      .map((cls) => `<option value="${cls.id}">${cls.name}</option>`)
      .join("");
    classSelects.forEach((select) => {
      if (select) select.innerHTML = options;
    });
  }

  function populateStudentSelects() {
    const selects = [
      enrollmentForm.querySelector("select[name=student_id]"),
      paymentForm.querySelector("select[name=student_id]"),
    ];
    const options = state.students
      .map((s) => `<option value="${s.id}">${s.name}</option>`)
      .join("");
    selects.forEach((select) => {
      if (select) select.innerHTML = options;
    });
  }

  async function refreshStudents() {
    state.students = await apiFetch("/api/students");
    renderStudents();
    populateStudentSelects();
  }

  function renderStudents() {
    if (!state.students.length) {
      studentsTable.innerHTML = `<tr><td colspan="6">No students yet</td></tr>`;
      return;
    }
    studentsTable.innerHTML = state.students
      .map(
        (s) => `
        <tr>
          <td>${s.id}</td>
          <td>${s.name}</td>
          <td>${s.phone}</td>
          <td>${s.grade}</td>
          <td><code>${s.qr_token.slice(0, 8)}…</code></td>
          <td>
            <button data-action="qr" data-id="${s.id}" class="secondary" style="margin-right:0.3rem;">QR</button>
            <button data-action="edit" data-id="${s.id}" class="secondary" style="margin-right:0.3rem;">Edit</button>
            <button data-action="delete" data-id="${s.id}" class="secondary">Delete</button>
          </td>
        </tr>`
      )
      .join("");
  }

  async function refreshClasses() {
    state.classes = await apiFetch("/api/classes");
    populateClassSelects();
    renderClassesTable();
  }

  function renderClassesTable() {
    const tbody = document.querySelector("#classes-table tbody");
    tbody.innerHTML = state.classes
      .map((c) => `<tr><td>${c.id}</td><td>${c.name}</td><td>${c.monthly_fee}</td></tr>`)
      .join("");
  }

  function setDefaultInputs() {
    const month = formatMonth();
    [paymentForm.querySelector("input[name=month]"), unpaidMonthInput, financeMonthInput].forEach((input) => {
      if (input) input.value = month;
    });
    if (attendanceDate) attendanceDate.value = todayISO();
  }

  studentForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const formData = new FormData(studentForm);
    const payload = Object.fromEntries(formData.entries());
    const editId = studentForm.dataset.editId;
    try {
      if (editId) {
        await apiFetch(`/api/students/${editId}`, { method: "PUT", body: payload });
        setStatus("Student updated");
      } else {
        const res = await apiFetch("/api/students", { method: "POST", body: payload });
        setStatus(`Student created. Default password: ${res.default_password}`);
      }
      studentForm.reset();
      delete studentForm.dataset.editId;
      studentForm.querySelector("button[type=submit]").textContent = "Create Student Account";
      studentCancelBtn.style.display = "none";
      await refreshStudents();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  studentCancelBtn.addEventListener("click", () => {
    studentForm.reset();
    delete studentForm.dataset.editId;
    studentForm.querySelector("button[type=submit]").textContent = "Create Student Account";
    studentCancelBtn.style.display = "none";
  });

  studentsTable.addEventListener("click", async (ev) => {
    const action = ev.target.dataset.action;
    if (!action) return;
    const id = Number(ev.target.dataset.id);
    const student = state.students.find((s) => s.id === id);
    if (!student) return;

    if (action === "qr") {
      try {
        const data = await apiFetch(`/api/students/${id}/qr`);
        qrPreview.innerHTML = `
          <p><strong>${student.name}</strong> (${student.grade})</p>
          <img src="${data.data_url}" alt="QR" style="max-width:220px;display:block;margin:0.75rem auto;" />
          <p style="word-break:break-all;">Token: ${data.token}</p>`;
      } catch (err) {
        setStatus(err.message, true);
      }
    }

    if (action === "edit") {
      studentForm.dataset.editId = id;
      studentForm.querySelector("input[name=name]").value = student.name;
      studentForm.querySelector("input[name=phone]").value = student.phone;
      studentForm.querySelector("select[name=grade]").value = student.grade;
      studentForm.querySelector("button[type=submit]").textContent = "Update Student";
      studentCancelBtn.style.display = "inline-flex";
      studentForm.scrollIntoView({ behavior: "smooth" });
    }

    if (action === "delete") {
      if (!confirm(`Delete ${student.name}?`)) return;
      try {
        await apiFetch(`/api/students/${id}`, { method: "DELETE" });
        setStatus("Student removed");
        await refreshStudents();
      } catch (err) {
        setStatus(err.message, true);
      }
    }
  });

  classForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const payload = Object.fromEntries(new FormData(classForm).entries());
    try {
      await apiFetch("/api/classes", { method: "POST", body: payload });
      setStatus("Class added");
      classForm.reset();
      await refreshClasses();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  classFeeForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const payload = Object.fromEntries(new FormData(classFeeForm).entries());
    try {
      await apiFetch(`/api/classes/${payload.class_id}`, { method: "PUT", body: { monthly_fee: payload.monthly_fee } });
      setStatus("Class fee updated");
      await refreshClasses();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  enrollmentForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const payload = Object.fromEntries(new FormData(enrollmentForm).entries());
    try {
      await apiFetch("/api/enrollments", { method: "POST", body: payload });
      setStatus("Student enrolled");
      if (classViewSelect.value) loadEnrollmentList(classViewSelect.value);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  classViewSelect.addEventListener("change", () => {
    if (classViewSelect.value) loadEnrollmentList(classViewSelect.value);
  });

  async function loadEnrollmentList(classId) {
    try {
      const rows = await apiFetch(`/api/classes/${classId}/students`);
      enrollmentTable.innerHTML = rows
        .map((s) => `<tr><td>${s.name}</td><td>${s.phone}</td><td>${s.grade}</td></tr>`)
        .join("");
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  attendanceRefresh.addEventListener("click", () => {
    if (attendanceClassSelect.value) loadAttendance();
  });

  attendanceClassSelect.addEventListener("change", () => {
    if (attendanceClassSelect.value) loadAttendance();
  });

  async function loadAttendance() {
    try {
      const params = new URLSearchParams({
        class_id: attendanceClassSelect.value,
        date: attendanceDate.value || todayISO(),
      });
      const data = await apiFetch(`/api/attendance?${params.toString()}`);
      attendanceTable.innerHTML = data.students
        .map(
          (row) => `
          <tr>
            <td>${row.name}</td>
            <td>${row.grade}</td>
            <td>
              <button class="secondary attendance-toggle" data-id="${row.id}" data-present="${row.present ? 1 : 0}" data-class-id="${data.class_id}">
                ${row.present ? "Mark absent" : "Mark present"}
              </button>
            </td>
          </tr>`
        )
        .join("");
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  attendanceTable.addEventListener("click", async (ev) => {
    if (!ev.target.classList.contains("attendance-toggle")) return;
    const { id, present, classId } = ev.target.dataset;
    const next = present === "1" ? 0 : 1;
    try {
      await apiFetch("/api/attendance/manual", {
        method: "POST",
        body: {
          student_id: id,
          class_id: classId,
          date: attendanceDate.value || todayISO(),
          present: next,
        },
      });
      setStatus("Attendance updated");
      loadAttendance();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  paymentForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const payload = Object.fromEntries(new FormData(paymentForm).entries());
    if (!payload.month) payload.month = formatMonth();
    try {
      await apiFetch("/api/payments", { method: "POST", body: payload });
      setStatus("Payment saved");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  unpaidBtn.addEventListener("click", async () => {
    try {
      const month = unpaidMonthInput.value || formatMonth();
      const data = await apiFetch(`/api/unpaid?month=${encodeURIComponent(month)}`);
      unpaidTable.innerHTML = data.rows
        .map((row) => `<tr><td>${row.class_name}</td><td>${row.student_name}</td><td>${row.phone || ""}</td></tr>`)
        .join("");
      setStatus(`Unpaid list for ${data.month}`);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  financeBtn.addEventListener("click", async () => {
    try {
      const month = financeMonthInput.value || formatMonth();
      const data = await apiFetch(`/api/finance?month=${encodeURIComponent(month)}`);
      financeTable.innerHTML = data.rows
        .map((row) => `<tr><td>${row.name}</td><td>${row.payments_count}</td><td>${formatMoney(row.total_amount)}</td></tr>`)
        .join("");
      financeTotal.textContent = formatMoney(data.total);
      setStatus(`Finance summary for ${data.month}`);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  async function loadDashboard() {
    try {
      const stats = await apiFetch("/api/admin/dashboard");
      dashboardCards.innerHTML = `
        <div class="card">
          <h3>Students</h3>
          <p style="font-size:2rem;">${stats.students}</p>
        </div>
        <div class="card">
          <h3>Classes</h3>
          <p style="font-size:2rem;">${stats.classes}</p>
        </div>
        <div class="card">
          <h3>Today's Attendance</h3>
          <p style="font-size:2rem;">${stats.today_attendance}</p>
        </div>
        <div class="card">
          <h3>Unpaid (this month)</h3>
          <p style="font-size:2rem;">${stats.unpaid_this_month}</p>
        </div>`;
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  async function loadExamAdmin() {
    try {
      const slots = await apiFetch("/api/admin/exam/slots");
      examSlotSelect.innerHTML = slots.map((slot) => `<option value="${slot.id}">${slot.label}</option>`).join("");
      if (slots.length && !examSlotSelect.value) {
        examSlotSelect.value = slots[0].id;
      }
      if (examSlotSelect.value) {
        await renderExamLayout(examSlotSelect.value);
      }
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  async function renderExamLayout(slotId) {
    try {
      const data = await apiFetch(`/api/admin/exam/slots/${slotId}/layout`);
      examInfo.textContent = `${data.slot.label} • ${data.seat_count} benches`;
      buildSeatLayout(examLayout, data, { readonly: true });
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  examRefresh.addEventListener("click", () => {
    if (examSlotSelect.value) renderExamLayout(examSlotSelect.value);
  });

  examSlotSelect.addEventListener("change", () => {
    if (examSlotSelect.value) renderExamLayout(examSlotSelect.value);
  });

  logoutBtn.addEventListener("click", async () => {
    await apiFetch("/logout", { method: "POST" });
    window.location.href = "/";
  });

  function buildSeatLayout(container, data, options = {}) {
    const bookings = {};
    data.bookings.forEach((b) => {
      bookings[`${b.seat_index}-${b.seat_pos}`] = b;
    });
    const rows = [];
    for (let i = 1; i <= data.seat_count; i += 1) {
      const segments = [];
      for (let pos = 1; pos <= 4; pos += 1) {
        const key = `${i}-${pos}`;
        const booking = bookings[key];
        const classes = ["seat-cell"];
        let label = `Seat ${i}`;
        if (booking) {
          if (booking.student_class === "Grade 7") classes.push("seat-grade7");
          if (booking.student_class === "Grade 8") classes.push("seat-grade8");
          label = booking.student_name;
        } else {
          classes.push("seat-empty");
        }
        segments.push(`<div class="${classes.join(" ")}" data-seat="${i}" data-pos="${pos}">${label}</div>`);
      }
      rows.push(`
        <div class="bench-row">
          <div class="bench-label">Seat ${i}</div>
          <div class="bench">${segments.join("")}</div>
        </div>`);
    }
    container.innerHTML = rows.join("");
  }

  async function startScanner() {
    if (state.scannerActive) return;
    if (!window.Html5Qrcode) {
      setStatus("QR library missing", true);
      return;
    }
    if (!state.scanner) {
      state.scanner = new Html5Qrcode("qr-reader");
    }
    try {
      await state.scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        onScanSuccess,
        () => {}
      );
      state.scannerActive = true;
      setStatus("Scanner ready");
    } catch (err) {
      setStatus(`Scanner error: ${err.message}`, true);
    }
  }

  function stopScanner() {
    if (state.scanner && state.scannerActive) {
      state.scanner.stop().finally(() => {
        state.scannerActive = false;
      });
    }
  }

  async function onScanSuccess(decodedText) {
    const now = Date.now();
    if (state.lastScanToken === decodedText && now - state.lastScanAt < 2000) {
      return;
    }
    state.lastScanToken = decodedText;
    state.lastScanAt = now;
    try {
      const data = await apiFetch("/api/scan", { method: "POST", body: { token: decodedText } });
      displayScanResult(data);
      playBeep();
    } catch (err) {
      scanResult.textContent = err.message;
      setStatus(err.message, true);
    }
  }

  function displayScanResult(data) {
    scanResult.innerHTML = `
      <h3>${data.student.name}</h3>
      <p>${data.student.grade} • ${data.student.phone}</p>
      <p>Attendance: ${data.attendance.date}</p>
      <p>Payment ${data.payment.month}: ${data.payment.paid ? '<span class="badge success">paid</span>' : '<span class="badge danger">unpaid</span>'}</p>`;
  }

  const audioCtx = window.AudioContext ? new AudioContext() : null;
  async function playBeep() {
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch (_) {}
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
  }

  window.addEventListener("beforeunload", stopScanner);

  async function bootstrap() {
    populateGradeSelect();
    setDefaultInputs();
    await Promise.all([refreshStudents(), refreshClasses()]);
    loadDashboard();
    setStatus("Loaded");
  }

  bootstrap();
})();
