/* OCR System — app.js */
"use strict";

// When opened as file:// the browser can't resolve relative /api paths.
// Auto-detect and prefix with the local server origin.
const API_BASE = location.protocol === "file:" ? "http://localhost:8080" : "";

// ============================================================
// Sidebar navigation
// ============================================================
(function initSidebar() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.view;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
      const view = document.getElementById('view' + target.charAt(0).toUpperCase() + target.slice(1));
      if (view) view.classList.remove('hidden');
      if (target === 'order') initOrderView();
    });
  });
})();

// ============================================================
// Order view — clients → files + client CRUD
// ============================================================
let _orderLoaded = false;
let _clientModalEditId = null; // null = adding, integer = editing

function openClientModal(client = null) {
  _clientModalEditId = client ? client.id : null;
  document.getElementById('clientModalTitle').textContent = client ? 'Edit Client' : 'Add Client';
  document.getElementById('clientFormNameJa').value  = client ? (client.name_ja  || '') : '';
  document.getElementById('clientFormNameEn').value  = client ? (client.name_en  || '') : '';
  document.getElementById('clientFormCode').value    = client ? (client.code     || '') : '';
  document.getElementById('clientFormKeywords').value= client ? (client.keywords || '') : '';
  document.getElementById('clientModalBackdrop').classList.remove('hidden');
  document.getElementById('clientFormNameJa').focus();
}

function closeClientModal() {
  document.getElementById('clientModalBackdrop').classList.add('hidden');
}

document.getElementById('clientFormCancel')?.addEventListener('click', closeClientModal);
document.getElementById('clientModalBackdrop')?.addEventListener('click', e => {
  if (e.target === document.getElementById('clientModalBackdrop')) closeClientModal();
});

document.getElementById('clientFormSave')?.addEventListener('click', async () => {
  const nameJa   = document.getElementById('clientFormNameJa').value.trim();
  const nameEn   = document.getElementById('clientFormNameEn').value.trim();
  const code     = document.getElementById('clientFormCode').value.trim();
  const keywords = document.getElementById('clientFormKeywords').value.trim();
  if (!nameJa || !code) { showToast('Japanese name and code are required', true); return; }

  const saveBtn = document.getElementById('clientFormSave');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const url     = _clientModalEditId ? `${API_BASE}/api/db/clients/${_clientModalEditId}` : `${API_BASE}/api/db/clients`;
    const method  = _clientModalEditId ? 'PUT' : 'POST';
    const r = await fetch(url, {
      method, headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name_ja: nameJa, name_en: nameEn, code, keywords }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ detail: r.statusText }));
      throw new Error(err.detail || r.statusText);
    }
    closeClientModal();
    showToast(_clientModalEditId ? 'Client updated' : 'Client added');
    _orderLoaded = false;
    await loadOrderClients();
  } catch (e) {
    showToast('Error: ' + e.message, true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
});

document.getElementById('addClientBtn')?.addEventListener('click', () => openClientModal(null));

async function deleteClient(client) {
  if (!confirm(`Delete client "${client.name_ja}"?\nJobs linked to this client will become unassigned.`)) return;
  try {
    const r = await fetch(`${API_BASE}/api/db/clients/${client.id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    showToast('Client deleted');
    _orderLoaded = false;
    document.getElementById('orderFileList').innerHTML = '<div class="order-empty">← Select a client to view their files</div>';
    document.getElementById('orderFilesTitle').textContent = 'Select a client';
    await loadOrderClients();
  } catch (e) {
    showToast('Error: ' + e.message, true);
  }
}

async function initOrderView() {
  if (_orderLoaded) return;
  _orderLoaded = true;
  await loadOrderClients();
}

async function loadOrderClients() {
  const listEl = document.getElementById('orderClientList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="order-loading">Loading clients…</div>';
  try {
    const r = await fetch(`${API_BASE}/api/db/clients`);
    if (!r.ok) throw new Error('DB not connected');
    const clients = await r.json();
    if (!clients.length) {
      listEl.innerHTML = '<div class="order-empty">No clients. Click + Add to create one.</div>';
      return;
    }
    listEl.innerHTML = clients.map(c => {
      const initials = (c.name_en || c.code || c.name_ja || '?').slice(0,2).toUpperCase();
      const clientJson = JSON.stringify({id:c.id,name_ja:c.name_ja,name_en:c.name_en||'',code:c.code,keywords:c.keywords||''}).replace(/'/g,"&#39;");
      return `
      <div class="order-client-item" data-client-id="${c.id}"
           data-name-ja="${esc(c.name_ja)}" data-name-en="${esc(c.name_en || '')}">
        <span class="order-client-avatar">${esc(initials)}</span>
        <span class="order-client-label">
          <span class="order-client-name">${esc(c.name_ja)}</span>
          <span class="order-client-sub">${esc(c.name_en || c.code)}</span>
        </span>
        <span class="order-client-count">${c.total_jobs || 0}</span>
        <span class="client-actions">
          <button class="client-action-btn edit" title="Edit" data-client-json='${clientJson}'>✎</button>
          <button class="client-action-btn del" title="Delete">🗑</button>
        </span>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.order-client-item').forEach(item => {
      // Click on row (not on action buttons) → load files
      item.addEventListener('click', e => {
        if (e.target.closest('.client-actions')) return;
        listEl.querySelectorAll('.order-client-item').forEach(b => b.classList.remove('active'));
        item.classList.add('active');
        const titleEl = document.getElementById('orderFilesTitle');
        if (titleEl) titleEl.textContent = item.dataset.nameJa + (item.dataset.nameEn ? ' / ' + item.dataset.nameEn : '');
        loadOrderFiles(item.dataset.clientId);
      });

      // Edit button
      item.querySelector('.client-action-btn.edit')?.addEventListener('click', e => {
        e.stopPropagation();
        try {
          const c = JSON.parse(e.currentTarget.dataset.clientJson);
          openClientModal(c);
        } catch {}
      });

      // Delete button
      item.querySelector('.client-action-btn.del')?.addEventListener('click', e => {
        e.stopPropagation();
        const c = { id: parseInt(item.dataset.clientId), name_ja: item.dataset.nameJa };
        deleteClient(c);
      });
    });
  } catch (e) {
    listEl.innerHTML = `<div class="order-empty">Error: ${esc(e.message)}</div>`;
  }
}

async function loadOrderFiles(clientId) {
  const fileEl  = document.getElementById('orderFileList');
  const countEl = document.getElementById('orderFilesCount');
  if (!fileEl) return;
  fileEl.innerHTML = '<div class="order-loading">Loading…</div>';
  if (countEl) countEl.classList.add('hidden');
  try {
    const r = await fetch(`${API_BASE}/api/db/jobs?limit=500&client_id=${encodeURIComponent(clientId)}`);
    if (!r.ok) throw new Error(r.statusText);
    const jobs = await r.json();
    if (!jobs.length) {
      fileEl.innerHTML = `<div class="order-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        No files saved for this client yet.
        <small>Process a file on Home, then click "Save to DB".</small>
      </div>`;
      return;
    }
    if (countEl) { countEl.textContent = `${jobs.length} file${jobs.length !== 1 ? 's' : ''}`; countEl.classList.remove('hidden'); }

    const rows = jobs.map(j => {
      const confVal   = j.confidence_avg != null ? j.confidence_avg * 100 : null;
      const confStr   = confVal != null ? confVal.toFixed(1) + '%' : '—';
      const confClass = confVal == null ? '' : confVal >= 85 ? '' : confVal >= 65 ? 'conf-warn' : 'conf-low';
      const confBar   = confVal != null ? `<div class="conf-bar-wrap"><div class="conf-bar" style="width:${Math.round(confVal)}%"></div></div>` : '';
      const date      = j.created_at ? j.created_at.replace('T',' ').slice(0,16) : '—';
      const engine    = esc(j.primary_engine || j.engine_requested || '—');
      const statusCls = `badge badge-${esc(j.status)}`;
      const timeStr   = j.processing_time_s != null ? j.processing_time_s + 's' : '—';
      return `<tr data-job-id="${esc(j.job_id)}" data-filename="${esc(j.filename)}">
        <td class="col-name" title="${esc(j.filename)}">${esc(j.filename)}</td>
        <td class="col-engine"><span class="badge badge-engine">${engine}</span></td>
        <td class="col-status"><span class="${statusCls}"><span class="badge-dot"></span>${esc(j.status)}</span></td>
        <td class="col-conf"><span class="conf-cell ${confClass}">${confBar}<span>${confStr}</span></span></td>
        <td class="col-time">${esc(timeStr)}</td>
        <td class="col-date">${esc(date)}</td>
      </tr>`;
    }).join('');

    fileEl.innerHTML = `<table class="order-files-table">
      <thead><tr>
        <th>Filename</th>
        <th>Engine</th>
        <th>Status</th>
        <th style="text-align:right">Confidence</th>
        <th style="text-align:right">Time</th>
        <th>Date</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    fileEl.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', () => openOrderPreview(tr.dataset.jobId, tr.dataset.filename));
    });
  } catch (e) {
    fileEl.innerHTML = `<div class="order-empty">Error: ${esc(e.message)}</div>`;
  }
}

async function openOrderPreview(jobId, filename) {
  const preview = document.getElementById('orderPreview');
  const titleEl = document.getElementById('orderPreviewTitle');
  const textEl  = document.getElementById('orderPreviewText');
  if (!preview) return;
  titleEl.textContent = filename || jobId;
  textEl.textContent  = 'Loading…';
  preview.classList.remove('hidden');
  try {
    const r = await fetch(`${API_BASE}/api/ocr/result/${encodeURIComponent(jobId)}`);
    if (!r.ok) throw new Error('Result not available (status: ' + r.status + ')');
    const data = await r.json();
    textEl.textContent = data.fused_text || data.text || data.markdown || JSON.stringify(data, null, 2);
  } catch (e) {
    textEl.textContent = 'Could not load result: ' + e.message;
  }
}

document.getElementById('orderPreviewClose')?.addEventListener('click', () => {
  document.getElementById('orderPreview')?.classList.add('hidden');
});

document.getElementById('orderRefreshBtn')?.addEventListener('click', () => {
  _orderLoaded = false;
  document.getElementById('orderClientList').innerHTML = '<div class="order-loading">Loading clients…</div>';
  document.getElementById('orderFileList').innerHTML   = `<div class="order-empty">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    Select a client to view their files
  </div>`;
  document.getElementById('orderFilesTitle').textContent = 'Select a client';
  const countEl = document.getElementById('orderFilesCount');
  if (countEl) countEl.classList.add('hidden');
  initOrderView();
});

let selectedFile   = null;
let selectedEngine = "all";
let currentResult  = null;
let currentJobId   = null;
let gpuAvailable   = false;  // updated from /api/health on load

// Engine selector
document.querySelectorAll(".toggle").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.engine === "deepseek" && !gpuAvailable) {
      showToast("DeepSeek-OCR requires a CUDA GPU — not available on this machine.", true);
      return;
    }
    document.querySelectorAll(".toggle").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedEngine = btn.dataset.engine;
  });
});

// Mark DeepSeek button as GPU-required based on health check
(async function checkGpu() {
  try {
    const r = await fetch(`${API_BASE}/api/health`);
    const j = await r.json();
    gpuAvailable = !!j.gpu_available;
  } catch { gpuAvailable = false; }
  const dsBtn = document.querySelector('.toggle[data-engine="deepseek"]');
  if (dsBtn && !gpuAvailable) {
    dsBtn.classList.add("gpu-required");
    dsBtn.title = "Requires CUDA GPU — not available on this machine";
    // Append a small badge if not already there
    if (!dsBtn.querySelector(".gpu-badge")) {
      const badge = document.createElement("span");
      badge.className = "gpu-badge";
      badge.textContent = " ⚠ GPU";
      dsBtn.appendChild(badge);
    }
  }
})();

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

  currentJobId  = null;
  currentResult = null;
  const saveBtn = document.getElementById("saveDbBtn");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Save to DB";
    saveBtn.classList.remove("saved");
  }

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
    currentJobId = job_id;
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
  const clientPill = res.client
    ? `<span class="meta-pill client">${esc(res.client.name_ja)} / ${esc(res.client.name_en)}</span>`
    : "";
  document.getElementById("resultsMeta").innerHTML =
    clientPill +
    `<span class="meta-pill engine">${esc(res.primary_engine || "—")}</span>` +
    (conf ? `<span class="meta-pill ${confClass}">${conf} confidence</span>` : "") +
    (res.processing_time_s ? `<span class="meta-pill">${res.processing_time_s}s</span>` : "");

  document.getElementById("fusedText").textContent   = res.fused_text || "(no text extracted)";
  document.getElementById("doclingText").textContent  = res.docling?.markdown || res.docling?.text || "(Docling produced no output)";
  const dsErr = res.deepseek?.error || "";
  document.getElementById("deepseekText").textContent =
    res.deepseek?.markdown || res.deepseek?.text ||
    (dsErr ? dsErr : "(DeepSeek-OCR not run — requires a CUDA GPU)");

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
  if (res.job_id) currentJobId = res.job_id;
  const saveBtn = document.getElementById("saveDbBtn");
  if (saveBtn) {
    saveBtn.disabled = !currentJobId;
    saveBtn.textContent = "Save to DB";
    saveBtn.classList.remove("saved");
  }
  document.getElementById("resultsCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

// Save to DB / Copy / Download buttons
const saveDbBtn = document.getElementById("saveDbBtn");
if (saveDbBtn) {
  saveDbBtn.addEventListener("click", async () => {
    if (!currentResult || !currentJobId) {
      showToast("No extracted result to save.", true);
      return;
    }
    saveDbBtn.disabled = true;
    const prevLabel = saveDbBtn.textContent;
    saveDbBtn.textContent = "Saving…";
    try {
      const filename = (selectedFile && selectedFile.name) || currentResult.filename || "unknown";
      const r = await fetch(`${API_BASE}/api/ocr/save/${encodeURIComponent(currentJobId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename,
          engine: selectedEngine,
          result: currentResult,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(err.detail || "Save failed");
      }
      const saved = await r.json();
      if (saved.client) {
        currentResult.client = saved.client;
      }
      saveDbBtn.classList.add("saved");
      saveDbBtn.textContent = "Saved ✓";
      const clientTxt = saved.client
        ? ` → ${saved.client.name_ja} / ${saved.client.name_en}`
        : "";
      showToast(`Saved "${saved.filename}" to database${clientTxt}`);
      if (typeof window._onJobSaved === "function") window._onJobSaved(saved);
    } catch (err) {
      saveDbBtn.textContent = prevLabel;
      showToast("Save failed: " + err.message, true);
    } finally {
      saveDbBtn.disabled = false;
    }
  });
}

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
  const statusEl     = document.getElementById('dbStatus');
  const bodyEl       = document.getElementById('historyBody');
  const refreshBtn   = document.getElementById('refreshHistoryBtn');
  const clientFilter = document.getElementById('historyClientFilter');

  async function checkDb() {
    try {
      const r = await fetch(`${API_BASE}/api/health`);
      const j = await r.json();
      if (statusEl) {
        statusEl.textContent = j.database === 'connected' ? '🟢 MySQL' : '🔴 No DB';
      }
    } catch { if (statusEl) statusEl.textContent = '🔴 No DB'; }
  }

  async function loadClients() {
    if (!clientFilter) return;
    const prev = clientFilter.value;
    try {
      const r = await fetch(`${API_BASE}/api/db/clients`);
      if (!r.ok) return;
      const clients = await r.json();
      clientFilter.innerHTML =
        '<option value="">All Clients</option>' +
        clients.map(c =>
          `<option value="${c.id}">${esc(c.name_ja)} / ${esc(c.name_en)} (${c.total_jobs || 0})</option>`
        ).join('');
      if (prev) clientFilter.value = prev;
    } catch { /* ignore when DB unavailable */ }
  }

  async function loadHistory() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Loading…</td></tr>';
    try {
      const cid = clientFilter && clientFilter.value ? `&client_id=${encodeURIComponent(clientFilter.value)}` : '';
      const r = await fetch(`${API_BASE}/api/db/jobs?limit=50${cid}`);
      if (!r.ok) {
        bodyEl.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#cb2431">Database not connected</td></tr>';
        return;
      }
      const rows = await r.json();
      if (!rows.length) {
        bodyEl.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No jobs yet</td></tr>';
        return;
      }
      bodyEl.innerHTML = rows.map(j => {
        const clientLabel = j.client_name_ja
          ? `${esc(j.client_name_ja)} (${esc(j.client_name_en)})`
          : '—';
        return `
        <tr data-job-id="${esc(j.job_id)}">
          <td style="text-align:center"><input type="checkbox" class="job-chk" data-job-id="${esc(j.job_id)}"></td>
          <td title="${esc(j.filename)}">${esc(j.filename)}</td>
          <td title="${clientLabel}">${clientLabel}</td>
          <td>${esc(j.engine_requested)}</td>
          <td><span class="status-${esc(j.status)}">${esc(j.status)}</span></td>
          <td>${j.confidence_avg != null ? (j.confidence_avg * 100).toFixed(1) + '%' : '—'}</td>
          <td>${j.processing_time_s != null ? j.processing_time_s : '—'}</td>
          <td>${j.created_at ? esc(j.created_at.replace('T',' ').slice(0,19)) : '—'}</td>
          <td><button class="del-job-btn" data-job-id="${esc(j.job_id)}" title="Delete this job">🗑</button></td>
        </tr>`;
      }).join('');

      // Select-all checkbox
      const selectAll = document.getElementById('selectAllJobs');
      if (selectAll) {
        selectAll.checked = false;
        selectAll.addEventListener('change', () => {
          bodyEl.querySelectorAll('.job-chk').forEach(chk => { chk.checked = selectAll.checked; });
          updateBulkBar();
        });
      }

      // Per-row checkboxes → update bulk bar
      bodyEl.querySelectorAll('.job-chk').forEach(chk => {
        chk.addEventListener('change', updateBulkBar);
      });

      // Wire single delete buttons
      bodyEl.querySelectorAll('.del-job-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const jobId = btn.dataset.jobId;
          if (!confirm('Delete this job record? This cannot be undone.')) return;
          btn.disabled = true;
          try {
            const r = await fetch(`${API_BASE}/api/db/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
            const row = btn.closest('tr');
            if (row) row.remove();
            if (!bodyEl.querySelector('tr[data-job-id]')) {
              bodyEl.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted)">No jobs yet</td></tr>';
            }
            updateBulkBar();
            showToast('Job deleted.');
          } catch (e) {
            btn.disabled = false;
            showToast('Delete failed: ' + e.message, true);
          }
        });
      });
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#cb2431">Error: ${esc(e.message)}</td></tr>`;
    }
  }

  await checkDb();
  await loadClients();
  await loadHistory();
  if (refreshBtn) refreshBtn.addEventListener('click', () => { loadClients(); loadHistory(); });
  if (clientFilter) clientFilter.addEventListener('change', loadHistory);

  // Bulk-delete bar helpers
  const bulkBar = document.getElementById('bulkBar');
  const bulkCount = document.getElementById('bulkCount');
  const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
  const bulkCancelBtn = document.getElementById('bulkCancelBtn');

  function getCheckedIds() {
    return Array.from(bodyEl.querySelectorAll('.job-chk:checked')).map(c => c.dataset.jobId);
  }

  function updateBulkBar() {
    const ids = getCheckedIds();
    if (!bulkBar) return;
    if (ids.length > 0) {
      bulkBar.classList.remove('hidden');
      if (bulkCount) bulkCount.textContent = ids.length + ' selected';
    } else {
      bulkBar.classList.add('hidden');
    }
    const allChks = bodyEl.querySelectorAll('.job-chk');
    const selectAll = document.getElementById('selectAllJobs');
    if (selectAll && allChks.length > 0) {
      selectAll.checked = ids.length === allChks.length;
      selectAll.indeterminate = ids.length > 0 && ids.length < allChks.length;
    }
  }

  if (bulkCancelBtn) {
    bulkCancelBtn.addEventListener('click', () => {
      bodyEl.querySelectorAll('.job-chk').forEach(c => { c.checked = false; });
      const selectAll = document.getElementById('selectAllJobs');
      if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
      updateBulkBar();
    });
  }

  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener('click', async () => {
      const ids = getCheckedIds();
      if (!ids.length) return;
      if (!confirm(`Delete ${ids.length} job(s)? This cannot be undone.`)) return;
      bulkDeleteBtn.disabled = true;
      try {
        const r = await fetch(`${API_BASE}/api/db/jobs/bulk-delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_ids: ids }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
        const { deleted } = await r.json();
        ids.forEach(id => {
          const row = bodyEl.querySelector(`tr[data-job-id="${id}"]`);
          if (row) row.remove();
        });
        if (!bodyEl.querySelector('tr[data-job-id]')) {
          bodyEl.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted)">No jobs yet</td></tr>';
        }
        updateBulkBar();
        showToast(`${deleted} job(s) deleted.`);
      } catch (e) {
        showToast('Bulk delete failed: ' + e.message, true);
      }
      bulkDeleteBtn.disabled = false;
    });
  }

  // Auto-refresh history when a job is saved to MySQL
  const origSavedHandler = window._onJobSaved;
  window._onJobSaved = function(saved) {
    if (origSavedHandler) origSavedHandler(saved);
    setTimeout(() => { loadClients(); loadHistory(); }, 250);
  };
})();
