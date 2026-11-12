/* OCR System — app.js */
"use strict";

// When opened as file:// the browser can't resolve relative /api paths.
// Auto-detect and prefix with the local server origin.
const API_BASE = location.protocol === "file:" ? "http://localhost:8080" : "";

let selectedFile   = null;
let selectedEngine = "all";
let currentResult  = null;

// Engine selector
document.querySelectorAll(".toggle").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".toggle").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedEngine = btn.dataset.engine;
    if (selectedEngine === "deepseek" || selectedEngine === "all") {
      showToast("DeepSeek-OCR needs a GPU and ~7 GB model on first run.");
    }
  });
});

// Tab switching
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    const panel = document.getElementById("tab-" + tab.dataset.tab);
    if (panel) panel.classList.remove("hidden");
  });
});

// Drop zone
const dz = document.getElementById("dropZone");
dz.addEventListener("dragover",  e => { e.preventDefault(); dz.classList.add("drag-over"); });
dz.addEventListener("dragleave", ()  => dz.classList.remove("drag-over"));
dz.addEventListener("drop",      e  => { e.preventDefault(); dz.classList.remove("drag-over"); pickFile(e.dataTransfer.files[0]); });
dz.addEventListener("keydown",   e  => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); document.getElementById("fileInput").click(); } });
document.getElementById("fileInput").addEventListener("change", e => pickFile(e.target.files[0]));

function pickFile(file) {
  if (!file) return;
  selectedFile = file;
  document.getElementById("processBtn").disabled = false;

  const ext   = file.name.split(".").pop().toLowerCase();
  const isImg = /^(jpg|jpeg|png|bmp|gif|webp|tif|tiff)$/.test(ext);
  const extLabel = ext === "xlsx" || ext === "xls" || ext === "xlsm" ? "EXCEL" : ext.toUpperCase();

  document.getElementById("previewArea").classList.remove("hidden");
  document.getElementById("fileExt").textContent   = extLabel;
  document.getElementById("fileName").textContent  = file.name;
  document.getElementById("previewMeta").textContent = fmtBytes(file.size) + " · " + (file.type || extLabel);

  if (isImg) {
    document.getElementById("previewImg").src = URL.createObjectURL(file);
    document.getElementById("previewImg").classList.remove("hidden");
    document.getElementById("fileIcon").classList.add("hidden");
  } else {
    document.getElementById("previewImg").classList.add("hidden");
    document.getElementById("fileIcon").classList.remove("hidden");
  }
}

function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function setProgress(pct, lbl) {
  document.getElementById("progressBar").style.width = pct + "%";
  document.getElementById("progressLabel").textContent = lbl;
}

// Process button
document.getElementById("processBtn").addEventListener("click", async () => {
  if (!selectedFile) return;

  document.getElementById("resultsCard").classList.add("hidden");
  document.getElementById("progressWrap").classList.remove("hidden");
  document.getElementById("processBtn").disabled = true;
  document.getElementById("procIcon") && document.getElementById("procIcon").classList.add("hidden");
  document.getElementById("spinner").classList.remove("hidden");
  document.getElementById("btn-text") || (document.querySelector(".btn-text").textContent = "Processing…");
  document.querySelector(".btn-text").textContent = "Processing…";

  try {
    setProgress(8, "Uploading file…");
    const form = new FormData();
    form.append("file", selectedFile);
    const uploadRes = await fetch(`${API_BASE}/api/ocr/upload?engine=${encodeURIComponent(selectedEngine)}`, {
      method: "POST",
      body: form,
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({ detail: uploadRes.statusText }));
      throw new Error(err.detail || "Upload failed");
    }
    const { job_id } = await uploadRes.json();
    setProgress(20, "File uploaded — running OCR engines…");

    const STAGES = [
      [36, "PaddleOCR: detecting text regions…"],
      [52, "PaddleOCR: running recognition…"],
      [65, "Docling: analyzing document layout…"],
      [78, "Docling: extracting tables & structure…"],
      [88, "DeepSeek-OCR: generating Markdown…"],
      [96, "Fusing engine outputs…"],
    ];
    let si = 0;
    while (true) {
      const sr = await fetch(`${API_BASE}/api/ocr/status/${job_id}`);
      if (!sr.ok) throw new Error("Status check failed");
      const job = await sr.json();

      if (job.status === "done") {
        const rr = await fetch(`${API_BASE}/api/ocr/result/${job_id}`);
        if (!rr.ok) throw new Error("Failed to retrieve result");
        currentResult = await rr.json();
        break;
      }
      if (job.status === "error") throw new Error(job.error || "OCR processing failed");

      if (si < STAGES.length) { const [p, l] = STAGES[si++]; setProgress(p, l); }
      await sleep(1200);
    }

    setProgress(100, "Complete");
    await sleep(300);
    document.getElementById("progressWrap").classList.add("hidden");
    renderResults(currentResult);

  } catch (err) {
    document.getElementById("progressWrap").classList.add("hidden");
    showToast("Error: " + err.message, true);
  }

  document.getElementById("processBtn").disabled = false;
  document.getElementById("procIcon") && document.getElementById("procIcon").classList.remove("hidden");
  document.getElementById("spinner").classList.add("hidden");
  document.querySelector(".btn-text").textContent = "Process Document";
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function renderResults(res) {
  const conf = res.confidence_avg ? (res.confidence_avg * 100).toFixed(1) + "%" : null;
  const confClass = (res.confidence_avg || 0) >= 0.9 ? "good" : "warn";
  document.getElementById("resultsMeta").innerHTML =
    `<span class="meta-pill engine">${esc(res.primary_engine || "—")}</span>` +
    (conf ? `<span class="meta-pill ${confClass}">${conf} confidence</span>` : "") +
    (res.processing_time_s ? `<span class="meta-pill">${res.processing_time_s}s</span>` : "");

  document.getElementById("fusedText").textContent   = res.fused_text || "(no text extracted)";
  document.getElementById("doclingText").textContent  = res.docling?.markdown || res.docling?.text || "(Docling produced no output)";
  document.getElementById("deepseekText").textContent = res.deepseek?.markdown || res.deepseek?.text || "(DeepSeek-OCR not run — requires GPU or first-time model download)";

  const lines = res.paddle?.lines || [];
  document.getElementById("paddleLines").innerHTML = lines.length
    ? lines.map(ln => {
        const p   = (ln.confidence * 100).toFixed(1);
        const cls = ln.confidence >= 0.9 ? "conf-high" : ln.confidence >= 0.7 ? "conf-mid" : "conf-low";
        const barColor = ln.confidence >= 0.9 ? "#16a34a" : ln.confidence >= 0.7 ? "#d97706" : "#dc2626";
        return `<div class="line-item">
          <span class="line-text">${esc(ln.text)}</span>
          <div class="conf-bar-wrap"><div class="conf-bar" style="width:${p}%;background:${barColor}"></div></div>
          <span class="conf-label ${cls}">${p}%</span>
        </div>`;
      }).join("")
    : `<p class="empty-msg">No PaddleOCR lines returned.</p>`;

  const tables = res.tables || res.docling?.tables || [];
  document.getElementById("tablesOutput").innerHTML = tables.length
    ? tables.map((tbl, i) => {
        const rows = tbl.data || [];
        if (!rows.length) return "";
        const cols = Object.keys(rows[0]);
        return `<div class="table-wrap">
          <div class="tbl-caption">Table ${i + 1}${tbl.caption ? ": " + esc(tbl.caption) : ""}</div>
          <table>
            <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>
            <tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>
          </table>
        </div>`;
      }).join("")
    : `<p class="empty-msg">No tables detected.</p>`;

  document.getElementById("rawJson").textContent = JSON.stringify(res, null, 2);
  document.getElementById("resultsCard").classList.remove("hidden");

  // Reset to Fused tab
  document.querySelectorAll(".tab").forEach(t => {
    const isFused = t.dataset.tab === "fused";
    t.classList.toggle("active", isFused);
    t.setAttribute("aria-selected", String(isFused));
  });
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
  document.getElementById("tab-fused").classList.remove("hidden");
  document.getElementById("resultsCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

// Copy / Download buttons
document.getElementById("copyBtn").addEventListener("click", () => {
  if (!currentResult) { showToast("No results yet."); return; }
  navigator.clipboard.writeText(currentResult.fused_text || "").then(
    () => showToast("Text copied to clipboard."),
    () => showToast("Clipboard blocked — please copy manually.", true)
  );
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  if (!currentResult) { showToast("No results yet."); return; }
  // Try clipboard first; fall back to download link
  const json = JSON.stringify(currentResult, null, 2);
  navigator.clipboard.writeText(json).then(
    () => showToast("JSON copied to clipboard."),
    () => {
      const blob = new Blob([json], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "ocr-result.json"; a.click();
      URL.revokeObjectURL(url);
    }
  );
});

// Toast
let toastTimer = null;
function showToast(msg, isErr = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.background = isErr ? "#dc2626" : "#111827";
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}


// ============================================================
// MySQL History panel
// ============================================================
(async function initHistory() {
  const statusEl  = document.getElementById('dbStatus');
  const bodyEl    = document.getElementById('historyBody');
  const refreshBtn= document.getElementById('refreshHistoryBtn');

  async function checkDb() {
    try {
      const r = await fetch('/api/health');
      const j = await r.json();
      if (statusEl) {
        statusEl.textContent = j.database === 'connected' ? '🟢 MySQL' : '🔴 No DB';
      }
    } catch { if (statusEl) statusEl.textContent = '🔴 No DB'; }
  }

  async function loadHistory() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Loading…</td></tr>';
    try {
      const r = await fetch('/api/db/jobs?limit=50');
      if (!r.ok) {
        bodyEl.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#cb2431">Database not connected</td></tr>`;
        return;
      }
      const rows = await r.json();
      if (!rows.length) {
        bodyEl.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No jobs yet</td></tr>';
        return;
      }
      bodyEl.innerHTML = rows.map(j => `
        <tr>
          <td title="${j.filename}">${j.filename}</td>
          <td>${j.engine_requested}</td>
          <td><span class="status-${j.status}">${j.status}</span></td>
          <td>${j.confidence_avg != null ? (j.confidence_avg * 100).toFixed(1) + '%' : '—'}</td>
          <td>${j.processing_time_s != null ? j.processing_time_s : '—'}</td>
          <td>${j.created_at ? j.created_at.replace('T',' ').slice(0,19) : '—'}</td>
        </tr>
      `).join('');
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#cb2431">Error: ${e.message}</td></tr>`;
    }
  }

  await checkDb();
  await loadHistory();
  if (refreshBtn) refreshBtn.addEventListener('click', loadHistory);

  // Auto-refresh history when a job completes
  const origHandler = window._onJobDone;
  window._onJobDone = function(result) {
    if (origHandler) origHandler(result);
    setTimeout(loadHistory, 800);
  };
})();
