/* OCR System — app.js */
"use strict";

// When opened as file:// the browser can't resolve relative /api paths.
// Auto-detect and prefix with the local server origin.
const API_BASE = location.protocol === "file:" ? "http://localhost:8080" : "";

// ============================================================
// Sidebar navigation
// ============================================================
(function initSidebar() {
  const appShell = document.querySelector('.app-shell');
  const toggleBtn = document.getElementById('sidebarToggleBtn');
  const mainArea = document.querySelector('.main-area');

  if (appShell) {
    try {
      if (window.innerWidth > 1024 && localStorage.getItem('ocr_sidebar_collapsed') === '1') {
        appShell.classList.add('sidebar-collapsed');
      }
    } catch {}
  }

  toggleBtn?.addEventListener('click', () => {
    if (!appShell) return;
    if (window.innerWidth <= 1024 && window.innerWidth > 768) {
      appShell.classList.toggle('sidebar-expanded');
    } else {
      const collapsed = appShell.classList.toggle('sidebar-collapsed');
      try { localStorage.setItem('ocr_sidebar_collapsed', collapsed ? '1' : '0'); } catch {}
    }
  });

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.view;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
      const view = document.getElementById('view' + target.charAt(0).toUpperCase() + target.slice(1));
      if (view) view.classList.remove('hidden');
      appShell?.classList.remove('sidebar-expanded');
      if (mainArea) mainArea.scrollTop = 0;
      if (target === 'order') initOrderView();
      if (target === 'clients') initClientsView();
      if (target === 'productMaster') initProductMasterView();
    });
  });
})();

// ============================================================
// Order view — Excel-style spreadsheet (all clients)
// ============================================================
let _orderLoaded      = false;
let _orderAllJobs     = [];           // full data set
let _orderSelectedIds = new Set();    // selected job_ids for bulk delete
let _orderSort        = { col: 'date', dir: -1 }; // default: newest first
let _clientModalEditId = null;

// ── Client modal ──────────────────────────────────────────────
function openClientModal(client = null) {
  _clientModalEditId = client ? client.id : null;
  document.getElementById('clientModalTitle').textContent = client ? '取引先情報を編集' : '取引先を追加';
  document.getElementById('clientFormNameJa').value   = client ? (client.name_ja  || '') : '';
  document.getElementById('clientFormNameEn').value   = client ? (client.name_en  || '') : '';
  document.getElementById('clientFormCode').value     = client ? (client.code     || '') : '';
  document.getElementById('clientFormKeywords').value = client ? (client.keywords || '') : '';
  const rowInput = document.getElementById('clientFormHeaderRow');
  if (rowInput) rowInput.value = client && client.header_row != null ? client.header_row : 1;
  const colsInput = document.getElementById('clientFormHeadingColumns');
  if (colsInput) colsInput.value = client ? (client.heading_columns || '') : '';

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
  const headerRow = parseInt(document.getElementById('clientFormHeaderRow')?.value || '1', 10) || 1;
  const headingColumns = (document.getElementById('clientFormHeadingColumns')?.value || '').trim();

  if (!nameJa || !code) { showToast('取引先名(日本語)とコードは必須項目です', true); return; }
  const saveBtn = document.getElementById('clientFormSave');
  saveBtn.disabled = true; saveBtn.textContent = '保存中…';
  try {
    const url    = _clientModalEditId ? `${API_BASE}/api/db/clients/${_clientModalEditId}` : `${API_BASE}/api/db/clients`;
    const method = _clientModalEditId ? 'PUT' : 'POST';
    const r = await fetch(url, { method, headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        name_ja: nameJa,
        name_en: nameEn,
        code,
        keywords,
        header_row: headerRow,
        heading_columns: headingColumns
      }) });
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).detail || r.statusText);
    closeClientModal();
    showToast(_clientModalEditId ? '取引先情報を更新しました' : '取引先を追加しました');
    await reloadOrderSheet();
    if (typeof reloadClientsSheet === 'function') await reloadClientsSheet();
    if (typeof reloadProductSheet === 'function' && _productsLoaded) await reloadProductSheet();
    if (typeof loadHomeUploadClients === 'function') await loadHomeUploadClients(true);
  } catch (e) { showToast('エラー: ' + e.message, true); }
  finally { saveBtn.disabled = false; saveBtn.textContent = '取引先を保存'; }
});
document.getElementById('addClientBtn')?.addEventListener('click', () => openClientModal(null));

// ── Main sheet logic ──────────────────────────────────────────
async function initOrderView() {
  if (_orderLoaded) return;
  await reloadOrderSheet();
  _orderLoaded = true;
}

async function reloadOrderSheet() {
  const tbody = document.getElementById('orderSheetBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="10" class="sheet-loading">読み込み中…</td></tr>';

  try {
    // Fetch all jobs + client list in parallel (dbFetch falls back to :8081 if primary has no DB)
    const [jobsRes, clientsRes] = await Promise.all([
      dbFetch('/api/db/jobs?limit=500'),
      dbFetch('/api/db/clients'),
    ]);
    if (!jobsRes || !jobsRes.ok) throw new Error('Database not connected');
    _orderAllJobs = await jobsRes.json();
    const validIds = new Set(_orderAllJobs.map(j => j.job_id));
    for (const id of Array.from(_orderSelectedIds)) {
      if (!validIds.has(id)) _orderSelectedIds.delete(id);
    }
    const clients = clientsRes.ok ? await clientsRes.json() : [];

    // Populate client filter
    const cf = document.getElementById('orderClientFilter');
    if (cf) {
      const prev = cf.value;
      cf.innerHTML = '<option value="">すべての取引先</option>' +
        clients.map(c => `<option value="${c.id}">${esc(c.name_ja)}${c.name_en ? ' / '+esc(c.name_en) : ''}</option>`).join('');
      cf.value = prev;
    }

    renderOrderSheet();
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="sheet-loading" style="color:var(--danger)">Error: ${esc(e.message)}</td></tr>`;
  }
}

function syncHomeHistoryRemoved(deletedIds) {
  const bodyEl = document.getElementById('historyBody');
  if (!bodyEl) return;
  const deletedSet = new Set(deletedIds);
  bodyEl.querySelectorAll('tr[data-job-id]').forEach(row => {
    if (deletedSet.has(row.dataset.jobId)) row.remove();
  });
  if (!bodyEl.querySelector('tr[data-job-id]')) {
    bodyEl.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted)">No jobs yet</td></tr>';
  }
  const chks = Array.from(bodyEl.querySelectorAll('.job-chk'));
  const checkedCount = chks.filter(c => c.checked).length;
  const bulkBar = document.getElementById('bulkBar');
  const bulkCount = document.getElementById('bulkCount');
  const selectAll = document.getElementById('selectAllJobs');
  if (bulkBar) bulkBar.classList.toggle('hidden', checkedCount === 0);
  if (bulkCount) bulkCount.textContent = checkedCount + ' selected';
  if (selectAll) {
    selectAll.checked = chks.length > 0 && checkedCount === chks.length;
    selectAll.indeterminate = checkedCount > 0 && checkedCount < chks.length;
  }
}

function updateOrderBulkUI() {
  const bulkBtn = document.getElementById('orderBulkDeleteBtn');
  const bulkCount = document.getElementById('orderBulkCount');
  const selectAll = document.getElementById('orderSelectAll');
  const selectedTotal = _orderSelectedIds.size;

  if (bulkBtn) bulkBtn.classList.toggle('hidden', selectedTotal === 0);
  if (bulkCount) bulkCount.textContent = String(selectedTotal);

  if (selectAll) {
    const visibleIds = getFilteredSorted().map(j => j.job_id);
    if (!visibleIds.length) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    } else {
      const checkedVisible = visibleIds.filter(id => _orderSelectedIds.has(id)).length;
      selectAll.checked = checkedVisible === visibleIds.length;
      selectAll.indeterminate = checkedVisible > 0 && checkedVisible < visibleIds.length;
    }
  }
}

async function deleteOrderJob(jobId, filename, triggerBtn = null) {
  if (!jobId) return false;
  const label = filename || jobId;
  if (!confirm(`発注書「${label}」を削除しますか？\nこの操作は元に戻せません。`)) return false;
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const r = await dbFetch(`/api/db/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    if (!r || !r.ok) {
      const err = r ? await r.json().catch(() => ({})) : {};
      throw new Error(err.detail || (r ? r.statusText : '削除に失敗しました'));
    }
    _orderAllJobs = _orderAllJobs.filter(j => j.job_id !== jobId);
    _orderSelectedIds.delete(jobId);
    renderOrderSheet();
    document.getElementById('orderPreview')?.classList.add('hidden');
    syncHomeHistoryRemoved([jobId]);
    showToast(`発注書「${label}」を削除しました`);
    return true;
  } catch (e) {
    showToast('削除に失敗しました: ' + e.message, true);
    return false;
  } finally {
    if (triggerBtn && document.body.contains(triggerBtn)) triggerBtn.disabled = false;
  }
}

function getFilteredSorted() {
  const q       = (document.getElementById('orderSearch')?.value || '').toLowerCase();
  const clientF = document.getElementById('orderClientFilter')?.value || '';
  const statusF = document.getElementById('orderStatusFilter')?.value || '';
  const engineF = document.getElementById('orderEngineFilter')?.value || '';

  let rows = _orderAllJobs.filter(j => {
    if (q       && !(j.filename || '').toLowerCase().includes(q)) return false;
    if (clientF && String(j.client_id) !== clientF) return false;
    if (statusF && j.status !== statusF) return false;
    if (engineF && !(j.primary_engine || j.engine_requested || '').toLowerCase().includes(engineF)) return false;
    return true;
  });

  const { col, dir } = _orderSort;
  rows.sort((a, b) => {
    let av, bv;
    if (col === 'client')     { av = (a.client_name_ja||'').toLowerCase(); bv = (b.client_name_ja||'').toLowerCase(); }
    else if (col === 'filename'){ av = (a.filename||'').toLowerCase();      bv = (b.filename||'').toLowerCase(); }
    else if (col === 'engine'){ av = (a.primary_engine||a.engine_requested||'').toLowerCase(); bv = (b.primary_engine||b.engine_requested||'').toLowerCase(); }
    else if (col === 'status'){ av = a.status||''; bv = b.status||''; }
    else if (col === 'confidence'){ av = a.confidence_avg ?? -1; bv = b.confidence_avg ?? -1; }
    else if (col === 'time')  { av = a.processing_time_s ?? -1; bv = b.processing_time_s ?? -1; }
    else                      { av = a.created_at||''; bv = b.created_at||''; }
    if (av < bv) return -dir; if (av > bv) return dir; return 0;
  });
  return rows;
}

function renderOrderSheet() {
  const tbody   = document.getElementById('orderSheetBody');
  const countEl = document.getElementById('orderRowCount');
  if (!tbody) return;

  const rows = getFilteredSorted();
  if (countEl) countEl.textContent = `${rows.length} 件`;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="sheet-empty">条件に一致する発注書データが見つかりませんでした。</td></tr>';
    updateOrderBulkUI();
    return;
  }

  tbody.innerHTML = rows.map((j, idx) => {
    const isChecked = _orderSelectedIds.has(j.job_id);
    const clientName = j.client_name_ja
      ? `<span class="sheet-client">${esc(j.client_name_ja)}</span>${j.client_name_en ? `<span class="sheet-client-en">${esc(j.client_name_en)}</span>` : ''}`
      : '<span class="sheet-unassigned">—</span>';
    const engine     = esc(j.primary_engine || j.engine_requested || '—');
    const statusCls  = `badge badge-${esc(j.status)}`;
    const statusLabels = { done: '完了', error: 'エラー', processing: '処理中', queued: '待機中' };
    const statusText = statusLabels[j.status] || esc(j.status);
    const confVal    = j.confidence_avg != null ? j.confidence_avg * 100 : null;
    const confStr    = confVal != null ? confVal.toFixed(1) + '%' : '—';
    const confClass  = confVal == null ? '' : confVal >= 85 ? '' : confVal >= 65 ? 'conf-warn' : 'conf-low';
    const confBar    = confVal != null
      ? `<div class="conf-bar-wrap"><div class="conf-bar" style="width:${Math.round(confVal)}%"></div></div>`
      : '';
    const date       = j.created_at ? j.created_at.replace('T',' ').slice(0,16) : '—';
    const timeStr    = j.processing_time_s != null ? j.processing_time_s + 's' : '—';
    return `<tr class="${idx % 2 === 1 ? 'row-alt' : ''}${isChecked ? ' row-selected' : ''}"
               data-job-id="${esc(j.job_id)}" data-filename="${esc(j.filename)}">
      <td class="col-check"><input type="checkbox" class="order-row-chk" data-job-id="${esc(j.job_id)}" ${isChecked ? 'checked' : ''} /></td>
      <td class="col-no">${idx + 1}</td>
      <td class="col-client">${clientName}</td>
      <td class="col-file" title="${esc(j.filename)}">${esc(j.filename)}</td>
      <td class="col-engine"><span class="badge badge-engine">${engine}</span></td>
      <td class="col-status"><span class="${statusCls}"><span class="badge-dot"></span>${statusText}</span></td>
      <td class="col-conf"><span class="conf-cell ${confClass}">${confBar}<span>${confStr}</span></span></td>
      <td class="col-time">${esc(timeStr)}</td>
      <td class="col-date">${esc(date)}</td>
      <td class="col-preview">
        <div class="order-row-actions">
          <button class="preview-btn" data-job-id="${esc(j.job_id)}" data-filename="${esc(j.filename)}" title="プレビュー表示">▶</button>
          <button class="order-del-btn" data-job-id="${esc(j.job_id)}" data-filename="${esc(j.filename)}" title="この発注書を削除">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-job-id]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.preview-btn, .order-del-btn, .col-check, .order-row-chk')) return;
      openOrderPreview(tr.dataset.jobId, tr.dataset.filename);
    });
  });
  tbody.querySelectorAll('.order-row-chk').forEach(chk => {
    chk.addEventListener('change', e => {
      e.stopPropagation();
      const jobId = chk.dataset.jobId;
      if (chk.checked) _orderSelectedIds.add(jobId);
      else _orderSelectedIds.delete(jobId);
      chk.closest('tr')?.classList.toggle('row-selected', chk.checked);
      updateOrderBulkUI();
    });
  });
  tbody.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openOrderPreview(btn.dataset.jobId, btn.dataset.filename); });
  });
  tbody.querySelectorAll('.order-del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteOrderJob(btn.dataset.jobId, btn.dataset.filename, btn);
    });
  });
  updateOrderBulkUI();
}

// ── Select All & Bulk Delete ──────────────────────────────────
document.getElementById('orderSelectAll')?.addEventListener('change', e => {
  const checked = !!e.target.checked;
  getFilteredSorted().forEach(j => {
    if (checked) _orderSelectedIds.add(j.job_id);
    else _orderSelectedIds.delete(j.job_id);
  });
  renderOrderSheet();
});

document.getElementById('orderBulkDeleteBtn')?.addEventListener('click', async () => {
  const ids = Array.from(_orderSelectedIds);
  if (!ids.length) return;
  if (!confirm(`選択した ${ids.length} 件の発注書を削除しますか？\nこの操作は元に戻せません。`)) return;
  const bulkBtn = document.getElementById('orderBulkDeleteBtn');
  if (bulkBtn) bulkBtn.disabled = true;
  try {
    const r = await dbFetch('/api/db/jobs/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_ids: ids }),
    });
    if (!r || !r.ok) {
      const err = r ? await r.json().catch(() => ({})) : {};
      throw new Error(err.detail || (r ? r.statusText : '一括削除に失敗しました'));
    }
    const { deleted } = await r.json();
    const deletedSet = new Set(ids);
    _orderAllJobs = _orderAllJobs.filter(j => !deletedSet.has(j.job_id));
    _orderSelectedIds.clear();
    renderOrderSheet();
    document.getElementById('orderPreview')?.classList.add('hidden');
    syncHomeHistoryRemoved(ids);
    showToast(`${deleted ?? ids.length} 件の発注書を削除しました`);
  } catch (e) {
    showToast('一括削除に失敗しました: ' + e.message, true);
  } finally {
    if (bulkBtn) bulkBtn.disabled = false;
  }
});

// ── Sorting ───────────────────────────────────────────────────
document.querySelectorAll('#orderSheet .sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (_orderSort.col === col) { _orderSort.dir *= -1; }
    else { _orderSort = { col, dir: 1 }; }
    document.querySelectorAll('#orderSheet .sortable').forEach(h => {
      const ic = h.querySelector('.sort-icon');
      if (ic) ic.textContent = h.dataset.col === col ? (_orderSort.dir === 1 ? '↑' : '↓') : '↕';
    });
    renderOrderSheet();
  });
});

// ── Filters ───────────────────────────────────────────────────
['orderSearch','orderClientFilter','orderStatusFilter','orderEngineFilter'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => renderOrderSheet());
});

// ── Refresh ───────────────────────────────────────────────────
document.getElementById('orderRefreshBtn')?.addEventListener('click', async () => {
  _orderLoaded = false;
  await reloadOrderSheet();
  _orderLoaded = true;
});

// ── CSV Export ────────────────────────────────────────────────
document.getElementById('orderExportBtn')?.addEventListener('click', () => {
  const rows = getFilteredSorted();
  const header = ['No.','Client (JA)','Client (EN)','Filename','Engine','Status','Confidence (%)','Time (s)','Saved At'];
  const lines = [header, ...rows.map((j, i) => [
    i+1,
    j.client_name_ja || '',
    j.client_name_en || '',
    j.filename || '',
    j.primary_engine || j.engine_requested || '',
    j.status || '',
    j.confidence_avg != null ? (j.confidence_avg * 100).toFixed(1) : '',
    j.processing_time_s ?? '',
    j.created_at ? j.created_at.replace('T',' ').slice(0,19) : '',
  ])].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'orders_' + new Date().toISOString().slice(0,10) + '.csv' });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  showToast(`Exported ${rows.length} rows`);
});

// ============================================================
// Clients view — Directory & Rule Management
// ============================================================
let _clientsViewLoaded = false;
let _clientsAllList    = [];
let _clientsSort       = { col: 'code', dir: 1 };
let _clientHeadingTarget = null;

const HEADING_PRESETS = {
  national: {
    row: 8,
    columns: '品目, 産地, 栽培区分, 規格・入数, 単価/p (税別), 単価/cs, JANコード, 備考・今週の産地状況, 9/21 月 要望, 9/22 火 要望, 9/23 水 要望, 9/24 木 要望, 9/25 金 要望, 9/26 土 要望'
  },
  fusui: {
    row: 8,
    columns: '商品名, 規格母目, C/S入数, 単価, 金額, 備考'
  },
  standard: {
    row: 1,
    columns: '商品コード, 商品名, 規格, 数量, 単価, 金額'
  },
  wholesale: {
    row: 1,
    columns: '品番, 品名, 規格, 入数, 単価, 金額, 納品日'
  },
  simple: {
    row: 1,
    columns: '品名, 数量, 単価, 金額'
  }
};

function updateHeadingModalLivePreview() {
  const colsTextarea = document.getElementById('clientHeadingColumns');
  const countEl = document.getElementById('clientHeadingColCount');
  const previewBar = document.getElementById('headingLivePreviewBar');
  const previewDateInput = document.getElementById('clientHeadingPreviewDate');
  if (!colsTextarea || !previewBar) return;

  const rawVal = colsTextarea.value || '';
  const cols = rawVal
    .split(/[,、\n]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (countEl) {
    countEl.textContent = `${cols.length} 列`;
  }

  if (cols.length === 0) {
    previewBar.innerHTML = '<div class="heading-live-preview-empty">上記に見出し列名を入力するか、テンプレートを選択するとプレビューが表示されます</div>';
    return;
  }

  const previewDateVal = (previewDateInput?.value || '').trim();
  const previewSheet = /^\d{4}-\d{2}-\d{2}$/.test(previewDateVal)
    ? { headingBaseDate: previewDateVal, rows: [] }
    : null;

  previewBar.innerHTML = cols.map((col, idx) => {
    const formattedCol = previewSheet ? _formatHeadingWithDate(col, previewSheet) : col;
    return `<div class="heading-live-preview-cell" title="第 ${idx + 1} 列: ${esc(formattedCol)}">
      <div class="heading-cell-idx">${idx + 1}</div>
      <div class="heading-cell-content">${formatHeaderHtml(formattedCol)}</div>
    </div>`;
  }).join('');
}

function openClientHeadingModal(client) {
  _clientHeadingTarget = client;
  const titleEl = document.getElementById('clientHeadingModalTitle');
  if (titleEl) {
    titleEl.textContent = `見出しフォーマット設定 — ${client.name_ja || client.code}`;
  }
  const rowInput  = document.getElementById('clientHeadingRow');
  const colsInput = document.getElementById('clientHeadingColumns');
  const presetSel = document.getElementById('clientHeadingPreset');
  const previewDateInput = document.getElementById('clientHeadingPreviewDate');

  const curRow  = client.header_row != null ? client.header_row : 1;
  const curCols = client.heading_columns || '';

  if (rowInput) rowInput.value = curRow;
  if (colsInput) colsInput.value = curCols;
  if (previewDateInput) {
    const xlsModalEl = document.getElementById('xlsModal');
    const xlsOpen = xlsModalEl && !xlsModalEl.classList.contains('hidden');
    const activeSheet = xlsOpen && Array.isArray(_xlsSheets) ? _xlsSheets[_xlsActiveSheet] : null;
    previewDateInput.value = xlsOpen
      ? (document.getElementById('xlsHeadingBaseDate')?.value || _detectSheetInitialIsoDate(activeSheet) || '')
      : '';
  }

  if (presetSel) {
    let matched = 'custom';
    for (const [key, p] of Object.entries(HEADING_PRESETS)) {
      if (p.row === curRow && p.columns.replace(/\s+/g, '') === curCols.replace(/\s+/g, '')) {
        matched = key;
        break;
      }
    }
    presetSel.value = matched;
  }

  updateHeadingModalLivePreview();
  document.getElementById('clientHeadingModalBackdrop')?.classList.remove('hidden');
  rowInput?.focus();
}

function closeClientHeadingModal() {
  document.getElementById('clientHeadingModalBackdrop')?.classList.add('hidden');
  _clientHeadingTarget = null;
}

document.getElementById('clientHeadingCancel')?.addEventListener('click', closeClientHeadingModal);
document.getElementById('clientHeadingModalBackdrop')?.addEventListener('click', e => {
  if (e.target === document.getElementById('clientHeadingModalBackdrop')) closeClientHeadingModal();
});

document.getElementById('clientHeadingPreset')?.addEventListener('change', e => {
  const presetKey = e.target.value;
  if (HEADING_PRESETS[presetKey]) {
    const p = HEADING_PRESETS[presetKey];
    const rowInput  = document.getElementById('clientHeadingRow');
    const colsInput = document.getElementById('clientHeadingColumns');
    if (rowInput) rowInput.value = p.row;
    if (colsInput) colsInput.value = p.columns;
    updateHeadingModalLivePreview();
  }
});

document.getElementById('clientHeadingColumns')?.addEventListener('input', updateHeadingModalLivePreview);
document.getElementById('clientHeadingColumns')?.addEventListener('change', updateHeadingModalLivePreview);
document.getElementById('clientHeadingPreviewDate')?.addEventListener('input', updateHeadingModalLivePreview);
document.getElementById('clientHeadingPreviewDate')?.addEventListener('change', updateHeadingModalLivePreview);

document.getElementById('clientHeadingSave')?.addEventListener('click', async () => {
  if (!_clientHeadingTarget) return;
  const rowVal  = parseInt(document.getElementById('clientHeadingRow')?.value || '1', 10) || 1;
  const colsVal = (document.getElementById('clientHeadingColumns')?.value || '').trim();

  const saveBtn = document.getElementById('clientHeadingSave');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }

  try {
    const r = await dbFetch(`/api/db/clients/${_clientHeadingTarget.id}/heading-format`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        header_row: rowVal,
        heading_columns: colsVal
      })
    });
    if (!r || !r.ok) {
      const err = r ? await r.json().catch(() => ({})) : {};
      throw new Error(err.detail || (r ? r.statusText : '保存に失敗しました'));
    }
    const targetId = _clientHeadingTarget.id;
    const targetLabel = _clientHeadingTarget.name_ja || _clientHeadingTarget.code;
    closeClientHeadingModal();
    showToast(`「${targetLabel}」の見出し設定を保存しました`);
    await reloadClientsSheet();
    if (typeof reloadProductSheet === 'function' && _productsLoaded) await reloadProductSheet();
    if (typeof _refreshXlsClientsAfterEdit === 'function') await _refreshXlsClientsAfterEdit();
    if (typeof loadHomeUploadClients === 'function') await loadHomeUploadClients(true);
    if (typeof currentResult !== 'undefined' && currentResult && currentResult.client && String(currentResult.client.id) === String(targetId)) {
      const updatedClient = (typeof _xlsAllClients !== 'undefined')
        ? _xlsAllClients.find(x => String(x.id) === String(targetId))
        : null;
      if (updatedClient) {
        currentResult.client = { ...currentResult.client, ...updatedClient };
      } else {
        currentResult.client.header_row = rowVal;
        currentResult.client.heading_columns = colsVal;
      }
      if (typeof renderResults === 'function') renderResults(currentResult);
    }
  } catch (err) {
    showToast('見出し設定の保存に失敗しました: ' + err.message, true);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '見出し設定を保存'; }
  }
});

async function initClientsView() {
  if (_clientsViewLoaded) return;
  await reloadClientsSheet();
  _clientsViewLoaded = true;
}

async function reloadClientsSheet() {
  const tbody = document.getElementById('clientsSheetBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" class="sheet-loading">Loading…</td></tr>';

  try {
    const res = await dbFetch('/api/db/clients');
    if (!res || !res.ok) throw new Error('Database not connected');
    _clientsAllList = await res.json();
    renderClientsSheet();
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="sheet-loading" style="color:var(--danger)">Error: ${esc(e.message)}</td></tr>`;
  }
}

function getFilteredSortedClients() {
  const q = (document.getElementById('clientsSearch')?.value || '').toLowerCase();

  let rows = _clientsAllList.filter(c => {
    if (q) {
      const code   = (c.code || '').toLowerCase();
      const ja     = (c.name_ja || '').toLowerCase();
      const en     = (c.name_en || '').toLowerCase();
      const kw     = (c.keywords || '').toLowerCase();
      const hcols  = (c.heading_columns || '').toLowerCase();
      if (!code.includes(q) && !ja.includes(q) && !en.includes(q) && !kw.includes(q) && !hcols.includes(q)) {
        return false;
      }
    }
    return true;
  });

  const { col, dir } = _clientsSort;
  rows.sort((a, b) => {
    let av, bv;
    if (col === 'code')           { av = (a.code || '').toLowerCase(); bv = (b.code || '').toLowerCase(); }
    else if (col === 'name_ja')   { av = (a.name_ja || '').toLowerCase(); bv = (b.name_ja || '').toLowerCase(); }
    else if (col === 'name_en')   { av = (a.name_en || '').toLowerCase(); bv = (b.name_en || '').toLowerCase(); }
    else if (col === 'keywords')  { av = (a.keywords || '').toLowerCase(); bv = (b.keywords || '').toLowerCase(); }
    else if (col === 'heading_format') {
      av = `row${a.header_row || 1}:${(a.heading_columns || '').toLowerCase()}`;
      bv = `row${b.header_row || 1}:${(b.heading_columns || '').toLowerCase()}`;
    }
    else if (col === 'total_jobs'){ av = a.total_jobs ?? 0; bv = b.total_jobs ?? 0; }
    else                          { av = a.created_at || ''; bv = b.created_at || ''; }
    if (av < bv) return -dir; if (av > bv) return dir; return 0;
  });
  return rows;
}

function renderClientsSheet() {
  const tbody   = document.getElementById('clientsSheetBody');
  const countEl = document.getElementById('clientsRowCount');
  if (!tbody) return;

  const rows = getFilteredSortedClients();
  if (countEl) countEl.textContent = `${rows.length} 件`;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="sheet-empty">該当する取引先が見つかりませんでした。</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((c, idx) => {
    const kws = c.keywords
      ? c.keywords.split(',').map(k => k.trim()).filter(Boolean).map(k => `<span class="client-kw-tag">${esc(k)}</span>`).join('')
      : '<span class="sheet-unassigned">—</span>';

    // Heading Format Option preview
    const hRow = c.header_row || 1;
    let colsPreview = '';
    if (c.heading_columns) {
      const colItems = c.heading_columns.split(/[,、\n]+/).map(s => s.trim()).filter(Boolean);
      const displayItems = colItems.slice(0, 4);
      const moreCount = colItems.length - displayItems.length;
      colsPreview = displayItems.map(col => `<span class="client-col-chip">${esc(col)}</span>`).join('') +
        (moreCount > 0 ? `<span class="client-col-chip more" title="${esc(c.heading_columns)}">+${moreCount}</span>` : '');
    } else {
      colsPreview = '<span class="sheet-unassigned" style="font-size:11px">デフォルト</span>';
    }
    const headingFormatHtml = `<div class="client-cols-preview"><span class="client-row-badge">行 ${hRow}</span>${colsPreview}</div>`;

    const totalJobs = c.total_jobs != null ? c.total_jobs : 0;
    const date = c.created_at ? c.created_at.replace('T', ' ').slice(0, 16) : '—';

    return `<tr class="${idx % 2 === 1 ? 'row-alt' : ''}" data-client-id="${esc(c.id)}">
      <td class="col-no">${idx + 1}</td>
      <td><span class="prod-code">${esc(c.code)}</span></td>
      <td><strong>${esc(c.name_ja)}</strong></td>
      <td>${esc(c.name_en || '—')}</td>
      <td>${kws}</td>
      <td>${headingFormatHtml}</td>
      <td style="text-align:center"><span class="badge ${totalJobs > 0 ? 'badge-done' : 'badge-queued'}">${totalJobs}</span></td>
      <td class="col-date">${esc(date)}</td>
      <td class="prod-actions">
        <button class="prod-btn prod-btn-edit" data-id="${esc(c.id)}" title="取引先情報を編集">✎ 編集</button>
        <button class="prod-btn prod-btn-headings" data-id="${esc(c.id)}" title="見出しフォーマットを設定">⚙ 見出し設定</button>
        <button class="prod-btn prod-btn-del" data-id="${esc(c.id)}" title="取引先を削除">🗑</button>
      </td>
    </tr>`;
  }).join('');

  // Wire edit, headings, and delete buttons
  tbody.querySelectorAll('.prod-btn-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const client = _clientsAllList.find(x => x.id === id);
      if (client) openClientModal(client);
    });
  });

  tbody.querySelectorAll('.prod-btn-headings').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const client = _clientsAllList.find(x => x.id === id);
      if (client) openClientHeadingModal(client);
    });
  });

  tbody.querySelectorAll('.prod-btn-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const client = _clientsAllList.find(x => x.id === id);
      const label = client ? `${client.name_ja} (${client.code})` : `ID ${id}`;
      if (!confirm(`取引先「${label}」を削除しますか？ 既存の発注書データは保持されます。`)) return;
      btn.disabled = true;
      try {
        const r = await dbFetch(`/api/db/clients/${id}`, { method: 'DELETE' });
        if (!r || !r.ok) {
          const err = r ? await r.json().catch(() => ({})) : {};
          throw new Error(err.detail || (r ? r.statusText : '削除に失敗しました'));
        }
        showToast(`取引先「${label}」を削除しました`);
        await reloadClientsSheet();
        await reloadOrderSheet();
      } catch (err) {
        showToast('Delete failed: ' + err.message, true);
        btn.disabled = false;
      }
    });
  });
}

// ── Sorting & Search for Clients ──
document.querySelectorAll('#clientsSheet .sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (_clientsSort.col === col) { _clientsSort.dir *= -1; }
    else { _clientsSort = { col, dir: 1 }; }
    document.querySelectorAll('#clientsSheet .sortable').forEach(h => {
      const ic = h.querySelector('.sort-icon');
      if (ic) ic.textContent = h.dataset.col === col ? (_clientsSort.dir === 1 ? '↑' : '↓') : '↕';
    });
    renderClientsSheet();
  });
});

document.getElementById('clientsSearch')?.addEventListener('input', () => renderClientsSheet());

document.getElementById('clientViewAddBtn')?.addEventListener('click', () => openClientModal(null));

document.getElementById('clientsRefreshBtn')?.addEventListener('click', async () => {
  _clientsViewLoaded = false;
  await reloadClientsSheet();
  _clientsViewLoaded = true;
});

// CSV Export for Clients
document.getElementById('clientsExportBtn')?.addEventListener('click', () => {
  const rows = getFilteredSortedClients();
  const header = ['No.', 'Client Code', 'Japanese Name', 'English Name', 'Keywords', 'Header Row', 'Heading Columns', 'Total Orders', 'Created At'];
  const lines = [header, ...rows.map((c, i) => [
    i + 1,
    c.code || '',
    c.name_ja || '',
    c.name_en || '',
    c.keywords || '',
    c.header_row || 1,
    c.heading_columns || '',
    c.total_jobs ?? 0,
    c.created_at ? c.created_at.replace('T', ' ').slice(0, 19) : '',
  ])].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'clients_' + new Date().toISOString().slice(0, 10) + '.csv' });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  showToast(`Exported ${rows.length} clients`);
});

// ============================================================
// Product Master view — Catalog & Price Management
// ============================================================
let _productsLoaded    = false;
let _productAllRows    = [];
let _productAllClients = [];
let _productSort       = { col: 'product_code', dir: 1 };
let _productModalEditId = null;
let _pmForceShowAllClients = false;

function buildClientHeadingColsHtml(headingColumns, maxChips = 6, variant = 'default') {
  const colItems = headingColumns
    ? String(headingColumns).split(/[,、\n]+/).map(s => s.trim()).filter(Boolean)
    : [];
  if (!colItems.length) {
    return '<span class="sheet-unassigned" style="font-size:11px">デフォルト (A, B, C…)</span>';
  }
  const displayItems = maxChips > 0 ? colItems.slice(0, maxChips) : colItems;
  const moreCount = colItems.length - displayItems.length;
  if (variant === 'schema') {
    const chips = displayItems.map((col, idx) =>
      `<span class="pm-col-pill"><em class="pm-col-idx">${_colLetter(idx)}</em><span class="pm-col-lbl">${esc(col)}</span></span>`
    ).join('');
    const more = moreCount > 0
      ? `<span class="pm-col-more" title="${esc(headingColumns)}">+${moreCount} 件</span>`
      : '';
    return chips + more;
  }
  const chips = displayItems.map(col => `<span class="client-col-chip">${esc(col)}</span>`).join('');
  const more = moreCount > 0
    ? `<span class="client-col-chip more" title="${esc(headingColumns)}">+${moreCount}</span>`
    : '';
  return chips + more;
}

function buildClientHeadingFormatHtml(headerRow, headingColumns, maxChips = 6, variant = 'default') {
  const hRow = headerRow || 1;
  const colsHtml = buildClientHeadingColsHtml(headingColumns, maxChips, variant);
  if (variant === 'schema') {
    return `<div class="pm-cols-list${maxChips > 0 ? ' nowrap' : ''}"><span class="pm-row-badge">行 ${hRow}</span>${colsHtml}</div>`;
  }
  return `<div class="client-cols-preview"><span class="client-row-badge">行 ${hRow}</span>${colsHtml}</div>`;
}

function _resolveProductClientHeading(p) {
  const client = _productAllClients.find(c => c.id === p.client_id);
  const headerRow = p.client_header_row ?? client?.header_row ?? 1;
  const headingCols = p.client_heading_columns ?? client?.heading_columns ?? '';
  return { client, headerRow, headingCols };
}

function renderProductClientsHeadingGrid() {
  const grid = document.getElementById('productClientsHeadingGrid');
  const tabStrip = document.getElementById('productClientsTabStrip');
  const countEl = document.getElementById('productClientsHeadingCount');
  const viewAllBtn = document.getElementById('pmViewAllClientsBtn');
  if (!grid) return;

  if (countEl) {
    countEl.textContent = `${_productAllClients.length} 社`;
  }

  if (!_productAllClients.length) {
    if (tabStrip) tabStrip.innerHTML = '';
    if (viewAllBtn) viewAllBtn.classList.add('hidden');
    grid.innerHTML = '<div class="sheet-empty" style="padding:14px">取引先が登録されていません。</div>';
    return;
  }

  const cf = document.getElementById('productClientFilter');
  const activeClientId = cf?.value || '';
  const searchQuery = (document.getElementById('productSearch')?.value || '').trim().toLowerCase();

  // Render quick client selector tabs
  if (tabStrip) {
    const allTab = `<button type="button" class="pm-client-tab${!activeClientId ? ' active' : ''}" data-client-id="">すべての取引先 <span class="pm-tab-badge">${_productAllClients.length}</span></button>`;
    const clientTabs = _productAllClients.map(c => {
      const isActive = activeClientId && String(c.id) === activeClientId;
      const colCount = String(c.heading_columns || '').split(/[,、\n]+/).map(s => s.trim()).filter(Boolean).length;
      return `<button type="button" class="pm-client-tab${isActive ? ' active' : ''}" data-client-id="${esc(c.id)}" title="${esc(c.code)}${c.name_en ? ' · ' + esc(c.name_en) : ''}">
        <span>${esc(c.name_ja || c.code)}</span>${colCount ? `<span class="pm-tab-badge">${colCount}</span>` : ''}
      </button>`;
    }).join('');
    tabStrip.innerHTML = allTab + clientTabs;

    tabStrip.querySelectorAll('.pm-client-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!cf) return;
        const cid = btn.dataset.clientId || '';
        cf.value = cid;
        _pmForceShowAllClients = false;
        renderProductSheet();
      });
    });
  }

  const selectedClient = activeClientId
    ? _productAllClients.find(c => String(c.id) === activeClientId)
    : null;

  if (viewAllBtn) {
    if (selectedClient) {
      viewAllBtn.classList.remove('hidden');
      viewAllBtn.textContent = _pmForceShowAllClients ? '⊡ 選択中の取引先に絞込' : `⊞ 全 ${_productAllClients.length} 社を表示`;
    } else {
      viewAllBtn.classList.add('hidden');
    }
  }

  // Focused Single-Client Schema Banner when a specific client is filtered
  if (selectedClient && !_pmForceShowAllClients) {
    grid.innerHTML = `<div class="pm-active-schema-banner">
      <div class="pm-active-schema-info">
        <div class="pm-active-schema-name">
          <span class="prod-code">${esc(selectedClient.code)}</span>
          <span>${esc(selectedClient.name_ja)}</span>
        </div>
        <div class="pm-active-schema-sub">
          ${selectedClient.name_en ? `<span>${esc(selectedClient.name_en)}</span><span>·</span>` : ''}
          <span>見出し行: <strong>${selectedClient.header_row || 1} 行目</strong></span>
        </div>
      </div>
      <div class="pm-active-schema-cols">
        <div class="pm-cols-list">${buildClientHeadingColsHtml(selectedClient.heading_columns, 0, 'schema')}</div>
      </div>
      <div class="pm-active-schema-actions">
        <button class="prod-btn prod-btn-headings pm-banner-headings-btn" data-id="${esc(selectedClient.id)}" type="button" title="見出しフォーマットを設定">⚙ 見出し設定</button>
      </div>
    </div>`;

    grid.querySelector('.pm-banner-headings-btn')?.addEventListener('click', () => {
      openClientHeadingModal(selectedClient);
    });
    return;
  }

  const matrixClients = searchQuery
    ? _productAllClients.filter(c =>
        (c.code || '').toLowerCase().includes(searchQuery) ||
        (c.name_ja || '').toLowerCase().includes(searchQuery) ||
        (c.name_en || '').toLowerCase().includes(searchQuery) ||
        (c.heading_columns || '').toLowerCase().includes(searchQuery)
      )
    : _productAllClients;

  if (!matrixClients.length) {
    grid.innerHTML = '<div class="sheet-empty" style="padding:20px">条件に一致する取引先見出しフォーマットが見つかりませんでした。</div>';
    return;
  }

  // Enterprise Aligned Schema Matrix Table when viewing All Clients
  grid.innerHTML = `<div class="pm-schema-matrix-wrap">
    <table class="pm-schema-table">
      <thead>
        <tr>
          <th>取引先</th>
          <th style="text-align:center">見出し行</th>
          <th>注文書列見出し (A → Z)</th>
          <th style="text-align:right">操作</th>
        </tr>
      </thead>
      <tbody>
        ${matrixClients.map(c => {
          const isActive = activeClientId && String(c.id) === activeClientId;
          return `<tr class="pm-schema-row${isActive ? ' active' : ''}" data-client-id="${esc(c.id)}" title="${esc(c.name_ja || c.code)} で絞り込み">
            <td class="pm-schema-client-cell">
              <div class="pm-schema-client-main">
                <span class="prod-code">${esc(c.code)}</span>
                <span class="pm-schema-client-ja">${esc(c.name_ja)}</span>
              </div>
              ${c.name_en ? `<div class="pm-schema-client-en">${esc(c.name_en)}</div>` : ''}
            </td>
            <td class="pm-schema-row-cell"><span class="pm-row-badge">行 ${c.header_row || 1}</span></td>
            <td><div class="pm-cols-list">${buildClientHeadingColsHtml(c.heading_columns, 0, 'schema')}</div></td>
            <td class="pm-schema-action-cell">
              <button class="prod-btn prod-btn-headings pm-card-headings-btn" data-id="${esc(c.id)}" type="button" title="見出しフォーマットを設定">⚙ 見出し設定</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;

  grid.querySelectorAll('.pm-schema-row').forEach(row => {
    row.addEventListener('click', () => {
      if (!cf) return;
      const cid = row.dataset.clientId;
      cf.value = cf.value === cid ? '' : cid;
      _pmForceShowAllClients = false;
      renderProductSheet();
    });
  });

  grid.querySelectorAll('.pm-card-headings-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const client = _productAllClients.find(x => x.id === id);
      if (client) openClientHeadingModal(client);
    });
  });
}

document.getElementById('pmViewAllClientsBtn')?.addEventListener('click', () => {
  _pmForceShowAllClients = !_pmForceShowAllClients;
  const grid = document.getElementById('productClientsHeadingGrid');
  const toggleBtn = document.getElementById('toggleProductHeadingsBtn');
  if (grid && grid.classList.contains('hidden')) {
    grid.classList.remove('hidden');
    if (toggleBtn) toggleBtn.textContent = '▾ 見出しを非表示';
  }
  renderProductClientsHeadingGrid();
});

document.getElementById('toggleProductHeadingsBtn')?.addEventListener('click', () => {
  const grid = document.getElementById('productClientsHeadingGrid');
  const btn = document.getElementById('toggleProductHeadingsBtn');
  if (!grid || !btn) return;
  const hidden = grid.classList.toggle('hidden');
  btn.textContent = hidden ? '▸ 見出しを表示' : '▾ 見出しを非表示';
});

function updateProductModalHeadingPreview() {
  const previewEl = document.getElementById('productFormClientHeadingPreview');
  const clientSel = document.getElementById('productFormClient');
  if (!previewEl || !clientSel) return;

  const cid = clientSel.value ? parseInt(clientSel.value, 10) : null;
  if (cid) {
    const client = _productAllClients.find(c => c.id === cid);
    if (client) {
      previewEl.classList.remove('hidden');
      previewEl.innerHTML = `<div style="font-weight:600;color:var(--text2);margin-bottom:6px">見出しフォーマット (${esc(client.name_ja)}):</div>` +
        buildClientHeadingFormatHtml(client.header_row, client.heading_columns, 0, 'schema');
      return;
    }
  }

  if (_productAllClients.length > 0) {
    previewEl.classList.remove('hidden');
    previewEl.innerHTML = `<div style="font-weight:600;color:var(--text2);margin-bottom:6px">全取引先 見出しフォーマット (${_productAllClients.length}社):</div>` +
      `<div style="display:flex;flex-direction:column;gap:6px;max-height:140px;overflow-y:auto">` +
      _productAllClients.map(c =>
        `<div style="display:flex;align-items:flex-start;gap:8px">
          <span class="prod-code" style="flex-shrink:0;white-space:nowrap">${esc(c.name_ja || c.code)}</span>
          ${buildClientHeadingFormatHtml(c.header_row, c.heading_columns, 0, 'schema')}
        </div>`
      ).join('') +
      `</div>`;
  } else {
    previewEl.classList.add('hidden');
    previewEl.innerHTML = '';
  }
}

document.getElementById('productFormClient')?.addEventListener('change', updateProductModalHeadingPreview);

function openProductModal(product = null) {
  _productModalEditId = product ? product.id : null;
  const title = document.getElementById('productModalTitle');
  if (title) title.textContent = product ? '商品情報を編集' : '商品を追加';
  document.getElementById('productFormCode').value   = product ? (product.product_code || '') : '';
  document.getElementById('productFormNameJa').value = product ? (product.name_ja      || '') : '';
  document.getElementById('productFormNameEn').value = product ? (product.name_en      || '') : '';
  document.getElementById('productFormSpec').value   = product ? (product.spec         || '') : '';
  document.getElementById('productFormPrice').value  = product && product.unit_price != null ? product.unit_price : '';

  // populate client select
  const clientSel = document.getElementById('productFormClient');
  if (clientSel) {
    clientSel.innerHTML = '<option value="">(指定なし / 共通商品)</option>' +
      _productAllClients.map(c => `<option value="${c.id}">${esc(c.name_ja)}${c.name_en ? ' / ' + esc(c.name_en) : ''}</option>`).join('');
    clientSel.value = product && product.client_id ? String(product.client_id) : '';
  }
  updateProductModalHeadingPreview();

  const modal = document.getElementById('productModalBackdrop');
  if (modal) modal.classList.remove('hidden');
  document.getElementById('productFormCode')?.focus();
}

function closeProductModal() {
  document.getElementById('productModalBackdrop')?.classList.add('hidden');
}

document.getElementById('productFormCancel')?.addEventListener('click', closeProductModal);
document.getElementById('productModalBackdrop')?.addEventListener('click', e => {
  if (e.target === document.getElementById('productModalBackdrop')) closeProductModal();
});

document.getElementById('addProductBtn')?.addEventListener('click', () => openProductModal(null));

document.getElementById('productFormSave')?.addEventListener('click', async () => {
  const code   = document.getElementById('productFormCode')?.value.trim();
  const nameJa = document.getElementById('productFormNameJa')?.value.trim();
  const nameEn = document.getElementById('productFormNameEn')?.value.trim();
  const spec   = document.getElementById('productFormSpec')?.value.trim();
  const priceVal = document.getElementById('productFormPrice')?.value.trim();
  const clientIdVal = document.getElementById('productFormClient')?.value;

  if (!code || !nameJa) {
    showToast('商品コードと商品名(日本語)は必須項目です', true);
    return;
  }

  const unit_price = priceVal === '' ? null : parseFloat(priceVal);
  if (unit_price !== null && isNaN(unit_price)) {
    showToast('単価は有効な数値を入力してください', true);
    return;
  }
  const client_id = clientIdVal ? parseInt(clientIdVal, 10) : null;

  const saveBtn = document.getElementById('productFormSave');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }

  try {
    const url    = _productModalEditId ? `/api/db/products/${_productModalEditId}` : `/api/db/products`;
    const method = _productModalEditId ? 'PUT' : 'POST';
    const r = await dbFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_code: code,
        name_ja: nameJa,
        name_en: nameEn || null,
        spec: spec || null,
        unit_price: unit_price,
        client_id: client_id,
      })
    });
    if (!r || !r.ok) {
      const err = r ? await r.json().catch(() => ({})) : {};
      throw new Error(err.detail || (r ? r.statusText : 'サーバーに接続できません'));
    }
    closeProductModal();
    showToast(_productModalEditId ? '商品情報を更新しました' : '商品を追加しました');
    await reloadProductSheet();
  } catch (e) {
    showToast('エラー: ' + e.message, true);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '商品を保存'; }
  }
});

async function initProductMasterView() {
  if (_productsLoaded) return;
  await reloadProductSheet();
  _productsLoaded = true;
}

async function reloadProductSheet() {
  const tbody = document.getElementById('productSheetBody');
  const headingGrid = document.getElementById('productClientsHeadingGrid');
  if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="sheet-loading">読み込み中…</td></tr>';
  else if (headingGrid) headingGrid.innerHTML = '<div class="sheet-loading" style="padding:16px">取引先見出しフォーマットを読み込み中…</div>';

  try {
    const [prodsRes, clientsRes] = await Promise.all([
      dbFetch('/api/db/products?limit=1000').catch(() => null),
      dbFetch('/api/db/clients'),
    ]);
    if (!clientsRes || !clientsRes.ok) throw new Error('Database not connected');
    _productAllClients = await clientsRes.json();
    _productAllRows = prodsRes && prodsRes.ok ? await prodsRes.json() : [];

    // Populate client filter dropdown
    const cf = document.getElementById('productClientFilter');
    if (cf) {
      const prev = cf.value;
      cf.innerHTML = '<option value="">すべての取引先</option>' +
        _productAllClients.map(c => `<option value="${c.id}">${esc(c.name_ja)}${c.name_en ? ' / ' + esc(c.name_en) : ''}</option>`).join('');
      cf.value = prev;
    }

    renderProductSheet();
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="sheet-loading" style="color:var(--danger)">Error: ${esc(e.message)}</td></tr>`;
    else if (headingGrid) headingGrid.innerHTML = `<div class="sheet-loading" style="padding:16px;color:var(--danger)">Error: ${esc(e.message)}</div>`;
  }
}

function getFilteredSortedProducts() {
  const q       = (document.getElementById('productSearch')?.value || '').toLowerCase();
  const clientF = document.getElementById('productClientFilter')?.value || '';

  let rows = _productAllRows.filter(p => {
    if (clientF && String(p.client_id) !== clientF) return false;
    if (q) {
      const code   = (p.product_code || '').toLowerCase();
      const ja     = (p.name_ja || '').toLowerCase();
      const en     = (p.name_en || '').toLowerCase();
      const spec   = (p.spec || '').toLowerCase();
      const client = (p.client_name_ja || p.client_name_en || '').toLowerCase();
      const { headingCols } = _resolveProductClientHeading(p);
      const hcols  = (headingCols || '').toLowerCase();
      if (!code.includes(q) && !ja.includes(q) && !en.includes(q) && !spec.includes(q) && !client.includes(q) && !hcols.includes(q)) {
        return false;
      }
    }
    return true;
  });

  const { col, dir } = _productSort;
  rows.sort((a, b) => {
    let av, bv;
    if (col === 'product_code') { av = (a.product_code || '').toLowerCase(); bv = (b.product_code || '').toLowerCase(); }
    else if (col === 'name_ja') { av = (a.name_ja || '').toLowerCase(); bv = (b.name_ja || '').toLowerCase(); }
    else if (col === 'name_en') { av = (a.name_en || '').toLowerCase(); bv = (b.name_en || '').toLowerCase(); }
    else if (col === 'spec')    { av = (a.spec || '').toLowerCase(); bv = (b.spec || '').toLowerCase(); }
    else if (col === 'unit_price') { av = a.unit_price ?? -1; bv = b.unit_price ?? -1; }
    else if (col === 'client')  { av = (a.client_name_ja || '').toLowerCase(); bv = (b.client_name_ja || '').toLowerCase(); }
    else if (col === 'heading_format') {
      const ha = _resolveProductClientHeading(a);
      const hb = _resolveProductClientHeading(b);
      av = a.client_id ? `row${String(ha.headerRow).padStart(3, '0')}:${(ha.headingCols || '').toLowerCase()}` : 'zzz';
      bv = b.client_id ? `row${String(hb.headerRow).padStart(3, '0')}:${(hb.headingCols || '').toLowerCase()}` : 'zzz';
    }
    else { av = a.updated_at || a.created_at || ''; bv = b.updated_at || b.created_at || ''; }
    if (av < bv) return -dir; if (av > bv) return dir; return 0;
  });
  return rows;
}

function renderProductSheet() {
  renderProductClientsHeadingGrid();

  const tbody   = document.getElementById('productSheetBody');
  const countEl = document.getElementById('productRowCount');
  if (!tbody) {
    if (countEl) countEl.textContent = `${_productAllClients.length} 社`;
    return;
  }

  const rows = getFilteredSortedProducts();
  if (countEl) countEl.textContent = `${rows.length} 件`;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="sheet-empty">条件に一致する商品が見つかりませんでした。</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((p, idx) => {
    const clientName = p.client_name_ja
      ? `<span class="sheet-client">${esc(p.client_name_ja)}</span>${p.client_name_en ? `<span class="sheet-client-en">${esc(p.client_name_en)}</span>` : ''}`
      : '<span class="sheet-unassigned">—</span>';
    const { headerRow, headingCols } = _resolveProductClientHeading(p);
    const headingFormatCell = p.client_id
      ? `<div class="pm-cell-heading-wrap">
          ${buildClientHeadingFormatHtml(headerRow, headingCols, 4, 'schema')}
          <button class="prod-btn prod-btn-headings pm-row-headings-btn" data-client-id="${esc(p.client_id)}" title="取引先見出し設定を開く">⚙</button>
         </div>`
      : '<span class="sheet-unassigned">—</span>';
    const priceStr = p.unit_price != null ? '¥' + Number(p.unit_price).toLocaleString('ja-JP', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '—';
    const updated = p.updated_at || p.created_at ? (p.updated_at || p.created_at).replace('T', ' ').slice(0, 16) : '—';

    return `<tr class="${idx % 2 === 1 ? 'row-alt' : ''}" data-product-id="${esc(p.id)}">
      <td class="col-no">${idx + 1}</td>
      <td><span class="prod-code">${esc(p.product_code)}</span></td>
      <td><strong>${esc(p.name_ja)}</strong></td>
      <td>${esc(p.name_en || '—')}</td>
      <td>${esc(p.spec || '—')}</td>
      <td class="prod-price">${priceStr}</td>
      <td>${clientName}</td>
      <td>${headingFormatCell}</td>
      <td class="col-date">${esc(updated)}</td>
      <td class="prod-actions">
        <button class="prod-btn prod-btn-edit" data-id="${esc(p.id)}" title="商品情報を編集">✎ 編集</button>
        <button class="prod-btn prod-btn-del" data-id="${esc(p.id)}" title="商品を削除">🗑</button>
      </td>
    </tr>`;
  }).join('');

  // Wire edit, heading config, and delete buttons
  tbody.querySelectorAll('.pm-row-headings-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const cid = parseInt(btn.dataset.clientId, 10);
      const client = _productAllClients.find(x => x.id === cid);
      if (client) openClientHeadingModal(client);
    });
  });

  tbody.querySelectorAll('.prod-btn-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const prod = _productAllRows.find(x => x.id === id);
      if (prod) openProductModal(prod);
    });
  });

  tbody.querySelectorAll('.prod-btn-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const prod = _productAllRows.find(x => x.id === id);
      const label = prod ? `${prod.product_code} (${prod.name_ja})` : `ID ${id}`;
      if (!confirm(`商品「${label}」を削除しますか？`)) return;
      btn.disabled = true;
      try {
        const r = await dbFetch(`/api/db/products/${id}`, { method: 'DELETE' });
        if (!r || !r.ok) {
          const err = r ? await r.json().catch(() => ({})) : {};
          throw new Error(err.detail || (r ? r.statusText : '削除に失敗しました'));
        }
        showToast(`商品「${label}」を削除しました`);
        await reloadProductSheet();
      } catch (err) {
        showToast('Delete failed: ' + err.message, true);
        btn.disabled = false;
      }
    });
  });
}

// ── Product Sorting & Filters ──
document.querySelectorAll('#productSheet .sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (_productSort.col === col) { _productSort.dir *= -1; }
    else { _productSort = { col, dir: 1 }; }
    document.querySelectorAll('#productSheet .sortable').forEach(h => {
      const ic = h.querySelector('.sort-icon');
      if (ic) ic.textContent = h.dataset.col === col ? (_productSort.dir === 1 ? '↑' : '↓') : '↕';
    });
    renderProductSheet();
  });
});

document.getElementById('productSearch')?.addEventListener('input', () => renderProductSheet());
document.getElementById('productClientFilter')?.addEventListener('change', () => {
  _pmForceShowAllClients = false;
  renderProductSheet();
});

document.getElementById('productRefreshBtn')?.addEventListener('click', async () => {
  _productsLoaded = false;
  await reloadProductSheet();
  _productsLoaded = true;
});

// CSV Export
document.getElementById('productExportBtn')?.addEventListener('click', () => {
  const rows = getFilteredSortedProducts();
  const header = ['No.', 'Item Code', 'Product Name (JA)', 'Product Name (EN)', 'Spec', 'Unit Price', 'Client Code', 'Client Name (JA)', 'Client Header Row', 'Client Heading Columns', 'Updated At'];
  const lines = [header, ...rows.map((p, i) => {
    const { headerRow, headingCols } = _resolveProductClientHeading(p);
    return [
      i + 1,
      p.product_code || '',
      p.name_ja || '',
      p.name_en || '',
      p.spec || '',
      p.unit_price != null ? p.unit_price : '',
      p.client_code || '',
      p.client_name_ja || '',
      p.client_id ? headerRow : '',
      p.client_id ? headingCols : '',
      p.updated_at || p.created_at || '',
    ];
  })].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'products_' + new Date().toISOString().slice(0, 10) + '.csv' });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  showToast(`Exported ${rows.length} products`);
});

// ── Excel Preview Modal ───────────────────────────────────────
let _xlsActiveSheet = 0;
let _xlsSheets = [];
let _xlsJobId = null;
let _xlsResult = null;
let _xlsDirty = false;
let _xlsAllClients = [];

function _markXlsDirty(dirty) {
  _xlsDirty = !!dirty;
  const saveBtn = document.getElementById('xlsSaveBtn');
  if (!saveBtn) return;
  saveBtn.disabled = !_xlsDirty;
  saveBtn.classList.toggle('is-dirty', _xlsDirty);
  saveBtn.textContent = _xlsDirty ? '💾 Save*' : '💾 Save';
}

function _colLetter(i) {
  let n = i, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function _cleanExcelCell(val) {
  if (val == null) return '';
  let s = String(val);
  if (/^Unnamed:\s*\d+$/i.test(s.trim())) return '';
  s = s.replace(/^(\d{4}-\d{2}-\d{2}) 00:00:00$/, '$1');
  return s;
}

function _parseClientHeadingCols(client) {
  if (!client || !client.heading_columns) return [];
  return String(client.heading_columns)
    .split(/[,、\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

async function _ensureXlsClientsLoaded(force = false) {
  if (!force) {
    if (_xlsAllClients.length) return _xlsAllClients;
    if (Array.isArray(_clientsAllList) && _clientsAllList.length) {
      _xlsAllClients = _clientsAllList;
      return _xlsAllClients;
    }
    if (Array.isArray(_productAllClients) && _productAllClients.length) {
      _xlsAllClients = _productAllClients;
      return _xlsAllClients;
    }
  }
  try {
    const res = await dbFetch('/api/db/clients');
    if (res && res.ok) _xlsAllClients = await res.json();
  } catch {}
  return _xlsAllClients;
}

function _getXlsSelectedClient() {
  const sel = document.getElementById('xlsClientSelect');
  const cid = sel?.value ? parseInt(sel.value, 10) : null;
  return cid ? (_xlsAllClients.find(c => c.id === cid) || null) : null;
}

function _updateXlsClientBarUI() {
  const previewEl  = document.getElementById('xlsClientColsPreview');
  const applyBtn   = document.getElementById('xlsApplyClientHeadingBtn');
  const saveBtn    = document.getElementById('xlsSaveToClientHeadingBtn');
  const editBtn    = document.getElementById('xlsEditClientHeadingBtn');
  const baseDateEl = document.getElementById('xlsHeadingBaseDate');
  const client     = _getXlsSelectedClient();
  const sheet      = _xlsSheets[_xlsActiveSheet] || null;

  if (baseDateEl) {
    const targetVal = sheet ? (sheet.headingBaseDate || _detectSheetInitialIsoDate(sheet) || '') : '';
    if (document.activeElement !== baseDateEl || !sheet) {
      baseDateEl.value = targetVal;
    }
    baseDateEl.disabled = !sheet;
  }

  if (previewEl) {
    if (client) {
      const cols = _parseClientHeadingCols(client).map(c => _formatHeadingWithDate(c, sheet));
      const formattedCols = cols.length ? cols.join(', ') : (client.heading_columns || '');
      previewEl.innerHTML = buildClientHeadingFormatHtml(client.header_row, formattedCols, 0, 'schema');
    } else {
      previewEl.innerHTML = '<span class="sheet-unassigned" style="font-size:11px">Select a client to view or apply its heading format</span>';
    }
  }

  const isApplied = !!(client && sheet && sheet.clientHeadingId != null && String(sheet.clientHeadingId) === String(client.id));
  if (applyBtn) {
    applyBtn.disabled = !client || _parseClientHeadingCols(client).length === 0;
    applyBtn.classList.toggle('active', isApplied);
    applyBtn.textContent = isApplied ? '✓ Client Heading Active' : '✓ Apply Client Heading';
  }
  if (saveBtn) saveBtn.disabled = !client;
  if (editBtn) editBtn.disabled = !client;
}

function _applyClientHeadingToSheet(sheet, client) {
  if (!sheet || !client) return false;
  const cols = _parseClientHeadingCols(client);
  if (!cols.length) {
    showToast(`${client.name_ja || client.code} has no heading columns configured`, true);
    return false;
  }
  sheet.clientHeaders = cols.map(c => _formatHeadingWithDate(c, sheet));
  sheet.clientHeadingId = client.id;
  _markXlsDirty(true);
  _renderXlsGrid(sheet);
  _updateXlsClientBarUI();
  return true;
}

async function _refreshXlsClientsAfterEdit() {
  await _ensureXlsClientsLoaded(true);
  if (typeof loadHomeUploadClients === 'function') await loadHomeUploadClients(false);
  const modal = document.getElementById('xlsModal');
  if (!modal || modal.classList.contains('hidden')) return;
  const sel = document.getElementById('xlsClientSelect');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">— 取引先を選択 —</option>' +
      _xlsAllClients.map(c => `<option value="${c.id}">${esc(c.name_ja)}${c.name_en ? ' / ' + esc(c.name_en) : ''}</option>`).join('');
    sel.value = prev;
  }
  const sheet = _xlsSheets[_xlsActiveSheet];
  if (sheet && sheet.clientHeadingId != null) {
    const c = _xlsAllClients.find(x => String(x.id) === String(sheet.clientHeadingId));
    if (c) sheet.clientHeaders = _parseClientHeadingCols(c).map(col => _formatHeadingWithDate(col, sheet));
  }
  _updateXlsClientBarUI();
  if (sheet) _renderXlsGrid(sheet);
}

function _parseMdToRows(md) {
  const lines = md.split('\n').map(l => l.trim()).filter(l => l);
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('-') && line.replace(/[\s|:\-]/g, '').length === 0) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.some(c => c.length > 0)) rows.push(cells);
  }
  return rows;
}

function _detectHeaderRow(rows) {
  if (!rows || rows.length === 0) return -1;
  const HEADER_KEYWORDS = [
    '商品名', '品名', '品目', '規格', '故格', '入数', '入曲', '数量', '単価', '単仙', '金額', '金領',
    '品名・規格', '商品コード', 'コード', '品番', '摘要', '備考',
    '納品日', '発注日', '注文番号', '伝票番号', '個数', '箱数',
    'item', 'description', 'qty', 'quantity', 'price', 'amount', 'total'
  ];

  let bestIdx = -1;
  let bestScore = 0;

  rows.forEach((row, idx) => {
    if (!row || !Array.isArray(row)) return;
    let score = 0;
    const rowText = row.map(c => String(c || '').trim());
    rowText.forEach(cell => {
      if (!cell) return;
      for (const kw of HEADER_KEYWORDS) {
        if (cell.includes(kw)) {
          score += 2;
          break;
        }
      }
    });
    const filledCols = rowText.filter(c => c.length > 0).length;
    if (score >= 2 && filledCols >= 3) {
      score += filledCols;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });

  return bestScore >= 4 ? bestIdx : -1;
}

function _bboxToTable(lines) {
  if (!lines || !lines.length || !lines[0] || !lines[0].bbox) return null;
  const annotated = lines.map(ln => ({
    text: ln.text,
    y: Math.min(...ln.bbox.map(pt => pt[1])),
    x: Math.min(...ln.bbox.map(pt => pt[0]))
  })).sort((a, b) => a.y - b.y);
  const groups = [];
  for (const item of annotated) {
    const match = groups.find(g => Math.abs(item.y - g.refY) <= 40);
    if (match) match.items.push(item);
    else groups.push({ refY: item.y, items: [item] });
  }
  const rows = groups.map(g => ({ cells: g.items.sort((a, b) => a.x - b.x).map(i => i.text) }));
  if (rows.length < 1) return null;
  const maxCols = Math.max(...rows.map(r => r.cells.length));
  const detected = _detectHeaderRow(rows.map(r => r.cells));
  const headerIdx = detected >= 0 ? detected : rows.findIndex(r => r.cells.length === maxCols);
  return { rows, maxCols, headerIdx };
}

function _normaliseDataRows(data) {
  // tbl.data can be Array<Array> (already cells) or Array<Object> (key→value from OCR engine).
  // Always return Array<Array<string>> so _renderXlsGrid can safely call r.length.
  if (!data || !data.length) return null;
  const first = data[0];
  if (Array.isArray(first)) {
    return data.map(row => Array.isArray(row) ? row.map(_cleanExcelCell) : [_cleanExcelCell(row)]);
  }
  if (first === null || typeof first !== 'object') return null;
  const cols = Object.keys(first);
  if (!cols.length) return null;
  const numericKeys = cols.every(c => !isNaN(Number(c)));
  if (numericKeys) {
    // Keys are 0,1,2... — each row's values are the cells; first row may contain header text
    return data.map(r => cols.map(c => _cleanExcelCell(r[c])));
  }
  // Named keys — prepend a header row with cleaned column names
  return [cols.map(_cleanExcelCell), ...data.map(r => cols.map(c => _cleanExcelCell(r[c])))];
}

function _buildSheets(result) {
  if (result.custom_sheets && Array.isArray(result.custom_sheets) && result.custom_sheets.length > 0) {
    return result.custom_sheets.map(s => ({
      name: String(s.name || 'Sheet1'),
      rows: Array.isArray(s.rows) ? s.rows.map(r => Array.isArray(r) ? r.map(_cleanExcelCell) : [_cleanExcelCell(r)]) : [['']],
      hasHeader: !!s.hasHeader,
      headerIdx: s.headerIdx != null ? s.headerIdx : -1,
      customHeaders: Array.isArray(s.customHeaders) ? [...s.customHeaders] : [],
      clientHeaders: Array.isArray(s.clientHeaders) ? [...s.clientHeaders] : [],
      clientHeadingId: s.clientHeadingId != null ? s.clientHeadingId : null,
      headingBaseDate: s.headingBaseDate || null,
    }));
  }

  const sheets = [];
  const tables = result.tables || [];
  tables.forEach((tbl, i) => {
    let rows = null;
    if (tbl.data && Array.isArray(tbl.data) && tbl.data.length > 0) {
      rows = _normaliseDataRows(tbl.data);
    }
    if (!rows && tbl.markdown && tbl.markdown.trim()) {
      rows = _parseMdToRows(tbl.markdown);
    }
    if (rows && rows.length > 0) {
      const detected = _detectHeaderRow(rows);
      sheets.push({
        name: tbl.caption ? tbl.caption.substring(0, 20) : ('Table ' + (i + 1)),
        rows,
        hasHeader: detected >= 0,
        headerIdx: detected >= 0 ? detected : 0,
        customHeaders: [],
        clientHeaders: [],
        clientHeadingId: null,
      });
    }
  });

  if (sheets.length === 0) {
    const lines = (result.paddle && result.paddle.lines) || [];
    if (lines.length && lines[0] && lines[0].bbox) {
      const recon = _bboxToTable(lines);
      if (recon && recon.rows.length > 1) {
        const rows = recon.rows.map(r => r.cells);
        const detected = _detectHeaderRow(rows);
        sheets.push({
          name: 'Sheet1',
          rows,
          hasHeader: detected >= 0,
          headerIdx: detected >= 0 ? detected : (recon.headerIdx >= 0 ? recon.headerIdx : 0),
          customHeaders: [],
          clientHeaders: [],
          clientHeadingId: null,
        });
      }
    }
  }

  if (sheets.length === 0) {
    const dsMd = result.deepseek && (result.deepseek.markdown || result.deepseek.text);
    if (dsMd) {
      const rows = _parseMdToRows(dsMd);
      if (rows.length > 1) {
        const detected = _detectHeaderRow(rows);
        sheets.push({
          name: 'Sheet1',
          rows,
          hasHeader: detected >= 0,
          headerIdx: detected >= 0 ? detected : 0,
          customHeaders: [],
          clientHeaders: [],
          clientHeadingId: null,
        });
      }
    }
  }

  const text = result.fused_text || result.text || '';
  if (text) {
    const rows = text.split('\n').filter(l => l.trim()).map(l => [l]);
    sheets.push({ name: 'Full Text', rows, hasHeader: false, headerIdx: -1, customHeaders: [], clientHeaders: [], clientHeadingId: null });
  }

  if (sheets.length === 0) sheets.push({ name: 'Sheet1', rows: [['No data']], hasHeader: false, headerIdx: -1, customHeaders: [], clientHeaders: [], clientHeadingId: null });
  return sheets;
}

const _DOW_CHARS = ['日', '月', '火', '水', '木', '金', '土'];

function _parseWeekdayHeadingToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const mParen = s.match(/^(?:(\d{1,2})\s*[\/\.月\-]\s*(\d{1,2})\s*日?\s*)?[\(（]\s*([月火水木金土日])(?:曜日|曜)?\s*[\)）]\s*(.*)$/);
  if (mParen) {
    const extra = (mParen[4] || '').trim();
    if (/\d{1,2}\s*[\/\.月\-]\s*\d{1,2}/.test(extra)) return null;
    return {
      month: mParen[1] ? parseInt(mParen[1], 10) : null,
      day: mParen[2] ? parseInt(mParen[2], 10) : null,
      dow: mParen[3],
      extra,
    };
  }
  const mBare = s.match(/^(?:(\d{1,2})\s*[\/\.月\-]\s*(\d{1,2})\s*日?\s+)?([月火水木金土日])(?:曜日|曜)?(?:\s+(.*))?$/);
  if (mBare) {
    const extra = (mBare[4] || '').trim();
    if (/\d{1,2}\s*[\/\.月\-]\s*\d{1,2}/.test(extra)) return null;
    return {
      month: mBare[1] ? parseInt(mBare[1], 10) : null,
      day: mBare[2] ? parseInt(mBare[2], 10) : null,
      dow: mBare[3],
      extra,
    };
  }
  return null;
}

function _toIsoDateStr(year, month, day) {
  const dt = new Date(year, month - 1, day);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function _inferSheetRefYear(sheet, resultOverride = null) {
  const result = resultOverride || (typeof _xlsResult !== 'undefined' ? _xlsResult : null);
  const jobId = resultOverride?.job_id || (typeof _xlsJobId !== 'undefined' ? _xlsJobId : null);
  const jobMeta = (typeof _orderAllJobs !== 'undefined' && Array.isArray(_orderAllJobs) && jobId)
    ? _orderAllJobs.find(j => j.job_id === jobId)
    : null;
  const titleText = (!resultOverride && typeof document !== 'undefined' ? document.getElementById('xlsTitle')?.textContent : '') || '';
  const candidates = [result?.filename, jobMeta?.filename, titleText, result?.fused_text, result?.text];
  if (sheet && Array.isArray(sheet.rows)) {
    for (const r of sheet.rows.slice(0, 20)) {
      if (Array.isArray(r)) candidates.push(r.join(' '));
    }
  }
  for (const src of candidates) {
    if (!src) continue;
    const ym = String(src).match(/(20\d{2})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})/);
    if (ym) return parseInt(ym[1], 10);
  }
  if (jobMeta?.created_at) {
    const jm = String(jobMeta.created_at).match(/(20\d{2})/);
    if (jm) return parseInt(jm[1], 10);
  }
  return new Date().getFullYear();
}

function _parseAnyDateInput(raw, fallbackYear, strictBodyCell = false) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const yrDefault = fallbackYear || new Date().getFullYear();
  function validDate(yr, mo, da) {
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return false;
    const d = new Date(yr, mo - 1, da);
    return d.getFullYear() === yr && d.getMonth() === mo - 1 && d.getDate() === da;
  }
  let m = s.match(/(?:^|[^\d])(20\d{2})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})\s*日?(?:\s*[\(（]?\s*([月火水木金土日])(?:曜日|曜)?\s*[\)）]?)?(?=$|[^\d])/);
  if (m) {
    const yr = parseInt(m[1], 10), mo = parseInt(m[2], 10), da = parseInt(m[3], 10);
    if (validDate(yr, mo, da)) return { year: yr, month: mo, day: da, dow: m[4] || null };
  }
  m = s.match(/(?:^|[^\d\/\.年\-])(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*[\(（]?\s*([月火水木金土日])(?:曜日|曜)?\s*[\)）]?)?(?=$|[^\d])/);
  if (m) {
    const mo = parseInt(m[1], 10), da = parseInt(m[2], 10);
    if (validDate(yrDefault, mo, da)) return { year: yrDefault, month: mo, day: da, dow: m[3] || null };
  }
  m = s.match(/(?:^|[^\d\/\.年\-])(\d{1,2})\s*[\/\.\-]\s*(\d{1,2})\s*日?\s*[\(（]?\s*([月火水木金土日])(?:曜日|曜)?\s*[\)）]?(?=$|[^月火水木金土日曜\d])/);
  if (m) {
    const mo = parseInt(m[1], 10), da = parseInt(m[2], 10);
    if (validDate(yrDefault, mo, da)) return { year: yrDefault, month: mo, day: da, dow: m[3] };
  }
  if (strictBodyCell) return null;
  m = s.match(/^\s*(\d{1,2})\s*[\/\.\-]\s*(\d{1,2})\s*(?:[\(（]\s*([月火水木金土日])(?:曜日|曜)?\s*[\)）])?(?:\s+.*)?$/);
  if (m) {
    const mo = parseInt(m[1], 10), da = parseInt(m[2], 10);
    if (validDate(yrDefault, mo, da)) return { year: yrDefault, month: mo, day: da, dow: m[3] || null };
  }
  return null;
}

function _extractSheetWeekdayDates(sheet, resultOverride = null) {
  if (sheet && sheet.headingBaseDate) {
    const bm = String(sheet.headingBaseDate).trim().match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
    if (bm) {
      const yr = parseInt(bm[1], 10), mo = parseInt(bm[2], 10), da = parseInt(bm[3], 10);
      const baseDt = new Date(yr, mo - 1, da);
      if (!isNaN(baseDt.getTime())) {
        const dowMap = {};
        for (let off = 0; off < 7; off++) {
          const dt = new Date(yr, mo - 1, da + off);
          const dow = _DOW_CHARS[dt.getDay()];
          dowMap[dow] = `${dt.getMonth() + 1}/${dt.getDate()}`;
        }
        return dowMap;
      }
    }
  }
  const result = resultOverride || (typeof _xlsResult !== 'undefined' ? _xlsResult : null);
  const jobId = resultOverride?.job_id || (typeof _xlsJobId !== 'undefined' ? _xlsJobId : null);
  const jobMeta = (typeof _orderAllJobs !== 'undefined' && Array.isArray(_orderAllJobs) && jobId)
    ? _orderAllJobs.find(j => j.job_id === jobId)
    : null;
  const titleText = (!resultOverride && typeof document !== 'undefined' ? document.getElementById('xlsTitle')?.textContent : '') || '';
  const filename = result?.filename || jobMeta?.filename || titleText || '';

  const docChunks = [];
  if (sheet && Array.isArray(sheet.rows)) {
    for (const r of sheet.rows) {
      if (Array.isArray(r)) {
        const line = r.map(c => (c != null ? String(c).trim() : '')).filter(Boolean).join(' ');
        if (line) docChunks.push(line);
      }
    }
  }
  if (result && Array.isArray(result.tables)) {
    for (const tbl of result.tables) {
      if (!tbl) continue;
      if (tbl.caption) docChunks.push(String(tbl.caption));
      if (tbl.markdown) docChunks.push(String(tbl.markdown));
      if (Array.isArray(tbl.data)) {
        for (const row of tbl.data) {
          if (Array.isArray(row)) {
            docChunks.push(row.map(c => (c != null ? String(c) : '')).join(' '));
          } else if (row && typeof row === 'object') {
            docChunks.push(Object.keys(row).join(' '));
            docChunks.push(Object.values(row).map(v => (v != null ? String(v) : '')).join(' '));
          }
        }
      }
    }
  }
  const paddleLines = result?.paddle?.lines;
  if (Array.isArray(paddleLines) && paddleLines.length) {
    const pts = paddleLines
      .filter(ln => ln && ln.text)
      .map(ln => ({
        text: String(ln.text).trim(),
        y: Array.isArray(ln.bbox) && ln.bbox.length ? Math.min(...ln.bbox.map(p => p[1])) : 0,
        x: Array.isArray(ln.bbox) && ln.bbox.length ? Math.min(...ln.bbox.map(p => p[0])) : 0,
      }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const rowGroups = [];
    for (const pt of pts) {
      const g = rowGroups.find(gr => Math.abs(pt.y - gr.refY) <= 18);
      if (g) g.items.push(pt);
      else rowGroups.push({ refY: pt.y, items: [pt] });
    }
    for (const g of rowGroups) {
      g.items.sort((a, b) => a.x - b.x);
      docChunks.push(g.items.map(i => i.text).join(' '));
    }
  }
  for (const txt of [
    result?.fused_text,
    result?.text,
    result?.deepseek?.markdown,
    result?.deepseek?.text,
    result?.docling?.markdown,
    result?.docling?.text,
  ]) {
    if (txt) docChunks.push(String(txt));
  }

  let refYear = new Date().getFullYear();
  let foundYear = false;
  for (const src of [filename, ...docChunks]) {
    if (!src) continue;
    const ym = String(src).match(/(20\d{2})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})/);
    if (ym) {
      refYear = parseInt(ym[1], 10);
      foundYear = true;
      break;
    }
  }
  if (!foundYear && jobMeta?.created_at) {
    const jm = String(jobMeta.created_at).match(/(20\d{2})/);
    if (jm) refYear = parseInt(jm[1], 10);
  }

  const dowMap = {};
  let anchor = null;
  const pairRe = /(?:(20\d{2})\s*[\/\.\-年]\s*)?(\d{1,2})\s*[\/\.月\-]\s*(\d{1,2})\s*日?\s*(?:[\(（]\s*([月火水木金土日])(?:曜日|曜)?\s*[\)）]|([月火水木金土日])(?:曜日|曜)?(?=\s|$|[変更要望発注納品数量\|]))/g;

  function scanExplicitPairs(chunks) {
    for (const chunk of chunks) {
      if (!chunk) continue;
      pairRe.lastIndex = 0;
      let m;
      while ((m = pairRe.exec(chunk)) !== null) {
        const yr = m[1] ? parseInt(m[1], 10) : refYear;
        const mo = parseInt(m[2], 10);
        const da = parseInt(m[3], 10);
        const dow = m[4] || m[5];
        if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31 && dow) {
          if (!dowMap[dow]) dowMap[dow] = `${mo}/${da}`;
          if (!anchor) anchor = { year: yr, month: mo, day: da, dow };
        }
      }
    }
  }

  scanExplicitPairs(docChunks);

  let fnDate = null;
  if (filename) {
    let fm = filename.match(/(?:^|[^\d])(20\d{2})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})(?:\s*日)?(?=$|[^\d])/);
    if (fm) {
      const yr = parseInt(fm[1], 10), mo = parseInt(fm[2], 10), da = parseInt(fm[3], 10);
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) fnDate = { year: yr, month: mo, day: da };
    }
    if (!fnDate) {
      fm = filename.match(/(?:^|[^\d\/\.年\-])(\d{1,2})\s*[\/\.\-]\s*(\d{1,2})(?=$|[^\d])/);
      if (fm) {
        const mo = parseInt(fm[1], 10), da = parseInt(fm[2], 10);
        if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) fnDate = { year: refYear, month: mo, day: da };
      }
    }
    if (!fnDate) {
      fm = filename.match(/(?:^|[^\d])(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?=$|[^\d])/);
      if (fm) {
        const mo = parseInt(fm[1], 10), da = parseInt(fm[2], 10);
        if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) fnDate = { year: refYear, month: mo, day: da };
      }
    }
  }

  function fillWeekFromAnchor(anch) {
    let startDow = anch.dow;
    const hdrCandidates = [
      ...(Array.isArray(sheet?.clientHeaders) ? sheet.clientHeaders : []),
      ...((sheet?.hasHeader && sheet?.headerIdx >= 0 && sheet?.rows?.[sheet.headerIdx]) ? sheet.rows[sheet.headerIdx] : []),
      ...(Array.isArray(sheet?.customHeaders) ? sheet.customHeaders : []),
    ];
    for (const h of hdrCandidates) {
      const p = _parseWeekdayHeadingToken(h);
      if (p && p.dow) { startDow = p.dow; break; }
    }
    if (fnDate) {
      const fnDt = new Date(fnDate.year, fnDate.month - 1, fnDate.day);
      const fnDow = _DOW_CHARS[fnDt.getDay()];
      if (dowMap[fnDow] === `${fnDate.month}/${fnDate.day}` || (anch.month === fnDate.month && anch.day === fnDate.day)) {
        startDow = fnDow;
      }
    }
    const startIdx = _DOW_CHARS.indexOf(startDow);
    const anchorPos = (_DOW_CHARS.indexOf(anch.dow) - startIdx + 7) % 7;
    for (const dChar of _DOW_CHARS) {
      if (!dowMap[dChar]) {
        const pos = (_DOW_CHARS.indexOf(dChar) - startIdx + 7) % 7;
        const delta = pos - anchorPos;
        const dt = new Date(anch.year, anch.month - 1, anch.day + delta);
        dowMap[dChar] = `${dt.getMonth() + 1}/${dt.getDate()}`;
      }
    }
  }

  const missingCount = _DOW_CHARS.filter(d => !dowMap[d]).length;
  if (missingCount > 0) {
    if (anchor) {
      fillWeekFromAnchor(anchor);
    } else if (fnDate) {
      for (let off = 0; off < 7; off++) {
        const dt = new Date(fnDate.year, fnDate.month - 1, fnDate.day + off);
        const dow = _DOW_CHARS[dt.getDay()];
        if (!dowMap[dow]) dowMap[dow] = `${dt.getMonth() + 1}/${dt.getDate()}`;
      }
    } else {
      const templateChunks = [];
      if (Array.isArray(sheet?.clientHeaders) && sheet.clientHeaders.length) templateChunks.push(sheet.clientHeaders.join(' '));
      if (Array.isArray(sheet?.customHeaders) && sheet.customHeaders.length) templateChunks.push(sheet.customHeaders.join(' '));
      scanExplicitPairs(templateChunks);
      if (anchor) {
        fillWeekFromAnchor(anchor);
      } else {
        let baseDate = null;
        for (const chunk of docChunks) {
          if (!chunk) continue;
          const dm = String(chunk).match(/(?:^|[^\d])(20\d{2})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})(?:\s*日)?(?=$|[^\d])/);
          if (dm) {
            const yr = parseInt(dm[1], 10), mo = parseInt(dm[2], 10), da = parseInt(dm[3], 10);
            if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
              baseDate = { year: yr, month: mo, day: da };
              break;
            }
          }
        }
        if (baseDate) {
          for (let off = 0; off < 7; off++) {
            const dt = new Date(baseDate.year, baseDate.month - 1, baseDate.day + off);
            const dow = _DOW_CHARS[dt.getDay()];
            if (!dowMap[dow]) dowMap[dow] = `${dt.getMonth() + 1}/${dt.getDate()}`;
          }
        }
      }
    }
  }

  return dowMap;
}

function _formatHeadingWithDate(raw, sheet, resultOverride = null) {
  const str = raw == null ? '' : String(raw).trim();
  if (!str) return '';
  const parsed = _parseWeekdayHeadingToken(str);
  if (!parsed) return str;
  const dowMap = _extractSheetWeekdayDates(sheet, resultOverride);
  let dateStr = dowMap[parsed.dow] || '';
  if (!dateStr && parsed.month && parsed.day && parsed.month >= 1 && parsed.month <= 12 && parsed.day >= 1 && parsed.day <= 31) {
    dateStr = `${parsed.month}/${parsed.day}`;
  }
  if (!dateStr) return str;
  return `${dateStr} (${parsed.dow})${parsed.extra ? ' ' + parsed.extra : ''}`;
}

function _detectSheetInitialIsoDate(sheet) {
  if (sheet && sheet.headingBaseDate && /^\d{4}-\d{2}-\d{2}$/.test(sheet.headingBaseDate)) {
    return sheet.headingBaseDate;
  }
  const dowMap = _extractSheetWeekdayDates(sheet);
  const refYear = _inferSheetRefYear(sheet);
  const entries = Object.values(dowMap).filter(Boolean);
  if (entries.length) {
    const dates = [];
    for (const md of entries) {
      const p = md.match(/^(\d{1,2})\/(\d{1,2})$/);
      if (p) {
        dates.push(new Date(refYear, parseInt(p[1], 10) - 1, parseInt(p[2], 10)));
      }
    }
    if (dates.length) {
      dates.sort((a, b) => a - b);
      const earliest = dates[0];
      return _toIsoDateStr(earliest.getFullYear(), earliest.getMonth() + 1, earliest.getDate());
    }
  }
  return '';
}

function _applyHeadingBaseDateToSheet(sheet, isoDateStr) {
  if (!sheet) return;
  const cleanIso = (isoDateStr && /^\d{4}-\d{2}-\d{2}$/.test(isoDateStr)) ? isoDateStr : null;
  sheet.headingBaseDate = cleanIso;

  const allClients = typeof _xlsAllClients !== 'undefined' ? _xlsAllClients : [];
  const hasClientHdrs = Array.isArray(sheet.clientHeaders) && sheet.clientHeaders.length > 0;
  if (hasClientHdrs) {
    let baseCols = sheet.clientHeaders;
    if (sheet.clientHeadingId != null && Array.isArray(allClients)) {
      const clientObj = allClients.find(c => String(c.id) === String(sheet.clientHeadingId));
      if (clientObj) {
        const tmplCols = _parseClientHeadingCols(clientObj);
        if (tmplCols.length > 0) {
          baseCols = baseCols.map((existingCol, idx) => {
            if (_parseWeekdayHeadingToken(existingCol)) return existingCol;
            if (idx < tmplCols.length && _parseWeekdayHeadingToken(tmplCols[idx])) return tmplCols[idx];
            return existingCol;
          });
        }
      }
    }
    sheet.clientHeaders = baseCols.map(c => _formatHeadingWithDate(c, sheet));
  }

  if (sheet.hasHeader && sheet.headerIdx >= 0 && Array.isArray(sheet.rows) && sheet.rows[sheet.headerIdx]) {
    if (!cleanIso && Array.isArray(sheet._origHeaderRow)) {
      sheet.rows[sheet.headerIdx] = [...sheet._origHeaderRow];
      delete sheet._origHeaderRow;
    } else if (cleanIso && !hasClientHdrs) {
      if (!Array.isArray(sheet._origHeaderRow)) {
        sheet._origHeaderRow = [...sheet.rows[sheet.headerIdx]];
      }
      sheet.rows[sheet.headerIdx] = sheet.rows[sheet.headerIdx].map(cell => {
        return _parseWeekdayHeadingToken(cell) ? _formatHeadingWithDate(cell, sheet) : cell;
      });
    }
  }

  if (Array.isArray(sheet.customHeaders) && sheet.customHeaders.length > 0) {
    sheet.customHeaders = sheet.customHeaders.map(cell => {
      return _parseWeekdayHeadingToken(cell) ? _formatHeadingWithDate(cell, sheet) : cell;
    });
  }
}

function _syncSheetBaseDateFromEditedValue(sheet, ci, rawInput, prevHeading) {
  if (!sheet) return null;
  const refYear = _inferSheetRefYear(sheet);
  const parsedDate = _parseAnyDateInput(rawInput, refYear, false);
  if (!parsedDate) return null;

  const rawTok = _parseWeekdayHeadingToken(rawInput);
  const prevTok = _parseWeekdayHeadingToken(prevHeading);
  const tok = rawTok || prevTok;
  if (!tok || !tok.dow) return null;

  const colDow = rawTok ? rawTok.dow : prevTok.dow;
  let firstDow = colDow;
  const hdrCandidates = [
    ...(Array.isArray(sheet.clientHeaders) ? sheet.clientHeaders : []),
    ...((sheet.hasHeader && sheet.headerIdx >= 0 && sheet.rows?.[sheet.headerIdx]) ? sheet.rows[sheet.headerIdx] : []),
    ...(Array.isArray(sheet.customHeaders) ? sheet.customHeaders : []),
  ];
  for (const h of hdrCandidates) {
    const p = _parseWeekdayHeadingToken(h);
    if (p && p.dow) { firstDow = p.dow; break; }
  }

  const offset = (_DOW_CHARS.indexOf(colDow) - _DOW_CHARS.indexOf(firstDow) + 7) % 7;
  const baseDt = offset > 0
    ? new Date(parsedDate.year, parsedDate.month - 1, parsedDate.day - offset)
    : new Date(parsedDate.year, parsedDate.month - 1, parsedDate.day);

  _applyHeadingBaseDateToSheet(sheet, _toIsoDateStr(baseDt.getFullYear(), baseDt.getMonth() + 1, baseDt.getDate()));
  const actualDow = _DOW_CHARS[new Date(parsedDate.year, parsedDate.month - 1, parsedDate.day).getDay()];
  const normalizedDow = rawTok ? rawTok.dow : actualDow;
  const dowMap = _extractSheetWeekdayDates(sheet);
  const finalDateStr = dowMap[normalizedDow] || `${parsedDate.month}/${parsedDate.day}`;
  const extra = rawTok ? rawTok.extra : (prevTok ? prevTok.extra : '');
  return `${finalDateStr} (${normalizedDow})${extra ? ' ' + extra : ''}`;
}

function _resolveSheetColHeading(sheet, ci) {
  if (!sheet) return '';
  if (Array.isArray(sheet.clientHeaders) && sheet.clientHeaders.length > 0) {
    const rawClientHdr = sheet.clientHeaders[ci] != null ? String(sheet.clientHeaders[ci]).trim() : '';
    return rawClientHdr ? _formatHeadingWithDate(rawClientHdr, sheet) : '';
  }
  const rows = sheet.rows || [];
  if (sheet.hasHeader && sheet.headerIdx >= 0 && sheet.headerIdx < rows.length) {
    const hdrRow = rows[sheet.headerIdx] || [];
    const raw = hdrRow[ci] != null ? String(hdrRow[ci]).trim() : '';
    const normCp = s => /^c\s*\/\s*p$/i.test(String(s || '').replace(/\u3000/g, ' ').trim());
    const hasSlashBelow = colIdx => {
      for (let r = sheet.headerIdx + 1; r < Math.min(rows.length, sheet.headerIdx + 8); r++) {
        if (String(rows[r]?.[colIdx] || '').trim() === '/') return true;
      }
      return false;
    };
    if (raw) {
      if (normCp(raw) && ci + 1 < hdrRow.length && !String(hdrRow[ci + 1] || '').trim() && hasSlashBelow(ci + 1)) {
        return 'C / P (C)';
      }
      return _formatHeadingWithDate(raw, sheet);
    }
    const prev1 = ci >= 1 ? (hdrRow[ci - 1] != null ? String(hdrRow[ci - 1]).trim() : '') : '';
    const prev2 = ci >= 2 ? (hdrRow[ci - 2] != null ? String(hdrRow[ci - 2]).trim() : '') : '';
    if (normCp(prev1) && hasSlashBelow(ci)) {
      return '/';
    }
    if (normCp(prev2) && !prev1 && hasSlashBelow(ci - 1)) {
      return 'C / P (P)';
    }
    if (sheet.headerIdx > 0) {
      const above = rows[sheet.headerIdx - 1]?.[ci];
      if (above != null && String(above).trim()) {
        return _formatHeadingWithDate(_cleanExcelCell(above).trim(), sheet);
      }
    }
    return '';
  }
  if (Array.isArray(sheet.customHeaders) && sheet.customHeaders[ci] != null) {
    const rawCustom = String(sheet.customHeaders[ci]).trim();
    return rawCustom ? _formatHeadingWithDate(rawCustom, sheet) : '';
  }
  return '';
}

function _syncHeaderSelect(sheet) {
  const select = document.getElementById('xlsHeaderSelect');
  if (!select) return;
  const rows = sheet.rows || [];
  let html = '<option value="-1">デフォルト (A, B, C...)</option>';

  if (_xlsAllClients && _xlsAllClients.length > 0) {
    html += '<optgroup label="取引先見出しフォーマット">';
    _xlsAllClients.forEach(c => {
      const cols = _parseClientHeadingCols(c);
      if (!cols.length) return;
      const colsPreview = cols.slice(0, 4).join(' | ') + (cols.length > 4 ? ` (+${cols.length - 4})` : '');
      const label = `${c.name_ja || c.code}: ${colsPreview}`;
      const isSel = sheet.clientHeadingId != null && String(sheet.clientHeadingId) === String(c.id);
      html += `<option value="client:${esc(c.id)}" ${isSel ? 'selected' : ''}>${esc(label)}</option>`;
    });
    html += '</optgroup>';
  }

  html += '<optgroup label="シート内の行">';
  rows.forEach((r, idx) => {
    const preview = r.filter(c => c != null && String(c).trim()).slice(0, 4).join(' | ');
    const previewTrimmed = preview.length > 32 ? preview.substring(0, 32) + '…' : preview;
    const label = `${idx + 1} 行目` + (previewTrimmed ? `: ${previewTrimmed}` : '');
    const isSelected = !sheet.clientHeadingId && sheet.hasHeader && sheet.headerIdx === idx;
    html += `<option value="${idx}" ${isSelected ? 'selected' : ''}>${esc(label)}</option>`;
  });
  html += '</optgroup>';

  select.innerHTML = html;
  if (sheet.clientHeadingId != null && _xlsAllClients.some(c => String(c.id) === String(sheet.clientHeadingId))) {
    select.value = `client:${sheet.clientHeadingId}`;
  } else if (!sheet.hasHeader || sheet.headerIdx < 0) {
    select.value = "-1";
  } else {
    select.value = String(sheet.headerIdx);
  }
}

function formatHeaderHtml(raw) {
  if (raw == null) return '';
  const str = String(raw).trim();
  if (!str) return '';
  if (str.includes('\n')) {
    const parts = str.split('\n').map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      return `<div class="hdr-main">${esc(parts[0])}</div>` + parts.slice(1).map(p => `<div class="hdr-sub">${esc(p)}</div>`).join('');
    }
  }
  const dateMatch = str.match(/^(\d{1,2}[\/\.-]\d{1,2})\s*(?:[\(（]([月火水木金土日])[\)）]|([月火水木金土日]))?\s*(.*)$/);
  if (dateMatch && (dateMatch[2] || dateMatch[3] || dateMatch[4])) {
    const d = dateMatch[1];
    const day = dateMatch[2] || dateMatch[3] || '';
    const extra = (dateMatch[4] || '').trim();
    const mainLabel = day ? `${d} (${day})` : d;
    let html = `<div class="hdr-main">${esc(mainLabel)}</div>`;
    if (extra) html += `<div class="hdr-extra">${esc(extra)}</div>`;
    return html;
  }
  const parenMatch = str.match(/^([^\(（]+)\s*([\(\（][^\)）]+[\)\）])$/);
  if (parenMatch) {
    return `<div class="hdr-main">${esc(parenMatch[1].trim())}</div><div class="hdr-sub">${esc(parenMatch[2].trim())}</div>`;
  }
  return `<div class="hdr-main">${esc(str)}</div>`;
}

function _renderXlsGrid(sheet) {
  const gridWrap  = document.getElementById('xlsGridWrap');
  const cellRefEl = document.getElementById('xlsCellRef');
  const cellValEl = document.getElementById('xlsCellVal');
  const statusEl  = document.getElementById('xlsStatusBar');
  const { rows, hasHeader, headerIdx } = sheet;
  if (!rows || rows.length === 0) { gridWrap.innerHTML = '<div class="xls-loading">No data</div>'; return; }

  _syncHeaderSelect(sheet);
  gridWrap.tabIndex = 0;

  const maxCols = Math.max(1, ...rows.map(r => r.length), (sheet.customHeaders || []).length, (sheet.clientHeaders || []).length);
  const colLetters = Array.from({ length: maxCols }, (_, i) => _colLetter(i));

  let selectedTd = null, selectedColIdx = -1, selectedRowIdx = -1;
  const cellMatrix = [];

  const table = document.createElement('table');
  table.className = 'xls-table';

  const thead = document.createElement('thead');
  const colHeaderRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'xls-th-corner';
  colHeaderRow.appendChild(corner);

  const colHeaders = colLetters.map((letter, ci) => {
    const th = document.createElement('th');
    th.className = 'xls-th-col';
    th.title = 'Double-click to edit column heading';
    colHeaderRow.appendChild(th);
    return th;
  });

  function refreshColHeader(ci) {
    const th = colHeaders[ci];
    if (!th) return;
    const headingVal = _resolveSheetColHeading(sheet, ci);
    const hasActiveSpan = !!(
      (sheet.hasHeader && sheet.headerIdx >= 0) ||
      (Array.isArray(sheet.clientHeaders) && sheet.clientHeaders.length > 0) ||
      !!headingVal
    );

    th.classList.toggle('has-heading', !!headingVal);
    th.classList.toggle('in-header-span', hasActiveSpan);
    if (headingVal) {
      th.innerHTML = `<div class="xls-th-letter">${colLetters[ci]}</div><div class="xls-th-title" title="${esc(headingVal)}">${formatHeaderHtml(headingVal)}</div>`;
    } else {
      th.innerHTML = `<div class="xls-th-letter">${colLetters[ci]}</div>`;
    }
  }

  colHeaders.forEach((th, ci) => {
    refreshColHeader(ci);
    th.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (th.querySelector('.xls-th-input')) return;
      let curVal = '';
      if (Array.isArray(sheet.clientHeaders) && sheet.clientHeaders.length > 0) {
        curVal = sheet.clientHeaders[ci] != null ? String(sheet.clientHeaders[ci]) : '';
      } else if (sheet.hasHeader && sheet.headerIdx >= 0 && sheet.headerIdx < rows.length) {
        curVal = _resolveSheetColHeading(sheet, ci);
      } else if (sheet.customHeaders && sheet.customHeaders[ci] != null) {
        curVal = String(sheet.customHeaders[ci]);
      }
      th.innerHTML = `<div class="xls-th-letter">${colLetters[ci]}</div>`;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'xls-th-input';
      input.value = curVal;
      th.appendChild(input);
      input.focus();
      input.select();

      let finished = false;
      function finishHeaderEdit(save) {
        if (finished) return;
        finished = true;
        if (save) {
          let newHeading = input.value;
          const synced = _syncSheetBaseDateFromEditedValue(sheet, ci, newHeading, curVal);
          if (synced) newHeading = synced;
          if (Array.isArray(sheet.clientHeaders) && sheet.clientHeaders.length > 0) {
            while (sheet.clientHeaders.length <= ci) sheet.clientHeaders.push('');
            sheet.clientHeaders[ci] = newHeading;
          } else if (sheet.hasHeader && sheet.headerIdx >= 0 && sheet.headerIdx < rows.length) {
            while (rows[sheet.headerIdx].length <= ci) rows[sheet.headerIdx].push('');
            rows[sheet.headerIdx][ci] = newHeading;
          } else {
            sheet.customHeaders = sheet.customHeaders || [];
            sheet.customHeaders[ci] = newHeading;
          }
          if (newHeading !== curVal) _markXlsDirty(true);
          _renderXlsGrid(sheet);
          _updateXlsClientBarUI();
        } else {
          refreshColHeader(ci);
        }
      }
      input.addEventListener('blur', () => finishHeaderEdit(true));
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); finishHeaderEdit(true); }
        else if (ke.key === 'Escape') { ke.preventDefault(); ke.stopPropagation(); finishHeaderEdit(false); }
      });
    });
  });

  thead.appendChild(colHeaderRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const rowNumCells = [];
  const hideHeaderRowInBody = !!(hasHeader && headerIdx >= 0 && headerIdx < rows.length && rows.length > 1);

  function stepRow(fromRi, delta) {
    let nextRi = fromRi + delta;
    if (hideHeaderRowInBody && nextRi === headerIdx) {
      nextRi += delta;
    }
    if (nextRi < 0 || nextRi >= rows.length) return fromRi;
    return nextRi;
  }

  function selectCell(ri, ci, focusGrid = false) {
    if (!rows.length) return;
    ri = Math.max(0, Math.min(rows.length - 1, ri));
    ci = Math.max(0, Math.min(maxCols - 1, ci));
    if (hideHeaderRowInBody && ri === headerIdx) {
      ri = headerIdx + 1 < rows.length ? headerIdx + 1 : Math.max(0, headerIdx - 1);
    }
    if (selectedTd) {
      selectedTd.classList.remove('xls-sel');
      if (selectedColIdx >= 0) colHeaders[selectedColIdx]?.classList.remove('xls-col-sel');
      if (selectedRowIdx >= 0) rowNumCells[selectedRowIdx]?.classList.remove('xls-row-sel');
    }
    selectedRowIdx = ri;
    selectedColIdx = ci;
    selectedTd = cellMatrix[ri]?.[ci] || null;
    sheet._selRow = ri;
    sheet._selCol = ci;

    selectedTd?.classList.add('xls-sel');
    colHeaders[ci]?.classList.add('xls-col-sel');
    rowNumCells[ri]?.classList.add('xls-row-sel');

    cellRefEl.textContent = colLetters[ci] + (ri + 1);
    const val = (rows[ri] && rows[ri][ci] != null) ? String(rows[ri][ci]) : '';
    cellValEl.value = val;

    const setBtn = document.getElementById('xlsSetHeaderBtn');
    if (setBtn) {
      setBtn.textContent = `📌 Set Row ${ri + 1} as Header`;
    }
    selectedTd?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focusGrid) gridWrap.focus({ preventScroll: true });
  }

  function updateCellValue(ri, ci, newVal) {
    if (!rows[ri]) rows[ri] = [];
    while (rows[ri].length <= ci) rows[ri].push('');
    const prevVal = rows[ri][ci] != null ? String(rows[ri][ci]) : '';
    if (prevVal === newVal) return;
    let finalCellVal = newVal;
    let dateSynced = false;
    const refYear = _inferSheetRefYear(sheet);
    if (sheet.hasHeader && ri === sheet.headerIdx) {
      const synced = _syncSheetBaseDateFromEditedValue(sheet, ci, newVal, prevVal);
      if (synced) {
        finalCellVal = synced;
        dateSynced = true;
      }
    } else {
      const parsedBodyDate = _parseAnyDateInput(newVal, refYear, true);
      if (parsedBodyDate) {
        const baseDt = new Date(parsedBodyDate.year, parsedBodyDate.month - 1, parsedBodyDate.day);
        _applyHeadingBaseDateToSheet(sheet, _toIsoDateStr(baseDt.getFullYear(), baseDt.getMonth() + 1, baseDt.getDate()));
        dateSynced = true;
      }
    }
    rows[ri][ci] = finalCellVal;
    const td = cellMatrix[ri]?.[ci];
    if (td && !td.classList.contains('xls-editing')) {
      if (sheet.hasHeader && ri === sheet.headerIdx && finalCellVal) {
        td.innerHTML = formatHeaderHtml(finalCellVal);
      } else {
        td.textContent = finalCellVal;
      }
      td.title = finalCellVal;
    }
    _markXlsDirty(true);
    if (dateSynced) {
      colHeaders.forEach((_, i) => refreshColHeader(i));
      _updateXlsClientBarUI();
      if (sheet.hasHeader && ri === sheet.headerIdx) _syncHeaderSelect(sheet);
    } else if (sheet.hasHeader && ri === sheet.headerIdx) {
      refreshColHeader(ci);
      _syncHeaderSelect(sheet);
    }
  }

  function startInlineEdit(ri, ci, initialChar = null) {
    selectCell(ri, ci, false);
    const td = cellMatrix[ri]?.[ci];
    if (!td || td.classList.contains('xls-editing')) return;
    const origVal = (rows[ri] && rows[ri][ci] != null) ? String(rows[ri][ci]) : '';
    td.classList.add('xls-editing');
    td.textContent = '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'xls-cell-input';
    input.value = initialChar !== null ? initialChar : origVal;
    td.appendChild(input);
    input.focus();
    if (initialChar === null) {
      input.select();
    } else {
      input.setSelectionRange(input.value.length, input.value.length);
    }
    cellValEl.value = input.value;

    let committed = false;
    input.addEventListener('input', () => {
      cellValEl.value = input.value;
    });

    function finishEdit(save, nextAction = null) {
      if (committed) return;
      committed = true;
      const finalVal = save ? input.value : origVal;
      td.classList.remove('xls-editing');
      if (sheet.hasHeader && ri === sheet.headerIdx && finalVal) {
        td.innerHTML = formatHeaderHtml(finalVal);
      } else {
        td.textContent = finalVal;
      }
      td.title = finalVal;
      if (save) updateCellValue(ri, ci, finalVal);
      cellValEl.value = (rows[ri] && rows[ri][ci] != null) ? String(rows[ri][ci]) : '';
      if (nextAction === 'down') selectCell(stepRow(ri, 1), ci, true);
      else if (nextAction === 'right') selectCell(ri, Math.min(maxCols - 1, ci + 1), true);
      else if (nextAction === 'left') selectCell(ri, Math.max(0, ci - 1), true);
      else gridWrap.focus({ preventScroll: true });
    }

    input.addEventListener('blur', () => finishEdit(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finishEdit(true, 'down');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        finishEdit(true, e.shiftKey ? 'left' : 'right');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finishEdit(false);
      }
    });
  }

  let visibleRowNum = 0;
  rows.forEach((rowCells, ri) => {
    const isHdr = hasHeader && ri === headerIdx;
    if (hideHeaderRowInBody && isHdr) return;

    visibleRowNum += 1;
    const tr = document.createElement('tr');
    if (isHdr) {
      tr.className = 'xls-row-is-header';
    } else if (visibleRowNum % 2 === 0) {
      tr.className = 'xls-row-alt';
    }

    const rowNum = document.createElement('td');
    rowNum.className = 'xls-td-row' + (isHdr ? ' is-header-row' : '');
    rowNum.textContent = visibleRowNum;
    rowNum.title = isHdr
      ? `Row ${ri + 1} is currently the Header Row (click to unselect)`
      : `Click to set Row ${ri + 1} as Header Row`;

    rowNum.addEventListener('click', (e) => {
      e.stopPropagation();
      sheet.clientHeaders = [];
      sheet.clientHeadingId = null;
      if (sheet.hasHeader && sheet.headerIdx === ri) {
        sheet.hasHeader = false;
        sheet.headerIdx = -1;
        showToast('Header reset to default');
      } else {
        sheet.hasHeader = true;
        sheet.headerIdx = ri;
        showToast(`Row ${ri + 1} set as table heading`);
      }
      _markXlsDirty(true);
      _renderXlsGrid(sheet);
      _updateXlsClientBarUI();
    });

    tr.appendChild(rowNum);
    rowNumCells[ri] = rowNum;
    cellMatrix[ri] = [];

    for (let ci = 0; ci < maxCols; ci++) {
      const td = document.createElement('td');
      td.className = 'xls-cell' + (isHdr ? ' xls-hdr' : '');
      const val = rowCells[ci] != null ? String(rowCells[ci]) : '';
      td.title = val;
      if (isHdr && val) {
        td.innerHTML = formatHeaderHtml(val);
      } else {
        td.textContent = val;
      }

      td.addEventListener('click', () => selectCell(ri, ci, true));
      td.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startInlineEdit(ri, ci);
      });

      tr.appendChild(td);
      cellMatrix[ri][ci] = td;
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  gridWrap.innerHTML = '';
  gridWrap.appendChild(table);

  cellValEl.onfocus = () => {
    cellValEl.dataset.origVal = cellValEl.value;
  };
  cellValEl.oninput = () => {
    if (selectedRowIdx >= 0 && selectedColIdx >= 0) {
      updateCellValue(selectedRowIdx, selectedColIdx, cellValEl.value);
      const td = cellMatrix[selectedRowIdx]?.[selectedColIdx];
      if (td) {
        td.textContent = cellValEl.value;
        td.title = cellValEl.value;
      }
    }
  };
  cellValEl.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedRowIdx >= 0 && selectedColIdx >= 0) {
        selectCell(stepRow(selectedRowIdx, 1), selectedColIdx, true);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const orig = cellValEl.dataset.origVal ?? '';
      if (selectedRowIdx >= 0 && selectedColIdx >= 0) {
        updateCellValue(selectedRowIdx, selectedColIdx, orig);
        const td = cellMatrix[selectedRowIdx]?.[selectedColIdx];
        if (td) {
          td.textContent = orig;
          td.title = orig;
        }
      }
      cellValEl.value = orig;
      gridWrap.focus({ preventScroll: true });
    }
  };

  gridWrap.onkeydown = (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (selectedRowIdx < 0 || selectedColIdx < 0) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); selectCell(stepRow(selectedRowIdx, -1), selectedColIdx, false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); selectCell(stepRow(selectedRowIdx, 1), selectedColIdx, false); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); selectCell(selectedRowIdx, selectedColIdx - 1, false); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); selectCell(selectedRowIdx, selectedColIdx + 1, false); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      selectCell(selectedRowIdx, selectedColIdx + (e.shiftKey ? -1 : 1), false);
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startInlineEdit(selectedRowIdx, selectedColIdx);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      updateCellValue(selectedRowIdx, selectedColIdx, '');
      cellValEl.value = '';
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startInlineEdit(selectedRowIdx, selectedColIdx, e.key);
    }
  };

  selectCell(sheet._selRow || 0, sheet._selCol || 0, false);

  const dataRows = (hasHeader && headerIdx >= 0) ? Math.max(0, rows.length - 1) : rows.length;
  const activeClientObj = sheet.clientHeadingId != null ? _xlsAllClients.find(c => String(c.id) === String(sheet.clientHeadingId)) : null;
  const headerNote = activeClientObj
    ? ` · Heading: Client (${activeClientObj.name_ja || activeClientObj.code})`
    : ((hasHeader && headerIdx >= 0) ? ` · Heading: Row ${headerIdx + 1}` : '');
  statusEl.textContent = `${dataRows} data rows × ${maxCols} cols${headerNote}`;
}

async function openOrderPreview(jobId, filename) {
  const modal       = document.getElementById('xlsModal');
  const titleEl     = document.getElementById('xlsTitle');
  const loading     = document.getElementById('xlsLoading');
  const gridWrap    = document.getElementById('xlsGridWrap');
  const sheetTabsEl = document.getElementById('xlsSheetTabs');
  if (!modal) return;

  titleEl.textContent = (filename || jobId);
  loading.textContent = 'Loading…';
  loading.classList.remove('hidden');
  gridWrap.classList.add('hidden');
  sheetTabsEl.innerHTML = '';
  document.getElementById('xlsCellRef').textContent = 'A1';
  document.getElementById('xlsCellVal').value = '';
  document.getElementById('xlsStatusBar').textContent = '';
  const clientSelectEl = document.getElementById('xlsClientSelect');
  const clientColsEl   = document.getElementById('xlsClientColsPreview');
  if (clientSelectEl) clientSelectEl.innerHTML = '<option value="">取引先を読み込み中…</option>';
  if (clientColsEl) clientColsEl.innerHTML = '';
  _xlsJobId = jobId;
  _xlsResult = null;
  _markXlsDirty(false);
  const delOrderBtn = document.getElementById('xlsDeleteOrderBtn');
  if (delOrderBtn) {
    delOrderBtn.disabled = false;
    delOrderBtn.onclick = async () => {
      const ok = await deleteOrderJob(_xlsJobId, filename || titleEl.textContent, delOrderBtn);
      if (ok) closeXlsModal();
    };
  }
  modal.classList.remove('hidden');

  let result = null;
  try {
    const [r] = await Promise.all([
      dbFetch('/api/ocr/result/' + encodeURIComponent(jobId)),
      _ensureXlsClientsLoaded(),
    ]);
    if (r && r.ok) result = await r.json();
  } catch {}
  if (!result && typeof currentJobId !== 'undefined' && jobId === currentJobId && currentResult) {
    result = currentResult;
  }

  if (!result) { loading.textContent = 'Could not load result.'; return; }

  _xlsResult = result;
  _xlsSheets = _buildSheets(result);
  _xlsActiveSheet = 0;

  // Populate Client Format dropdown & detect matched client
  if (clientSelectEl) {
    clientSelectEl.innerHTML = '<option value="">— Select Client —</option>' +
      _xlsAllClients.map(c => `<option value="${c.id}">${esc(c.name_ja)}${c.name_en ? ' / ' + esc(c.name_en) : ''}</option>`).join('');

    const jobMeta = Array.isArray(_orderAllJobs) ? _orderAllJobs.find(j => j.job_id === jobId) : null;
    let initialClientId = result.client?.id || jobMeta?.client_id || null;
    if (!initialClientId && _xlsSheets[0]?.clientHeadingId != null) {
      initialClientId = _xlsSheets[0].clientHeadingId;
    }
    if (!initialClientId && _xlsAllClients.length) {
      // Robust client matching using 検出キーワード (detection keywords), names, and codes
      const hayNorm = `${filename || ''} ${result.fused_text || ''} ${result.text || ''}`.toLowerCase();
      const hayStrip = hayNorm.replace(/\s+/g, '');
      let bestScore = 0;
      let bestMatch = null;
      _xlsAllClients.forEach(c => {
        let score = 0;
        const nameJa = (c.name_ja || '').toLowerCase();
        const code = (c.code || '').toLowerCase();
        if (nameJa && (hayNorm.includes(nameJa) || hayStrip.includes(nameJa.replace(/\s+/g, '')))) score += 100;
        if (code && hayNorm.includes(code)) score += 80;
        const kws = String(c.keywords || '').split(/[,、\n\r\t;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        kws.forEach(kw => {
          const kwStrip = kw.replace(/\s+/g, '');
          if (hayNorm.includes(kw) || (kwStrip && hayStrip.includes(kwStrip))) {
            score += kwStrip.length >= 4 ? 25 : 8;
          }
        });
        if (score > bestScore) {
          bestScore = score;
          bestMatch = c;
        }
      });
      if (bestMatch && bestScore >= 8) initialClientId = bestMatch.id;
    }
    clientSelectEl.value = initialClientId ? String(initialClientId) : '';
    clientSelectEl.onchange = () => _updateXlsClientBarUI();

    // Auto-apply matched client heading format if sheet has not been customized
    if (initialClientId) {
      const detectedClient = _xlsAllClients.find(c => String(c.id) === String(initialClientId));
      if (detectedClient && _xlsSheets[0] && _xlsSheets[0].clientHeadingId == null) {
        _applyClientHeadingToSheet(_xlsSheets[0], detectedClient);
      }
    }
  }

  _xlsSheets.forEach((sheet, i) => {
    const tab = document.createElement('div');
    tab.className = 'xls-sheet-tab' + (i === 0 ? ' active' : '');
    tab.textContent = sheet.name;
    tab.addEventListener('click', () => {
      _xlsActiveSheet = i;
      sheetTabsEl.querySelectorAll('.xls-sheet-tab').forEach((t, j) => t.classList.toggle('active', j === i));
      _renderXlsGrid(_xlsSheets[i]);
      _updateXlsClientBarUI();
    });
    sheetTabsEl.appendChild(tab);
  });

  // Wire Heading Base Date picker (auto-updates weekday headings on date input)
  const baseDateEl = document.getElementById('xlsHeadingBaseDate');
  if (baseDateEl) {
    const handleBaseDateChange = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      if (!sheet) return;
      const val = (baseDateEl.value || '').trim();
      if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) return;
      _applyHeadingBaseDateToSheet(sheet, val || null);
      _markXlsDirty(true);
      _renderXlsGrid(sheet);
      _updateXlsClientBarUI();
    };
    baseDateEl.oninput = handleBaseDateChange;
    baseDateEl.onchange = handleBaseDateChange;
  }

  // Wire Client Heading Format bar actions
  const applyClientBtn = document.getElementById('xlsApplyClientHeadingBtn');
  if (applyClientBtn) {
    applyClientBtn.onclick = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      const client = _getXlsSelectedClient();
      if (!client) { showToast('Please select a client first', true); return; }
      if (sheet.clientHeadingId != null && String(sheet.clientHeadingId) === String(client.id)) {
        sheet.clientHeaders = [];
        sheet.clientHeadingId = null;
        _markXlsDirty(true);
        _renderXlsGrid(sheet);
        _updateXlsClientBarUI();
        showToast('Reverted to sheet row heading');
        return;
      }
      if (_applyClientHeadingToSheet(sheet, client)) {
        const cols = _parseClientHeadingCols(client);
        showToast(`Applied ${client.name_ja} heading format (${cols.length} cols)`);
      }
    };
  }

  const saveToClientBtn = document.getElementById('xlsSaveToClientHeadingBtn');
  if (saveToClientBtn) {
    saveToClientBtn.onclick = async () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      const client = _getXlsSelectedClient();
      if (!client) { showToast('Please select a client first', true); return; }
      if (!sheet) return;

      const maxCols = Math.max(
        1,
        ...(sheet.rows || []).map(r => r.length),
        (sheet.customHeaders || []).length,
        (sheet.clientHeaders || []).length
      );
      const resolvedCols = Array.from({ length: maxCols }, (_, ci) => _resolveSheetColHeading(sheet, ci).trim());
      while (resolvedCols.length && !resolvedCols[resolvedCols.length - 1]) resolvedCols.pop();
      const nonEmptyCols = resolvedCols.filter(Boolean);
      if (!nonEmptyCols.length) {
        showToast('No column headings found in current sheet', true);
        return;
      }
      const headerRowNum = (sheet.hasHeader && sheet.headerIdx >= 0) ? (sheet.headerIdx + 1) : (client.header_row || 1);
      saveToClientBtn.disabled = true;
      saveToClientBtn.textContent = 'Saving…';
      try {
        const r = await dbFetch(`/api/db/clients/${client.id}/heading-format`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            header_row: headerRowNum,
            heading_columns: nonEmptyCols.join(', '),
          }),
        });
        if (!r || !r.ok) {
          const err = r ? await r.json().catch(() => ({})) : {};
          throw new Error(err.detail || 'Save failed');
        }
        await _ensureXlsClientsLoaded(true);
        _updateXlsClientBarUI();
        _syncHeaderSelect(sheet);
        if (typeof reloadClientsSheet === 'function' && _clientsViewLoaded) await reloadClientsSheet();
        if (typeof reloadProductSheet === 'function' && _productsLoaded) await reloadProductSheet();
        showToast(`Saved Row ${headerRowNum} headings (${nonEmptyCols.length} cols) to ${client.name_ja}`);
      } catch (e) {
        showToast('Failed to save to client: ' + e.message, true);
      } finally {
        saveToClientBtn.disabled = false;
        saveToClientBtn.textContent = '📌 Save Header to Client';
      }
    };
  }

  const editClientBtn = document.getElementById('xlsEditClientHeadingBtn');
  if (editClientBtn) {
    editClientBtn.onclick = () => {
      const client = _getXlsSelectedClient();
      if (!client) { showToast('Please select a client first', true); return; }
      openClientHeadingModal(client);
    };
  }

  // Wire header controls
  const headerSelect = document.getElementById('xlsHeaderSelect');
  if (headerSelect) {
    headerSelect.onchange = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      if (!sheet) return;
      const rawVal = headerSelect.value;
      if (rawVal && rawVal.startsWith('client:')) {
        const cid = rawVal.slice(7);
        const client = _xlsAllClients.find(c => String(c.id) === cid);
        if (client) {
          if (clientSelectEl) clientSelectEl.value = String(client.id);
          if (_applyClientHeadingToSheet(sheet, client)) {
            showToast(`Applied ${client.name_ja} heading format`);
          }
        }
        return;
      }
      const val = parseInt(rawVal, 10);
      sheet.clientHeaders = [];
      sheet.clientHeadingId = null;
      if (val >= 0) {
        sheet.hasHeader = true;
        sheet.headerIdx = val;
        showToast(`Row ${val + 1} set as table heading`);
      } else {
        sheet.hasHeader = false;
        sheet.headerIdx = -1;
        showToast('Headers reset to default (A, B, C...)');
      }
      _markXlsDirty(true);
      _renderXlsGrid(sheet);
      _updateXlsClientBarUI();
    };
  }

  const setHeaderBtn = document.getElementById('xlsSetHeaderBtn');
  if (setHeaderBtn) {
    setHeaderBtn.textContent = '📌 Set as Header';
    setHeaderBtn.onclick = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      if (!sheet) return;
      const match = (document.getElementById('xlsCellRef').textContent || '').match(/\d+/);
      const rowNum = match ? parseInt(match[0], 10) - 1 : 0;
      if (rowNum >= 0 && rowNum < (sheet.rows || []).length) {
        sheet.clientHeaders = [];
        sheet.clientHeadingId = null;
        sheet.hasHeader = true;
        sheet.headerIdx = rowNum;
        _markXlsDirty(true);
        _renderXlsGrid(sheet);
        _updateXlsClientBarUI();
        showToast(`Row ${rowNum + 1} set as table heading`);
      }
    };
  }

  const resetHeaderBtn = document.getElementById('xlsResetHeaderBtn');
  if (resetHeaderBtn) {
    resetHeaderBtn.onclick = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      if (!sheet) return;
      sheet.hasHeader = false;
      sheet.headerIdx = -1;
      sheet.customHeaders = [];
      sheet.clientHeaders = [];
      sheet.clientHeadingId = null;
      _markXlsDirty(true);
      _renderXlsGrid(sheet);
      _updateXlsClientBarUI();
      showToast('Headers reset to default (A, B, C...)');
    };
  }

  const addRowBtn = document.getElementById('xlsAddRowBtn');
  if (addRowBtn) {
    addRowBtn.onclick = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      if (!sheet) return;
      const maxCols = Math.max(1, ...(sheet.rows || []).map(r => r.length), (sheet.customHeaders || []).length, (sheet.clientHeaders || []).length);
      sheet.rows = sheet.rows || [];
      sheet.rows.push(Array(maxCols).fill(''));
      sheet._selRow = sheet.rows.length - 1;
      sheet._selCol = 0;
      _markXlsDirty(true);
      _renderXlsGrid(sheet);
      showToast('Added new row');
    };
  }

  const addColBtn = document.getElementById('xlsAddColBtn');
  if (addColBtn) {
    addColBtn.onclick = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      if (!sheet) return;
      sheet.rows = sheet.rows || [[]];
      const maxCols = Math.max(1, ...sheet.rows.map(r => r.length), (sheet.customHeaders || []).length, (sheet.clientHeaders || []).length);
      sheet.rows.forEach(r => { while (r.length <= maxCols) r.push(''); });
      sheet._selCol = maxCols;
      _markXlsDirty(true);
      _renderXlsGrid(sheet);
      showToast('Added column ' + _colLetter(maxCols));
    };
  }

  const delRowBtn = document.getElementById('xlsDelRowBtn');
  if (delRowBtn) {
    delRowBtn.onclick = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      if (!sheet || !Array.isArray(sheet.rows) || !sheet.rows.length) return;
      const ri = sheet._selRow != null ? sheet._selRow : 0;
      if (ri < 0 || ri >= sheet.rows.length) return;
      if (sheet.rows.length <= 1) {
        sheet.rows[0] = sheet.rows[0].map(() => '');
        sheet.hasHeader = false;
        sheet.headerIdx = -1;
        sheet._selRow = 0;
        _markXlsDirty(true);
        _renderXlsGrid(sheet);
        _updateXlsClientBarUI();
        showToast('行 1 の内容をクリアしました');
        return;
      }
      sheet.rows.splice(ri, 1);
      if (sheet.hasHeader && sheet.headerIdx >= 0) {
        if (sheet.headerIdx === ri) {
          sheet.hasHeader = false;
          sheet.headerIdx = -1;
        } else if (sheet.headerIdx > ri) {
          sheet.headerIdx -= 1;
        }
      }
      sheet._selRow = Math.min(ri, sheet.rows.length - 1);
      _markXlsDirty(true);
      _renderXlsGrid(sheet);
      _updateXlsClientBarUI();
      showToast(`行 ${ri + 1} を削除しました`);
    };
  }

  const delColBtn = document.getElementById('xlsDelColBtn');
  if (delColBtn) {
    delColBtn.onclick = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      if (!sheet || !Array.isArray(sheet.rows) || !sheet.rows.length) return;
      const maxCols = Math.max(1, ...sheet.rows.map(r => r.length), (sheet.customHeaders || []).length, (sheet.clientHeaders || []).length);
      const ci = sheet._selCol != null ? sheet._selCol : 0;
      if (ci < 0 || ci >= maxCols) return;
      const colName = _colLetter(ci);
      if (maxCols <= 1) {
        sheet.rows.forEach(r => { if (r.length > 0) r[0] = ''; });
        if (Array.isArray(sheet.customHeaders) && sheet.customHeaders.length > 0) sheet.customHeaders[0] = '';
        if (Array.isArray(sheet.clientHeaders) && sheet.clientHeaders.length > 0) sheet.clientHeaders[0] = '';
        sheet._selCol = 0;
        _markXlsDirty(true);
        _renderXlsGrid(sheet);
        _updateXlsClientBarUI();
        showToast(`列 ${colName} の内容をクリアしました`);
        return;
      }
      sheet.rows.forEach(r => { if (ci < r.length) r.splice(ci, 1); });
      if (Array.isArray(sheet.customHeaders) && ci < sheet.customHeaders.length) {
        sheet.customHeaders.splice(ci, 1);
      }
      if (Array.isArray(sheet.clientHeaders) && ci < sheet.clientHeaders.length) {
        sheet.clientHeaders.splice(ci, 1);
      }
      sheet._selCol = Math.min(ci, maxCols - 2);
      _markXlsDirty(true);
      _renderXlsGrid(sheet);
      _updateXlsClientBarUI();
      showToast(`列 ${colName} を削除しました`);
    };
  }

  const saveXlsBtn = document.getElementById('xlsSaveBtn');
  if (saveXlsBtn) {
    saveXlsBtn.onclick = async () => {
      if (!_xlsJobId || !_xlsResult) return;
      saveXlsBtn.disabled = true;
      saveXlsBtn.textContent = 'Saving…';
      try {
        const cleanSheets = _xlsSheets.map(s => ({
          name: s.name,
          rows: s.rows,
          hasHeader: !!s.hasHeader,
          headerIdx: s.headerIdx != null ? s.headerIdx : -1,
          customHeaders: Array.isArray(s.customHeaders) ? s.customHeaders : [],
          clientHeaders: Array.isArray(s.clientHeaders) ? s.clientHeaders : [],
          clientHeadingId: s.clientHeadingId != null ? s.clientHeadingId : null,
          headingBaseDate: s.headingBaseDate || null,
        }));
        _xlsResult.custom_sheets = cleanSheets;

        const fullTextSheet = cleanSheets.find(s => s.name === 'Full Text');
        if (fullTextSheet && Array.isArray(fullTextSheet.rows)) {
          _xlsResult.fused_text = fullTextSheet.rows.map(r => r.join('\t')).join('\n');
        }

        const tableSheets = cleanSheets.filter(s => s.name !== 'Full Text');
        if (tableSheets.length > 0 && Array.isArray(_xlsResult.tables) && _xlsResult.tables.length > 0) {
          _xlsResult.tables = tableSheets.map((s, idx) => {
            const existing = _xlsResult.tables[idx] || {};
            const rows = s.rows || [];
            const cols = rows.length ? Math.max(...rows.map(r => r.length)) : 0;
            return {
              ...existing,
              caption: existing.caption || s.name,
              data: rows,
              shape: [rows.length, cols],
            };
          });
        }

        const selClient = _getXlsSelectedClient();
        if (selClient) {
          _xlsResult.client = {
            id: selClient.id,
            code: selClient.code,
            name_ja: selClient.name_ja,
            name_en: selClient.name_en,
            header_row: selClient.header_row || 1,
            heading_columns: selClient.heading_columns || '',
          };
        } else if (clientSelectEl && !clientSelectEl.value) {
          _xlsResult.client = null;
        }

        const r = await dbFetch('/api/ocr/result/' + encodeURIComponent(_xlsJobId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ result: _xlsResult }),
        });
        if (!r || !r.ok) {
          const err = r ? await r.json().catch(() => ({})) : {};
          throw new Error(err.detail || 'Failed to save changes');
        }
        if (typeof currentJobId !== 'undefined' && currentJobId === _xlsJobId && currentResult) {
          currentResult = _xlsResult;
          const resCard = document.getElementById('resultsCard');
          if (resCard && !resCard.classList.contains('hidden') && typeof renderResults === 'function') {
            renderResults(currentResult);
          }
        }
        _markXlsDirty(false);
        saveXlsBtn.textContent = '💾 Saved';
        showToast('Spreadsheet changes saved');
      } catch (e) {
        saveXlsBtn.disabled = false;
        saveXlsBtn.textContent = '💾 Save*';
        showToast('Save failed: ' + e.message, true);
      }
    };
  }

  loading.classList.add('hidden');
  gridWrap.classList.remove('hidden');
  _renderXlsGrid(_xlsSheets[0]);
  _updateXlsClientBarUI();

  document.getElementById('xlsCsvBtn').onclick = () => {
    const sheet = _xlsSheets[_xlsActiveSheet];
    if (!sheet || !sheet.rows) return;

    let exportRows = [];
    if (Array.isArray(sheet.clientHeaders) && sheet.clientHeaders.length > 0) {
      const maxCols = Math.max(1, ...sheet.rows.map(r => r.length), sheet.clientHeaders.length);
      const hdrRow = Array.from({ length: maxCols }, (_, ci) => sheet.clientHeaders[ci] ?? '');
      exportRows.push(hdrRow);
      const startRow = (sheet.hasHeader && sheet.headerIdx >= 0 && sheet.headerIdx < sheet.rows.length) ? sheet.headerIdx + 1 : 0;
      for (let d = startRow; d < sheet.rows.length; d++) {
        exportRows.push(sheet.rows[d]);
      }
    } else if (sheet.hasHeader && sheet.headerIdx >= 0 && sheet.headerIdx < sheet.rows.length) {
      for (let m = 0; m < sheet.headerIdx; m++) {
        const line = sheet.rows[m].filter(c => c != null && String(c).trim()).join(' | ');
        if (line) exportRows.push(['# ' + line]);
      }
      exportRows.push(sheet.rows[sheet.headerIdx]);
      for (let d = sheet.headerIdx + 1; d < sheet.rows.length; d++) {
        exportRows.push(sheet.rows[d]);
      }
    } else {
      if (sheet.customHeaders && sheet.customHeaders.some(h => h != null && String(h).trim())) {
        const maxCols = Math.max(1, ...sheet.rows.map(r => r.length), sheet.customHeaders.length);
        const hdrRow = Array.from({ length: maxCols }, (_, ci) => sheet.customHeaders[ci] ?? _colLetter(ci));
        exportRows.push(hdrRow);
      }
      exportRows.push(...sheet.rows);
    }

    const csv = exportRows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: (filename || 'table') + '_' + sheet.name.replace(/\s+/g, '_') + '.csv' });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    showToast('Downloaded ' + sheet.name + ' as CSV');
  };
}

function closeXlsModal() { document.getElementById('xlsModal')?.classList.add('hidden'); }
document.getElementById('xlsClose')?.addEventListener('click', closeXlsModal);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const chModal = document.getElementById('clientHeadingModalBackdrop');
    if (chModal && !chModal.classList.contains('hidden')) {
      closeClientHeadingModal();
      return;
    }
    const active = document.activeElement;
    if (active && (active.classList.contains('xls-cell-input') || active.classList.contains('xls-th-input') || active.id === 'xlsCellVal')) {
      return;
    }
    closeXlsModal();
  }
});

document.getElementById('orderPreviewClose')?.addEventListener('click', () => {
  document.getElementById('orderPreview')?.classList.add('hidden');
});

let selectedFile   = null;
let selectedEngine = "all";
let currentResult  = null;
let currentJobId   = null;
let gpuAvailable   = false;  // updated from /api/health on load

function _normClientMatchText(s) {
  return String(s || '').normalize('NFKC').toLowerCase();
}

function _stripClientMatchSpaces(s) {
  return _normClientMatchText(s).replace(/[\s_\-]+/g, '');
}

function _clientKeywordMatches(normHay, normKw) {
  if (!normHay || !normKw) return false;
  if (/^[a-z0-9 _-]+$/.test(normKw)) {
    const escaped = normKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(normHay);
  }
  return normHay.includes(normKw);
}

function _detectClientFromFilenameClientSide(filename, clients) {
  if (!filename || !Array.isArray(clients) || !clients.length) return null;
  const fnNorm = _normClientMatchText(filename);
  const fnStrip = _stripClientMatchSpaces(filename);
  if (!fnStrip) return null;

  let bestScore = 0;
  let bestClient = null;
  for (const c of clients) {
    let score = 0;
    for (const rawTok of [c.name_ja, c.name_en, c.code]) {
      if (!rawTok) continue;
      const ntok = _normClientMatchText(rawTok);
      const stok = _stripClientMatchSpaces(rawTok);
      if (stok && (fnStrip.includes(stok) || _clientKeywordMatches(fnNorm, ntok))) {
        score += 150 + stok.length * 5;
      }
    }
    const kws = String(c.keywords || '').split(/[,、\n\r\t;]+/).map(s => s.trim()).filter(Boolean);
    for (const kw of kws) {
      const nkw = _normClientMatchText(kw);
      const skw = _stripClientMatchSpaces(kw);
      if (skw && (fnStrip.includes(skw) || _clientKeywordMatches(fnNorm, nkw))) {
        score += 50 + skw.length * 2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestClient = c;
    }
  }
  return bestScore >= 8 ? bestClient : null;
}

function populateHomeClientSelects(clients) {
  const list = Array.isArray(clients) ? clients : [];
  const upSel = document.getElementById('uploadClientSelect');
  if (upSel) {
    const prev = upSel.value;
    upSel.innerHTML =
      '<option value="">🔍 自動判別 (ファイル名・OCR内容から自動マッチ)</option>' +
      list.map(c => `<option value="${esc(c.id)}">${esc(c.name_ja)}${c.name_en ? ' / ' + esc(c.name_en) : ''} (${esc(c.code)})</option>`).join('');
    if (prev && list.some(c => String(c.id) === String(prev))) upSel.value = prev;
  }
  const resSel = document.getElementById('resultsClientSelect');
  if (resSel) {
    const prev = resSel.value;
    resSel.innerHTML =
      '<option value="">— 取引先未指定 (標準抽出) —</option>' +
      list.map(c => `<option value="${esc(c.id)}">${esc(c.name_ja)}${c.name_en ? ' / ' + esc(c.name_en) : ''}</option>`).join('');
    if (prev && list.some(c => String(c.id) === String(prev))) resSel.value = prev;
  }
}

function getEffectiveUploadClient() {
  const upSel = document.getElementById('uploadClientSelect');
  const cid = upSel?.value ? String(upSel.value) : '';
  if (cid) {
    const found = _xlsAllClients.find(c => String(c.id) === cid) || null;
    return found ? { mode: 'manual', client: found } : null;
  }
  if (selectedFile && _xlsAllClients.length) {
    const auto = _detectClientFromFilenameClientSide(selectedFile.name, _xlsAllClients);
    if (auto) return { mode: 'auto', client: auto };
  }
  return null;
}

function updateUploadClientPreview() {
  const preview = document.getElementById('uploadClientPreview');
  const modeBadge = document.getElementById('uploadClientModeBadge');
  const nameEl = document.getElementById('uploadClientName');
  const rowBadge = document.getElementById('uploadClientRowBadge');
  const colsEl = document.getElementById('uploadClientCols');
  if (!preview) return;

  const info = getEffectiveUploadClient();
  if (!info || !info.client) {
    preview.classList.add('hidden');
    return;
  }
  const { mode, client } = info;
  preview.classList.remove('hidden');
  if (modeBadge) {
    modeBadge.classList.toggle('mode-manual', mode === 'manual');
    modeBadge.classList.toggle('mode-auto', mode === 'auto');
    modeBadge.textContent = mode === 'manual' ? '🎯 指定取引先' : '✨ ファイル名から自動判別';
  }
  if (nameEl) {
    nameEl.textContent = `${client.name_ja}${client.name_en ? ' / ' + client.name_en : ''} (${client.code})`;
  }
  if (rowBadge) {
    rowBadge.textContent = `見出し: ${client.header_row || 1}行目`;
  }
  if (colsEl) {
    colsEl.innerHTML = buildClientHeadingColsHtml(client.heading_columns, 16, 'schema');
  }
}

async function loadHomeUploadClients(force = false) {
  const clients = await _ensureXlsClientsLoaded(force);
  populateHomeClientSelects(clients);
  updateUploadClientPreview();
  return clients;
}

document.getElementById('uploadClientSelect')?.addEventListener('change', updateUploadClientPreview);
document.getElementById('uploadClientHeadingBtn')?.addEventListener('click', () => {
  const info = getEffectiveUploadClient();
  if (!info || !info.client) {
    showToast('見出しを設定する取引先をプルダウンから選択してください', true);
    return;
  }
  openClientHeadingModal(info.client);
});
document.getElementById('uploadAddClientBtn')?.addEventListener('click', () => openClientModal(null));
loadHomeUploadClients(false);

// Engine selector — seamlessly supports CPU mode (e.g. AWS EC2 CPU) and CUDA GPU
document.querySelectorAll(".toggle").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".toggle").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedEngine = btn.dataset.engine;
  });
});

// Update DeepSeek indicator based on hardware health check (GPU vs CPU mode)
(async function checkGpu() {
  try {
    const r = await fetch(`${API_BASE}/api/health`);
    const j = await r.json();
    gpuAvailable = !!j.gpu_available;
  } catch { gpuAvailable = false; }
  const dsBtn = document.querySelector('.toggle[data-engine="deepseek"]');
  if (dsBtn) {
    if (gpuAvailable) {
      dsBtn.title = "DeepSeek-OCR (CUDA GPU 加速)";
    } else {
      dsBtn.title = "DeepSeek-OCR (CPU モード・自動レイアウト抽出)";
      if (!dsBtn.querySelector(".gpu-badge")) {
        const badge = document.createElement("span");
        badge.className = "gpu-badge";
        badge.textContent = " CPU";
        dsBtn.appendChild(badge);
      }
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
  updateUploadClientPreview();
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
  const dlTgl = document.getElementById("dlToggle");
  if (dlTgl) { dlTgl.disabled = true; document.getElementById("dlMenu")?.classList.add("hidden"); }

  document.getElementById("resultsCard").classList.add("hidden");
  document.getElementById("progressWrap").classList.remove("hidden");
  document.getElementById("processBtn").disabled = true;
  document.getElementById("procIcon") && document.getElementById("procIcon").classList.add("hidden");
  document.getElementById("spinner").classList.remove("hidden");
  document.getElementById("btn-text") || (document.querySelector(".btn-text").textContent = "Processing…");
  document.querySelector(".btn-text").textContent = "Processing…";

  try {
    setProgress(8, "Uploading file…");
    const selectedClientId = document.getElementById("uploadClientSelect")?.value || "";
    const form = new FormData();
    form.append("file", selectedFile);
    if (selectedClientId) form.append("client_id", selectedClientId);
    const uploadUrl = `${API_BASE}/api/ocr/upload?engine=${encodeURIComponent(selectedEngine)}` +
      (selectedClientId ? `&client_id=${encodeURIComponent(selectedClientId)}` : "");
    const uploadRes = await fetch(uploadUrl, {
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
        await _ensureXlsClientsLoaded();
        if (currentResult && selectedClientId) {
          const picked = _xlsAllClients.find(c => String(c.id) === String(selectedClientId));
          if (picked && (!currentResult.client || String(currentResult.client.id) !== String(picked.id))) {
            currentResult.client = { ...picked };
          }
        }
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

function _resolveResultClient(res) {
  if (!res || !res.client) return null;
  const c = res.client;
  const match = (c.id != null && Array.isArray(_xlsAllClients))
    ? _xlsAllClients.find(x => String(x.id) === String(c.id))
    : null;
  return match ? { ...c, ...match } : c;
}

function _getClientEnrichedHeaders(activeClient, rows2D, res) {
  if (!activeClient) return [];
  const rawCols = _parseClientHeadingCols(activeClient);
  if (!rawCols.length) return [];
  const headerIdx = Math.max(0, (parseInt(activeClient.header_row, 10) || 1) - 1);
  const sheetCtx = { rows: Array.isArray(rows2D) ? rows2D : [], headerIdx };
  return rawCols.map(col => _formatHeadingWithDate(col, sheetCtx, res));
}

function _applyClientFormattingToTable(origHeaders, bodyRows2D, activeClient, res, opts = {}) {
  const { headerIncludedInRows = false, allowDeepHeaderSkip = false, fallbackHeaderIdx = -1 } = opts;
  const safeHeaders = Array.isArray(origHeaders) ? origHeaders.map(h => _cleanExcelCell(h)) : [];
  const safeRows = Array.isArray(bodyRows2D)
    ? bodyRows2D.map(r => Array.isArray(r) ? r.map(c => _cleanExcelCell(c)) : [_cleanExcelCell(r)])
    : [];

  if (!activeClient) {
    return { headerCols: safeHeaders, bodyRows: safeRows, isClientFormatted: false };
  }
  const allSampleRows = safeHeaders.length ? [safeHeaders, ...safeRows] : safeRows;
  const enrichedCols = _getClientEnrichedHeaders(activeClient, allSampleRows, res);
  if (!enrichedCols.length) {
    return { headerCols: safeHeaders, bodyRows: safeRows, isClientFormatted: false };
  }

  const cfgIdx = Math.max(0, (parseInt(activeClient.header_row, 10) || 1) - 1);
  const detIdx = _detectHeaderRow(safeRows);
  let finalBodyRows;

  if (!headerIncludedInRows) {
    const headersArePlaceholders = safeHeaders.length > 0 &&
      safeHeaders.every(h => !h || !isNaN(Number(h)) || /^Unnamed/i.test(h));
    if (headersArePlaceholders && detIdx === 0 && safeRows.length > 1) {
      finalBodyRows = safeRows.slice(1);
    } else if (allowDeepHeaderSkip && cfgIdx > 0 && cfgIdx < safeRows.length && detIdx === cfgIdx) {
      finalBodyRows = safeRows.slice(cfgIdx + 1);
    } else {
      finalBodyRows = safeRows;
    }
  } else {
    if (allowDeepHeaderSkip && cfgIdx > 0 && cfgIdx < safeRows.length && detIdx === cfgIdx) {
      finalBodyRows = safeRows.slice(cfgIdx + 1);
    } else if (detIdx >= 0) {
      finalBodyRows = safeRows.slice(detIdx + 1);
    } else if (fallbackHeaderIdx >= 0 && safeRows.length > fallbackHeaderIdx + 1) {
      finalBodyRows = [...safeRows.slice(0, fallbackHeaderIdx), ...safeRows.slice(fallbackHeaderIdx + 1)];
    } else if (allowDeepHeaderSkip && cfgIdx > 0 && cfgIdx < safeRows.length) {
      finalBodyRows = safeRows.slice(cfgIdx + 1);
    } else if (safeRows.length > 1) {
      finalBodyRows = safeRows.slice(1);
    } else {
      finalBodyRows = safeRows;
    }
  }

  const maxCols = Math.max(1, enrichedCols.length, safeHeaders.length, ...finalBodyRows.map(r => r.length));
  const finalHeaders = Array.from({ length: maxCols }, (_, ci) =>
    enrichedCols[ci] != null ? enrichedCols[ci] : (safeHeaders[ci] || _colLetter(ci))
  );
  return { headerCols: finalHeaders, bodyRows: finalBodyRows, isClientFormatted: true, maxCols };
}

function _renderResultsClientBar(res, activeClient) {
  const barEl = document.getElementById('resultsClientBar');
  const selEl = document.getElementById('resultsClientSelect');
  const rowBadge = document.getElementById('resultsClientRowBadge');
  const colsEl = document.getElementById('resultsClientCols');
  const editBtn = document.getElementById('resultsEditHeadingBtn');
  if (!barEl) return;

  barEl.classList.remove('hidden');
  if (selEl) {
    if (selEl.options.length <= 1 && _xlsAllClients.length) populateHomeClientSelects(_xlsAllClients);
    selEl.value = activeClient ? String(activeClient.id) : '';
    selEl.onchange = async () => {
      if (!currentResult) return;
      const newCid = selEl.value;
      const chosen = newCid ? (_xlsAllClients.find(c => String(c.id) === String(newCid)) || null) : null;
      if (chosen) {
        const cols = _parseClientHeadingCols(chosen);
        const hdrIdx = Math.max(0, (parseInt(chosen.header_row, 10) || 1) - 1);
        currentResult.client = {
          id: chosen.id,
          code: chosen.code,
          name_ja: chosen.name_ja,
          name_en: chosen.name_en,
          header_row: chosen.header_row || 1,
          heading_columns: chosen.heading_columns || '',
        };
        currentResult.client_ocr = {
          client_id: chosen.id,
          code: chosen.code,
          name_ja: chosen.name_ja,
          name_en: chosen.name_en,
          header_row: chosen.header_row || 1,
          heading_columns: chosen.heading_columns || '',
          parsed_columns: cols,
          matched_mode: 'manual',
        };
        if (Array.isArray(currentResult.custom_sheets)) {
          currentResult.custom_sheets.forEach(s => {
            if (!s || s.name === 'Full Text') return;
            const enriched = _getClientEnrichedHeaders(chosen, s.rows || [], currentResult);
            s.clientHeadingId = chosen.id;
            if (enriched.length) s.clientHeaders = enriched;
            if (Array.isArray(s.rows) && s.rows.length) {
              s.hasHeader = true;
              s.headerIdx = Math.min(hdrIdx, s.rows.length - 1);
            }
          });
        }
      } else {
        currentResult.client = null;
        currentResult.client_ocr = { matched_mode: 'unassigned' };
        if (Array.isArray(currentResult.custom_sheets)) {
          currentResult.custom_sheets.forEach(s => {
            if (!s || s.name === 'Full Text') return;
            s.clientHeaders = [];
            s.clientHeadingId = null;
          });
        }
      }
      if (currentJobId) {
        dbFetch('/api/ocr/result/' + encodeURIComponent(currentJobId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ result: currentResult }),
        }).catch(() => {});
      }
      renderResults(currentResult, { preserveTab: true });
      showToast(chosen ? `取引先「${chosen.name_ja}」のフォーマットを適用しました` : '取引先指定を解除しました');
    };
  }

  if (rowBadge) {
    rowBadge.textContent = activeClient ? `見出し: ${activeClient.header_row || 1}行目` : '標準';
  }
  if (colsEl) {
    if (activeClient) {
      const enriched = _getClientEnrichedHeaders(activeClient, [], res);
      const colStr = enriched.length ? enriched.join(', ') : (activeClient.heading_columns || '');
      colsEl.innerHTML = buildClientHeadingColsHtml(colStr, 16, 'schema');
    } else {
      colsEl.innerHTML = '<span class="sheet-unassigned" style="font-size:11.5px">取引先を選択すると、見出しフォーマットで表を整形します</span>';
    }
  }
  if (editBtn) {
    editBtn.disabled = !activeClient;
    editBtn.onclick = () => {
      if (!activeClient) {
        showToast('見出しを設定する取引先を選択してください', true);
        return;
      }
      openClientHeadingModal(activeClient);
    };
  }
  const xlsBtn = document.getElementById('openResultXlsBtn');
  if (xlsBtn) {
    xlsBtn.disabled = !currentResult;
    xlsBtn.onclick = () => {
      if (!currentResult) return;
      const fn = (selectedFile && selectedFile.name) || currentResult.filename || 'OCR Result';
      openOrderPreview(currentJobId || 'preview', fn);
    };
  }
}

function renderResults(res, opts = {}) {
  const { preserveTab = false } = opts;
  const activeClient = _resolveResultClient(res);
  const conf = res.confidence_avg ? (res.confidence_avg * 100).toFixed(1) + "%" : null;
  const confClass = (res.confidence_avg || 0) >= 0.9 ? "good" : "warn";
  const displayClient = activeClient || res.client;
  const clientModeTag = res.client_ocr?.matched_mode === 'manual' ? '指定' : (displayClient ? '自動判別' : '');
  const clientPill = displayClient
    ? `<span class="meta-pill client">${esc(displayClient.name_ja)}${displayClient.name_en ? ' / ' + esc(displayClient.name_en) : ''}${clientModeTag ? ` (${esc(clientModeTag)})` : ''}</span>`
    : "";
  document.getElementById("resultsMeta").innerHTML =
    clientPill +
    `<span class="meta-pill engine">${esc(res.primary_engine || "—")}</span>` +
    (conf ? `<span class="meta-pill ${confClass}">${conf} confidence</span>` : "") +
    (res.processing_time_s ? `<span class="meta-pill">${res.processing_time_s}s</span>` : "");

  _renderResultsClientBar(res, activeClient);

  document.getElementById("fusedText").textContent   = res.fused_text || "(no text extracted)";
  document.getElementById("doclingText").textContent  = res.docling?.markdown || res.docling?.text || "(Docling produced no output)";
  const dsErr = res.deepseek?.error || "";
  const dsNotice = res.deepseek?.notice ? `\n\n[${res.deepseek.notice}]` : "";
  document.getElementById("deepseekText").textContent =
    (res.deepseek?.markdown || res.deepseek?.text ||
    (dsErr ? dsErr : "(DeepSeek-OCR produced no output)")) + dsNotice;

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

  // ── Table/CSV shared helpers ─────────────────────────────────────────────
  // A separator row contains only |, -, :, and whitespace AND must have a dash
  const isSepRow = l => l.includes('-') && l.replace(/[\s|:\-]/g, "").length === 0;
  const mdRowToCsv = line =>
    line.replace(/^\|/, "").replace(/\|$/, "")
      .split("|").map(c => `"${String(c.trim()).replace(/"/g, '""')}"`).join(",");

  function extractMdTables(md) {
    if (!md) return [];
    const result = [];
    let cur = null;
    for (const rawL of md.replace(/\r\n/g, "\n").split("\n")) {
      const l = rawL.trim();
      if (l.startsWith("|")) {
        if (!cur) cur = [];
        cur.push(l);
      } else if (cur) {
        if (cur.length) result.push(cur);
        cur = null;
      }
    }
    if (cur && cur.length) result.push(cur);
    return result;
  }

  // Reconstruct a table from PaddleOCR bbox data by grouping lines by y-coordinate.
  // Uses the row with the most columns as the header (most likely the actual column headers).
  function reconstructTableFromBbox(lines) {
    if (!lines || !lines.length || !lines[0].bbox) return null;
    // Annotate each line with its top-y and left-x
    const annotated = lines.map(ln => ({
      text: ln.text,
      y: Math.min(...ln.bbox.map(pt => pt[1])),
      x: Math.min(...ln.bbox.map(pt => pt[0]))
    })).sort((a, b) => a.y - b.y);
    // Cluster by y with 40px tolerance
    const groups = [];
    for (const item of annotated) {
      const match = groups.find(g => Math.abs(item.y - g.refY) <= 40);
      if (match) match.items.push(item);
      else groups.push({ refY: item.y, items: [item] });
    }
    // Build rows sorted by x
    const rows = groups.map(g => ({
      cells: g.items.sort((a, b) => a.x - b.x).map(i => i.text)
    }));
    if (rows.length < 1) return null;
    // Use the row with the most columns as the table header
    const maxCols = Math.max(...rows.map(r => r.cells.length));
    const headerIdx = rows.findIndex(r => r.cells.length === maxCols);
    return { rows, maxCols, headerIdx };
  }

  // Render a reconstructed bbox table as an HTML string (with optional client headings).
  function renderBboxTable(caption, recon) {
    const { rows, maxCols, headerIdx } = recon;
    const rawRows2D = rows.map(r => r.cells);
    const defaultHeaders = (rows[headerIdx]?.cells || []).map(c => String(c ?? ''));
    const defaultBodyRows = [...rows.slice(0, headerIdx), ...rows.slice(headerIdx + 1)].map(r => r.cells);

    let headerCols = defaultHeaders;
    let bodyRows = defaultBodyRows;
    let colCount = maxCols;
    let clientTag = '';

    if (activeClient) {
      const formatted = _applyClientFormattingToTable(defaultHeaders, rawRows2D, activeClient, res, {
        headerIncludedInRows: true,
        allowDeepHeaderSkip: true,
        fallbackHeaderIdx: headerIdx,
      });
      if (formatted.isClientFormatted) {
        headerCols = formatted.headerCols;
        bodyRows = formatted.bodyRows;
        colCount = formatted.maxCols || headerCols.length;
        clientTag = ` · ${esc(activeClient.name_ja)}`;
      }
    }

    const thead = `<thead><tr>${Array.from({ length: colCount }, (_, ci) => `<th>${esc(headerCols[ci] || '')}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${bodyRows.map((r, ri) =>
      `<tr class="${ri % 2 === 1 ? 'tbl-alt' : ''}">${
        Array.from({ length: colCount }, (_, ci) => `<td>${esc(r[ci] || '')}</td>`).join('')
      }</tr>`
    ).join('')}</tbody>`;
    return `<div class="tbl-block">
      <div class="tbl-header">
        <span class="tbl-title">${caption} <small style="font-weight:400;color:var(--muted)">(layout reconstructed${clientTag})</small></span>
        <span class="tbl-meta">${bodyRows.length} rows × ${colCount} cols</span>
      </div>
      <div class="tbl-scroll"><table class="tbl-grid">${thead}${tbody}</table></div>
    </div>`;
  }

  // Parse pipe-table lines into {headers, bodyRows}
  function parseMdTable(lines) {
    const sepIdx = lines.findIndex(l => isSepRow(l));
    if (sepIdx < 1) return null; // need at least one header row + separator
    const headerLine = lines[sepIdx - 1];
    const headers = headerLine.replace(/^\|/, "").replace(/\|$/, "")
      .split("|").map(c => c.trim());
    if (!headers.length || headers.every(h => h === "")) return null;
    const bodyLines = lines.slice(sepIdx + 1).filter(l => l.startsWith("|") && !isSepRow(l));
    const bodyRows = bodyLines.map(l =>
      l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim())
    );
    return { headers, bodyRows };
  }

  function renderHtmlTableBlock(titleHtml, headerCols, bodyRows2D, isClientFormatted = false) {
    const colCount = Math.max(1, headerCols.length, ...bodyRows2D.map(r => r.length));
    const thead = `<thead><tr>${Array.from({ length: colCount }, (_, ci) => `<th>${esc(headerCols[ci] ?? '')}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${bodyRows2D.map((r, ri) =>
      `<tr class="${ri % 2 === 1 ? 'tbl-alt' : ''}">${
        Array.from({ length: colCount }, (_, ci) => `<td>${esc(r[ci] ?? '')}</td>`).join('')
      }</tr>`
    ).join('')}</tbody>`;
    const badge = isClientFormatted && activeClient
      ? ` <small style="font-weight:500;color:#2563eb">(${esc(activeClient.name_ja)})</small>`
      : '';
    return `<div class="tbl-block">
      <div class="tbl-header">
        <span class="tbl-title">${titleHtml}${badge}</span>
        <span class="tbl-meta">${bodyRows2D.length} rows × ${colCount} cols</span>
      </div>
      <div class="tbl-scroll"><table class="tbl-grid">${thead}${tbody}</table></div>
    </div>`;
  }

  const tables = res.tables || res.docling?.tables || [];
  const customSheets = Array.isArray(res.custom_sheets)
    ? res.custom_sheets.filter(s => s && s.name !== 'Full Text' && Array.isArray(s.rows) && s.rows.length > 0)
    : [];

  if (!tables.length && customSheets.length > 0) {
    document.getElementById("tablesOutput").innerHTML = customSheets.map((s, si) => {
      const caption = esc(s.name || `Sheet ${si + 1}`);
      const hIdx = (s.hasHeader && s.headerIdx >= 0 && s.headerIdx < s.rows.length) ? s.headerIdx : 0;
      const origHdrs = (s.rows[hIdx] || []).map(c => _cleanExcelCell(c));
      const formatted = _applyClientFormattingToTable(origHdrs, s.rows, activeClient, res, {
        headerIncludedInRows: true,
        allowDeepHeaderSkip: true,
        fallbackHeaderIdx: hIdx,
      });
      return renderHtmlTableBlock(caption, formatted.headerCols, formatted.bodyRows, formatted.isClientFormatted);
    }).join('');
  } else if (!tables.length) {
    const recon = reconstructTableFromBbox(res.paddle?.lines);
    document.getElementById("tablesOutput").innerHTML = recon
      ? renderBboxTable("Table 1", recon)
      : `<div class="tbl-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
          <span>No tables detected in this document.</span>
        </div>`;
  } else {
    document.getElementById("tablesOutput").innerHTML = tables.map((tbl, i) => {
      const rows = tbl.data || [];
      const caption = tbl.caption ? esc(tbl.caption) : `Table ${i + 1}`;

      // If no row data, try to parse the markdown or fall back to docling full markdown
      if (!rows.length) {
        const tblMdLines = (tbl.markdown || "").replace(/\r\n/g, "\n")
          .split("\n").map(l => l.trim()).filter(l => l.startsWith("|"));
        let parsed = parseMdTable(tblMdLines);

        if (!parsed) {
          const docMdTables = extractMdTables(res.docling?.markdown);
          if (docMdTables[i]) parsed = parseMdTable(docMdTables[i]);
        }

        if (parsed && parsed.headers.length) {
          const formatted = _applyClientFormattingToTable(parsed.headers, parsed.bodyRows, activeClient, res, {
            headerIncludedInRows: false,
            allowDeepHeaderSkip: true,
          });
          return renderHtmlTableBlock(caption, formatted.headerCols, formatted.bodyRows, formatted.isClientFormatted);
        }

        // Final fallback: reconstruct from PaddleOCR bbox (only on first table to avoid duplication)
        if (i === 0) {
          const recon = reconstructTableFromBbox(res.paddle?.lines);
          if (recon) return renderBboxTable(caption || `Table ${i + 1}`, recon);
        }

        return `<div class="tbl-block">
          <div class="tbl-header">
            <span class="tbl-title">${caption}</span>
            <span class="tbl-meta">Structure not extracted — see Fused Output</span>
          </div>
        </div>`;
      }

      const cols = Object.keys(rows[0]);
      const numericKeys = cols.every(c => !isNaN(Number(c)));
      let origHeaderCols, bodyRows2D;
      if (numericKeys && rows.length > 1) {
        origHeaderCols = cols.map(c => _cleanExcelCell(rows[0][c]));
        bodyRows2D = rows.map(r => cols.map(c => _cleanExcelCell(r[c])));
        const formatted = _applyClientFormattingToTable(origHeaderCols, bodyRows2D, activeClient, res, {
          headerIncludedInRows: true,
          allowDeepHeaderSkip: true,
          fallbackHeaderIdx: 0,
        });
        return renderHtmlTableBlock(caption, formatted.headerCols, formatted.bodyRows, formatted.isClientFormatted);
      } else {
        origHeaderCols = cols.map(c => _cleanExcelCell(c));
        bodyRows2D = rows.map(r => cols.map(c => _cleanExcelCell(r[c])));
        const formatted = _applyClientFormattingToTable(origHeaderCols, bodyRows2D, activeClient, res, {
          headerIncludedInRows: false,
          allowDeepHeaderSkip: true,
        });
        return renderHtmlTableBlock(caption, formatted.headerCols, formatted.bodyRows, formatted.isClientFormatted);
      }
    }).join('');
  }

  document.getElementById("rawJson").textContent = JSON.stringify(res, null, 2);

  // CSV tab — full fused text + all client-formatted table blocks
  (function renderCsv() {
    const q = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;

    // ── Section 1: complete fused text ───────────────────────────
    const fusedLines = (res.fused_text || "").split("\n");
    const textSection = "# Full Text\r\nline\r\n" + fusedLines.map(q).join("\r\n");

    // ── Section 2: tables ─────────────────────────────────────────
    const docMd = res.docling?.markdown || res.deepseek?.markdown || "";
    const docMdTables = extractMdTables(docMd);
    const hasClientHeading = !!(activeClient && _parseClientHeadingCols(activeClient).length > 0);

    let tableSections = [];
    if (customSheets.length > 0 && !tables.length) {
      tableSections = customSheets.map((s, si) => {
        const caption = s.name || `Sheet ${si + 1}`;
        const hIdx = (s.hasHeader && s.headerIdx >= 0 && s.headerIdx < s.rows.length) ? s.headerIdx : 0;
        const origHdrs = (s.rows[hIdx] || []).map(c => _cleanExcelCell(c));
        const formatted = _applyClientFormattingToTable(origHdrs, s.rows, activeClient, res, {
          headerIncludedInRows: true,
          allowDeepHeaderSkip: true,
          fallbackHeaderIdx: hIdx,
        });
        const maxCols = Math.max(1, formatted.headerCols.length, ...formatted.bodyRows.map(r => r.length));
        const hdrCsv = Array.from({ length: maxCols }, (_, ci) => q(formatted.headerCols[ci] ?? '')).join(",");
        const bodyCsv = formatted.bodyRows.map(r =>
          Array.from({ length: maxCols }, (_, ci) => q(r[ci] ?? '')).join(",")
        ).join("\r\n");
        return `# ${caption}\r\n${hdrCsv}${bodyCsv ? '\r\n' + bodyCsv : ''}`;
      });
    } else if (docMdTables.length > 0) {
      tableSections = docMdTables.map((lines, i) => {
        if (hasClientHeading) {
          const parsed = parseMdTable(lines);
          if (parsed && parsed.headers.length) {
            const formatted = _applyClientFormattingToTable(parsed.headers, parsed.bodyRows, activeClient, res, {
              headerIncludedInRows: false,
              allowDeepHeaderSkip: true,
            });
            const maxCols = Math.max(1, formatted.headerCols.length, ...formatted.bodyRows.map(r => r.length));
            const hdrCsv = Array.from({ length: maxCols }, (_, ci) => q(formatted.headerCols[ci] ?? '')).join(",");
            const bodyCsv = formatted.bodyRows.map(r =>
              Array.from({ length: maxCols }, (_, ci) => q(r[ci] ?? '')).join(",")
            ).join("\r\n");
            return `# Table ${i + 1}\r\n${hdrCsv}${bodyCsv ? '\r\n' + bodyCsv : ''}`;
          }
        }
        const dataLines = lines.filter(l => !isSepRow(l) && l.replace(/[\s|]/g, "").length > 0);
        if (!dataLines.length) return null;
        return `# Table ${i + 1}\r\n` + dataLines.map(mdRowToCsv).join("\r\n");
      }).filter(Boolean);
    } else {
      const tblList = res.tables || res.docling?.tables || [];
      tableSections = tblList.map((tbl, i) => {
        const caption = tbl.caption || `Table ${i + 1}`;
        const rows = tbl.data || [];

        if (rows.length) {
          const cols = Object.keys(rows[0]);
          const numericKeys = cols.every(c => !isNaN(Number(c)));
          let formatted;
          if (numericKeys && rows.length > 1) {
            const origHdrs = cols.map(c => _cleanExcelCell(rows[0][c]));
            const allRows2D = rows.map(r => cols.map(c => _cleanExcelCell(r[c])));
            formatted = _applyClientFormattingToTable(origHdrs, allRows2D, activeClient, res, {
              headerIncludedInRows: true,
              allowDeepHeaderSkip: true,
              fallbackHeaderIdx: 0,
            });
          } else {
            const origHdrs = cols.map(c => _cleanExcelCell(c));
            const body2D = rows.map(r => cols.map(c => _cleanExcelCell(r[c])));
            formatted = _applyClientFormattingToTable(origHdrs, body2D, activeClient, res, {
              headerIncludedInRows: false,
              allowDeepHeaderSkip: true,
            });
          }
          const maxCols = Math.max(1, formatted.headerCols.length, ...formatted.bodyRows.map(r => r.length));
          const header = Array.from({ length: maxCols }, (_, ci) => q(formatted.headerCols[ci] ?? '')).join(",");
          const body   = formatted.bodyRows.map(r => Array.from({ length: maxCols }, (_, ci) => q(r[ci] ?? '')).join(",")).join("\r\n");
          return `# ${caption}\r\n${header}${body ? '\r\n' + body : ''}`;
        }

        const md = (tbl.markdown || "").replace(/\r\n/g, "\n");
        const mdLines = md.split("\n").map(l => l.trim()).filter(l => l.startsWith("|"));
        if (hasClientHeading) {
          const parsed = parseMdTable(mdLines);
          if (parsed && parsed.headers.length) {
            const formatted = _applyClientFormattingToTable(parsed.headers, parsed.bodyRows, activeClient, res, {
              headerIncludedInRows: false,
              allowDeepHeaderSkip: true,
            });
            const maxCols = Math.max(1, formatted.headerCols.length, ...formatted.bodyRows.map(r => r.length));
            const hdrCsv = Array.from({ length: maxCols }, (_, ci) => q(formatted.headerCols[ci] ?? '')).join(",");
            const bodyCsv = formatted.bodyRows.map(r => Array.from({ length: maxCols }, (_, ci) => q(r[ci] ?? '')).join(",")).join("\r\n");
            return `# ${caption}\r\n${hdrCsv}${bodyCsv ? '\r\n' + bodyCsv : ''}`;
          }
        }
        const dataLines = mdLines.filter(l =>
          !isSepRow(l) && l.replace(/[\s|]/g, "").length > 0
        );
        if (dataLines.length) {
          return `# ${caption}\r\n` + dataLines.map(mdRowToCsv).join("\r\n");
        }

        if (i === 0) {
          const recon = reconstructTableFromBbox(res.paddle?.lines);
          if (recon) {
            const rawRows2D = recon.rows.map(r => r.cells);
            const defHdrs = (recon.rows[recon.headerIdx]?.cells || []).map(c => String(c ?? ''));
            if (hasClientHeading) {
              const formatted = _applyClientFormattingToTable(defHdrs, rawRows2D, activeClient, res, {
                headerIncludedInRows: true,
                allowDeepHeaderSkip: true,
                fallbackHeaderIdx: recon.headerIdx,
              });
              const maxCols = Math.max(1, formatted.headerCols.length, ...formatted.bodyRows.map(r => r.length));
              const hdrCsv = Array.from({ length: maxCols }, (_, ci) => q(formatted.headerCols[ci] ?? '')).join(",");
              const bodyCsv = formatted.bodyRows.map(r => Array.from({ length: maxCols }, (_, ci) => q(r[ci] ?? '')).join(",")).join("\r\n");
              return `# ${caption || `Table ${i + 1}`} (layout reconstructed)\r\n${hdrCsv}${bodyCsv ? '\r\n' + bodyCsv : ''}`;
            }
            const csvRows = recon.rows.map(r =>
              Array.from({length: recon.maxCols}, (_, ci) => q(r.cells[ci] || "")).join(",")
            );
            return `# ${caption || `Table ${i + 1}`} (layout reconstructed)\r\n` + csvRows.join("\r\n");
          }
        }

        return `# ${caption}\r\n(no data)`;
      });
    }

    const parts = [textSection, ...tableSections];
    document.getElementById("csvOutput").textContent = parts.join("\r\n\r\n");
  })();
  document.getElementById("resultsCard").classList.remove("hidden");

  if (!preserveTab) {
    // Reset to Fused tab
    document.querySelectorAll(".tab").forEach(t => {
      const isFused = t.dataset.tab === "fused";
      t.classList.toggle("active", isFused);
      t.setAttribute("aria-selected", String(isFused));
    });
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
    document.getElementById("tab-fused").classList.remove("hidden");
  }
  if (res.job_id) currentJobId = res.job_id;
  const saveBtn = document.getElementById("saveDbBtn");
  if (saveBtn) {
    saveBtn.disabled = !currentJobId;
    saveBtn.textContent = "Save to DB";
    saveBtn.classList.remove("saved");
  }
  const dlToggle = document.getElementById("dlToggle");
  if (dlToggle) dlToggle.disabled = false;
  if (!preserveTab) {
    document.getElementById("resultsCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
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

    const filename = (selectedFile && selectedFile.name) || currentResult.filename || "unknown";
    const explicitCid = document.getElementById("resultsClientSelect")?.value || document.getElementById("uploadClientSelect")?.value || "";
    const resolvedCid = currentResult.client?.id
      ? Number(currentResult.client.id)
      : (explicitCid ? Number(explicitCid) : null);
    const payload = { filename, engine: selectedEngine, client_id: resolvedCid, result: currentResult };

    async function doSave(base) {
      return fetch(`${base}/api/ocr/save/${encodeURIComponent(currentJobId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    try {
      let r = await doSave(API_BASE);

      if (r.status === 503) {
        // DB not connected — try to reconnect first
        saveDbBtn.textContent = "Reconnecting…";
        const reconResp = await fetch(`${API_BASE}/api/db/reconnect`, { method: "POST" }).catch(() => null);

        if (!reconResp || reconResp.status === 404) {
          // Old server without reconnect endpoint — try the new server on :8081 as fallback
          saveDbBtn.textContent = "Trying alt server…";
          const altBase = window.location.origin.replace(/:808\d$/, ":8081");
          try {
            const r2 = await doSave(altBase);
            if (r2.ok) {
              r = r2;
            } else {
              const e2 = await r2.json().catch(() => ({ detail: r2.statusText }));
              throw new Error(e2.detail || "Save failed on fallback server");
            }
          } catch {
            showToast(
              "Database not connected. Run restart_server.bat, then try again.",
              true, 7000
            );
            saveDbBtn.textContent = prevLabel;
            saveDbBtn.disabled = false;
            return;
          }
        } else {
          const recon = await reconResp.json().catch(() => null);
          if (!recon?.connected) {
            showToast("Database reconnect failed. Make sure GodApp (MariaDB) is running.", true, 7000);
            saveDbBtn.textContent = prevLabel;
            saveDbBtn.disabled = false;
            return;
          }
          saveDbBtn.textContent = "Saving…";
          r = await doSave(API_BASE);
        }
      }

      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(err.detail || "Save failed");
      }
      const saved = await r.json();
      if (saved.client) {
        currentResult.client = saved.client;
        renderResults(currentResult, { preserveTab: true });
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

// ── Download dropdown ─────────────────────────────────────────
(function initDownloadDropdown() {
  const toggle = document.getElementById("dlToggle");
  const menu   = document.getElementById("dlMenu");
  if (!toggle || !menu) return;

  toggle.addEventListener("click", e => {
    e.stopPropagation();
    if (!currentResult) { showToast("No results yet."); return; }
    menu.classList.toggle("hidden");
  });

  document.addEventListener("click", () => menu.classList.add("hidden"));

  menu.querySelectorAll(".dl-item").forEach(btn => {
    btn.addEventListener("click", () => {
      menu.classList.add("hidden");
      if (!currentResult) return;
      const fmt      = btn.dataset.fmt;
      const baseName = (currentResult.filename || "ocr-result").replace(/\.[^.]+$/, "");
      let content, mime, ext;

      if (fmt === "txt") {
        content = currentResult.fused_text || currentResult.text || "";
        mime    = "text/plain";
        ext     = "txt";
      } else if (fmt === "md") {
        const md = currentResult.docling?.markdown
                || currentResult.deepseek?.markdown
                || currentResult.fused_text
                || "";
        content = md;
        mime    = "text/markdown";
        ext     = "md";
      } else if (fmt === "json") {
        content = JSON.stringify(currentResult, null, 2);
        mime    = "application/json";
        ext     = "json";
      } else if (fmt === "csv") {
        // Reuse the same CSV text already rendered in the tab
        const csvEl = document.getElementById("csvOutput");
        content = csvEl ? csvEl.textContent : (currentResult.fused_text || "");
        ext  = "csv";
        mime = "text/csv";
      }

      const blob = new Blob([content], { type: mime + ";charset=utf-8" });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement("a"), { href: url, download: `${baseName}.${ext}` });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showToast(`Downloaded as ${baseName}.${ext}`);
    });
  });
})();

// Toast
let toastTimer = null;
function showToast(msg, isErr = false, duration = 3500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.background = isErr ? "#dc2626" : "#111827";
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), duration);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}


// ── DB fetch helper — tries primary server, falls back to :8081 if DB unavailable ──
function _altDbBase() {
  return window.location.origin.replace(/:808\d$/, ':8081');
}
async function dbFetch(path, opts) {
  let r = await fetch(`${API_BASE}${path}`, opts).catch(() => null);
  if (!r || !r.ok) {
    const r2 = await fetch(`${_altDbBase()}${path}`, opts).catch(() => null);
    if (r2 && r2.ok) return r2;
  }
  return r;
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
      let r = await fetch(`${API_BASE}/api/health`).catch(() => null);
      let j = r ? await r.json().catch(() => null) : null;
      if (!j || j.database !== 'connected') {
        const r2 = await fetch(`${_altDbBase()}/api/health`).catch(() => null);
        const j2 = r2 ? await r2.json().catch(() => null) : null;
        if (j2 && j2.database === 'connected') j = j2;
      }
      if (statusEl) {
        statusEl.textContent = (j && j.database === 'connected') ? '🟢 MySQL' : '🔴 No DB';
      }
    } catch { if (statusEl) statusEl.textContent = '🔴 No DB'; }
  }

  async function loadClients() {
    if (!clientFilter) return;
    const prev = clientFilter.value;
    try {
      const r = await dbFetch('/api/db/clients');
      if (!r || !r.ok) return;
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
      const r = await dbFetch(`/api/db/jobs?limit=50${cid}`);
      if (!r || !r.ok) {
        bodyEl.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#cb2431">Database not connected</td></tr>';
        return;
      }
      const rows = await r.json();
      if (!rows.length) {
        bodyEl.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted)">解析履歴はありません</td></tr>';
        return;
      }
      const histStatusLabels = { done: '完了', error: 'エラー', processing: '処理中', queued: '待機中' };
      bodyEl.innerHTML = rows.map(j => {
        const clientLabel = j.client_name_ja
          ? `${esc(j.client_name_ja)}${j.client_name_en ? ` (${esc(j.client_name_en)})` : ''}`
          : '—';
        const stLabel = histStatusLabels[j.status] || esc(j.status);
        return `
        <tr data-job-id="${esc(j.job_id)}">
          <td style="text-align:center"><input type="checkbox" class="job-chk" data-job-id="${esc(j.job_id)}"></td>
          <td title="${esc(j.filename)}">${esc(j.filename)}</td>
          <td title="${clientLabel}">${clientLabel}</td>
          <td>${esc(j.engine_requested)}</td>
          <td><span class="status-${esc(j.status)}">${stLabel}</span></td>
          <td>${j.confidence_avg != null ? (j.confidence_avg * 100).toFixed(1) + '%' : '—'}</td>
          <td>${j.processing_time_s != null ? j.processing_time_s : '—'}</td>
          <td>${j.created_at ? esc(j.created_at.replace('T',' ').slice(0,19)) : '—'}</td>
          <td><button class="del-job-btn" data-job-id="${esc(j.job_id)}" title="この履歴を削除">🗑</button></td>
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
          if (!confirm('この解析履歴を削除しますか？')) return;
          btn.disabled = true;
          try {
            const r = await dbFetch(`/api/db/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
            const row = btn.closest('tr');
            if (row) row.remove();
            if (!bodyEl.querySelector('tr[data-job-id]')) {
              bodyEl.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted)">解析履歴はありません</td></tr>';
            }
            updateBulkBar();
            showToast('解析履歴を削除しました');
          } catch (e) {
            btn.disabled = false;
            showToast('削除に失敗しました: ' + e.message, true);
          }
        });
      });
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#cb2431">エラー: ${esc(e.message)}</td></tr>`;
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
      if (bulkCount) bulkCount.textContent = ids.length + ' 件選択中';
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
        const r = await dbFetch('/api/db/jobs/bulk-delete', {
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
