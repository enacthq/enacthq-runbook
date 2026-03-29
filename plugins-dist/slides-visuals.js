(() => {
  const BLOCK_RE = /^:::\s*([a-z0-9-]+)\s*$/i;
  const CLOSE_RE = /^:::\s*$/;

  function parseScalar(raw) {
    let v = String(raw ?? "").trim();
    v = v.replace(/\s*:::\s*$/, "").trim();
    if (!v) return "";
    const m = v.match(/^"(.*)"$/) || v.match(/^'(.*)'$/);
    if (m) return m[1];
    return v;
  }

  function parseFence(text) {
    const raw = String(text ?? "");
    const trimmed = raw.trim();
    if (!trimmed.startsWith(":::")) return null;
    const lines = trimmed.split(/\r?\n/);
    if (lines.length < 2) return null;
    const head = lines[0].trim();
    const tail = lines[lines.length - 1].trim();
    const m = head.match(BLOCK_RE);
    if (!m) return null;
    if (!CLOSE_RE.test(tail)) return null;
    const type = m[1].toLowerCase();
    const body = lines.slice(1, -1);
    return { type, data: parseLinesToObject(body) };
  }

  function parseLinesToObject(lines) {
    const out = {};
    let pendingKey = null;
    for (const raw of lines) {
      const line = String(raw ?? "");
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const kv = trimmed.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/i);
      if (!kv) continue;
      const key = kv[1];
      const value = kv[2];
      if (value) {
        out[key] = parseScalar(value);
        pendingKey = null;
      } else {
        pendingKey = key;
        out[key] = out[key] ?? [];
      }
    }
    return out;
  }

  function parseListItemToValue(li) {
    const parts = [];
    for (const child of li.querySelectorAll(":scope > p")) {
      const t = (child.textContent || "").trim();
      if (t) parts.push(t);
    }
    const raw = parts.length ? parts.join("\n") : (li.textContent || "").trim();
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l !== ":::");
    const obj = {};
    let any = false;
    for (const line of lines) {
      const kv = line.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/i);
      if (!kv) continue;
      any = true;
      obj[kv[1]] = parseScalar(kv[2]);
    }
    return any ? obj : parseScalar(raw);
  }

  function asTextItem(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return String(value ?? "");
    if (typeof value.text === "string") return value.text;
    if (typeof value.label === "string" && typeof value.value === "string") return `${value.label}: ${value.value}`;
    const parts = [];
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && v.trim()) parts.push(`${k}: ${v}`);
    }
    return parts.length ? parts.join(" · ") : "";
  }

  function listKeysForType(type) {
    switch (type) {
      case "compare":
        return ["left", "right"];
      case "comparison-table":
        return ["headers", "rows"];
      case "flow-branching":
        return ["branches"];
      case "flow-converging":
        return ["sources"];
      case "staircase":
        return ["steps"];
      default:
        return [];
    }
  }

  function scalarKeysForType(type) {
    switch (type) {
      case "compare":
        return ["left-title", "right-title"];
      case "flow-branching":
        return ["source", "split"];
      case "flow-converging":
        return ["target", "merge"];
      case "staircase":
        return ["direction"];
      default:
        return [];
    }
  }

  function isListKeyMarkerText(text, allowedKeys) {
    if (!allowedKeys || allowedKeys.length === 0) return null;
    const m = text.match(/^([a-z0-9_-]+)\s*:\s*$/i);
    if (!m) return null;
    const key = m[1].toLowerCase();
    return allowedKeys.includes(key) ? key : null;
  }

  function parseScalarMarkerText(text, allowedScalarKeys) {
    if (!allowedScalarKeys || allowedScalarKeys.length === 0) return null;
    const m = text.match(/^([a-z0-9_-]+)\s*:\s*(.+)$/i);
    if (!m) return null;
    const key = m[1].toLowerCase();
    if (!allowedScalarKeys.includes(key)) return null;
    return { key, value: parseScalar(m[2]) };
  }

  function parseBodyNodes(nodes) {
    const out = {};
    let pendingKey = null;

    for (const node of nodes) {
      const tag = String(node.tagName || "").toUpperCase();
      if (tag === "P") {
        const lines = (node.textContent || "").split(/\r?\n/);
        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const kv = trimmed.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/i);
          if (!kv) continue;
          const key = kv[1];
          const value = kv[2];
          if (value) {
            out[key] = parseScalar(value);
            pendingKey = null;
          } else {
            pendingKey = key;
            out[key] = [];
          }
        }
        continue;
      }

      if ((tag === "UL" || tag === "OL") && pendingKey) {
        const items = [];
        for (const li of node.querySelectorAll(":scope > li")) {
          items.push(parseListItemToValue(li));
        }
        out[pendingKey] = items;
        pendingKey = null;
        continue;
      }
    }

    return out;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== "") node.textContent = String(text);
    return node;
  }

  function renderKpi(data) {
    const root = el("div", "kitfly-visual kitfly-kpi");
    root.appendChild(el("div", "kitfly-kpi-label", data.label || ""));
    root.appendChild(el("div", "kitfly-kpi-value", data.value || ""));
    const trend = String(data.trend || "").trim();
    const trendEl = el("div", "kitfly-kpi-trend", trend);
    if (/^\+/.test(trend)) trendEl.classList.add("pos");
    if (/^-/.test(trend)) trendEl.classList.add("neg");
    root.appendChild(trendEl);
    return root;
  }

  function renderStatGrid(data) {
    const items = Array.isArray(data.metrics) ? data.metrics : Array.isArray(data.items) ? data.items : [];
    const root = el("div", "kitfly-visual kitfly-stat-grid");
    for (const it of items) {
      const item = typeof it === "object" && it ? it : { label: String(it ?? "") };
      const card = el("div", "kitfly-stat");
      card.appendChild(el("div", "kitfly-stat-label", item.label || ""));
      card.appendChild(el("div", "kitfly-stat-value", item.value || ""));
      const trend = String(item.trend || "").trim();
      if (trend) {
        const t = el("div", "kitfly-stat-trend", trend);
        if (/^\+/.test(trend)) t.classList.add("pos");
        if (/^-/.test(trend)) t.classList.add("neg");
        card.appendChild(t);
      }
      root.appendChild(card);
    }
    return root;
  }

  function renderCompare(data) {
    const root = el("div", "kitfly-visual kitfly-compare");
    const left = el("div", "kitfly-compare-col");
    const right = el("div", "kitfly-compare-col");
    left.appendChild(el("div", "kitfly-compare-title", data["left-title"] || data.leftTitle || "Left"));
    right.appendChild(el("div", "kitfly-compare-title", data["right-title"] || data.rightTitle || "Right"));

    const leftItems = Array.isArray(data.left) ? data.left : [];
    const rightItems = Array.isArray(data.right) ? data.right : [];

    const ulL = el("ul", "kitfly-compare-list");
    const ulR = el("ul", "kitfly-compare-list");
    for (const item of leftItems) ulL.appendChild(el("li", "", asTextItem(item)));
    for (const item of rightItems) ulR.appendChild(el("li", "", asTextItem(item)));
    left.appendChild(ulL);
    right.appendChild(ulR);
    root.appendChild(left);
    root.appendChild(right);
    return root;
  }

  function renderQuadrantGrid(data) {
    const root = el("div", "kitfly-visual kitfly-quadrant");
    const grid = el("div", "kitfly-quadrant-grid");
    grid.appendChild(el("div", "kitfly-quadrant-cell tl block", data.tl || ""));
    grid.appendChild(el("div", "kitfly-quadrant-cell tr block", data.tr || ""));
    grid.appendChild(el("div", "kitfly-quadrant-cell bl block", data.bl || ""));
    grid.appendChild(el("div", "kitfly-quadrant-cell br block", data.br || ""));
    root.appendChild(grid);

    const axisX = el("div", "kitfly-quadrant-axis axis-x", data["axis-x"] || data.axisX || "");
    const axisY = el("div", "kitfly-quadrant-axis axis-y", data["axis-y"] || data.axisY || "");
    if (axisX.textContent) root.appendChild(axisX);
    if (axisY.textContent) root.appendChild(axisY);
    return root;
  }

  function renderScorecard(data) {
    const metrics = Array.isArray(data.metrics) ? data.metrics : [];
    const root = el("div", "kitfly-visual kitfly-scorecard");
    for (const m of metrics) {
      const item = typeof m === "object" && m ? m : { label: String(m ?? "") };
      const card = el("div", "kitfly-scorecard-metric");
      card.appendChild(el("div", "kitfly-scorecard-label", item.label || ""));
      card.appendChild(el("div", "kitfly-scorecard-value", item.value || ""));
      const trend = String(item.trend || "").trim();
      if (trend) {
        const t = el("div", "kitfly-scorecard-trend", trend);
        if (/^\+/.test(trend)) t.classList.add("pos");
        if (/^-/.test(trend)) t.classList.add("neg");
        card.appendChild(t);
      }
      root.appendChild(card);
    }
    return root;
  }

  function rowCells(row) {
    if (typeof row === "string") {
      const t = row.trim();
      if (t.startsWith("[") && t.endsWith("]")) {
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed)) return parsed.map((v) => String(v ?? ""));
        } catch {
          // fall through
        }
      }
      return row.split("|").map((s) => s.trim()).filter(Boolean);
    }
    if (typeof row === "object" && row && Array.isArray(row.cells)) return row.cells.map((s) => String(s ?? ""));
    return [String(row ?? "")];
  }

  function renderComparisonTable(data) {
    const headers = Array.isArray(data.headers) ? data.headers : [];
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const root = el("div", "kitfly-visual kitfly-comparison-table");

    const headRow = el("div", "kitfly-table-row kitfly-table-head");
    for (const h of headers) headRow.appendChild(el("div", "kitfly-table-cell", asTextItem(h)));
    root.appendChild(headRow);

    for (const r of rows) {
      const row = el("div", "kitfly-table-row");
      for (const c of rowCells(r)) row.appendChild(el("div", "kitfly-table-cell", asTextItem(c)));
      root.appendChild(row);
    }

    return root;
  }

  function renderLayerCake(data) {
    const layers = Array.isArray(data.layers) ? data.layers : [];
    const root = el("div", "kitfly-visual kitfly-layer-cake");
    layers.forEach((layer, idx) => {
      const band = el("div", "kitfly-layer", layer);
      band.style.setProperty("--kitfly-layer-idx", String(idx));
      root.appendChild(band);
    });
    return root;
  }

  function renderPyramid(data) {
    const levels = Array.isArray(data.levels) ? data.levels : [];
    const root = el("div", "kitfly-visual kitfly-pyramid");
    const total = Math.max(levels.length, 1);
    const min = 55;
    const max = 100;
    levels.forEach((lvl, idx) => {
      const row = el("div", "kitfly-pyramid-level", lvl);
      const t = Math.max(total - 1, 1);
      const width = min + (idx / t) * (max - min);
      row.style.width = `${width.toFixed(2)}%`;
      root.appendChild(row);
    });
    return root;
  }

  function renderFunnel(data) {
    const stages = Array.isArray(data.stages) ? data.stages : [];
    const root = el("div", "kitfly-visual kitfly-funnel");
    const total = Math.max(stages.length, 1);
    const min = 55;
    const max = 100;
    stages.forEach((stage, idx) => {
      const row = el("div", "kitfly-funnel-stage", stage);
      const t = Math.max(total - 1, 1);
      const width = max - (idx / t) * (max - min);
      row.style.width = `${width.toFixed(2)}%`;
      root.appendChild(row);
    });
    return root;
  }

  function renderTimelineHorizontal(data) {
    const events = Array.isArray(data.events) ? data.events : [];
    const root = el("div", "kitfly-visual kitfly-timeline-h");
    const track = el("div", "kitfly-timeline-h-track");
    for (const event of events) {
      const item = typeof event === "object" && event ? event : { label: String(event ?? "") };
      const node = el("div", "kitfly-timeline-h-event");
      node.appendChild(el("div", "kitfly-timeline-h-label", item.label || ""));
      node.appendChild(el("div", "kitfly-timeline-h-marker"));
      if (item.date) node.appendChild(el("div", "kitfly-timeline-h-date", item.date));
      track.appendChild(node);
    }
    root.appendChild(track);
    return root;
  }

  function renderTimelineVertical(data) {
    const events = Array.isArray(data.events) ? data.events : [];
    const root = el("div", "kitfly-visual kitfly-timeline-v");
    const track = el("div", "kitfly-timeline-v-track");
    for (const event of events) {
      const item = typeof event === "object" && event ? event : { label: String(event ?? "") };
      const row = el("div", "kitfly-timeline-v-event");
      row.appendChild(el("div", "kitfly-timeline-v-marker"));
      const content = el("div", "kitfly-timeline-v-content");
      content.appendChild(el("div", "kitfly-timeline-v-label", item.label || ""));
      if (item.date) content.appendChild(el("div", "kitfly-timeline-v-date", item.date));
      row.appendChild(content);
      track.appendChild(row);
    }
    root.appendChild(track);
    return root;
  }

  function renderFlowBranching(data) {
    const source = String(data.source || "").trim();
    const split = String(data.split || "").trim();
    const branches = Array.isArray(data.branches) ? data.branches : [];
    const branchCount = Math.max(branches.length, 1);
    const root = el("div", "kitfly-visual kitfly-flow-branch");
    root.style.setProperty("--kitfly-branch-count", String(branchCount));
    root.appendChild(el("div", "kitfly-flow-branch-source block", source));
    root.appendChild(el("div", "kitfly-flow-branch-arrow", "↓"));
    if (split) {
      root.appendChild(el("div", "kitfly-flow-branch-split block accent", split));
      root.appendChild(el("div", "kitfly-flow-branch-arrow", "↓"));
    }
    const arms = el("div", "kitfly-flow-branch-arms");
    const targets = el("div", "kitfly-flow-branch-targets");
    for (const branch of branches) {
      arms.appendChild(el("div", "kitfly-flow-branch-arm", "↓"));
      targets.appendChild(el("div", "kitfly-flow-branch-target block", asTextItem(branch)));
    }
    root.appendChild(arms);
    root.appendChild(targets);
    return root;
  }

  function renderFlowConverging(data) {
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const merge = String(data.merge || "").trim();
    const target = String(data.target || "").trim();
    const sourceCount = Math.max(sources.length, 1);
    const root = el("div", "kitfly-visual kitfly-flow-converge");
    root.style.setProperty("--kitfly-source-count", String(sourceCount));
    const sourceRow = el("div", "kitfly-flow-converge-sources");
    const armRow = el("div", "kitfly-flow-converge-arms");
    for (const source of sources) {
      sourceRow.appendChild(el("div", "kitfly-flow-converge-source block", asTextItem(source)));
      armRow.appendChild(el("div", "kitfly-flow-converge-arm", "↓"));
    }
    root.appendChild(sourceRow);
    root.appendChild(armRow);
    if (merge) {
      root.appendChild(el("div", "kitfly-flow-converge-merge block accent", merge));
      root.appendChild(el("div", "kitfly-flow-converge-arrow", "↓"));
    }
    root.appendChild(el("div", "kitfly-flow-converge-target block", target));
    return root;
  }

  function renderStaircase(data) {
    const steps = Array.isArray(data.steps) ? data.steps : [];
    const direction = String(data.direction || "up").trim().toLowerCase();
    const reverse = direction === "down";
    const total = Math.max(steps.length - 1, 1);
    const root = el("div", "kitfly-visual kitfly-staircase");
    if (reverse) root.classList.add("is-down");
    steps.forEach((step, idx) => {
      const row = el("div", "kitfly-staircase-step", asTextItem(step));
      const normalized = reverse ? (steps.length - 1 - idx) / total : idx / total;
      row.style.setProperty("--kitfly-step-idx", String(idx));
      row.style.setProperty("--kitfly-step-level", String(normalized));
      root.appendChild(row);
    });
    return root;
  }

  function renderBlock(type, data) {
    switch (type) {
      case "kpi":
        return renderKpi(data);
      case "stat-grid":
        return renderStatGrid(data);
      case "compare":
        return renderCompare(data);
      case "quadrant-grid":
        return renderQuadrantGrid(data);
      case "scorecard":
        return renderScorecard(data);
      case "comparison-table":
        return renderComparisonTable(data);
      case "layer-cake":
        return renderLayerCake(data);
      case "pyramid":
        return renderPyramid(data);
      case "funnel":
        return renderFunnel(data);
      case "timeline-horizontal":
        return renderTimelineHorizontal(data);
      case "timeline-vertical":
        return renderTimelineVertical(data);
      case "flow-branching":
        return renderFlowBranching(data);
      case "flow-converging":
        return renderFlowConverging(data);
      case "staircase":
        return renderStaircase(data);
      default:
        return null;
    }
  }

  function tryReplaceSingleNode(node) {
    const txt = node.textContent || "";
    if (!txt.trimStart().startsWith(":::")) return false;
    const parsed = parseFence(txt);
    if (!parsed) return false;
    const rendered = renderBlock(parsed.type, parsed.data);
    if (!rendered) return false;
    rendered.setAttribute("data-kitfly-visual", parsed.type);
    node.replaceWith(rendered);
    return true;
  }

  function tryReplaceFragmentedFence(start) {
    const startTxt = String(start.textContent || "");
    const lines = startTxt.split(/\r?\n/);
    const first = (lines[0] || "").trim();
    const m = first.match(BLOCK_RE);
    if (!m) return false;
    const type = m[1].toLowerCase();

    const between = [];
    let end = null;
    let cur = start.nextElementSibling;
    while (cur) {
      const allLines = String(cur.textContent || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (allLines.some((l) => l === ":::")) {
        end = cur;
        break;
      }
      between.push(cur);
      cur = cur.nextElementSibling;
    }
    if (!end) return false;

    const data = parseBodyNodesWithFirstLines(lines.slice(1), between, end, type);
    const rendered = renderBlock(type, data);
    if (!rendered) return false;
    rendered.setAttribute("data-kitfly-visual", type);

    start.parentNode.insertBefore(rendered, start);
    const toRemove = [start, ...between, end];
    for (const n of toRemove) n.remove();
    return true;
  }

  function parseBodyNodesWithFirstLines(firstLines, between, end, type) {
    const out = {};
    let pendingKey = null;

    const seed = parseLinesToObject(firstLines);
    for (const k of Object.keys(seed)) {
      out[k] = seed[k];
      if (Array.isArray(out[k])) pendingKey = k;
    }

    const allowedKeys = listKeysForType(type);
    const allowedScalarKeys = scalarKeysForType(type);

    const nodes = [...between, end];
    for (const node of nodes) {
      const tag = String(node.tagName || "").toUpperCase();
      if (tag === "P") {
        const lines = (node.textContent || "").split(/\r?\n/);
        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (!trimmed || trimmed === ":::" || trimmed.startsWith("#")) continue;
          const kv = trimmed.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/i);
          if (!kv) continue;
          const key = kv[1];
          const value = kv[2];
          if (value) {
            out[key] = parseScalar(value);
            pendingKey = null;
          } else {
            pendingKey = key;
            out[key] = [];
          }
        }
        continue;
      }

      if ((tag === "UL" || tag === "OL") && pendingKey) {
        let currentKey = pendingKey;
        const buckets = {};
        buckets[currentKey] = [];

        for (const li of node.querySelectorAll(":scope > li")) {
          if (
            ((type === "stat-grid" || type === "scorecard") && currentKey === "metrics") ||
            ((type === "timeline-horizontal" || type === "timeline-vertical") && currentKey === "events")
          ) {
            buckets[currentKey].push(parseListItemToValue(li));
            continue;
          }

          const textLines = String(li.textContent || "")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && l !== ":::");

          let anyContent = false;
          let itemBucketKey = currentKey;
          const itemLines = [];

          function flushItemLines() {
            if (!itemLines.length) return;
            buckets[itemBucketKey] = buckets[itemBucketKey] || [];
            buckets[itemBucketKey].push(parseScalar(itemLines.join(" ")));
            itemLines.length = 0;
            anyContent = true;
          }

          for (const line of textLines) {
            const listMarker = isListKeyMarkerText(line, allowedKeys);
            if (listMarker) {
              flushItemLines();
              currentKey = listMarker;
              itemBucketKey = currentKey;
              buckets[currentKey] = buckets[currentKey] || [];
              anyContent = true;
              continue;
            }
            const scalarMarker = parseScalarMarkerText(line, allowedScalarKeys);
            if (scalarMarker) {
              flushItemLines();
              out[scalarMarker.key] = scalarMarker.value;
              if (type === "compare" && scalarMarker.key === "right-title") {
                currentKey = "right";
                itemBucketKey = currentKey;
                buckets[currentKey] = buckets[currentKey] || [];
              }
              if (type === "compare" && scalarMarker.key === "left-title") {
                currentKey = "left";
                itemBucketKey = currentKey;
                buckets[currentKey] = buckets[currentKey] || [];
              }
              anyContent = true;
              continue;
            }
            itemLines.push(line);
          }

          flushItemLines();
          if (anyContent) continue;

          // Fallback: absorbed key/value object in a <li>
          if (!anyContent) {
            const v = parseListItemToValue(li);
            if (typeof v === "string") buckets[currentKey].push(v);
          }
        }

        for (const [k, items] of Object.entries(buckets)) out[k] = items;
        pendingKey = null;
        continue;
      }
    }

    return out;
  }

  function apply(root) {
    const containers = root.querySelectorAll(".slide");
    for (const container of containers) {
      // First pass: handle single-node fences (flat key-values)
      for (const node of container.querySelectorAll("p, pre, code")) {
        if (node.closest(".kitfly-visual")) continue;
        tryReplaceSingleNode(node);
      }

      // Second pass: handle fences split across siblings (lists turn into <ul><li>...)
      let changed = true;
      while (changed) {
        changed = false;
        const elems = container.querySelectorAll("p");
        for (const p of elems) {
          if (p.closest(".kitfly-visual")) continue;
          const t = (p.textContent || "").trim();
          if (!t.startsWith(":::")) continue;
          if (tryReplaceFragmentedFence(p)) {
            changed = true;
            break;
          }
        }
      }
    }
  }

  if (typeof document === "undefined") {
    globalThis.__kitflySlidesVisualsTest = {
      parseBodyNodesWithFirstLines,
      rowCells,
    };
  } else {
    function start() {
      apply(document);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }
})();
