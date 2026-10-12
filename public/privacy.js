// Fills in the live version and contact address (kept on the server so the notice never goes out of date).
fetch("/api/privacy-info")
  .then((res) => (res.ok ? res.json() : null))
  .then((info) => {
    if (!info) return;
    document.getElementById("version").textContent = info.version;
    if (!info.contact) return;
    for (const el of document.querySelectorAll("[data-contact]")) {
      const link = document.createElement("a");
      link.href = `mailto:${encodeURIComponent(info.contact)}`;
      link.textContent = info.contact;
      el.replaceChildren(link);
    }
  })
  .catch(() => {
    // offline: the notice still reads correctly with its fallback text
  });
