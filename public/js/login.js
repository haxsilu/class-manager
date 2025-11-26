document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("login-form");
  const statusEl = document.getElementById("login-status");
  const roleInput = document.getElementById("login-role");
  const usernameInput = document.getElementById("login-username");
  const passwordInput = document.getElementById("login-password");
  const toggleButtons = document.querySelectorAll(".role-toggle .chip");

  function setStatus(message, isError) {
    statusEl.textContent = message || "";
    statusEl.classList.toggle("error", Boolean(isError));
    statusEl.classList.toggle("success", Boolean(!isError && message));
  }

  toggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const role = btn.dataset.role;
      roleInput.value = role;
      usernameInput.value = "";
      passwordInput.value = "";
      if (role === "admin") {
        usernameInput.placeholder = "admin";
      } else {
        usernameInput.placeholder = "0701234567";
      }
      setStatus("");
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("Signing in…");
    const payload = {
      role: roleInput.value,
      username: usernameInput.value.trim(),
      password: passwordInput.value,
    };
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Login failed");
      }
      const data = await res.json();
      setStatus("Success", false);
      window.location.href = data.redirect || "/";
    } catch (err) {
      setStatus(err.message, true);
    }
  });
});
