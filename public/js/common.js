window.apiFetch = async function apiFetch(url, options = {}) {
  const opts = { ...options };
  opts.credentials = "include";
  opts.headers = opts.headers || {};
  if (!opts.headers["Content-Type"] && !(opts.body instanceof FormData)) {
    opts.headers["Content-Type"] = "application/json";
  }
  if (opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    // ignore json errors for 204
  }
  if (!res.ok) {
    const message = data && data.error ? data.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
};

window.formatMoney = function formatMoney(amount) {
  return new Intl.NumberFormat("en-LK", { style: "currency", currency: "LKR" }).format(amount || 0);
};

window.formatMonth = function formatMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
};

window.todayISO = function todayISO(date = new Date()) {
  return date.toISOString().slice(0, 10);
};
