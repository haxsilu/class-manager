(function(){
  const statusEl = document.getElementById("login-status");

  function setStatus(message, isError) {
    statusEl.textContent = message || "";
    statusEl.style.color = isError ? "#f87171" : "var(--muted)";
  }

  async function handleSubmit(form, role) {
    setStatus("Authenticating...");
    const formData = new FormData(form);
    const payload = {
      username: formData.get("username"),
      password: formData.get("password"),
      role
    };
    try {
      const res = await apiFetch("/login", { method: "POST", body: payload });
      setStatus("Success. Redirecting...");
      window.location.href = res.redirect;
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function bindForm(id, role) {
    const form = document.getElementById(id);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      handleSubmit(form, role);
    });
  }

  bindForm("admin-form", "admin");
  bindForm("student-form", "student");

  apiFetch("/session")
    .then((session) => {
      if (session && session.authenticated) {
        window.location.href = session.role === "admin" ? "/admin" : "/student";
      }
    })
    .catch(() => {});
})();
