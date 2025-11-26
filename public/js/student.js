(() => {
  const root = document.getElementById("student-root");
  if (!root) return;

  const statusEl = document.getElementById("student-status");
  const layoutEl = document.getElementById("student-seat-layout");
  const seatInfo = document.getElementById("student-seat-info");
  const slotSelect = document.getElementById("student-slot");
  const btnBook = document.getElementById("btn-student-book");
  const btnCancel = document.getElementById("btn-student-cancel");

  const pageData = window.__STUDENT_PAGE__ || {};
  const eligibleGrades = ["Grade 7", "Grade 8"];
  const isEligible = eligibleGrades.includes(pageData.student?.grade);

  const state = {
    slots: [],
    layout: null,
    selectedSeat: null,
    myBooking: null,
  };

  function setStatus(msg, type = "info") {
    statusEl.textContent = msg || "";
    statusEl.className = `status-banner ${type}`;
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
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.headers.get("content-type")?.includes("application/json")
      ? res.json()
      : res.text();
  }

  if (!isEligible) {
    setStatus("Exam booking available only for Grade 7 & 8 students.", "error");
    btnBook?.setAttribute("disabled", "true");
    btnCancel?.setAttribute("disabled", "true");
    return;
  }

  async function loadSlots() {
    state.slots = await api("/api/exam/slots");
    slotSelect.innerHTML = state.slots
      .map((slot) => `<option value="${slot.id}">${slot.label}</option>`)
      .join("");
    if (state.slots.length) {
      slotSelect.value = state.slots[0].id;
      loadLayout();
    }
  }

  slotSelect?.addEventListener("change", () => {
    loadLayout();
  });

  async function loadLayout() {
    try {
      const slotId = slotSelect?.value;
      if (!slotId) return;
      const layout = await api(`/api/exam/slots/${slotId}/layout`);
      state.layout = layout;
      if (state.myBooking && state.myBooking.slot_id) {
        slotSelect.value = String(state.myBooking.slot_id);
        if (state.myBooking.slot_id !== Number(slotId)) {
          return loadLayout();
        }
      }
      state.selectedSeat = null;
      renderLayout();
      setStatus(`Showing seats for ${layout.slot.label}`);
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  async function fetchMyBooking() {
    state.myBooking = await api("/api/student/exam/booking");
    if (state.myBooking && state.myBooking.slot_id && slotSelect) {
      slotSelect.value = String(state.myBooking.slot_id);
    }
  }

  function renderLayout() {
    if (!layoutEl || !state.layout) return;
    if (state.myBooking) {
      seatInfo.style.display = "block";
      seatInfo.textContent = `Your seat: Bench ${state.myBooking.seat_index}, Position ${state.myBooking.seat_pos}`;
    } else if (state.selectedSeat) {
      seatInfo.style.display = "block";
      seatInfo.textContent = `Selected bench ${state.selectedSeat.seat}, pos ${state.selectedSeat.pos}`;
    } else {
      seatInfo.style.display = "none";
    }
    const map = {};
    (state.layout.bookings || []).forEach((b) => {
      map[`${b.seat_index}-${b.seat_pos}`] = b;
    });
    let html = "";
    const totalSeats = state.layout.seat_count;
    for (let i = 1; i <= totalSeats; i++) {
      html += `<div class="bench-row" style="display:flex;align-items:center;margin-bottom:0.4rem;">
        <div style="width:70px;color:#94a3b8;">Seat ${i}</div>
        <div class="bench" style="display:flex;flex:1;background:#78350f;border-radius:8px;overflow:hidden;">
      `;
      for (let p = 1; p <= 4; p++) {
        const key = `${i}-${p}`;
        const booking = map[key];
        const isMine = booking && state.myBooking && booking.id === state.myBooking.id;
        const bookedClass = booking?.student_class;
        const bg = booking
          ? bookedClass === "Grade 7"
            ? "#1d4ed8"
            : "#16a34a"
          : "transparent";
        const classes = ["bench-segment"];
        if (!booking) classes.push("empty");
        if (isMine) classes.push("my-seat");
        if (state.selectedSeat && state.selectedSeat.key === key) classes.push("selected");
        html += `<div class="${classes.join(" ")}" data-seat="${i}" data-pos="${p}" style="flex:1;padding:0.4rem;text-align:center;border-right:1px solid rgba(15,23,42,0.6);background:${bg};cursor:${booking ? (isMine ? "pointer" : "not-allowed") : "pointer"};">
          ${booking ? booking.student_name : "Empty"}
        </div>`;
      }
      html += `</div></div>`;
    }
    layoutEl.innerHTML = html;
  }

  layoutEl?.addEventListener("click", (ev) => {
    const cell = ev.target.closest(".bench-segment");
    if (!cell) return;
    const seat = Number(cell.dataset.seat);
    const pos = Number(cell.dataset.pos);
    const key = `${seat}-${pos}`;
    const booking = (state.layout.bookings || []).find(
      (b) => b.seat_index === seat && b.seat_pos === pos
    );
    if (booking) {
      if (state.myBooking && booking.id === state.myBooking.id) {
        seatInfo.style.display = "block";
        seatInfo.textContent = `Your seat: Bench ${seat}, Position ${pos}`;
      } else {
        setStatus("Seat already booked", "error");
      }
      return;
    }
    state.selectedSeat = { seat, pos, key };
    seatInfo.style.display = "block";
    seatInfo.textContent = `Selected bench ${seat}, pos ${pos}`;
    renderLayout();
  });

  btnBook?.addEventListener("click", async () => {
    if (!state.selectedSeat) {
      return setStatus("Select an available seat", "error");
    }
    try {
      await api("/api/exam/book", {
        method: "POST",
        body: {
          slot_id: Number(slotSelect.value),
          seat_index: state.selectedSeat.seat,
          seat_pos: state.selectedSeat.pos,
        },
      });
      setStatus("Seat booked successfully", "success");
      state.selectedSeat = null;
      await fetchMyBooking();
      await loadLayout();
    } catch (err) {
      setStatus(err.message, "error");
      await loadLayout();
    }
  });

  btnCancel?.addEventListener("click", async () => {
    if (!state.myBooking) {
      return setStatus("You do not have a booking", "error");
    }
    if (!confirm("Cancel your current booking?")) return;
    try {
      await api("/api/student/exam/booking", { method: "DELETE" });
      state.myBooking = null;
      state.selectedSeat = null;
      setStatus("Booking cancelled", "success");
      await loadLayout();
    } catch (err) {
      setStatus(err.message, "error");
    }
  });

  (async function init() {
    try {
      await loadSlots();
      await fetchMyBooking();
      await loadLayout();
      setStatus("Seat planner ready", "success");
    } catch (err) {
      console.error(err);
      setStatus(err.message, "error");
    }
  })();
})();
