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
      if (target === 'todayOrder') initTodayOrderView();
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

// ── Today Order view (Multi-Format: Chiba + Haibukiya CRUD) ───
const TODAY_ORDER_FORMATS = {
  chiba: {
    cols: 8,
    dayStartCol: 2,
    storageKey: 'ocr_today_order_sheet_v1_chiba',
    legacyStorageKey: 'ocr_today_order_sheet_v1',
    xlsxFile: 'chiba_auto_order.xlsx',
    downloadName: '千葉自動発注書（発注分のみ）.xlsx',
    csvName: '千葉自動発注書_発注書.csv',
    defaultDate: '2026-10-26',
  },
  haibukiya: {
    cols: 13,
    dayStartCol: 6,
    storageKey: 'ocr_today_order_sheet_v1_haibukiya',
    xlsxFile: 'haibukiya_order.xlsx',
    downloadName: '発注書_株式会社灰吹屋御中.xlsx',
    csvName: '灰吹屋_発注書.csv',
    defaultDate: '2026-10-19',
  },
};
const TODAY_PRESET_ITEMS = ['大根', '赤からし水菜', '小江戸菜', 'スイスチャード', 'ほうれん草', 'キャベツ', 'ホテル風か様用'];
const TODAY_HAIBUKIYA_CATEGORIES = ['葉物類', '葉菜類', '根菜類', '果物類', 'イタリア・レストラン野菜'];
const TODAY_HAIBUKIYA_PRESETS = [
  { category: '葉物類', name: '水菜', origin: '千葉', spec: '150g/5p', priceP: '165', priceCs: '825', jan: '4514811010524', days: ['1', '', '', '6→1', '', ''], note: '生育不良により欠品の可能性あり' },
  { category: '葉物類', name: 'ベビーリーフ', origin: '千葉', spec: '40g/5p', priceP: '165', priceCs: '825', jan: '4514811010470', days: ['1', '', '', '1→6', '', ''], note: '生育不良により欠品の可能性あり' },
  { category: '葉菜類', name: 'サニーレタス', origin: '群馬・長野', spec: 'L/5玉', priceP: '190', priceCs: '950', jan: '4514811010036', days: ['5', '', '', '5', '', ''], note: '' },
  { category: '根菜類', name: '人参', origin: '青森・北海道・山梨', spec: '400g/5p', priceP: '225', priceCs: '1,125', jan: '4514811010111', days: ['1', '', '', '', '', ''], note: '' },
  { category: '根菜類', name: 'じゃが芋', origin: '青森・岩手・北海道', spec: '約500g/5p', priceP: '275', priceCs: '1,375', jan: '4514811010128', days: ['', '', '', '1', '', ''], note: '' },
  { category: '根菜類', name: '玉ねぎ', origin: '北海道', spec: '500g/5p', priceP: '280', priceCs: '1,400', jan: '4514811050339', days: ['', '', '', '1', '', ''], note: '' },
  { category: '根菜類', name: '生姜', origin: '熊本・千葉', spec: '50g/5p', priceP: '145', priceCs: '725', jan: '4514811013730', days: ['1', '', '', '', '', ''], note: '' },
  { category: '根菜類', name: 'にんにく', origin: '長野', spec: '1〜2コ/5p', priceP: '198', priceCs: '990', jan: '4514811011187', days: ['1', '', '', '', '', ''], note: '群馬県産終了' },
  { category: '果物類', name: 'レモン', origin: '香川', spec: '2コ/5p', priceP: '245', priceCs: '1,225', jan: '4514811010678', days: ['1', '', '', '', '', ''], note: '' },
  { category: 'イタリア・レストラン野菜', name: 'カリーノケール', origin: '群馬・長野', spec: '100g/5p', priceP: '155', priceCs: '775', jan: '4514811014966', days: ['3', '', '', '3', '', ''], note: '生育不良により欠品の可能性あり' },
];
const TODAY_VALID_UNITS = ['cs', 'p', 'kg', 'g', '束', '袋', '箱', '本', '個', '玉', 'パック', 'ケース', '枚', 'セット', 'ネット', '把', '丁', '尾', '杯'];

let _todayOrderCurrentFormat = 'chiba';
let _todayOrderInitialized = false;
let _todayOrderRows = [];
let _todayOrderSelRow = 0;
let _todayOrderSelCol = 0;
let _todayOrderDirty = false;
let _todayOrderEditRowIdx = null;

function _todayFmtCfg(fmt = _todayOrderCurrentFormat) {
  return TODAY_ORDER_FORMATS[fmt] || TODAY_ORDER_FORMATS.chiba;
}
function _todayColCount(fmt = _todayOrderCurrentFormat) {
  return _todayFmtCfg(fmt).cols;
}
function _todayDayStartCol(fmt = _todayOrderCurrentFormat) {
  return _todayFmtCfg(fmt).dayStartCol;
}

function _validateTodayUnit(rawUnit) {
  const rawStr = String(rawUnit == null ? '' : rawUnit);
  const val = rawStr.normalize('NFKC').trim();
  if (!val) {
    return { valid: false, normalized: '', error: '単位を入力・選択してください' };
  }
  if (/[0-9０-９]/.test(rawStr) || /\d/.test(val)) {
    return {
      valid: false,
      normalized: val.replace(/[0-9０-９]/g, '').trim(),
      error: '単位には数値を入力できません',
    };
  }
  const lower = val.toLowerCase();
  const matched = TODAY_VALID_UNITS.find(u => u.toLowerCase() === lower);
  return { valid: true, normalized: matched || val, error: '' };
}

function _setTodayModalValMsg(msg) {
  const el = document.getElementById('todayModalValidationMsg');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

function _createTodayOrderInitialRows(fmt = _todayOrderCurrentFormat) {
  if (fmt === 'haibukiya') {
    const ncols = TODAY_ORDER_FORMATS.haibukiya.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',    cells: pad('発注書　株式会社灰吹屋 御中（発注分のみ）') },
      { type: 'meta',     cells: pad('販売部 部長 石川様　／　宮前平店 店長 佐藤様　／　発注先：㈱ベジコープ（FAX 03-6808-0900）') },
      { type: 'meta',     cells: pad('見積期間：2026年10月19日（月）〜10月24日（土）販売分　／　価格は店着価格（税別）　／　作成：2026年10月19日 佐藤・栗山') },
      { type: 'spacer',   cells: Array(ncols).fill('') },
      { type: 'header',   cells: ['品目', '産地', '規格・入数', '単価/p', '単価/cs', 'JANコード', '10/19\n月', '10/20\n火', '10/21\n水', '10/22\n木', '10/23\n金', '10/24\n土', '備考・産地状況'] },
      { type: 'category', cells: pad('葉物類') },
      { type: 'item',     cells: ['水菜', '千葉', '150g/5p', '165', '825', '4514811010524', '1', '', '', '6→1', '', '', '生育不良により欠品の可能性あり'] },
      { type: 'item',     cells: ['ベビーリーフ', '千葉', '40g/5p', '165', '825', '4514811010470', '1', '', '', '1→6', '', '', '生育不良により欠品の可能性あり'] },
      { type: 'category', cells: pad('葉菜類') },
      { type: 'item',     cells: ['サニーレタス', '群馬・長野', 'L/5玉', '190', '950', '4514811010036', '5', '', '', '5', '', '', ''] },
      { type: 'category', cells: pad('根菜類') },
      { type: 'item',     cells: ['人参', '青森・北海道・山梨', '400g/5p', '225', '1,125', '4514811010111', '1', '', '', '', '', '', ''] },
      { type: 'item',     cells: ['じゃが芋', '青森・岩手・北海道', '約500g/5p', '275', '1,375', '4514811010128', '', '', '', '1', '', '', ''] },
      { type: 'item',     cells: ['玉ねぎ', '北海道', '500g/5p', '280', '1,400', '4514811050339', '', '', '', '1', '', '', ''] },
      { type: 'item',     cells: ['生姜', '熊本・千葉', '50g/5p', '145', '725', '4514811013730', '1', '', '', '', '', '', ''] },
      { type: 'item',     cells: ['にんにく', '長野', '1〜2コ/5p', '198', '990', '4514811011187', '1', '', '', '', '', '', '群馬県産終了'] },
      { type: 'category', cells: pad('果物類') },
      { type: 'item',     cells: ['レモン', '香川', '2コ/5p', '245', '1,225', '4514811010678', '1', '', '', '', '', '', ''] },
      { type: 'category', cells: pad('イタリア・レストラン野菜') },
      { type: 'item',     cells: ['カリーノケール', '群馬・長野', '100g/5p', '155', '775', '4514811014966', '3', '', '', '3', '', '', '生育不良により欠品の可能性あり'] },
      { type: 'spacer',   cells: Array(ncols).fill('') },
      { type: 'note',     cells: pad('※ 「6→1」は原本の「変更」欄による修正（元の数量→変更後）。') },
      { type: 'note',     cells: pad('※ 10/21（水）は納品なし（グレー）。店舗直納のため、1回あたりの発注合計は8,000円以上でお願いします。') },
      { type: 'note',     cells: pad('※ 発注数の入っている品目のみ表示（発注なし・休止の品目は省略）。') },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  const ncols = TODAY_ORDER_FORMATS.chiba.cols;
  const rows = [
    { type: 'title',  cells: ['千葉自動発注書（発注分のみ）', '', '', '', '', '', '', ''] },
    { type: 'meta',   cells: ['宛先：千葉成田センター\u3000／\u3000発注先：葛西産直ファーム', '', '', '', '', '', '', ''] },
    { type: 'meta',   cells: ['対象期間：2026年10月26日（月）〜10月31日（土）', '', '', '', '', '', '', ''] },
    { type: 'spacer', cells: Array(ncols).fill('') },
    { type: 'header', cells: ['品目', '単位', '10/26\n月', '10/27\n火', '10/28\n水', '10/29\n木', '10/30\n金', '10/31\n土'] },
    { type: 'merged', cells: ['今週（10/26〜10/31）の発注はありません（全品目 休止）', '', '', '', '', '', '', ''] },
    { type: 'spacer', cells: Array(ncols).fill('') },
    { type: 'note',   cells: ['※ 発注数の入っている品目のみ表示する設定ですが、今週は該当する品目がありません。', '', '', '', '', '', '', ''] },
    { type: 'note',   cells: ['※ 原本では大根・赤からし水菜・小江戸菜・スイスチャード・ほうれん草・キャベツが休止、ホテル風か様用は数量未記入。', '', '', '', '', '', '', ''] },
  ];
  for (let i = 0; i < 6; i++) {
    rows.push({ type: 'data', cells: Array(ncols).fill('') });
  }
  return rows;
}

function _normalizeTodayOrderRowsClient(rawRows, fmt = _todayOrderCurrentFormat) {
  const ncols = _todayColCount(fmt);
  const allowed = new Set(['title', 'meta', 'spacer', 'header', 'category', 'item', 'merged', 'note', 'data']);
  if (!Array.isArray(rawRows) || !rawRows.length) return _createTodayOrderInitialRows(fmt);
  return rawRows.map(r => {
    const type = allowed.has(r?.type) ? r.type : 'data';
    const cells = Array.from({ length: ncols }, (_, ci) => {
      const v = r?.cells?.[ci];
      return v != null ? String(v) : '';
    });
    return { type, cells };
  });
}

function _markTodayOrderDirty(dirty) {
  _todayOrderDirty = !!dirty;
  const saveBtn = document.getElementById('todayOrderSaveBtn');
  if (!saveBtn) return;
  saveBtn.classList.toggle('is-dirty', _todayOrderDirty);
  saveBtn.textContent = _todayOrderDirty ? '💾 保存*' : '💾 保存';
}

function _persistTodayOrderLocal(fmt = _todayOrderCurrentFormat) {
  try {
    const cfg = _todayFmtCfg(fmt);
    localStorage.setItem(cfg.storageKey, JSON.stringify(_todayOrderRows));
  } catch {}
}

async function saveTodayOrderSheet(silent = false) {
  const fmt = _todayOrderCurrentFormat;
  if (fmt === 'chiba') {
    for (let i = 0; i < _todayOrderRows.length; i++) {
      const r = _todayOrderRows[i];
      const hasName = !!String(r.cells?.[0] || '').trim();
      if ((r.type === 'item' || (r.type === 'data' && hasName)) && hasName) {
        const check = _validateTodayUnit(r.cells?.[1]);
        if (!check.valid) {
          _todayOrderSelRow = i;
          _todayOrderSelCol = 1;
          _renderTodayOrderGrid();
          showToast(`${i + 1} 行目（${r.cells[0]}）: ${check.error}`, true);
          return false;
        }
        r.cells[1] = check.normalized;
      }
    }
  }
  _persistTodayOrderLocal(fmt);
  const saveBtn = document.getElementById('todayOrderSaveBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
  }
  try {
    const r = await fetch(`${API_BASE}/api/today-order?format=${encodeURIComponent(fmt)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: _todayOrderRows }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.statusText);
    }
    _markTodayOrderDirty(false);
    if (saveBtn) saveBtn.textContent = '💾 保存済';
    if (!silent) showToast('本日の発注書を保存しました');
    return true;
  } catch (e) {
    _markTodayOrderDirty(false);
    if (!silent) showToast('ブラウザに保存しました（サーバー同期エラー: ' + e.message + '）', true);
    return false;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function loadTodayOrderSheet(fmt = _todayOrderCurrentFormat) {
  const cfg = _todayFmtCfg(fmt);
  try {
    const r = await fetch(`${API_BASE}/api/today-order?format=${encodeURIComponent(fmt)}`);
    if (r.ok) {
      const data = await r.json();
      if (data && !data.is_default && Array.isArray(data.rows) && data.rows.length) {
        _todayOrderRows = _normalizeTodayOrderRowsClient(data.rows, fmt);
        _persistTodayOrderLocal(fmt);
        return;
      }
    }
  } catch {}
  try {
    const cached = localStorage.getItem(cfg.storageKey) || (cfg.legacyStorageKey ? localStorage.getItem(cfg.legacyStorageKey) : null);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length) {
        _todayOrderRows = _normalizeTodayOrderRowsClient(parsed, fmt);
        return;
      }
    }
  } catch {}
  _todayOrderRows = _createTodayOrderInitialRows(fmt);
}

function _renderTodayPresetChips() {
  const quickEl = document.getElementById('todayOrderQuickPresets');
  const modalEl = document.getElementById('todayItemPresetChips');
  const isHaibukiya = _todayOrderCurrentFormat === 'haibukiya';
  const items = isHaibukiya ? TODAY_HAIBUKIYA_PRESETS.map(p => p.name) : TODAY_PRESET_ITEMS;

  if (quickEl) {
    quickEl.innerHTML =
      '<span class="today-preset-label">クイック追加:</span>' +
      items.map(n => `<button type="button" class="today-preset-chip" data-preset="${esc(n)}">+ ${esc(n)}</button>`).join('') +
      `<button type="button" class="today-preset-chip today-preset-chip-all" id="todayOrderAddAllPresetsBtn">+ 全${items.length}品目を一括追加</button>`;
    quickEl.querySelectorAll('.today-preset-chip[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => openTodayOrderItemModal(null, btn.dataset.preset || ''));
    });
    document.getElementById('todayOrderAddAllPresetsBtn')?.addEventListener('click', () => {
      openTodayOrderItemModal(null, '', { fillAllPresets: true });
    });
  }

  if (modalEl) {
    modalEl.innerHTML =
      items.map(n => `<button type="button" class="today-preset-chip" data-preset="${esc(n)}">+ ${esc(n)}</button>`).join('') +
      `<button type="button" class="today-preset-chip today-preset-chip-all" id="todayModalFillAllPresetsBtn">+ 全${items.length}品目をセット</button>`;
    modalEl.querySelectorAll('.today-preset-chip[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => _fillTodayModalPreset(btn.dataset.preset || ''));
    });
    document.getElementById('todayModalFillAllPresetsBtn')?.addEventListener('click', () => {
      const tbody = document.getElementById('todayModalItemsBody');
      if (!tbody) return;
      Array.from(tbody.children).forEach(tr => {
        const nameVal = (tr.querySelector('.today-m-name')?.value || '').trim();
        if (!nameVal) tr.remove();
      });
      const existing = new Set(
        Array.from(tbody.querySelectorAll('.today-m-name')).map(inp => inp.value.trim()).filter(Boolean)
      );
      let firstAdded = null;
      if (_todayOrderCurrentFormat === 'haibukiya') {
        TODAY_HAIBUKIYA_PRESETS.forEach(p => {
          if (!existing.has(p.name)) {
            const tr = _appendTodayModalItemRow({ ...p, days: [...p.days] });
            if (!firstAdded) firstAdded = tr;
          }
        });
      } else {
        TODAY_PRESET_ITEMS.forEach(pName => {
          if (!existing.has(pName)) {
            const tr = _appendTodayModalItemRow({ name: pName, unit: '', days: ['', '', '', '', '', ''] });
            if (!firstAdded) firstAdded = tr;
          }
        });
      }
      _renumberTodayModalRows();
      (firstAdded?.querySelector('.today-m-unit') || firstAdded?.querySelector('.today-m-day'))?.focus();
    });
  }
}

async function switchTodayOrderFormat(fmt) {
  const nextFmt = fmt === 'haibukiya' ? 'haibukiya' : 'chiba';
  _todayOrderCurrentFormat = nextFmt;

  const sel = document.getElementById('todayOrderFormatSelect');
  if (sel) sel.value = nextFmt;

  document.querySelectorAll('#todayOrderSheetTabs .xls-sheet-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.format === nextFmt);
  });

  const addCatBtn = document.getElementById('todayOrderAddCategoryBtn');
  if (addCatBtn) addCatBtn.classList.toggle('hidden', nextFmt !== 'haibukiya');

  _renderTodayPresetChips();
  await loadTodayOrderSheet(nextFmt);
  _todayOrderSelRow = 0;
  _todayOrderSelCol = 0;
  _markTodayOrderDirty(false);
  _renderTodayOrderGrid();
}

function _countTodayOrderItems() {
  return _todayOrderRows.filter(r =>
    r.type === 'item' || (r.type === 'data' && r.cells.some(c => String(c || '').trim()))
  ).length;
}

function _updateTodayOrderHeaderBadges() {
  const countBadge = document.getElementById('todayOrderItemCount');
  if (countBadge) {
    countBadge.textContent = `${_countTodayOrderItems()} 品目`;
  }
}

function _getTodayHeaderDateSpan() {
  const hdr = _todayOrderRows.find(r => r.type === 'header');
  const startCol = _todayDayStartCol();
  if (!hdr) return _todayOrderCurrentFormat === 'haibukiya' ? '10/19〜10/24' : '10/26〜10/31';
  const startRaw = String(hdr.cells[startCol] || '').split('\n')[0].trim() || '10/26';
  const endRaw = String(hdr.cells[startCol + 5] || '').split('\n')[0].trim() || '10/31';
  return `${startRaw}〜${endRaw}`;
}

function _syncTodayOrderMergedNotice() {
  if (_todayOrderCurrentFormat === 'haibukiya') return;
  const hasItems = _todayOrderRows.some(r => r.type === 'item');
  if (hasItems) {
    _todayOrderRows = _todayOrderRows.filter(r => r.type !== 'merged');
    return;
  }
  const hasMerged = _todayOrderRows.some(r => r.type === 'merged');
  if (!hasMerged) {
    const hdrIdx = _todayOrderRows.findIndex(r => r.type === 'header');
    const insertAt = hdrIdx >= 0 ? hdrIdx + 1 : Math.min(5, _todayOrderRows.length);
    const span = _getTodayHeaderDateSpan();
    _todayOrderRows.splice(insertAt, 0, {
      type: 'merged',
      cells: [`今週（${span}）の発注はありません（全品目 休止）`, ...Array(_todayColCount() - 1).fill('')],
    });
  }
}

function _isTodayRowSpanned(rowObj) {
  if (!rowObj) return false;
  if (!['title', 'meta', 'category', 'merged', 'note'].includes(rowObj.type)) return false;
  return rowObj.cells.slice(1).every(v => !String(v || '').trim());
}

function _getTodayRowCellClass(rowObj, ci, val) {
  const isHaibukiya = _todayOrderCurrentFormat === 'haibukiya';
  let cls = 'xls-cell';
  if (rowObj.type === 'title') cls += ' today-xls-title';
  else if (rowObj.type === 'meta') cls += ' today-xls-meta';
  else if (rowObj.type === 'category') cls += ' today-xls-category';
  else if (rowObj.type === 'header') {
    cls += ' today-xls-header';
    if (isHaibukiya) {
      if (ci === 0 || ci === 1 || ci === 2 || ci === 12) cls += ' today-xls-header-left';
      else if (ci === 3 || ci === 4) cls += ' today-xls-header-right';
      else cls += ' today-xls-header-center';
    } else {
      if (ci === 0) cls += ' today-xls-header-left';
      else if (ci === 1) cls += ' today-xls-header-right';
      else cls += ' today-xls-header-center';
    }
  } else if (rowObj.type === 'merged') cls += ' today-xls-merged';
  else if (rowObj.type === 'note') cls += ' today-xls-note';
  else if (isHaibukiya) {
    if (rowObj.type === 'item' && ci === 0) cls += ' today-xls-item-name';
    else if (ci === 5) cls += ' today-xls-jan';
    else if (ci === 3 || ci === 4 || (ci >= 6 && ci <= 11)) cls += ' today-xls-num';
    if (ci === 8 && (rowObj.type === 'item' || rowObj.type === 'data')) cls += ' today-xls-wed-off';
  } else {
    if (rowObj.type === 'item' && ci === 0) cls += ' today-xls-item-name';
    else if (ci === 1 && (rowObj.type === 'item' || String(rowObj.cells?.[0] || '').trim())) {
      cls += ' today-xls-item-unit';
      if (!_validateTodayUnit(val).valid) cls += ' today-cell-invalid';
    } else if (rowObj.type === 'item' && ci === 1) cls += ' today-xls-item-unit';
    else if (val && /^[\d,，.\-￥¥\s]+$/.test(val) && /\d/.test(val)) cls += ' today-xls-num';
  }
  return cls;
}

function _extractTodayBaseIsoDate() {
  const metaRows = _todayOrderRows.filter(r => r.type === 'meta');
  for (const r of metaRows) {
    const m = String(r.cells?.[0] || '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (m) {
      return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    }
  }
  const hdr = _todayOrderRows.find(r => r.type === 'header');
  const startCol = _todayDayStartCol();
  if (hdr) {
    const m = String(hdr.cells?.[startCol] || '').match(/(\d{1,2})\/(\d{1,2})/);
    if (m) {
      return `2026-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    }
  }
  return _todayFmtCfg().defaultDate;
}

function _formatTodayPeriodString(isoDateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDateStr || '')) return '';
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const startDt = new Date(y, m - 1, d);
  const endDt = new Date(y, m - 1, d + 5);
  const wdays = ['日', '月', '火', '水', '木', '金', '土'];
  const span = `${startDt.getFullYear()}年${startDt.getMonth() + 1}月${startDt.getDate()}日（${wdays[startDt.getDay()]}）〜${endDt.getMonth() + 1}月${endDt.getDate()}日（${wdays[endDt.getDay()]}）`;
  if (_todayOrderCurrentFormat === 'haibukiya') {
    return `見積期間：${span}販売分`;
  }
  return `対象期間：${span}`;
}

function _applyBaseDateToTodaySheet(isoDateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDateStr || '')) return false;
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const wdays = ['日', '月', '火', '水', '木', '金', '土'];
  const startCol = _todayDayStartCol();

  const metaRows = _todayOrderRows.filter(r => r.type === 'meta');
  if (metaRows[1]) {
    if (_todayOrderCurrentFormat === 'haibukiya') {
      const oldMeta = String(metaRows[1].cells[0] || '');
      const parts = oldMeta.split('／');
      const newPrefix = _formatTodayPeriodString(isoDateStr);
      metaRows[1].cells[0] = parts.length > 1 ? `${newPrefix}　／${parts.slice(1).join('／')}` : newPrefix;
    } else {
      metaRows[1].cells[0] = _formatTodayPeriodString(isoDateStr);
    }
  }
  const hdr = _todayOrderRows.find(r => r.type === 'header');
  if (hdr) {
    for (let offset = 0; offset < 6; offset++) {
      const dt = new Date(y, m - 1, d + offset);
      hdr.cells[startCol + offset] = `${dt.getMonth() + 1}/${dt.getDate()}\n${wdays[dt.getDay()]}`;
    }
  }
  if (_todayOrderCurrentFormat === 'haibukiya') {
    const wedDt = new Date(y, m - 1, d + 2);
    const wedLabel = `${wedDt.getMonth() + 1}/${wedDt.getDate()}（${wdays[wedDt.getDay()]}）`;
    const note2 = _todayOrderRows.find(r => r.type === 'note' && String(r.cells[0] || '').includes('納品なし'));
    if (note2) {
      note2.cells[0] = note2.cells[0].replace(/\d{1,2}\/\d{1,2}（[^）]+）/, wedLabel);
    }
  } else {
    const mergedRow = _todayOrderRows.find(r => r.type === 'merged');
    if (mergedRow) {
      mergedRow.cells[0] = `今週（${_getTodayHeaderDateSpan()}）の発注はありません（全品目 休止）`;
    }
  }
  const inlineDateEl = document.getElementById('todayOrderInlineDate');
  if (inlineDateEl) inlineDateEl.value = isoDateStr;
  return true;
}

function _getHaibukiyaCategoriesInSheet() {
  const cats = new Set(TODAY_HAIBUKIYA_CATEGORIES);
  _todayOrderRows.forEach(r => {
    if (r.type === 'category' && String(r.cells[0] || '').trim()) {
      cats.add(String(r.cells[0]).trim());
    }
  });
  return Array.from(cats);
}

function _getRowPrecedingCategory(ri) {
  for (let i = ri - 1; i >= 0; i--) {
    if (_todayOrderRows[i]?.type === 'category') {
      return String(_todayOrderRows[i].cells[0] || '').trim();
    }
    if (_todayOrderRows[i]?.type === 'header') break;
  }
  return '';
}

function _renderTodayModalTableHead(isoDateStr) {
  const thead = document.getElementById('todayModalItemsHead');
  if (!thead) return;
  const wdays = ['日', '月', '火', '水', '木', '金', '土'];
  const dayLabels = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDateStr || '')) {
    const [y, m, d] = isoDateStr.split('-').map(Number);
    for (let offset = 0; offset < 6; offset++) {
      const dt = new Date(y, m - 1, d + offset);
      dayLabels.push(`${dt.getMonth() + 1}/${dt.getDate()} (${wdays[dt.getDay()]})`);
    }
  } else {
    const hdr = _todayOrderRows.find(r => r.type === 'header');
    const startCol = _todayDayStartCol();
    for (let offset = 0; offset < 6; offset++) {
      const rawHdr = String(hdr?.cells?.[startCol + offset] || '').trim();
      dayLabels.push(rawHdr ? rawHdr.replace(/\n+/g, ' (') + (rawHdr.includes('\n') ? ')' : '') : `日 ${offset + 1}`);
    }
  }

  if (_todayOrderCurrentFormat === 'haibukiya') {
    const catOpts = _getHaibukiyaCategoriesInSheet().map(c => `<option value="${esc(c)}"></option>`).join('');
    thead.innerHTML =
      `<tr>
        <th style="width:28px">#</th>
        <th style="min-width:110px">カテゴリ<datalist id="todayHaibukiyaCatList">${catOpts}</datalist></th>
        <th style="min-width:120px">品目名 <span class="required">*</span></th>
        <th style="min-width:100px">産地</th>
        <th style="min-width:85px">規格・入数</th>
        <th style="width:68px">単価/p</th>
        <th style="width:72px">単価/cs</th>
        <th style="min-width:112px">JANコード</th>
        ${dayLabels.map((lbl, idx) => `<th id="todayModalDayHdr${idx}" style="width:62px">${esc(lbl)}</th>`).join('')}
        <th style="min-width:130px">備考・産地状況</th>
        <th style="width:36px"></th>
      </tr>`;
  } else {
    thead.innerHTML =
      `<tr>
        <th style="width:32px">#</th>
        <th style="min-width:170px">品目名 <span class="required">*</span></th>
        <th style="width:96px">単位 <span class="required">*</span></th>
        ${dayLabels.map((lbl, idx) => `<th id="todayModalDayHdr${idx}">${esc(lbl)}</th>`).join('')}
        <th style="width:42px"></th>
      </tr>`;
  }
}

function _updateTodayModalDateHeaders(isoDateStr) {
  const previewEl = document.getElementById('todayItemModalPeriodPreview');
  const wdays = ['日', '月', '火', '水', '木', '金', '土'];
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDateStr || '')) {
    const [y, m, d] = isoDateStr.split('-').map(Number);
    if (previewEl) previewEl.textContent = _formatTodayPeriodString(isoDateStr);
    for (let offset = 0; offset < 6; offset++) {
      const dt = new Date(y, m - 1, d + offset);
      const th = document.getElementById(`todayModalDayHdr${offset}`);
      if (th) th.textContent = `${dt.getMonth() + 1}/${dt.getDate()} (${wdays[dt.getDay()]})`;
    }
  } else {
    const hdr = _todayOrderRows.find(r => r.type === 'header');
    const metaRows = _todayOrderRows.filter(r => r.type === 'meta');
    const startCol = _todayDayStartCol();
    if (previewEl) previewEl.textContent = metaRows[1]?.cells?.[0] || '';
    for (let offset = 0; offset < 6; offset++) {
      const th = document.getElementById(`todayModalDayHdr${offset}`);
      const rawHdr = String(hdr?.cells?.[startCol + offset] || '').trim();
      if (th) th.textContent = rawHdr ? rawHdr.replace(/\n+/g, ' (') + (rawHdr.includes('\n') ? ')' : '') : `日 ${offset + 1}`;
    }
  }
}

function _renumberTodayModalRows() {
  const tbody = document.getElementById('todayModalItemsBody');
  if (!tbody) return;
  Array.from(tbody.children).forEach((tr, idx) => {
    const numTd = tr.querySelector('.today-m-row-num');
    if (numTd) numTd.textContent = String(idx + 1);
  });
}

function _appendTodayModalItemRow(itemData = null) {
  const tbody = document.getElementById('todayModalItemsBody');
  if (!tbody) return null;
  const isHaibukiya = _todayOrderCurrentFormat === 'haibukiya';
  const data = itemData || { category: '', name: '', unit: '', origin: '', spec: '', priceP: '', priceCs: '', jan: '', days: ['', '', '', '', '', ''], note: '' };
  const tr = document.createElement('tr');

  const numTd = document.createElement('td');
  numTd.className = 'today-m-row-num';
  numTd.textContent = String(tbody.children.length + 1);
  tr.appendChild(numTd);

  const makeInput = (cls, placeholder, val, listId = null) => {
    const td = document.createElement('td');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'today-m-input ' + cls;
    inp.placeholder = placeholder;
    inp.autocomplete = 'off';
    inp.value = val || '';
    if (listId) inp.setAttribute('list', listId);
    inp.addEventListener('input', () => {
      inp.classList.remove('today-input-error');
      _setTodayModalValMsg('');
    });
    td.appendChild(inp);
    return { td, inp };
  };

  if (isHaibukiya) {
    const { td: catTd } = makeInput('today-m-cat', '葉物類', data.category || '', 'todayHaibukiyaCatList');
    const { td: nameTd } = makeInput('today-m-name', '品目名', data.name || '');
    const { td: origTd } = makeInput('today-m-origin', '産地', data.origin || '');
    const { td: specTd } = makeInput('today-m-spec', '150g/5p', data.spec || '');
    const { td: ppTd } = makeInput('today-m-pricep today-m-day', '165', data.priceP || '');
    const { td: pcsTd } = makeInput('today-m-pricecs today-m-day', '825', data.priceCs || '');
    const { td: janTd } = makeInput('today-m-jan', '4514811...', data.jan || '');
    tr.appendChild(catTd);
    tr.appendChild(nameTd);
    tr.appendChild(origTd);
    tr.appendChild(specTd);
    tr.appendChild(ppTd);
    tr.appendChild(pcsTd);
    tr.appendChild(janTd);
    for (let d = 0; d < 6; d++) {
      const { td: dayTd } = makeInput('today-m-day', '0', (data.days && data.days[d] != null) ? String(data.days[d]) : '');
      tr.appendChild(dayTd);
    }
    const { td: noteTd } = makeInput('today-m-note', '備考', data.note || '');
    tr.appendChild(noteTd);
  } else {
    const { td: nameTd, inp: nameInp } = makeInput('today-m-name', '品目名（例: 大根）', data.name || '');
    tr.appendChild(nameTd);

    const unitTd = document.createElement('td');
    const unitInp = document.createElement('input');
    unitInp.type = 'text';
    unitInp.className = 'today-m-input today-m-unit';
    unitInp.setAttribute('list', 'todayItemUnitList');
    unitInp.placeholder = '例: cs / 束';
    unitInp.autocomplete = 'off';
    unitInp.value = data.unit || '';

    const validateUnitInput = (allowEmptyWhenBlankRow = true) => {
      const raw = unitInp.value.trim();
      const rowHasOther = Boolean(
        nameInp.value.trim() ||
        Array.from(tr.querySelectorAll('.today-m-day')).some(inp => inp.value.trim())
      );
      if (!raw && allowEmptyWhenBlankRow && !rowHasOther) {
        unitInp.classList.remove('today-input-error', 'today-input-valid');
        return true;
      }
      const res = _validateTodayUnit(raw);
      if (res.valid) {
        unitInp.value = res.normalized;
        unitInp.classList.remove('today-input-error');
        unitInp.classList.add('today-input-valid');
        return true;
      }
      unitInp.classList.remove('today-input-valid');
      unitInp.classList.add('today-input-error');
      return res.error;
    };

    unitInp.addEventListener('keydown', (e) => {
      if (/^[0-9０-９]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        unitInp.classList.remove('today-input-valid');
        unitInp.classList.add('today-input-error');
        _setTodayModalValMsg('単位には数値を入力できません');
      }
    });
    unitInp.addEventListener('input', () => {
      if (/[0-9０-９]/.test(unitInp.value)) {
        unitInp.value = unitInp.value.replace(/[0-9０-９]/g, '');
        unitInp.classList.remove('today-input-valid');
        unitInp.classList.add('today-input-error');
        _setTodayModalValMsg('単位には数値を入力できません');
        return;
      }
      const raw = unitInp.value.trim();
      if (!raw) {
        unitInp.classList.remove('today-input-error', 'today-input-valid');
        _setTodayModalValMsg('');
        return;
      }
      const res = _validateTodayUnit(raw);
      if (res.valid) {
        unitInp.classList.remove('today-input-error');
        unitInp.classList.add('today-input-valid');
        _setTodayModalValMsg('');
      } else {
        unitInp.classList.remove('today-input-valid');
      }
    });
    unitInp.addEventListener('change', () => {
      const check = validateUnitInput(true);
      if (check !== true) _setTodayModalValMsg(check);
      else _setTodayModalValMsg('');
    });
    unitInp.addEventListener('blur', () => {
      const check = validateUnitInput(true);
      if (check !== true) _setTodayModalValMsg(check);
    });
    if (data.unit && _validateTodayUnit(data.unit).valid) {
      unitInp.classList.add('today-input-valid');
    }

    unitTd.appendChild(unitInp);
    tr.appendChild(unitTd);

    for (let d = 0; d < 6; d++) {
      const { td: dayTd } = makeInput('today-m-day', '0', (data.days && data.days[d] != null) ? String(data.days[d]) : '');
      tr.appendChild(dayTd);
    }
  }

  const delTd = document.createElement('td');
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'today-m-del';
  delBtn.title = 'この入力行を削除';
  delBtn.textContent = '✕';
  delBtn.addEventListener('click', () => {
    tr.remove();
    if (!tbody.children.length) {
      _appendTodayModalItemRow();
    } else {
      _renumberTodayModalRows();
    }
  });
  delTd.appendChild(delBtn);
  tr.appendChild(delTd);

  tbody.appendChild(tr);
  return tr;
}

function _fillTodayModalPreset(presetName) {
  const tbody = document.getElementById('todayModalItemsBody');
  if (!tbody || !presetName) return;
  const presetObj = _todayOrderCurrentFormat === 'haibukiya'
    ? (TODAY_HAIBUKIYA_PRESETS.find(p => p.name === presetName) || { name: presetName, days: ['', '', '', '', '', ''] })
    : { name: presetName, unit: '', days: ['', '', '', '', '', ''] };

  const emptyRow = Array.from(tbody.children).find(tr => {
    const inp = tr.querySelector('.today-m-name');
    return inp && !inp.value.trim();
  });
  if (emptyRow) {
    if (_todayOrderCurrentFormat === 'haibukiya') {
      if (emptyRow.querySelector('.today-m-cat')) emptyRow.querySelector('.today-m-cat').value = presetObj.category || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-origin')) emptyRow.querySelector('.today-m-origin').value = presetObj.origin || '';
      if (emptyRow.querySelector('.today-m-spec')) emptyRow.querySelector('.today-m-spec').value = presetObj.spec || '';
      if (emptyRow.querySelector('.today-m-pricep')) emptyRow.querySelector('.today-m-pricep').value = presetObj.priceP || '';
      if (emptyRow.querySelector('.today-m-pricecs')) emptyRow.querySelector('.today-m-pricecs').value = presetObj.priceCs || '';
      if (emptyRow.querySelector('.today-m-jan')) emptyRow.querySelector('.today-m-jan').value = presetObj.jan || '';
      const dayInps = Array.from(emptyRow.querySelectorAll('.today-m-day')).slice(2);
      dayInps.forEach((inp, idx) => { inp.value = (presetObj.days && presetObj.days[idx]) || ''; });
      if (emptyRow.querySelector('.today-m-note')) emptyRow.querySelector('.today-m-note').value = presetObj.note || '';
      dayInps[0]?.focus();
    } else {
      emptyRow.querySelector('.today-m-name').value = presetName;
      emptyRow.querySelector('.today-m-unit')?.focus();
    }
    return;
  }
  const newTr = _appendTodayModalItemRow(presetObj);
  (newTr?.querySelector('.today-m-unit') || newTr?.querySelector('.today-m-day'))?.focus();
}

function openTodayOrderItemModal(rowIdx = null, presetName = '', options = {}) {
  const backdrop = document.getElementById('todayOrderItemModalBackdrop');
  if (!backdrop) return;
  _todayOrderEditRowIdx = rowIdx;
  const isHaibukiya = _todayOrderCurrentFormat === 'haibukiya';

  const modalBox = backdrop.querySelector('.modal-box');
  if (modalBox) modalBox.classList.toggle('today-modal-box-haibukiya', isHaibukiya);

  const hintEl = document.getElementById('todayModalHint');
  if (hintEl) {
    hintEl.textContent = isHaibukiya
      ? '※ 品目名を入力して保存すると、指定したカテゴリ配下に追加されます（数量は「6→1」表記も可）。'
      : '※ 品目名と単位（cs, p, kg, 束, 袋, 箱, 本, 個 など）は必須です。';
  }

  const baseIso = _extractTodayBaseIsoDate();
  const modalDateInp = document.getElementById('todayItemModalBaseDate');
  if (modalDateInp) modalDateInp.value = baseIso;
  _renderTodayModalTableHead(baseIso);
  _updateTodayModalDateHeaders(baseIso);

  const titleEl = document.getElementById('todayOrderItemModalTitle');
  const delBtn = document.getElementById('todayItemFormDelete');
  const tbody = document.getElementById('todayModalItemsBody');
  if (tbody) tbody.innerHTML = '';
  _setTodayModalValMsg('');

  let focusEl = null;

  if (rowIdx !== null && _todayOrderRows[rowIdx] && _todayOrderRows[rowIdx].type !== 'merged') {
    const row = _todayOrderRows[rowIdx];
    if (titleEl) titleEl.textContent = `発注品目を編集（${rowIdx + 1} 行目）`;
    const tr = isHaibukiya
      ? _appendTodayModalItemRow({
          category: _getRowPrecedingCategory(rowIdx),
          name: row.cells[0] || '',
          origin: row.cells[1] || '',
          spec: row.cells[2] || '',
          priceP: row.cells[3] || '',
          priceCs: row.cells[4] || '',
          jan: row.cells[5] || '',
          days: row.cells.slice(6, 12),
          note: row.cells[12] || '',
        })
      : _appendTodayModalItemRow({
          name: row.cells[0] || '',
          unit: row.cells[1] || '',
          days: row.cells.slice(2, 8),
        });
    if (delBtn) delBtn.classList.remove('hidden');
    focusEl = tr?.querySelector('.today-m-name');
  } else if (options.fillAllPresets) {
    if (titleEl) titleEl.textContent = '複数品目を一括追加（日付・数量入力）';
    if (isHaibukiya) {
      TODAY_HAIBUKIYA_PRESETS.forEach((p, idx) => {
        const tr = _appendTodayModalItemRow({ ...p, days: [...p.days] });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-name');
      });
    } else {
      TODAY_PRESET_ITEMS.forEach((pName, idx) => {
        const tr = _appendTodayModalItemRow({ name: pName, unit: '', days: ['', '', '', '', '', ''] });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-unit');
      });
    }
    if (delBtn) delBtn.classList.add('hidden');
  } else {
    if (titleEl) titleEl.textContent = '発注品目を追加（複数品目・日付設定）';
    const defCat = options.defaultCategory || '';
    if (presetName) {
      if (isHaibukiya) {
        const pObj = TODAY_HAIBUKIYA_PRESETS.find(p => p.name === presetName) || { category: defCat, name: presetName, days: ['', '', '', '', '', ''] };
        const tr1 = _appendTodayModalItemRow({ ...pObj, days: [...(pObj.days || ['', '', '', '', '', ''])] });
        _appendTodayModalItemRow({ category: pObj.category || defCat, name: '', days: ['', '', '', '', '', ''] });
        focusEl = tr1?.querySelector('.today-m-name');
      } else {
        const tr1 = _appendTodayModalItemRow({ name: presetName, unit: '', days: ['', '', '', '', '', ''] });
        _appendTodayModalItemRow();
        focusEl = tr1?.querySelector('.today-m-unit');
      }
    } else {
      const tr1 = _appendTodayModalItemRow({ category: defCat, name: '', unit: '', days: ['', '', '', '', '', ''] });
      _appendTodayModalItemRow({ category: defCat, name: '', unit: '', days: ['', '', '', '', '', ''] });
      _appendTodayModalItemRow({ category: defCat, name: '', unit: '', days: ['', '', '', '', '', ''] });
      focusEl = tr1?.querySelector('.today-m-name');
    }
    if (delBtn) delBtn.classList.add('hidden');
  }

  backdrop.classList.remove('hidden');
  focusEl?.focus();
}

function closeTodayOrderItemModal() {
  document.getElementById('todayOrderItemModalBackdrop')?.classList.add('hidden');
  _todayOrderEditRowIdx = null;
}

function openTodayOrderMetaModal(focusTarget = 'title') {
  const backdrop = document.getElementById('todayOrderMetaModalBackdrop');
  if (!backdrop) return;
  const titleRow = _todayOrderRows.find(r => r.type === 'title');
  const metaRows = _todayOrderRows.filter(r => r.type === 'meta');
  const noteRows = _todayOrderRows.filter(r => r.type === 'note');

  const titleInp = document.getElementById('todayMetaTitle');
  const destInp = document.getElementById('todayMetaDest');
  const periodInp = document.getElementById('todayMetaPeriod');
  const baseDateInp = document.getElementById('todayMetaBaseDate');
  const note1Inp = document.getElementById('todayMetaNote1');
  const note2Inp = document.getElementById('todayMetaNote2');

  if (titleInp) titleInp.value = titleRow?.cells?.[0] || '';
  if (destInp) destInp.value = metaRows[0]?.cells?.[0] || '';
  const periodText = metaRows[1]?.cells?.[0] || '';
  if (periodInp) periodInp.value = periodText;
  if (note1Inp) note1Inp.value = noteRows[0]?.cells?.[0] || '';
  if (note2Inp) note2Inp.value = noteRows[1]?.cells?.[0] || '';

  if (baseDateInp) {
    baseDateInp.value = _extractTodayBaseIsoDate();
  }

  backdrop.classList.remove('hidden');
  if (focusTarget === 'date') baseDateInp?.focus();
  else titleInp?.focus();
}

function closeTodayOrderMetaModal() {
  document.getElementById('todayOrderMetaModalBackdrop')?.classList.add('hidden');
}

async function deleteTodayOrderRow(ri, skipConfirm = false) {
  if (!_todayOrderRows.length || ri < 0 || ri >= _todayOrderRows.length) return;
  const rowObj = _todayOrderRows[ri];
  if (rowObj.type === 'title' || rowObj.type === 'header') {
    showToast('タイトル行・見出し行は削除できません', true);
    return;
  }
  const label = rowObj.cells[0] ? `「${rowObj.cells[0]}」` : `行 ${ri + 1}`;
  if (!skipConfirm && !confirm(`${label} を削除しますか？`)) return;

  if (_todayOrderRows.length <= 1) {
    _todayOrderRows[0].cells = Array(_todayColCount()).fill('');
    _todayOrderSelRow = 0;
  } else {
    _todayOrderRows.splice(ri, 1);
    _syncTodayOrderMergedNotice();
    _todayOrderSelRow = Math.min(ri, _todayOrderRows.length - 1);
  }
  _markTodayOrderDirty(true);
  _renderTodayOrderGrid();
  await saveTodayOrderSheet(true);
  showToast(`${label} を削除しました`);
}

function _renderTodayOrderGrid() {
  const gridWrap  = document.getElementById('todayOrderGridWrap');
  const cellRefEl = document.getElementById('todayOrderCellRef');
  const cellValEl = document.getElementById('todayOrderCellVal');
  const statusEl  = document.getElementById('todayOrderStatusBar');
  const searchQ   = (document.getElementById('todayOrderSearch')?.value || '').trim().toLowerCase();
  if (!gridWrap) return;

  const isHaibukiya = _todayOrderCurrentFormat === 'haibukiya';
  const ncols = _todayColCount();

  _updateTodayOrderHeaderBadges();
  const inlineDateEl = document.getElementById('todayOrderInlineDate');
  if (inlineDateEl) inlineDateEl.value = _extractTodayBaseIsoDate();

  const rows = _todayOrderRows;
  const colLetters = Array.from({ length: ncols }, (_, i) => _colLetter(i));
  const cellMatrix = [];
  const rowNumCells = [];
  let selectedTd = null;
  let selectedColIdx = -1;
  let selectedRowIdx = -1;

  const table = document.createElement('table');
  table.className = 'xls-table today-xls-table' + (isHaibukiya ? ' format-haibukiya' : '');

  const colgroup = document.createElement('colgroup');
  const rnCol = document.createElement('col');
  rnCol.className = 'today-col-rn';
  colgroup.appendChild(rnCol);
  for (let ci = 0; ci < ncols; ci++) {
    const colEl = document.createElement('col');
    if (isHaibukiya) {
      colEl.className = (ci >= 6 && ci <= 11) ? 'today-col-h-day' : `today-col-h-${ci}`;
    } else {
      colEl.className = ci === 0 ? 'today-col-a' : 'today-col-other';
    }
    colgroup.appendChild(colEl);
  }
  const actCol = document.createElement('col');
  actCol.className = 'today-col-act';
  colgroup.appendChild(actCol);
  table.appendChild(colgroup);

  const thead = document.createElement('thead');
  const colHeaderRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'xls-th-corner';
  colHeaderRow.appendChild(corner);

  const colHeaders = colLetters.map((letter, ci) => {
    const th = document.createElement('th');
    if (isHaibukiya) {
      const hCls = (ci >= 6 && ci <= 11) ? 'today-th-h-day' : `today-th-h-${ci}`;
      th.className = 'xls-th-col ' + hCls;
    } else {
      th.className = 'xls-th-col ' + (ci === 0 ? 'today-th-col-a' : 'today-th-col-other');
    }
    th.innerHTML = `<div class="xls-th-letter">${letter}</div>`;
    colHeaderRow.appendChild(th);
    return th;
  });
  const actTh = document.createElement('th');
  actTh.className = 'xls-th-col today-th-col-act';
  actTh.innerHTML = '<div class="xls-th-letter">操作</div>';
  colHeaderRow.appendChild(actTh);
  thead.appendChild(colHeaderRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  function selectCell(ri, ci, focusGrid = false) {
    if (!rows.length) return;
    ri = Math.max(0, Math.min(rows.length - 1, ri));
    ci = Math.max(0, Math.min(ncols - 1, ci));
    if (_isTodayRowSpanned(rows[ri])) ci = 0;

    if (selectedTd) {
      selectedTd.classList.remove('xls-sel');
      if (selectedColIdx >= 0) colHeaders[selectedColIdx]?.classList.remove('xls-col-sel');
      if (selectedRowIdx >= 0) rowNumCells[selectedRowIdx]?.classList.remove('xls-row-sel');
    }

    selectedRowIdx = ri;
    selectedColIdx = ci;
    selectedTd = cellMatrix[ri]?.[ci] || null;
    _todayOrderSelRow = ri;
    _todayOrderSelCol = ci;

    selectedTd?.classList.add('xls-sel');
    colHeaders[ci]?.classList.add('xls-col-sel');
    rowNumCells[ri]?.classList.add('xls-row-sel');

    if (cellRefEl) cellRefEl.textContent = colLetters[ci] + (ri + 1);
    const val = rows[ri]?.cells?.[ci] != null ? String(rows[ri].cells[ci]) : '';
    if (cellValEl) cellValEl.value = val;

    selectedTd?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focusGrid) gridWrap.focus({ preventScroll: true });
  }

  function updateCellValue(ri, ci, newVal, showErrToast = true) {
    const rowObj = rows[ri];
    if (!rowObj) return;
    while (rowObj.cells.length < ncols) rowObj.cells.push('');
    const prevVal = rowObj.cells[ci] != null ? String(rowObj.cells[ci]) : '';
    let finalVal = newVal;
    const isUnitCell = !isHaibukiya && ci === 1 && (rowObj.type === 'item' || String(rowObj.cells[0] || '').trim());
    if (isUnitCell) {
      const check = _validateTodayUnit(newVal);
      if (check.valid) {
        finalVal = check.normalized;
      } else {
        if (/[0-9０-９]/.test(String(newVal || ''))) {
          finalVal = check.normalized;
        }
        if (showErrToast) showToast(check.error, true);
      }
    }
    if (prevVal === finalVal && !isUnitCell) return;
    rowObj.cells[ci] = finalVal;
    if (rowObj.type === 'data' && finalVal.trim() && ci === 0) {
      rowObj.type = 'item';
    }
    const td = cellMatrix[ri]?.[ci];
    if (td && !td.classList.contains('xls-editing')) {
      td.className = _getTodayRowCellClass(rowObj, ci, finalVal) + (selectedRowIdx === ri && selectedColIdx === ci ? ' xls-sel' : '');
      td.textContent = finalVal;
      td.title = finalVal;
    }
    if (!isHaibukiya && ci === 0) {
      const unitTd = cellMatrix[ri]?.[1];
      if (unitTd) {
        const unitVal = rowObj.cells[1] != null ? String(rowObj.cells[1]) : '';
        unitTd.className = _getTodayRowCellClass(rowObj, 1, unitVal) + (selectedRowIdx === ri && selectedColIdx === 1 ? ' xls-sel' : '');
      }
    }
    if (cellValEl && selectedRowIdx === ri && selectedColIdx === ci && document.activeElement !== cellValEl) {
      cellValEl.value = finalVal;
    }
    _markTodayOrderDirty(true);
    _persistTodayOrderLocal();
    _updateTodayOrderHeaderBadges();
    const inlineDateEl = document.getElementById('todayOrderInlineDate');
    if (inlineDateEl) inlineDateEl.value = _extractTodayBaseIsoDate();
  }

  function startInlineEdit(ri, ci, initialChar = null) {
    if (_isTodayRowSpanned(rows[ri])) ci = 0;
    const isUnitCol = !isHaibukiya && ci === 1 && rows[ri]?.type !== 'header';
    if (isUnitCol && initialChar !== null && /^[0-9０-９]$/.test(initialChar)) {
      showToast('単位列には数値を入力できません', true);
      return;
    }
    selectCell(ri, ci, false);
    const td = cellMatrix[ri]?.[ci];
    if (!td || td.classList.contains('xls-editing')) return;
    const origVal = rows[ri]?.cells?.[ci] != null ? String(rows[ri].cells[ci]) : '';
    td.classList.add('xls-editing');
    td.textContent = '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'xls-cell-input';
    if (isUnitCol && (rows[ri]?.type === 'item' || rows[ri]?.type === 'data')) {
      input.setAttribute('list', 'todayItemUnitList');
    }
    input.value = initialChar !== null ? initialChar : origVal;
    td.appendChild(input);
    input.focus();
    if (initialChar === null) {
      input.select();
    } else {
      input.setSelectionRange(input.value.length, input.value.length);
    }
    if (cellValEl) cellValEl.value = input.value;

    let committed = false;
    input.addEventListener('input', () => {
      if (isUnitCol && /[0-9０-９]/.test(input.value)) {
        input.value = input.value.replace(/[0-9０-９]/g, '');
        showToast('単位列には数値を入力できません', true);
      }
      if (cellValEl) cellValEl.value = input.value;
    });

    function finishEdit(save, nextAction = null) {
      if (committed) return;
      committed = true;
      const finalVal = save ? input.value : origVal;
      td.classList.remove('xls-editing');
      td.textContent = finalVal;
      td.title = finalVal;
      if (save) updateCellValue(ri, ci, finalVal);
      if (cellValEl) cellValEl.value = rows[ri]?.cells?.[ci] != null ? String(rows[ri].cells[ci]) : '';
      if (nextAction === 'down') selectCell(Math.min(rows.length - 1, ri + 1), ci, true);
      else if (nextAction === 'right') selectCell(ri, Math.min(ncols - 1, ci + 1), true);
      else if (nextAction === 'left') selectCell(ri, Math.max(0, ci - 1), true);
      else gridWrap.focus({ preventScroll: true });
    }

    input.addEventListener('blur', () => finishEdit(true));
    input.addEventListener('keydown', (e) => {
      if (isUnitCol && /^[0-9０-９]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        showToast('単位列には数値を入力できません', true);
        return;
      }
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

  const dayStartCol = _todayDayStartCol();

  rows.forEach((rowObj, ri) => {
    const tr = document.createElement('tr');
    const rowText = rowObj.cells.join(' ').toLowerCase();
    const matchesSearch = searchQ && rowText.includes(searchQ);
    if (rowObj.type === 'item') tr.classList.add('today-row-item');
    if (matchesSearch && ['item', 'data', 'category', 'merged', 'note'].includes(rowObj.type)) {
      tr.classList.add('today-row-match');
    }
    if (searchQ && rowObj.type === 'item' && !matchesSearch) {
      tr.classList.add('hidden');
    }

    const rowNum = document.createElement('td');
    rowNum.className = 'xls-td-row';
    rowNum.textContent = ri + 1;
    rowNum.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCell(ri, 0, true);
    });
    tr.appendChild(rowNum);
    rowNumCells[ri] = rowNum;
    cellMatrix[ri] = [];

    if (_isTodayRowSpanned(rowObj)) {
      const td = document.createElement('td');
      const val = rowObj.cells[0] != null ? String(rowObj.cells[0]) : '';
      td.colSpan = ncols;
      td.className = _getTodayRowCellClass(rowObj, 0, val);
      td.title = val;
      td.textContent = val;
      td.addEventListener('click', () => selectCell(ri, 0, true));
      td.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startInlineEdit(ri, 0);
      });
      tr.appendChild(td);
      for (let c = 0; c < ncols; c++) cellMatrix[ri][c] = td;
    } else {
      for (let ci = 0; ci < ncols; ci++) {
        const td = document.createElement('td');
        const val = rowObj.cells[ci] != null ? String(rowObj.cells[ci]) : '';
        td.className = _getTodayRowCellClass(rowObj, ci, val);
        td.title = val;
        td.textContent = val;
        td.addEventListener('click', () => selectCell(ri, ci, true));
        td.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (rowObj.type === 'header' && ci >= dayStartCol && ci < dayStartCol + 6) {
            openTodayOrderMetaModal('date');
            return;
          }
          startInlineEdit(ri, ci);
        });
        tr.appendChild(td);
        cellMatrix[ri][ci] = td;
      }
    }

    // Per-row CRUD Actions cell
    const actTd = document.createElement('td');
    actTd.className = 'today-xls-actions' + (rowObj.type === 'header' ? ' today-xls-actions-hdr' : '');
    if (rowObj.type === 'header') {
      const grp = document.createElement('div');
      grp.className = 'today-row-act-group';
      const dateBtn = document.createElement('button');
      dateBtn.type = 'button';
      dateBtn.className = 'today-hdr-act-btn';
      dateBtn.title = '対象期間・曜日日付を変更';
      dateBtn.textContent = '📅 日付';
      dateBtn.addEventListener('click', (e) => { e.stopPropagation(); openTodayOrderMetaModal('date'); });
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'today-hdr-act-btn';
      addBtn.title = '複数品目を追加';
      addBtn.textContent = '+ 品目';
      addBtn.addEventListener('click', (e) => { e.stopPropagation(); openTodayOrderItemModal(null); });
      grp.appendChild(dateBtn);
      grp.appendChild(addBtn);
      actTd.appendChild(grp);
    } else if (rowObj.type === 'category') {
      const grp = document.createElement('div');
      grp.className = 'today-row-act-group';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'today-row-act-btn add';
      addBtn.title = 'このカテゴリに品目を追加';
      addBtn.textContent = '+ 品目';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTodayOrderItemModal(null, '', { defaultCategory: rowObj.cells[0] || '' });
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'today-row-act-btn del';
      delBtn.title = 'このカテゴリ行を削除';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteTodayOrderRow(ri); });
      grp.appendChild(addBtn);
      grp.appendChild(delBtn);
      actTd.appendChild(grp);
    } else if (rowObj.type === 'title' || rowObj.type === 'meta' || rowObj.type === 'note') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'today-row-act-btn';
      btn.title = 'ヘッダー・備考を編集';
      btn.textContent = '✎ 編集';
      btn.addEventListener('click', (e) => { e.stopPropagation(); openTodayOrderMetaModal(); });
      actTd.appendChild(btn);
    } else if (rowObj.type === 'merged') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'today-row-act-btn add';
      btn.title = '発注品目を追加';
      btn.textContent = '+ 品目追加';
      btn.addEventListener('click', (e) => { e.stopPropagation(); openTodayOrderItemModal(null); });
      actTd.appendChild(btn);
    } else if (rowObj.type === 'item' || rowObj.type === 'data') {
      const grp = document.createElement('div');
      grp.className = 'today-row-act-group';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'today-row-act-btn add';
      addBtn.title = '複数品目を追加';
      addBtn.textContent = '＋';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTodayOrderItemModal(null, '', { defaultCategory: _getRowPrecedingCategory(ri) });
      });
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'today-row-act-btn';
      editBtn.title = 'この行を編集';
      editBtn.textContent = '✎ 編集';
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); openTodayOrderItemModal(ri); });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'today-row-act-btn del';
      delBtn.title = 'この行を削除';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteTodayOrderRow(ri); });
      grp.appendChild(addBtn);
      grp.appendChild(editBtn);
      grp.appendChild(delBtn);
      actTd.appendChild(grp);
    }
    tr.appendChild(actTd);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  gridWrap.innerHTML = '';
  gridWrap.appendChild(table);

  if (cellValEl) {
    cellValEl.onfocus = () => {
      cellValEl.dataset.origRawVal = rows[_todayOrderSelRow]?.cells?.[_todayOrderSelCol] ?? '';
    };
    cellValEl.oninput = () => {
      if (selectedRowIdx >= 0 && selectedColIdx >= 0) {
        if (!isHaibukiya && selectedColIdx === 1 && rows[selectedRowIdx]?.type !== 'header' && /[0-9０-９]/.test(cellValEl.value)) {
          cellValEl.value = cellValEl.value.replace(/[0-9０-９]/g, '');
          showToast('単位列には数値を入力できません', true);
        }
        updateCellValue(selectedRowIdx, selectedColIdx, cellValEl.value, false);
      }
    };
    cellValEl.onchange = () => {
      if (selectedRowIdx >= 0 && selectedColIdx >= 0) {
        updateCellValue(selectedRowIdx, selectedColIdx, cellValEl.value, true);
      }
    };
    cellValEl.onkeydown = (e) => {
      if (!isHaibukiya && selectedColIdx === 1 && rows[selectedRowIdx]?.type !== 'header' && /^[0-9０-９]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        showToast('単位列には数値を入力できません', true);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedRowIdx >= 0 && selectedColIdx >= 0) {
          selectCell(Math.min(rows.length - 1, selectedRowIdx + 1), selectedColIdx, true);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const orig = cellValEl.dataset.origRawVal ?? '';
        if (selectedRowIdx >= 0 && selectedColIdx >= 0) {
          updateCellValue(selectedRowIdx, selectedColIdx, orig);
        }
        cellValEl.value = orig;
        gridWrap.focus({ preventScroll: true });
      }
    };
  }

  gridWrap.onkeydown = (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (selectedRowIdx < 0 || selectedColIdx < 0) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); selectCell(Math.max(0, selectedRowIdx - 1), selectedColIdx, false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); selectCell(Math.min(rows.length - 1, selectedRowIdx + 1), selectedColIdx, false); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); selectCell(selectedRowIdx, Math.max(0, selectedColIdx - 1), false); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); selectCell(selectedRowIdx, Math.min(ncols - 1, selectedColIdx + 1), false); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      selectCell(selectedRowIdx, Math.max(0, Math.min(ncols - 1, selectedColIdx + (e.shiftKey ? -1 : 1))), false);
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startInlineEdit(selectedRowIdx, selectedColIdx);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      updateCellValue(selectedRowIdx, selectedColIdx, '');
      if (cellValEl) cellValEl.value = '';
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!isHaibukiya && selectedColIdx === 1 && rows[selectedRowIdx]?.type !== 'header' && /^[0-9０-９]$/.test(e.key)) {
        showToast('単位列には数値を入力できません', true);
        return;
      }
      startInlineEdit(selectedRowIdx, selectedColIdx, e.key);
    }
  };

  selectCell(_todayOrderSelRow, _todayOrderSelCol, false);

  if (statusEl) {
    const itemCount = _countTodayOrderItems();
    const fmtLabel = isHaibukiya ? '灰吹屋 発注書' : '千葉自動発注書';
    statusEl.textContent = `${rows.length} rows × ${ncols} cols · ${itemCount} 品目 · ${fmtLabel}`;
  }
}

function _insertHaibukiyaItemUnderCategory(categoryName, cells) {
  const cat = String(categoryName || '').trim();
  if (cat) {
    const catIdx = _todayOrderRows.findIndex(r => r.type === 'category' && String(r.cells[0] || '').trim() === cat);
    if (catIdx >= 0) {
      let insertAt = catIdx + 1;
      while (insertAt < _todayOrderRows.length && _todayOrderRows[insertAt].type === 'item') {
        insertAt++;
      }
      _todayOrderRows.splice(insertAt, 0, { type: 'item', cells });
      return insertAt;
    }
  }
  const spacerIdx = _todayOrderRows.findIndex((r, idx) => idx > 4 && (r.type === 'spacer' || r.type === 'note'));
  const baseIdx = spacerIdx >= 0 ? spacerIdx : _todayOrderRows.length;
  if (cat) {
    _todayOrderRows.splice(baseIdx, 0, { type: 'category', cells: [cat, ...Array(_todayColCount() - 1).fill('')] });
    _todayOrderRows.splice(baseIdx + 1, 0, { type: 'item', cells });
    return baseIdx + 1;
  }
  _todayOrderRows.splice(baseIdx, 0, { type: 'item', cells });
  return baseIdx;
}

async function initTodayOrderView() {
  if (!_todayOrderInitialized) {
    await switchTodayOrderFormat(_todayOrderCurrentFormat);

    document.getElementById('todayOrderFormatSelect')?.addEventListener('change', (e) => {
      switchTodayOrderFormat(e.target.value);
    });

    document.querySelectorAll('#todayOrderSheetTabs .xls-sheet-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        if (tab.dataset.format && tab.dataset.format !== _todayOrderCurrentFormat) {
          switchTodayOrderFormat(tab.dataset.format);
        }
      });
    });

    document.getElementById('todayOrderAddItemBtn')?.addEventListener('click', () => {
      openTodayOrderItemModal(null);
    });

    document.getElementById('todayOrderAddCategoryBtn')?.addEventListener('click', async () => {
      const catName = (prompt('追加するカテゴリ名を入力してください（例: 葉物類、根菜類、果物類）') || '').trim();
      if (!catName) return;
      const spacerIdx = _todayOrderRows.findIndex((r, idx) => idx > 4 && (r.type === 'spacer' || r.type === 'note'));
      const insertAt = spacerIdx >= 0 ? spacerIdx : _todayOrderRows.length;
      _todayOrderRows.splice(insertAt, 0, { type: 'category', cells: [catName, ...Array(_todayColCount() - 1).fill('')] });
      _todayOrderSelRow = insertAt;
      _todayOrderSelCol = 0;
      _markTodayOrderDirty(true);
      _renderTodayOrderGrid();
      await saveTodayOrderSheet(true);
      showToast(`カテゴリ「${catName}」を追加しました`);
    });

    document.getElementById('todayOrderEditRowBtn')?.addEventListener('click', () => {
      const row = _todayOrderRows[_todayOrderSelRow];
      if (!row) return;
      if (['title', 'meta', 'header', 'note'].includes(row.type)) {
        openTodayOrderMetaModal();
      } else {
        openTodayOrderItemModal(_todayOrderSelRow);
      }
    });

    document.getElementById('todayOrderAddRowBtn')?.addEventListener('click', () => {
      _todayOrderRows.push({ type: 'data', cells: Array(_todayColCount()).fill('') });
      _todayOrderSelRow = _todayOrderRows.length - 1;
      _todayOrderSelCol = 0;
      _markTodayOrderDirty(true);
      _persistTodayOrderLocal();
      _renderTodayOrderGrid();
      showToast('行を追加しました');
    });

    document.getElementById('todayOrderDelRowBtn')?.addEventListener('click', () => {
      const ri = Math.max(0, Math.min(_todayOrderRows.length - 1, _todayOrderSelRow));
      deleteTodayOrderRow(ri);
    });

    document.getElementById('todayOrderMetaBtn')?.addEventListener('click', () => {
      openTodayOrderMetaModal();
    });

    document.getElementById('todayOrderSaveBtn')?.addEventListener('click', () => {
      saveTodayOrderSheet(false);
    });

    document.getElementById('todayOrderResetBtn')?.addEventListener('click', async () => {
      if (!confirm('表示中の発注書を初期状態にリセットしますか？')) return;
      const fmt = _todayOrderCurrentFormat;
      const cfg = _todayFmtCfg(fmt);
      try { localStorage.removeItem(cfg.storageKey); } catch {}
      try {
        await fetch(`${API_BASE}/api/today-order?format=${encodeURIComponent(fmt)}`, { method: 'DELETE' });
      } catch {}
      _todayOrderRows = _createTodayOrderInitialRows(fmt);
      _todayOrderSelRow = 0;
      _todayOrderSelCol = 0;
      _markTodayOrderDirty(false);
      _renderTodayOrderGrid();
      showToast('初期データにリセットしました');
    });

    document.getElementById('todayOrderSearch')?.addEventListener('input', () => {
      _renderTodayOrderGrid();
    });

    document.getElementById('todayOrderInlineDate')?.addEventListener('change', async (e) => {
      const val = (e.target.value || '').trim();
      if (!_applyBaseDateToTodaySheet(val)) return;
      _markTodayOrderDirty(true);
      _renderTodayOrderGrid();
      await saveTodayOrderSheet(true);
      showToast('対象期間と曜日日付を更新しました');
    });

    document.getElementById('todayItemModalBaseDate')?.addEventListener('change', (e) => {
      _updateTodayModalDateHeaders((e.target.value || '').trim());
    });

    document.getElementById('todayModalAddRowBtn')?.addEventListener('click', () => {
      const tr = _appendTodayModalItemRow();
      tr?.querySelector('.today-m-name')?.focus();
    });

    document.getElementById('todayItemFormCancel')?.addEventListener('click', closeTodayOrderItemModal);
    document.getElementById('todayOrderItemModalBackdrop')?.addEventListener('click', e => {
      if (e.target === document.getElementById('todayOrderItemModalBackdrop')) closeTodayOrderItemModal();
    });

    document.getElementById('todayItemFormDelete')?.addEventListener('click', async () => {
      const ri = _todayOrderEditRowIdx;
      if (ri == null) return;
      closeTodayOrderItemModal();
      await deleteTodayOrderRow(ri);
    });

    document.getElementById('todayItemFormSave')?.addEventListener('click', async () => {
      const tbody = document.getElementById('todayModalItemsBody');
      const modalBaseDate = (document.getElementById('todayItemModalBaseDate')?.value || '').trim();
      const isHaibukiya = _todayOrderCurrentFormat === 'haibukiya';
      const collected = [];
      let validationError = '';
      let errorFocusEl = null;

      _setTodayModalValMsg('');
      if (tbody) {
        const trs = Array.from(tbody.children);
        trs.forEach(tr => {
          tr.querySelectorAll('.today-m-input').forEach(inp => inp.classList.remove('today-input-error'));
        });

        for (let idx = 0; idx < trs.length; idx++) {
          const tr = trs[idx];
          const nameInp = tr.querySelector('.today-m-name');
          const name = (nameInp?.value || '').trim();

          if (isHaibukiya) {
            const cat = (tr.querySelector('.today-m-cat')?.value || '').trim();
            const origin = (tr.querySelector('.today-m-origin')?.value || '').trim();
            const spec = (tr.querySelector('.today-m-spec')?.value || '').trim();
            const priceP = (tr.querySelector('.today-m-pricep')?.value || '').trim();
            const priceCs = (tr.querySelector('.today-m-pricecs')?.value || '').trim();
            const jan = (tr.querySelector('.today-m-jan')?.value || '').trim();
            const note = (tr.querySelector('.today-m-note')?.value || '').trim();
            const allDayInputs = Array.from(tr.querySelectorAll('.today-m-day'));
            const dayInps = allDayInputs.slice(2, 8);
            const daysRaw = dayInps.map(inp => (inp.value || '').trim());
            const hasAny = Boolean(cat || name || origin || spec || priceP || priceCs || jan || note || daysRaw.some(Boolean));
            if (!hasAny) continue;

            if (!name) {
              nameInp?.classList.add('today-input-error');
              validationError = `${idx + 1} 行目: 品目名を入力してください`;
              errorFocusEl = nameInp;
              break;
            }

            const normalizedDays = [];
            for (let d = 0; d < 6; d++) {
              const rawD = (daysRaw[d] || '').normalize('NFKC').trim();
              if (rawD && !/^\d+(?:\.\d+)?(?:\s*(?:→|->)+\s*\d+(?:\.\d+)?)?$/.test(rawD)) {
                dayInps[d]?.classList.add('today-input-error');
                validationError = `${idx + 1} 行目（${name}）: 数量は数値または「6→1」形式で入力してください`;
                errorFocusEl = dayInps[d];
                break;
              }
              normalizedDays.push(rawD.replace(/\s*->+\s*/g, '→').replace(/\s*→\s*/g, '→'));
            }
            if (validationError) break;

            collected.push({
              category: cat,
              cells: [name, origin, spec, priceP, priceCs, jan, ...normalizedDays, note],
            });
          } else {
            const unitInp = tr.querySelector('.today-m-unit');
            const dayInps = Array.from(tr.querySelectorAll('.today-m-day'));
            const unitRaw = (unitInp?.value || '').trim();
            const daysRaw = dayInps.map(inp => (inp.value || '').trim());
            const hasAny = Boolean(name || unitRaw || daysRaw.some(Boolean));
            if (!hasAny) continue;

            if (!name) {
              nameInp?.classList.add('today-input-error');
              validationError = `${idx + 1} 行目: 品目名を入力してください`;
              errorFocusEl = nameInp;
              break;
            }

            const unitCheck = _validateTodayUnit(unitRaw);
            if (!unitCheck.valid) {
              unitInp?.classList.add('today-input-error');
              unitInp?.classList.remove('today-input-valid');
              validationError = `${idx + 1} 行目（${name}）: ${unitCheck.error}`;
              errorFocusEl = unitInp;
              break;
            }
            if (unitInp) {
              unitInp.value = unitCheck.normalized;
              unitInp.classList.add('today-input-valid');
            }

            const normalizedDays = [];
            for (let d = 0; d < 6; d++) {
              const rawD = (daysRaw[d] || '').normalize('NFKC').trim();
              if (rawD && !/^\d+(\.\d+)?$/.test(rawD)) {
                dayInps[d]?.classList.add('today-input-error');
                validationError = `${idx + 1} 行目（${name}）: 数量は0以上の数値で入力してください`;
                errorFocusEl = dayInps[d];
                break;
              }
              normalizedDays.push(rawD);
            }
            if (validationError) break;

            collected.push({ category: '', cells: [name, unitCheck.normalized, ...normalizedDays] });
          }
        }
      }

      if (validationError) {
        _setTodayModalValMsg(validationError);
        showToast(validationError, true);
        errorFocusEl?.focus();
        return;
      }

      if (!collected.length) {
        const msg = isHaibukiya ? '品目名を1件以上入力してください' : '品目名と単位を1件以上入力してください';
        _setTodayModalValMsg(msg);
        showToast(msg, true);
        tbody?.querySelector('.today-m-name')?.focus();
        return;
      }

      if (/^\d{4}-\d{2}-\d{2}$/.test(modalBaseDate)) {
        _applyBaseDateToTodaySheet(modalBaseDate);
      }

      if (_todayOrderEditRowIdx !== null && _todayOrderRows[_todayOrderEditRowIdx] && _todayOrderRows[_todayOrderEditRowIdx].type !== 'merged') {
        _todayOrderRows[_todayOrderEditRowIdx].type = 'item';
        _todayOrderRows[_todayOrderEditRowIdx].cells = collected[0].cells;
        if (collected.length > 1) {
          const extraItems = collected.slice(1).map(item => ({ type: 'item', cells: item.cells }));
          _todayOrderRows.splice(_todayOrderEditRowIdx + 1, 0, ...extraItems);
        }
        _todayOrderSelRow = _todayOrderEditRowIdx;
        _todayOrderSelCol = 0;
        showToast(collected.length === 1 ? `品目「${collected[0].cells[0]}」を更新しました` : `${collected.length} 件の品目を更新・追加しました`);
      } else if (isHaibukiya) {
        let lastInserted = 0;
        collected.forEach(item => {
          lastInserted = _insertHaibukiyaItemUnderCategory(item.category, item.cells);
        });
        _todayOrderSelRow = lastInserted;
        _todayOrderSelCol = 0;
        showToast(collected.length === 1 ? `品目「${collected[0].cells[0]}」を追加しました` : `${collected.length} 件の品目を追加しました`);
      } else {
        _todayOrderRows = _todayOrderRows.filter(r => r.type !== 'merged');
        let insertIdx = -1;
        _todayOrderRows.forEach((r, idx) => {
          if (r.type === 'item') insertIdx = idx;
        });
        if (insertIdx < 0) {
          insertIdx = _todayOrderRows.findIndex(r => r.type === 'header');
        }
        const targetIdx = insertIdx >= 0 ? insertIdx + 1 : Math.min(5, _todayOrderRows.length);
        const newRows = collected.map(item => ({ type: 'item', cells: item.cells }));
        _todayOrderRows.splice(targetIdx, 0, ...newRows);
        _todayOrderSelRow = targetIdx;
        _todayOrderSelCol = 0;
        showToast(collected.length === 1 ? `品目「${collected[0].cells[0]}」を追加しました` : `${collected.length} 件の品目を追加しました`);
      }

      closeTodayOrderItemModal();
      _markTodayOrderDirty(true);
      _renderTodayOrderGrid();
      await saveTodayOrderSheet(true);
    });

    const metaBaseDate = document.getElementById('todayMetaBaseDate');
    metaBaseDate?.addEventListener('change', () => {
      const val = (metaBaseDate.value || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return;
      const periodInp = document.getElementById('todayMetaPeriod');
      if (periodInp) {
        if (_todayOrderCurrentFormat === 'haibukiya') {
          const parts = periodInp.value.split('／');
          const prefix = _formatTodayPeriodString(val);
          periodInp.value = parts.length > 1 ? `${prefix}　／${parts.slice(1).join('／')}` : prefix;
        } else {
          periodInp.value = _formatTodayPeriodString(val);
        }
      }
    });

    document.getElementById('todayMetaCancel')?.addEventListener('click', closeTodayOrderMetaModal);
    document.getElementById('todayOrderMetaModalBackdrop')?.addEventListener('click', e => {
      if (e.target === document.getElementById('todayOrderMetaModalBackdrop')) closeTodayOrderMetaModal();
    });

    document.getElementById('todayMetaSave')?.addEventListener('click', async () => {
      const titleVal  = (document.getElementById('todayMetaTitle')?.value || '').trim();
      const destVal   = (document.getElementById('todayMetaDest')?.value || '').trim();
      const periodVal = (document.getElementById('todayMetaPeriod')?.value || '').trim();
      const baseVal   = (document.getElementById('todayMetaBaseDate')?.value || '').trim();
      const note1Val  = (document.getElementById('todayMetaNote1')?.value || '').trim();
      const note2Val  = (document.getElementById('todayMetaNote2')?.value || '').trim();

      const titleRow = _todayOrderRows.find(r => r.type === 'title');
      if (titleRow) titleRow.cells[0] = titleVal;
      const metaRows = _todayOrderRows.filter(r => r.type === 'meta');
      if (metaRows[0]) metaRows[0].cells[0] = destVal;
      if (metaRows[1]) metaRows[1].cells[0] = periodVal;
      const noteRows = _todayOrderRows.filter(r => r.type === 'note');
      if (noteRows[0]) noteRows[0].cells[0] = note1Val;
      if (noteRows[1]) noteRows[1].cells[0] = note2Val;

      if (/^\d{4}-\d{2}-\d{2}$/.test(baseVal)) {
        const hdr = _todayOrderRows.find(r => r.type === 'header');
        const startCol = _todayDayStartCol();
        if (hdr) {
          const [y, m, d] = baseVal.split('-').map(Number);
          const wdays = ['日', '月', '火', '水', '木', '金', '土'];
          for (let offset = 0; offset < 6; offset++) {
            const dt = new Date(y, m - 1, d + offset);
            hdr.cells[startCol + offset] = `${dt.getMonth() + 1}/${dt.getDate()}\n${wdays[dt.getDay()]}`;
          }
        }
        const mergedRow = _todayOrderRows.find(r => r.type === 'merged');
        if (mergedRow) {
          const span = _getTodayHeaderDateSpan();
          mergedRow.cells[0] = `今週（${span}）の発注はありません（全品目 休止）`;
        }
      }

      closeTodayOrderMetaModal();
      _markTodayOrderDirty(true);
      _renderTodayOrderGrid();
      await saveTodayOrderSheet(true);
      showToast('ヘッダー・期間・備考を更新しました');
    });

    document.getElementById('todayOrderCsvBtn')?.addEventListener('click', () => {
      const cfg = _todayFmtCfg();
      let lastNonEmpty = -1;
      _todayOrderRows.forEach((r, idx) => {
        if (r.cells.some(v => String(v || '').trim())) lastNonEmpty = idx;
      });
      const exportCount = Math.max(1, lastNonEmpty + 1);
      const exportRows = _todayOrderRows.slice(0, exportCount).map(r => r.cells);
      const csv = exportRows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: cfg.csvName });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('CSVをダウンロードしました');
    });

    document.getElementById('todayOrderXlsxBtn')?.addEventListener('click', async () => {
      const cfg = _todayFmtCfg();
      if (_todayOrderDirty) {
        await saveTodayOrderSheet(true);
      }
      const a = Object.assign(document.createElement('a'), {
        href: `${API_BASE}/static/${cfg.xlsxFile}?t=${Date.now()}`,
        download: cfg.downloadName,
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Excelファイルをダウンロードしました');
    });

    _todayOrderInitialized = true;
  }
  _renderTodayOrderGrid();
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

  // Render as a document-view style table header row
  previewBar.innerHTML =
    `<table class="heading-doc-table"><thead><tr>` +
    cols.map((col, idx) => {
      const formattedCol = previewSheet ? _formatHeadingWithDate(col, previewSheet) : col;
      return `<th class="heading-doc-th" title="列 ${idx + 1}">
        <div class="heading-doc-th-num">${idx + 1}</div>
        <div class="heading-doc-th-label">${formatHeaderHtml(formattedCol)}</div>
      </th>`;
    }).join('') +
    `</tr></thead></table>`;
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

// ── 風水プロジェクト 発注書 Renderer ──
function _isFusuiClient(selClient, result) {
  const c = selClient || result?.client || null;
  if (!c) return false;
  const code = (c.code || '').toLowerCase();
  const name = c.name_ja || '';
  return code === 'fusui_project' || code.includes('fusui') || name.includes('風水プロジェクト');
}

function _buildFusuiTable(sheet) {
  const rows = sheet.rows || [];
  if (!rows.length) return '';
  const hIdx = (sheet.hasHeader && sheet.headerIdx >= 0) ? sheet.headerIdx : -1;
  const startRow = hIdx >= 0 ? hIdx + 1 : 0;
  const maxCols = Math.max(1, ...rows.map(r => r.length));

  let html = '<div class="fusui-hanchu-table-wrap"><table class="fusui-hanchu-table">';

  if (hIdx >= 0) {
    html += '<thead><tr>';
    for (let ci = 0; ci < maxCols; ci++) {
      const h = (_resolveSheetColHeading(sheet, ci) || _cleanExcelCell((rows[hIdx] || [])[ci])).trim();
      const isNum = ci > 0 && ci >= maxCols - 3;
      html += `<th class="fusui-hanchu-th${isNum ? ' fusui-hanchu-th-num' : ''}">${esc(h)}</th>`;
    }
    html += '</tr></thead>';
  }

  html += '<tbody>';
  let visibleRow = 0;
  for (let ri = startRow; ri < rows.length; ri++) {
    const vals = Array.from({length: maxCols}, (_, ci) => _cleanExcelCell((rows[ri] || [])[ci]));
    if (!vals.some(Boolean)) continue;
    visibleRow++;
    const hasTotal = vals.some(v => /合計|小計|TOTAL/i.test(v));
    const rowClass = hasTotal ? 'fusui-hanchu-row-total' : visibleRow % 2 === 0 ? 'fusui-hanchu-row-alt' : '';
    html += `<tr class="${rowClass}">`;
    for (let ci = 0; ci < maxCols; ci++) {
      const v = vals[ci] || '';
      const isNum = v && /^[\d,，.\-￥¥\s]+$/.test(v) && /\d/.test(v);
      html += `<td class="fusui-hanchu-td${isNum ? ' fusui-hanchu-td-num' : ''}">${esc(v)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function _renderFusuiHanchuView(result, wrap, selClient) {
  const dataSheet = _xlsSheets.find(s => s.name !== 'Full Text') || _xlsSheets[0];
  const fullText = (result.fused_text || result.text || '');
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);

  const hIdx = dataSheet && dataSheet.hasHeader && dataSheet.headerIdx >= 0 ? dataSheet.headerIdx : -1;
  const preambleRows = hIdx > 0 && dataSheet ? dataSheet.rows.slice(0, hIdx) : [];
  const preambleLines = preambleRows.map(r => r.filter(Boolean).join('　').trim()).filter(Boolean);
  const allMetaLines = [...preambleLines, ...lines];

  // Extract metadata helpers
  const findLine = (...kwds) => allMetaLines.find(l => kwds.some(k => l.includes(k))) || '';
  const extractVal = (line, ...labels) => {
    if (!line) return '';
    for (const label of labels) {
      const idx = line.indexOf(label);
      if (idx >= 0) return line.slice(idx + label.length).replace(/^[:：\s]+/, '').trim();
    }
    return line.trim();
  };

  const ateleLine     = findLine('宛先');
  const hatuchuLine   = findLine('発注日');
  const nohinDateLine = findLine('納品指定日', '納品日');
  const nohinPlaceLine= findLine('納品場所');
  const postalLine    = findLine('〒');
  const telLine       = findLine('TEL', 'Tel', '電話');
  const faxLine       = findLine('FAX', 'Fax');

  const orderDate  = extractVal(hatuchuLine, '発注日');
  const nohinDate  = extractVal(nohinDateLine, '納品指定日', '納品日');
  const nohinPlace = extractVal(nohinPlaceLine, '納品場所');
  const vendor     = extractVal(ateleLine, '宛先') || (preambleLines[1] || '');

  const noteLines = lines.filter(l => l.startsWith('※') || l.startsWith('＊'));
  const clientObj = selClient || result?.client || {};
  const companyName = clientObj.name_ja || '風水プロジェクト';

  let html = '<div class="doc-view doc-fusui-hanchu">';

  // ── Title Header ──
  html += `<div class="fusui-hanchu-header">
    <div class="fusui-hanchu-title">発注書</div>
    <div class="fusui-hanchu-company">株式会社${esc(companyName)}（ゆうき市場）</div>
  </div>`;

  // ── Info Section ──
  html += '<div class="fusui-hanchu-info">';
  html += '<div class="fusui-hanchu-info-left">';
  html += '<div class="fusui-hanchu-info-label">宛先</div>';
  if (vendor) html += `<div class="fusui-hanchu-recipient">${esc(vendor)}　御中</div>`;
  html += '</div>';
  html += '<div class="fusui-hanchu-info-right">';
  html += '<div class="fusui-hanchu-info-label">発注元</div>';
  if (postalLine) html += `<div class="fusui-hanchu-addr-line">${esc(postalLine)}</div>`;
  if (telLine)    html += `<div class="fusui-hanchu-addr-line">${esc(telLine)}</div>`;
  if (faxLine)    html += `<div class="fusui-hanchu-addr-line">${esc(faxLine)}</div>`;
  if (!postalLine && !telLine) html += `<div class="fusui-hanchu-addr-line">${esc(companyName)}</div>`;
  html += '</div>';
  html += '</div>';

  // ── Date Row ──
  if (orderDate || nohinDate || nohinPlace) {
    html += '<div class="fusui-hanchu-dates">';
    if (orderDate)  html += `<div class="fusui-hanchu-date-item"><span class="fusui-hanchu-date-label">発注日:</span><span>${esc(orderDate)}</span></div>`;
    if (nohinDate)  html += `<div class="fusui-hanchu-date-item"><span class="fusui-hanchu-date-label">納品指定日:</span><span>${esc(nohinDate)}</span></div>`;
    if (nohinPlace) html += `<div class="fusui-hanchu-date-item"><span class="fusui-hanchu-date-label">納品場所:</span><span>${esc(nohinPlace)}</span></div>`;
    html += '</div>';
  }

  // ── Product Table ──
  if (dataSheet && Array.isArray(dataSheet.rows) && dataSheet.rows.length) {
    html += _buildFusuiTable(dataSheet);
  } else if (fullText) {
    html += `<div style="padding:16px 28px"><pre style="font-size:.82rem;white-space:pre-wrap">${esc(fullText)}</pre></div>`;
  }

  // ── Notes ──
  if (noteLines.length) {
    html += '<div class="fusui-hanchu-notes">';
    for (const note of noteLines) html += `<div class="fusui-hanchu-note">${esc(note)}</div>`;
    html += '</div>';
  }

  html += '</div>';
  wrap.innerHTML = html;
}
// ── End 風水プロジェクト Renderer ──

function _renderDocumentView(result) {
  const wrap = document.getElementById('xlsDocWrap');
  if (!wrap) return;
  if (!result) { wrap.innerHTML = '<div class="doc-empty">データがありません</div>'; return; }

  const dataSheet = _xlsSheets.find(s => s.name !== 'Full Text') || _xlsSheets[0];
  const selClient = typeof _getXlsSelectedClient === 'function' ? _getXlsSelectedClient() : null;
  const clientName = selClient ? (selClient.name_ja || '') : (result.client?.name_ja || '');

  // Client-specific renderers
  if (_isFusuiClient(selClient, result)) {
    _renderFusuiHanchuView(result, wrap, selClient);
    return;
  }

  const fullText = (result.fused_text || result.text || '');
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
  const noteLines = lines.filter(l => l.startsWith('※') || l.startsWith('＊'));

  // Rows before the client header row are document preamble/metadata
  const hIdx = dataSheet && dataSheet.hasHeader && dataSheet.headerIdx >= 0 ? dataSheet.headerIdx : -1;
  const preambleRows = hIdx > 0 && dataSheet ? dataSheet.rows.slice(0, hIdx) : [];

  // Find document title: prefer preamble, fallback to full text
  const DOC_KEYWORDS = ['発注書','注文書','週間','明細書','連絡表','発注リスト','確認書','請求書','見積書'];
  let titleText = '';
  for (const row of preambleRows) {
    const t = row.filter(Boolean).join(' ').trim();
    if (DOC_KEYWORDS.some(kw => t.includes(kw))) { titleText = t; break; }
  }
  if (!titleText) for (const l of lines) { if (DOC_KEYWORDS.some(kw => l.includes(kw))) { titleText = l; break; } }
  if (!titleText && lines.length) titleText = lines[0];

  // Build metadata from preamble rows — skip title row and noise (email headers, @ addresses)
  const NOISE_RE = /^Gmail|@|^<|^\s*$|^Inbox|^Re:|^Fwd:/i;
  const metaItems = preambleRows
    .map(row => row.filter(Boolean).join('　').trim())
    .filter(t => t && t !== titleText && !NOISE_RE.test(t));

  let html = '<div class="doc-view">';

  // ── Header ──
  html += '<div class="doc-header">';
  if (titleText) html += `<div class="doc-title">${esc(titleText)}</div>`;
  if (clientName && !titleText.includes(clientName)) html += `<div class="doc-client-name">${esc(clientName)}</div>`;
  if (metaItems.length) {
    html += '<div class="doc-meta">';
    for (const item of metaItems) {
      const parts = item.split(/[\/／]/);
      html += '<div class="doc-meta-row">';
      for (const p of parts) if (p.trim()) html += `<span class="doc-meta-item">${esc(p.trim())}</span>`;
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // ── Table (only rows from headerIdx onward) ──
  if (dataSheet && Array.isArray(dataSheet.rows) && dataSheet.rows.length) {
    html += _buildDocTable(dataSheet);
  } else {
    html += `<div class="doc-fulltext"><pre>${esc(fullText)}</pre></div>`;
  }

  // ── Notes ──
  if (noteLines.length) {
    html += '<div class="doc-notes">';
    for (const note of noteLines) html += `<div class="doc-note">${esc(note)}</div>`;
    html += '</div>';
  }
  html += '</div>';
  wrap.innerHTML = html;
}

function _buildDocTable(sheet) {
  const rows = sheet.rows || [];
  if (!rows.length) return '';
  const hIdx = (sheet.hasHeader && sheet.headerIdx >= 0) ? sheet.headerIdx : -1;
  const startRow = hIdx >= 0 ? hIdx + 1 : 0;   // data starts after header
  const maxCols = Math.max(1, ...rows.map(r => r.length));

  let html = '<div class="doc-table-wrap"><table class="doc-table">';

  // Client-aware column headers
  if (hIdx >= 0) {
    html += '<thead><tr>';
    for (let ci = 0; ci < maxCols; ci++) {
      const h = (_resolveSheetColHeading(sheet, ci) || _cleanExcelCell((rows[hIdx] || [])[ci])).trim();
      html += `<th class="doc-th">${esc(h)}</th>`;
    }
    html += '</tr></thead>';
  }

  // Only data rows (hIdx+1 onward)
  html += '<tbody>';
  let visibleRow = 0;
  for (let ri = startRow; ri < rows.length; ri++) {
    const vals = Array.from({length: maxCols}, (_, ci) => _cleanExcelCell((rows[ri] || [])[ci]));
    if (!vals.some(Boolean)) continue;
    visibleRow++;
    const hasTotal = vals.some(v => /合計|小計|TOTAL/i.test(v));
    const isCategory = vals.filter(Boolean).length <= 2 && !((vals[0] || '').match(/^\d/)) && maxCols > 2;
    const rowClass = hasTotal ? 'doc-row-total' : isCategory ? 'doc-row-category' : visibleRow % 2 === 0 ? 'doc-row-alt' : '';
    html += `<tr class="${rowClass}">`;
    for (let ci = 0; ci < maxCols; ci++) {
      const v = vals[ci] || '';
      const isNum = v && !isNaN(parseFloat(v.replace(/[¥円,，\s]/g, ''))) && /[\d]/.test(v);
      html += `<td class="doc-td${isNum ? ' doc-td-num' : ''}">${esc(v)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
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

  // Document View tab (default)
  const docTab = document.createElement('div');
  docTab.className = 'xls-sheet-tab xls-sheet-tab-doc active';
  docTab.textContent = '文書プレビュー';
  docTab.addEventListener('click', () => {
    _xlsActiveSheet = -1;
    sheetTabsEl.querySelectorAll('.xls-sheet-tab').forEach(t => t.classList.remove('active'));
    docTab.classList.add('active');
    document.getElementById('xlsGridWrap').classList.add('hidden');
    document.getElementById('xlsDocWrap').classList.remove('hidden');
    document.querySelector('.xls-formulabar').classList.add('xls-formulabar-hidden');
    document.getElementById('xlsClientHeadingBar').classList.add('xls-client-bar-hidden');
    _renderDocumentView(_xlsResult);
  });
  sheetTabsEl.appendChild(docTab);

  _xlsSheets.forEach((sheet, i) => {
    const tab = document.createElement('div');
    tab.className = 'xls-sheet-tab';
    tab.textContent = sheet.name;
    tab.addEventListener('click', () => {
      _xlsActiveSheet = i;
      sheetTabsEl.querySelectorAll('.xls-sheet-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('xlsDocWrap').classList.add('hidden');
      document.getElementById('xlsGridWrap').classList.remove('hidden');
      document.querySelector('.xls-formulabar').classList.remove('xls-formulabar-hidden');
      document.getElementById('xlsClientHeadingBar').classList.remove('xls-client-bar-hidden');
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
  _xlsActiveSheet = -1;
  document.getElementById('xlsDocWrap').classList.remove('hidden');
  document.querySelector('.xls-formulabar').classList.add('xls-formulabar-hidden');
  document.getElementById('xlsClientHeadingBar').classList.add('xls-client-bar-hidden');
  _renderDocumentView(_xlsResult);

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
    const todayItemModal = document.getElementById('todayOrderItemModalBackdrop');
    if (todayItemModal && !todayItemModal.classList.contains('hidden')) {
      closeTodayOrderItemModal();
      return;
    }
    const todayMetaModal = document.getElementById('todayOrderMetaModalBackdrop');
    if (todayMetaModal && !todayMetaModal.classList.contains('hidden')) {
      closeTodayOrderMetaModal();
      return;
    }
    const chModal = document.getElementById('clientHeadingModalBackdrop');
    if (chModal && !chModal.classList.contains('hidden')) {
      closeClientHeadingModal();
      return;
    }
    const active = document.activeElement;
    if (active && (active.classList.contains('xls-cell-input') || active.classList.contains('xls-th-input') || active.id === 'xlsCellVal' || active.id === 'todayOrderCellVal')) {
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
    // Use backend bbox-aligned rows first (most accurate for structured order forms)
    const paddleExtracted = res.paddle_extracted_rows;
    if (Array.isArray(paddleExtracted) && paddleExtracted.length > 0 && activeClient) {
      const clientCols = _parseClientHeadingCols(activeClient);
      const allKeys = [...clientCols];
      paddleExtracted.forEach(row => {
        Object.keys(row).forEach(k => { if (!allKeys.includes(k)) allKeys.push(k); });
      });
      const bodyRows2D = paddleExtracted.map(row => allKeys.map(k => row[k] || ''));
      document.getElementById("tablesOutput").innerHTML =
        renderHtmlTableBlock('Table 1', allKeys, bodyRows2D, true);
    } else {
      const recon = reconstructTableFromBbox(res.paddle?.lines);
      document.getElementById("tablesOutput").innerHTML = recon
        ? renderBboxTable("Table 1", recon)
        : `<div class="tbl-empty">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
            <span>No tables detected in this document.</span>
          </div>`;
    }
  } else {
    document.getElementById("tablesOutput").innerHTML = tables.map((tbl, i) => {
      const rows = tbl.data || [];
      const caption = tbl.caption ? esc(tbl.caption) : `Table ${i + 1}`;

      // --- Priority 1: use backend-aligned rows when available ----------
      const backendExtracted = tbl.client_extracted_rows;
      if (Array.isArray(backendExtracted) && backendExtracted.length > 0 && activeClient) {
        const clientCols = _parseClientHeadingCols(activeClient);
        // Collect all keys present across extracted rows (preserve client order first)
        const allKeys = [...clientCols];
        backendExtracted.forEach(row => {
          Object.keys(row).forEach(k => { if (!allKeys.includes(k)) allKeys.push(k); });
        });
        const headerCols = allKeys;
        const bodyRows2D = backendExtracted.map(row => allKeys.map(k => row[k] || ''));
        return renderHtmlTableBlock(caption, headerCols, bodyRows2D, true);
      }

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
          // Use backend bbox-extracted rows if available
          const paddleExtracted = res.paddle_extracted_rows;
          if (Array.isArray(paddleExtracted) && paddleExtracted.length > 0 && activeClient) {
            const clientCols = _parseClientHeadingCols(activeClient);
            const allKeys = [...clientCols];
            paddleExtracted.forEach(row => {
              Object.keys(row).forEach(k => { if (!allKeys.includes(k)) allKeys.push(k); });
            });
            const bodyRows2D = paddleExtracted.map(row => allKeys.map(k => row[k] || ''));
            return renderHtmlTableBlock(caption, allKeys, bodyRows2D, true);
          }
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
