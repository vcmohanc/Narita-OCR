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
// Order view — Excel-style spreadsheet (all clients)
// ============================================================
let _orderLoaded  = false;
let _orderAllJobs = [];           // full data set
let _orderSort    = { col: 'date', dir: -1 }; // default: newest first
let _clientModalEditId = null;

// ── Client modal ──────────────────────────────────────────────
function openClientModal(client = null) {
  _clientModalEditId = client ? client.id : null;
  document.getElementById('clientModalTitle').textContent = client ? 'Edit Client' : 'Add Client';
  document.getElementById('clientFormNameJa').value   = client ? (client.name_ja  || '') : '';
  document.getElementById('clientFormNameEn').value   = client ? (client.name_en  || '') : '';
  document.getElementById('clientFormCode').value     = client ? (client.code     || '') : '';
  document.getElementById('clientFormKeywords').value = client ? (client.keywords || '') : '';
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
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  try {
    const url    = _clientModalEditId ? `${API_BASE}/api/db/clients/${_clientModalEditId}` : `${API_BASE}/api/db/clients`;
    const method = _clientModalEditId ? 'PUT' : 'POST';
    const r = await fetch(url, { method, headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name_ja: nameJa, name_en: nameEn, code, keywords }) });
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).detail || r.statusText);
    closeClientModal();
    showToast(_clientModalEditId ? 'Client updated' : 'Client added');
    await reloadOrderSheet();
  } catch (e) { showToast('Error: ' + e.message, true); }
  finally { saveBtn.disabled = false; saveBtn.textContent = 'Save Client'; }
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
  tbody.innerHTML = '<tr><td colspan="9" class="sheet-loading">Loading…</td></tr>';

  try {
    // Fetch all jobs + client list in parallel (dbFetch falls back to :8081 if primary has no DB)
    const [jobsRes, clientsRes] = await Promise.all([
      dbFetch('/api/db/jobs?limit=500'),
      dbFetch('/api/db/clients'),
    ]);
    if (!jobsRes || !jobsRes.ok) throw new Error('Database not connected');
    _orderAllJobs = await jobsRes.json();
    const clients = clientsRes.ok ? await clientsRes.json() : [];

    // Populate client filter
    const cf = document.getElementById('orderClientFilter');
    if (cf) {
      const prev = cf.value;
      cf.innerHTML = '<option value="">All Clients</option>' +
        clients.map(c => `<option value="${c.id}">${esc(c.name_ja)}${c.name_en ? ' / '+esc(c.name_en) : ''}</option>`).join('');
      cf.value = prev;
    }

    renderOrderSheet();
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="sheet-loading" style="color:var(--danger)">Error: ${esc(e.message)}</td></tr>`;
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
  if (countEl) countEl.textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''}`;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="sheet-empty">No records match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((j, idx) => {
    const clientName = j.client_name_ja
      ? `<span class="sheet-client">${esc(j.client_name_ja)}</span>${j.client_name_en ? `<span class="sheet-client-en">${esc(j.client_name_en)}</span>` : ''}`
      : '<span class="sheet-unassigned">—</span>';
    const engine     = esc(j.primary_engine || j.engine_requested || '—');
    const statusCls  = `badge badge-${esc(j.status)}`;
    const confVal    = j.confidence_avg != null ? j.confidence_avg * 100 : null;
    const confStr    = confVal != null ? confVal.toFixed(1) + '%' : '—';
    const confClass  = confVal == null ? '' : confVal >= 85 ? '' : confVal >= 65 ? 'conf-warn' : 'conf-low';
    const confBar    = confVal != null
      ? `<div class="conf-bar-wrap"><div class="conf-bar" style="width:${Math.round(confVal)}%"></div></div>`
      : '';
    const date       = j.created_at ? j.created_at.replace('T',' ').slice(0,16) : '—';
    const timeStr    = j.processing_time_s != null ? j.processing_time_s + 's' : '—';
    return `<tr class="${idx % 2 === 1 ? 'row-alt' : ''}"
               data-job-id="${esc(j.job_id)}" data-filename="${esc(j.filename)}">
      <td class="col-no">${idx + 1}</td>
      <td class="col-client">${clientName}</td>
      <td class="col-file" title="${esc(j.filename)}">${esc(j.filename)}</td>
      <td class="col-engine"><span class="badge badge-engine">${engine}</span></td>
      <td class="col-status"><span class="${statusCls}"><span class="badge-dot"></span>${esc(j.status)}</span></td>
      <td class="col-conf"><span class="conf-cell ${confClass}">${confBar}<span>${confStr}</span></span></td>
      <td class="col-time">${esc(timeStr)}</td>
      <td class="col-date">${esc(date)}</td>
      <td class="col-preview"><button class="preview-btn" data-job-id="${esc(j.job_id)}" data-filename="${esc(j.filename)}" title="Preview">▶</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-job-id]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.preview-btn')) return;
      openOrderPreview(tr.dataset.jobId, tr.dataset.filename);
    });
  });
  tbody.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openOrderPreview(btn.dataset.jobId, btn.dataset.filename); });
  });
}

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

// ── Excel Preview Modal ───────────────────────────────────────
let _xlsActiveSheet = 0;
let _xlsSheets = [];

function _colLetter(i) {
  let n = i, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
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

function _buildSheets(result) {
  const sheets = [];
  const tables = result.tables || [];
  tables.forEach((tbl, i) => {
    let rows = null;
    if (tbl.data && Array.isArray(tbl.data) && tbl.data.length > 0) {
      rows = tbl.data;
    } else if (tbl.markdown && tbl.markdown.trim()) {
      rows = _parseMdToRows(tbl.markdown);
    }
    if (rows && rows.length > 0) {
      const detected = _detectHeaderRow(rows);
      sheets.push({
        name: tbl.caption ? tbl.caption.substring(0, 20) : ('Table ' + (i + 1)),
        rows,
        hasHeader: detected >= 0,
        headerIdx: detected >= 0 ? detected : 0
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
          headerIdx: detected >= 0 ? detected : (recon.headerIdx >= 0 ? recon.headerIdx : 0)
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
          headerIdx: detected >= 0 ? detected : 0
        });
      }
    }
  }

  const text = result.fused_text || result.text || '';
  if (text) {
    const rows = text.split('\n').filter(l => l.trim()).map(l => [l]);
    sheets.push({ name: 'Full Text', rows, hasHeader: false, headerIdx: -1 });
  }

  if (sheets.length === 0) sheets.push({ name: 'Sheet1', rows: [['No data']], hasHeader: false, headerIdx: -1 });
  return sheets;
}

function _syncHeaderSelect(sheet) {
  const select = document.getElementById('xlsHeaderSelect');
  if (!select) return;
  const rows = sheet.rows || [];
  let html = '<option value="-1">Default (A, B, C...)</option>';
  rows.forEach((r, idx) => {
    const preview = r.filter(c => c != null && String(c).trim()).slice(0, 4).join(' | ');
    const previewTrimmed = preview.length > 32 ? preview.substring(0, 32) + '…' : preview;
    const label = `Row ${idx + 1}` + (previewTrimmed ? `: ${previewTrimmed}` : '');
    const isSelected = sheet.hasHeader && sheet.headerIdx === idx;
    html += `<option value="${idx}" ${isSelected ? 'selected' : ''}>${esc(label)}</option>`;
  });
  select.innerHTML = html;
  if (!sheet.hasHeader || sheet.headerIdx < 0) {
    select.value = "-1";
  } else {
    select.value = String(sheet.headerIdx);
  }
}

function _renderXlsGrid(sheet) {
  const gridWrap  = document.getElementById('xlsGridWrap');
  const cellRefEl = document.getElementById('xlsCellRef');
  const cellValEl = document.getElementById('xlsCellVal');
  const statusEl  = document.getElementById('xlsStatusBar');
  const { rows, hasHeader, headerIdx } = sheet;
  if (!rows || rows.length === 0) { gridWrap.innerHTML = '<div class="xls-loading">No data</div>'; return; }

  _syncHeaderSelect(sheet);

  const maxCols = Math.max(...rows.map(r => r.length));
  const colLetters = Array.from({ length: maxCols }, (_, i) => _colLetter(i));

  let selectedTd = null, selectedColIdx = -1, selectedRowIdx = -1;

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
    
    let headingVal = '';
    if (hasHeader && headerIdx >= 0 && headerIdx < rows.length) {
      const raw = rows[headerIdx][ci];
      if (raw != null && String(raw).trim()) {
        headingVal = String(raw).trim();
      }
    }

    if (headingVal) {
      th.classList.add('has-heading');
      th.innerHTML = `<div class="xls-th-letter">${letter}</div><div class="xls-th-title" title="${esc(headingVal)}">${esc(headingVal)}</div>`;
    } else {
      th.innerHTML = `<div class="xls-th-letter">${letter}</div>`;
    }
    colHeaderRow.appendChild(th);
    return th;
  });
  thead.appendChild(colHeaderRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const rowNumCells = [];
  rows.forEach((rowCells, ri) => {
    const tr = document.createElement('tr');
    const isHdr = hasHeader && ri === headerIdx;
    if (isHdr) {
      tr.className = 'xls-row-is-header';
    } else if (ri % 2 === 1) {
      tr.className = 'xls-row-alt';
    }

    const rowNum = document.createElement('td');
    rowNum.className = 'xls-td-row' + (isHdr ? ' is-header-row' : '');
    rowNum.textContent = ri + 1;
    rowNum.title = isHdr
      ? `Row ${ri + 1} is currently the Header Row (click to unselect)`
      : `Click to set Row ${ri + 1} as Header Row`;

    rowNum.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sheet.hasHeader && sheet.headerIdx === ri) {
        sheet.hasHeader = false;
        sheet.headerIdx = -1;
        showToast('Header reset to default');
      } else {
        sheet.hasHeader = true;
        sheet.headerIdx = ri;
        showToast(`Row ${ri + 1} set as table heading`);
      }
      _renderXlsGrid(sheet);
    });

    tr.appendChild(rowNum);
    rowNumCells.push(rowNum);

    for (let ci = 0; ci < maxCols; ci++) {
      const td = document.createElement('td');
      td.className = 'xls-cell' + (isHdr ? ' xls-hdr' : '');
      const val = rowCells[ci] != null ? String(rowCells[ci]) : '';
      td.title = val;
      td.textContent = val;

      td.addEventListener('click', () => {
        if (selectedTd) {
          selectedTd.classList.remove('xls-sel');
          if (selectedColIdx >= 0) colHeaders[selectedColIdx]?.classList.remove('xls-col-sel');
          if (selectedRowIdx >= 0) rowNumCells[selectedRowIdx]?.classList.remove('xls-row-sel');
        }
        selectedTd = td; selectedColIdx = ci; selectedRowIdx = ri;
        td.classList.add('xls-sel');
        colHeaders[ci]?.classList.add('xls-col-sel');
        rowNum.classList.add('xls-row-sel');
        cellRefEl.textContent = colLetters[ci] + (ri + 1);
        cellValEl.textContent = val;

        const setBtn = document.getElementById('xlsSetHeaderBtn');
        if (setBtn) {
          setBtn.textContent = `📌 Set Row ${ri + 1} as Header`;
        }
      });
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  gridWrap.innerHTML = '';
  gridWrap.appendChild(table);
  gridWrap.scrollTop = 0; gridWrap.scrollLeft = 0;

  const dataRows = (hasHeader && headerIdx >= 0) ? Math.max(0, rows.length - 1) : rows.length;
  const headerNote = (hasHeader && headerIdx >= 0) ? ` · Heading: Row ${headerIdx + 1}` : '';
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
  document.getElementById('xlsCellVal').textContent = '';
  document.getElementById('xlsStatusBar').textContent = '';
  modal.classList.remove('hidden');

  let result = null;
  try {
    const r = await dbFetch('/api/ocr/result/' + encodeURIComponent(jobId));
    if (r && r.ok) result = await r.json();
  } catch {}

  if (!result) { loading.textContent = 'Could not load result.'; return; }

  _xlsSheets = _buildSheets(result);
  _xlsActiveSheet = 0;

  _xlsSheets.forEach((sheet, i) => {
    const tab = document.createElement('div');
    tab.className = 'xls-sheet-tab' + (i === 0 ? ' active' : '');
    tab.textContent = sheet.name;
    tab.addEventListener('click', () => {
      _xlsActiveSheet = i;
      sheetTabsEl.querySelectorAll('.xls-sheet-tab').forEach((t, j) => t.classList.toggle('active', j === i));
      _renderXlsGrid(_xlsSheets[i]);
    });
    sheetTabsEl.appendChild(tab);
  });

  // Wire header controls
  const headerSelect = document.getElementById('xlsHeaderSelect');
  if (headerSelect) {
    headerSelect.onchange = () => {
      const sheet = _xlsSheets[_xlsActiveSheet];
      if (!sheet) return;
      const val = parseInt(headerSelect.value, 10);
      if (val >= 0) {
        sheet.hasHeader = true;
        sheet.headerIdx = val;
        showToast(`Row ${val + 1} set as table heading`);
      } else {
        sheet.hasHeader = false;
        sheet.headerIdx = -1;
        showToast('Headers reset to default (A, B, C...)');
      }
      _renderXlsGrid(sheet);
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
        sheet.hasHeader = true;
        sheet.headerIdx = rowNum;
        _renderXlsGrid(sheet);
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
      _renderXlsGrid(sheet);
      showToast('Headers reset to default (A, B, C...)');
    };
  }

  loading.classList.add('hidden');
  gridWrap.classList.remove('hidden');
  _renderXlsGrid(_xlsSheets[0]);

  document.getElementById('xlsCsvBtn').onclick = () => {
    const sheet = _xlsSheets[_xlsActiveSheet];
    if (!sheet || !sheet.rows) return;

    let exportRows = [];
    if (sheet.hasHeader && sheet.headerIdx >= 0 && sheet.headerIdx < sheet.rows.length) {
      for (let m = 0; m < sheet.headerIdx; m++) {
        const line = sheet.rows[m].filter(c => c != null && String(c).trim()).join(' | ');
        if (line) exportRows.push(['# ' + line]);
      }
      exportRows.push(sheet.rows[sheet.headerIdx]);
      for (let d = sheet.headerIdx + 1; d < sheet.rows.length; d++) {
        exportRows.push(sheet.rows[d]);
      }
    } else {
      exportRows = sheet.rows;
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeXlsModal(); });

document.getElementById('orderPreviewClose')?.addEventListener('click', () => {
  document.getElementById('orderPreview')?.classList.add('hidden');
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

  // Render a reconstructed bbox table as an HTML string.
  // The row with the most columns becomes <thead>; all other rows become <tbody>.
  function renderBboxTable(caption, recon) {
    const { rows, maxCols, headerIdx } = recon;
    const header = rows[headerIdx];
    // Data rows = everything except the header row
    const bodyRows = [...rows.slice(0, headerIdx), ...rows.slice(headerIdx + 1)];
    const thead = `<thead><tr>${header.cells.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${bodyRows.map((r, ri) =>
      `<tr class="${ri % 2 === 1 ? 'tbl-alt' : ''}">${
        Array.from({length: maxCols}, (_, ci) => `<td>${esc(r.cells[ci] || '')}</td>`).join('')
      }</tr>`
    ).join('')}</tbody>`;
    return `<div class="tbl-block">
      <div class="tbl-header">
        <span class="tbl-title">${caption} <small style="font-weight:400;color:var(--muted)">(layout reconstructed)</small></span>
        <span class="tbl-meta">${bodyRows.length} rows × ${maxCols} cols</span>
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

  const tables = res.tables || res.docling?.tables || [];
  if (!tables.length) {
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
      const shape = tbl.shape || [rows.length, rows.length ? Object.keys(rows[0]).length : 0];
      const caption = tbl.caption ? esc(tbl.caption) : `Table ${i + 1}`;

      // If no row data, try to parse the markdown or fall back to docling full markdown
      if (!rows.length) {
        // Try per-table markdown first (works when PPStructure fallback populated it)
        const tblMdLines = (tbl.markdown || "").replace(/\r\n/g, "\n")
          .split("\n").map(l => l.trim()).filter(l => l.startsWith("|"));
        let parsed = parseMdTable(tblMdLines);

        // If that failed, try the i-th table from full Docling markdown
        if (!parsed) {
          const docMdTables = extractMdTables(res.docling?.markdown);
          if (docMdTables[i]) parsed = parseMdTable(docMdTables[i]);
        }

        if (parsed && parsed.headers.length) {
          const thead = `<thead><tr>${parsed.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
          const tbody = `<tbody>${parsed.bodyRows.map((r, ri) =>
            `<tr class="${ri % 2 === 1 ? 'tbl-alt' : ''}">${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`
          ).join('')}</tbody>`;
          return `<div class="tbl-block">
            <div class="tbl-header">
              <span class="tbl-title">${caption}</span>
              <span class="tbl-meta">${parsed.bodyRows.length} rows × ${parsed.headers.length} cols</span>
            </div>
            <div class="tbl-scroll"><table class="tbl-grid">${thead}${tbody}</table></div>
          </div>`;
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
      // Detect if first column keys are numeric (0,1,2…) → treat first data row as header
      const numericKeys = cols.every(c => !isNaN(Number(c)));
      let headerCols, bodyRows;
      if (numericKeys && rows.length > 1) {
        headerCols = cols.map(c => String(rows[0][c] ?? ''));
        bodyRows   = rows.slice(1);
      } else {
        headerCols = cols;
        bodyRows   = rows;
      }

      const thead = `<thead><tr>${headerCols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${bodyRows.map((r, ri) =>
        `<tr class="${ri % 2 === 1 ? 'tbl-alt' : ''}">${cols.map(c => `<td>${esc(String(r[c] ?? ''))}</td>`).join('')}</tr>`
      ).join('')}</tbody>`;

      return `<div class="tbl-block">
        <div class="tbl-header">
          <span class="tbl-title">${caption}</span>
          <span class="tbl-meta">${shape[0]} rows × ${shape[1]} cols</span>
        </div>
        <div class="tbl-scroll">
          <table class="tbl-grid">
            ${thead}
            ${tbody}
          </table>
        </div>
      </div>`;
    }).join('');
  }

  document.getElementById("rawJson").textContent = JSON.stringify(res, null, 2);

  // CSV tab — full fused text + all table blocks
  (function renderCsv() {
    const q = s => `"${String(s).replace(/"/g, '""')}"`;

    // ── Section 1: complete fused text ───────────────────────────
    const fusedLines = (res.fused_text || "").split("\n");
    const textSection = "# Full Text\r\nline\r\n" + fusedLines.map(q).join("\r\n");

    // ── Section 2: tables ─────────────────────────────────────────
    // Prefer the full Docling document markdown — it has the actual
    // table headers & data rows that the per-table DataFrame often lacks.
    // Also try DeepSeek markdown as additional source.
    const docMd = res.docling?.markdown || res.deepseek?.markdown || "";
    const docMdTables = extractMdTables(docMd);

    let tableSections;
    if (docMdTables.length > 0) {
      tableSections = docMdTables.map((lines, i) => {
        const dataLines = lines.filter(l => !isSepRow(l) && l.replace(/[\s|]/g, "").length > 0);
        if (!dataLines.length) return null;
        return `# Table ${i + 1}\r\n` + dataLines.map(mdRowToCsv).join("\r\n");
      }).filter(Boolean);
    } else {
      // Fallback: per-table objects from res.tables
      const tables = res.tables || res.docling?.tables || [];
      tableSections = tables.map((tbl, i) => {
        const caption = tbl.caption || `Table ${i + 1}`;
        const rows = tbl.data || [];

        // Path A: structured row data
        if (rows.length) {
          const cols = Object.keys(rows[0]);
          const numericKeys = cols.every(c => !isNaN(Number(c)));
          let headerCols, bodyRows;
          if (numericKeys && rows.length > 1) {
            headerCols = cols.map(c => String(rows[0][c] ?? ""));
            bodyRows   = rows.slice(1);
          } else {
            headerCols = cols;
            bodyRows   = rows;
          }
          const header = headerCols.map(q).join(",");
          const body   = bodyRows.map(r => cols.map(c => q(r[c] ?? "")).join(",")).join("\r\n");
          return `# ${caption}\r\n${header}\r\n${body}`;
        }

        // Path B: parse per-table markdown
        const md = (tbl.markdown || "").replace(/\r\n/g, "\n");
        const mdLines = md.split("\n").map(l => l.trim()).filter(l => l.startsWith("|"));
        // dataLines: not a separator AND has at least one non-empty cell
        const dataLines = mdLines.filter(l =>
          !isSepRow(l) && l.replace(/[\s|]/g, "").length > 0
        );
        if (dataLines.length) {
          return `# ${caption}\r\n` + dataLines.map(mdRowToCsv).join("\r\n");
        }

        // Path C: bbox reconstruction (only on first table)
        if (i === 0) {
          const recon = reconstructTableFromBbox(res.paddle?.lines);
          if (recon) {
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
  const dlToggle = document.getElementById("dlToggle");
  if (dlToggle) dlToggle.disabled = false;
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

    const filename = (selectedFile && selectedFile.name) || currentResult.filename || "unknown";
    const payload = { filename, engine: selectedEngine, result: currentResult };

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
            const r = await dbFetch(`/api/db/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
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
