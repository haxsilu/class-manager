document.addEventListener("DOMContentLoaded", () => {
  const state = {
    profile: null,
    slots: [],
    selection: null,
    currentBooking: null,
  };

  const els = {
    slot: document.getElementById("student-slot"),
    seatLayout: document.getElementById("student-seat-layout"),
    confirm: document.getElementById("confirm-booking"),
    cancel: document.getElementById("cancel-booking"),
    status: document.getElementById("student-status"),
    meta: document.getElementById("student-meta"),
    note: document.getElementById("booking-note"),
    current: document.getElementById("current-booking"),
    logout: document.getElementById("student-logout"),
  };

  function setStatus(message, isError) {
    els.status.textContent = message || "";
    els.status.classList.toggle("error", Boolean(isError));
    els.status.classList.toggle("success", Boolean(!isError && message));
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

  function updateMeta() {
    if (!state.profile) return;
    const student = state.profile.student;
    els.meta.textContent = `${student.name} • ${student.grade}`;
    const allowed = isEligible();
    els.note.textContent = allowed
      ? "Tap an empty seat to select it, then confirm."
      : "Your grade is not eligible for this exam booking.";
    els.confirm.disabled = !allowed;
  }

  function isEligible() {
    const grade = state.profile?.student?.grade;
    return grade === "Grade 7" || grade === "Grade 8";
  }

  async function loadProfile() {
    const data = await fetchJSON("/api/session");
    if (data.role !== "student") {
      window.location.href = "/";
      return;
    }
    state.profile = data;
    updateMeta();
  }

  async function loadSlots() {
    state.slots = await fetchJSON("/api/exam/slots");
    els.slot.innerHTML = state.slots
      .map((slot) => `<option value="${slot.id}">${slot.label}</option>`)
      .join("");
    if (state.slots.length) {
      els.slot.value = state.slots[0].id;
    }
  }

  async function loadMyBooking() {
    state.currentBooking = await fetchJSON("/api/exam/my-booking");
    if (state.currentBooking) {
      const slot = state.slots.find((s) => s.id === state.currentBooking.slot_id);
      els.current.innerHTML = `You booked <strong>${slot ? slot.label : "a session"}</strong><br />Bench ${state.currentBooking.seat_index} • Seat ${state.currentBooking.seat_pos}`;
      els.cancel.disabled = false;
    } else {
      els.current.textContent = "No seat reserved yet.";
      els.cancel.disabled = true;
    }
  }

  function renderSeatLayout(data) {
    if (!data) {
      els.seatLayout.innerHTML = "<p class=hint>No session selected.</p>";
      return;
    }
    const map = new Map();
    (data.bookings || []).forEach((b) => map.set(`${b.seat_index}-${b.seat_pos}`, b));
    const studentId = state.profile?.student?.id;
    let html = "";
    for (let seat = 1; seat <= data.seat_count; seat += 1) {
      html += `<div class="seat-row"><div class="seat-label">Bench ${seat}</div><div class="bench">`;
      for (let pos = 1; pos <= data.max_per_seat; pos += 1) {
        const key = `${seat}-${pos}`;
        const booking = map.get(key);
        if (booking) {
          const mine = booking.student_id === studentId ? "mine" : "";
          const gradeClass = booking.student_class === "Grade 7" ? "grade7" : "grade8";
          html += `<button type="button" class="reserved ${gradeClass} ${mine}" disabled>${booking.student_name}</button>`;
        } else {
          const selected = state.selection && state.selection.seatIndex === seat && state.selection.seatPos === pos ? "selected" : "";
          const disabled = isEligible() ? "" : "disabled";
          html += `<button type="button" class="${selected}" data-seat="${seat}" data-pos="${pos}" ${disabled}>Seat ${pos}</button>`;
        }
      }
      html += "</div></div>";
    }
    els.seatLayout.innerHTML = html;
  }

  async function loadLayout() {
    const slotId = Number(els.slot.value);
    if (!slotId) return;
    const data = await fetchJSON(`/api/exam/slots/${slotId}/layout`);
    if (state.currentBooking && state.currentBooking.slot_id !== slotId) {
      state.selection = null;
    }
    renderSeatLayout(data);
  }

  els.seatLayout.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn || btn.disabled || btn.classList.contains("reserved")) return;
    const seatIndex = Number(btn.dataset.seat);
    const seatPos = Number(btn.dataset.pos);
    state.selection = { seatIndex, seatPos };
    document.querySelectorAll(".bench button").forEach((el) => el.classList.remove("selected"));
    btn.classList.add("selected");
    setStatus(`Selected bench ${seatIndex} seat ${seatPos}`);
  });

  els.confirm.addEventListener("click", async () => {
    if (!isEligible()) {
      setStatus("You are not eligible to book", true);
      return;
    }
    if (!state.selection) {
      setStatus("Select an available seat first", true);
      return;
    }
    try {
      await fetchJSON("/api/exam/book", {
        method: "POST",
        body: {
          slot_id: Number(els.slot.value),
          seat_index: state.selection.seatIndex,
          seat_pos: state.selection.seatPos,
        },
      });
      setStatus("Seat reserved successfully.", false);
      await loadMyBooking();
      await loadLayout();
    } catch (err) {
      setStatus(err.message, true);
      await loadLayout();
    }
  });

  els.cancel.addEventListener("click", async () => {
    if (!state.currentBooking) return;
    if (!confirm("Cancel your current booking?")) return;
    await fetchJSON("/api/exam/my-booking", { method: "DELETE" });
    setStatus("Booking cancelled");
    await loadMyBooking();
    await loadLayout();
  });

  els.slot.addEventListener("change", async () => {
    state.selection = null;
    await loadLayout();
  });

  els.logout.addEventListener("click", async () => {
    await fetch("/logout", { method: "POST" });
    window.location.href = "/";
  });

  (async () => {
    try {
      await loadProfile();
      await loadSlots();
      await loadMyBooking();
      await loadLayout();
    } catch (err) {
      setStatus(err.message, true);
    }
  })();
});
