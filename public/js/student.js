(function () {
  const statusEl = document.getElementById("student-status");
  const nameEl = document.getElementById("student-name");
  const gradeEl = document.getElementById("student-grade");
  const logoutBtn = document.getElementById("student-logout");
  const slotSelect = document.getElementById("slot-select");
  const layoutContainer = document.getElementById("student-seat-layout");
  const bookingInfo = document.getElementById("booking-info");
  const selectionInfo = document.getElementById("selection-info");
  const confirmBtn = document.getElementById("confirm-booking");
  const refreshBtn = document.getElementById("refresh-layout");

  let profile = null;
  let currentBooking = null;
  let slots = [];
  let selectedSeat = null;

  function setStatus(message, isError) {
    statusEl.textContent = message || "";
    statusEl.style.color = isError ? "#f87171" : "var(--muted)";
  }

  async function loadProfile() {
    profile = await apiFetch("/api/student/profile");
    nameEl.textContent = `Name: ${profile.name}`;
    gradeEl.textContent = `Grade: ${profile.grade}`;
    if (profile.grade !== "Grade 7" && profile.grade !== "Grade 8") {
      disableBooking("Only Grade 7 and Grade 8 students are allowed to book seats.");
    }
  }

  function disableBooking(message) {
    bookingInfo.textContent = message;
    slotSelect.disabled = true;
    confirmBtn.disabled = true;
    refreshBtn.disabled = true;
    layoutContainer.innerHTML = "";
  }

  async function loadSlots() {
    slots = await apiFetch("/api/exam/slots");
    slotSelect.innerHTML = slots.map((slot) => `<option value="${slot.id}">${slot.label}</option>`).join("");
    if (slots.length) {
      slotSelect.value = slots[0].id;
    }
  }

  async function loadBooking() {
    currentBooking = await apiFetch("/api/exam/booking");
    if (currentBooking) {
      bookingInfo.innerHTML = `You have booked <strong>${currentBooking.label}</strong> at seat ${currentBooking.seat_index}, position ${currentBooking.seat_pos}.`;
    } else {
      bookingInfo.textContent = "You have not booked a seat yet.";
    }
  }

  async function loadLayout() {
    if (!slotSelect.value) return;
    try {
      const layout = await apiFetch(`/api/exam/slots/${slotSelect.value}/layout`);
      renderSeatLayout(layout);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function renderSeatLayout(data) {
    const bookings = {};
    data.bookings.forEach((b) => {
      bookings[`${b.seat_index}-${b.seat_pos}`] = b;
    });
    selectionInfo.textContent = currentBooking
      ? `Current booking: Seat ${currentBooking.seat_index}, Position ${currentBooking.seat_pos}`
      : "Select a seat to continue.";
    const rows = [];
    selectedSeat = null;
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
          if (currentBooking && currentBooking.seat_index === i && currentBooking.seat_pos === pos) {
            classes.push("seat-selected");
            selectionInfo.textContent = `Current booking: Seat ${i}, Position ${pos}`;
          }
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
    layoutContainer.innerHTML = rows.join("");
  }

  layoutContainer.addEventListener("click", (ev) => {
    const cell = ev.target.closest(".seat-cell");
    if (!cell || cell.classList.contains("seat-grade7") || cell.classList.contains("seat-grade8")) {
      return;
    }
    const seat = Number(cell.dataset.seat);
    const pos = Number(cell.dataset.pos);
    selectedSeat = { seat, pos };
    layoutContainer.querySelectorAll(".seat-cell").forEach((c) => c.classList.remove("seat-selected"));
    cell.classList.add("seat-selected");
    selectionInfo.textContent = `Selected: Seat ${seat}, Position ${pos}`;
  });

  confirmBtn.addEventListener("click", async () => {
    if (profile.grade !== "Grade 7" && profile.grade !== "Grade 8") return;
    if (!slotSelect.value) {
      setStatus("Select a session", true);
      return;
    }
    if (!selectedSeat) {
      setStatus("Click an empty seat to select it", true);
      return;
    }
    try {
      await apiFetch("/api/exam/book", {
        method: "POST",
        body: {
          slot_id: slotSelect.value,
          seat_index: selectedSeat.seat,
          seat_pos: selectedSeat.pos,
        },
      });
      setStatus("Seat booked successfully");
      await loadBooking();
      await loadLayout();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  slotSelect.addEventListener("change", () => {
    selectionInfo.textContent = "Select a seat to continue.";
    loadLayout();
  });

  refreshBtn.addEventListener("click", () => loadLayout());

  logoutBtn.addEventListener("click", async () => {
    await apiFetch("/logout", { method: "POST" });
    window.location.href = "/";
  });

  async function init() {
    try {
      await loadProfile();
      if (profile.grade !== "Grade 7" && profile.grade !== "Grade 8") {
        return;
      }
      await loadSlots();
      await loadBooking();
      await loadLayout();
      setStatus("Ready");
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  init();
})();
