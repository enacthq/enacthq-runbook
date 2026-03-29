(() => {
  function isCurrency(expr) {
    return /^\d[\d,]*(?:\.\d+)?(?:\s*(?:to|-)\s*\d[\d,]*(?:\.\d+)?)?$/.test(expr.trim());
  }

  function shouldTreatAsLiteralInline(expr, text, closingIndex) {
    if (/^\s|\s$/.test(expr) || /\n/.test(expr) || isCurrency(expr)) return true;
    // Guard common currency range form "$5-$10" where expr becomes "5-".
    if (/-\s*$/.test(expr)) {
      const tail = text.slice(closingIndex + 1);
      if (/^\d/.test(tail)) return true;
    }
    return false;
  }

  function findClosing(text, start, display) {
    for (let i = start; i < text.length; i++) {
      if (text[i] === "\\" && text[i + 1] === "$") {
        i++;
        continue;
      }
      if (display) {
        if (text[i] === "$" && text[i + 1] === "$") return i;
      } else if (text[i] === "$" && text[i - 1] !== "$" && text[i + 1] !== "$") {
        return i;
      }
    }
    return -1;
  }

  function splitMath(text) {
    const out = [];
    let buf = "";
    let i = 0;

    while (i < text.length) {
      if (text[i] === "\\" && text[i + 1] === "$") {
        buf += "$";
        i += 2;
        continue;
      }
      if (text[i] !== "$") {
        buf += text[i++];
        continue;
      }

      const display = text[i + 1] === "$";
      const openLen = display ? 2 : 1;
      const end = findClosing(text, i + openLen, display);
      if (end < 0) {
        buf += display ? "$$" : "$";
        i += openLen;
        continue;
      }

      const expr = text.slice(i + openLen, end);
      if (!display && shouldTreatAsLiteralInline(expr, text, end)) {
        buf += `$${expr}$`;
        i = end + 1;
        continue;
      }

      if (buf) out.push({ text: buf });
      out.push({ math: expr, display });
      buf = "";
      i = end + openLen;
    }

    if (buf) out.push({ text: buf });
    return out;
  }

  function renderFencedMath() {
    document.querySelectorAll("pre > code.language-math").forEach((code) => {
      const pre = code.parentElement;
      if (!pre || pre.tagName !== "PRE") return;
      const host = document.createElement("div");
      host.className = "kitfly-katex-display";
      window.katex.render(code.textContent || "", host, { displayMode: true, throwOnError: false });
      pre.replaceWith(host);
    });
  }

  function renderDelimitedMath() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest("pre, code, script, style, textarea, .katex")) continue;
      if (!(node.textContent || "").includes("$")) continue;
      nodes.push(node);
    }

    for (const node of nodes) {
      const parts = splitMath(node.textContent || "");
      if (!parts.some((p) => p.math)) continue;
      const frag = document.createDocumentFragment();
      for (const p of parts) {
        if (p.text != null) {
          frag.appendChild(document.createTextNode(p.text));
        } else if (p.math != null) {
          const host = document.createElement("span");
          host.className = p.display ? "kitfly-katex-display" : "kitfly-katex-inline";
          window.katex.render(p.math, host, { displayMode: Boolean(p.display), throwOnError: false });
          frag.appendChild(host);
        }
      }
      node.replaceWith(frag);
    }
  }

  function apply() {
    const styleId = "kitfly-latex-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = ".kitfly-katex-display{display:block;text-align:center;margin:1em 0;overflow-x:auto}";
      document.head.appendChild(style);
    }

    if (!window.katex?.render) {
      console.warn("[kitfly:latex] KaTeX unavailable");
      return;
    }

    renderFencedMath();
    renderDelimitedMath();
  }

  if (typeof document === "undefined") {
    globalThis.__kitflyLatexTest = { splitMath, isCurrency, shouldTreatAsLiteralInline };
    return;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();
