// Loaded synchronously in <head> so the saved theme is applied before first paint (no flash).
(function () {
  var root = document.documentElement;
  var theme;
  try {
    theme = localStorage.getItem("theme");
  } catch {
    theme = null;
  }
  if (!theme) theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  root.setAttribute("data-theme", theme);

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        try {
          localStorage.setItem("theme", next);
        } catch {
          // private mode: the choice just will not persist
        }
      });
    });
  });
})();
