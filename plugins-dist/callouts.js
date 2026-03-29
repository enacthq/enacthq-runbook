(() => {
  const TYPES = {
    NOTE: "note",
    TIP: "tip",
    INFO: "info",
    WARNING: "warning",
    DANGER: "danger",
  };

  function parseType(text) {
    const m = text.match(/^\s*(NOTE|TIP|INFO|WARNING|DANGER)\s*:\s*/i);
    if (!m) return null;
    const key = m[1].toUpperCase();
    const type = TYPES[key];
    if (!type) return null;
    return { type, rest: text.slice(m[0].length) };
  }

  function apply() {
    const blocks = document.querySelectorAll("blockquote");
    for (const bq of blocks) {
      const firstP = bq.querySelector("p");
      if (!firstP) continue;
      const parsed = parseType(firstP.textContent || "");
      if (!parsed) continue;

      bq.classList.add("kitfly-callout", `kitfly-callout--${parsed.type}`);

      const title = document.createElement("div");
      title.className = "kitfly-callout-title";
      title.textContent = parsed.type;

      if (parsed.rest.trim()) {
        firstP.textContent = parsed.rest;
      }

      bq.insertBefore(title, bq.firstChild);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();
