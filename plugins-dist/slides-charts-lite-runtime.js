(() => {
  const KIND_SET = new Set(["bar", "line", "pie"]);

  function parseValue(raw) {
    const v = String(raw ?? "").trim();
    if (!v) return "";
    if ((v.startsWith("[") && v.endsWith("]")) || (v.startsWith("{") && v.endsWith("}"))) {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
    const m = v.match(/^"(.*)"$/) || v.match(/^'(.*)'$/);
    return m ? m[1] : v;
  }

  function parseSpec(text) {
    const out = {};
    const lines = String(text ?? "").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const kv = line.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/i);
      if (!kv) continue;
      out[kv[1]] = parseValue(kv[2]);
    }

    const kind = String(out.kind || "").toLowerCase();
    const labels = Array.isArray(out.labels) ? out.labels.map((x) => String(x ?? "")) : [];
    const data = Array.isArray(out.data)
      ? out.data
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n))
      : [];

    if (!KIND_SET.has(kind)) return null;
    if (!labels.length || !data.length || labels.length !== data.length) return null;

    const height = typeof out.height === "number" && Number.isFinite(out.height) ? out.height : 300;
    const color = typeof out.color === "string" ? out.color.trim().toLowerCase() : "primary";
    const title = typeof out.title === "string" ? out.title : "";

    return {
      kind,
      labels,
      data,
      title,
      color,
      height: Math.max(160, Math.min(640, Math.round(height))),
    };
  }

  function pickThemeColor(hint) {
    const style = getComputedStyle(document.documentElement);
    const map = {
      primary: style.getPropertyValue("--color-primary").trim() || "#2563eb",
      accent: style.getPropertyValue("--color-accent").trim() || "#f59e0b",
      muted: style.getPropertyValue("--color-text-muted")?.trim() || "#6b7280",
      text: style.getPropertyValue("--color-text")?.trim() || "#111827",
      border: style.getPropertyValue("--color-border")?.trim() || "#d1d5db",
      surface: style.getPropertyValue("--color-surface")?.trim() || "#f9fafb",
    };
    return map[hint] || map.primary;
  }

  function configFromSpec(spec) {
    const base = pickThemeColor(spec.color);
    const isPie = spec.kind === "pie";
    const bg = isPie
      ? spec.labels.map((_, i) => `color-mix(in srgb, ${base} ${Math.max(20, 90 - i * 12)}%, white)`)
      : base;

    return {
      type: spec.kind,
      data: {
        labels: spec.labels,
        datasets: [
          {
            label: spec.title || "Series",
            data: spec.data,
            backgroundColor: bg,
            borderColor: base,
            borderWidth: 2,
            tension: spec.kind === "line" ? 0.25 : 0,
            fill: spec.kind === "line" ? false : true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: spec.kind === "pie", labels: { color: pickThemeColor("text") } },
          title: { display: Boolean(spec.title), text: spec.title, color: pickThemeColor("text") },
        },
        scales:
          spec.kind === "pie"
            ? undefined
            : {
                x: { ticks: { color: pickThemeColor("text") }, grid: { color: pickThemeColor("border") } },
                y: { ticks: { color: pickThemeColor("text") }, grid: { color: pickThemeColor("border") } },
              },
      },
    };
  }

  function renderWrapper(wrapper, spec) {
    let canvas = wrapper.querySelector("canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      wrapper.appendChild(canvas);
    }
    wrapper.style.height = `${spec.height}px`;
    if (wrapper.__kitflyChart && typeof wrapper.__kitflyChart.destroy === "function") {
      wrapper.__kitflyChart.destroy();
    }
    wrapper.__kitflyChart = new window.Chart(canvas, configFromSpec(spec));
  }

  function transformCodeBlock(code) {
    const pre = code.parentElement;
    if (!pre || pre.tagName !== "PRE") return;
    const spec = parseSpec(code.textContent || "");
    if (!spec) {
      console.warn("[kitfly:slides-charts-lite] Invalid chart block, leaving as code");
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "kitfly-chart-wrapper";
    wrapper.setAttribute("data-kitfly-chart-spec", JSON.stringify(spec));
    pre.replaceWith(wrapper);
    renderWrapper(wrapper, spec);
  }

  function renderAll() {
    if (!window.Chart) {
      console.warn("[kitfly:slides-charts-lite] Chart.js unavailable");
      return;
    }

    const styleId = "kitfly-charts-lite-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = ".kitfly-chart-wrapper{position:relative;width:100%;max-width:100%;margin:1rem 0}";
      document.head.appendChild(style);
    }

    document.querySelectorAll("pre > code.language-chart").forEach(transformCodeBlock);
  }

  function reinitCharts() {
    document.querySelectorAll(".kitfly-chart-wrapper[data-kitfly-chart-spec]").forEach((wrapper) => {
      const raw = wrapper.getAttribute("data-kitfly-chart-spec") || "";
      try {
        const spec = JSON.parse(raw);
        renderWrapper(wrapper, spec);
      } catch {
        // ignore broken metadata
      }
    });
  }

  if (typeof document === "undefined") {
    globalThis.__kitflyChartsLiteTest = { parseSpec };
    return;
  }

  window.reinitCharts = reinitCharts;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderAll);
  } else {
    renderAll();
  }
})();
