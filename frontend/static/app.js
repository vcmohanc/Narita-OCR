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
      if (target === 'todayOrder') initTodayOrderView();
      if (target === 'order') initOrderView();
      if (target === 'clients') initClientsView();
      if (target === 'savedJson') initSavedJsonView();
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
// Display labels matching the sheet tab labels in index.html
const TODAY_FMT_LABELS = {
  chiba: '千葉自動発注書',
  haibukiya: '灰吹屋 発注書',
  tsukiji: '築地産直ファーム',
  props_japan: 'プロップスジャパン 注文書',
  national_azabu: 'ナショナル麻布 発注書',
  fusui: '風水プロジェクト 発注書',
  nanohana: 'なのはな生協 発注書',
  greenworld: 'グリーンワールド 発注書',
  rosen: 'ローゼン 発注リスト',
  worlddelica: 'ワールドデリカ 発注書',
  santoku: '三徳 発注書',
  josoSeikyo: '常総生協',
};
const TODAY_ORDER_FORMATS = {
  chiba: {
    cols: 8,
    dayStartCol: 2,
    dayStep: 1,
    storageKey: 'ocr_today_order_sheet_v5_chiba',
    legacyStorageKey: 'ocr_today_order_sheet_v1_chiba',
    xlsxFile: 'chiba_auto_order.xlsx',
    downloadName: '千葉自動発注書（発注分のみ）.xlsx',
    csvName: '千葉自動発注書_発注書.csv',
    defaultDate: '2026-10-26',
    titleMatch: '千葉',
  },
  haibukiya: {
    cols: 20,
    dayStartCol: 7,
    dayStep: 2,
    storageKey: 'ocr_today_order_sheet_v5_haibukiya',
    legacyStorageKey: 'ocr_today_order_sheet_v1_haibukiya',
    xlsxFile: 'haibukiya_order.xlsx',
    downloadName: '発注書_株式会社灰吹屋御中_全列.xlsx',
    csvName: '灰吹屋_発注書_全列.csv',
    defaultDate: '2026-10-19',
    titleMatch: '灰吹屋',
  },
  props_japan: {
    cols: 10,
    dayStartCol: 4,
    dayStep: 1,
    storageKey: 'ocr_today_order_sheet_v2_props_japan',
    legacyStorageKey: 'ocr_today_order_sheet_v1_props_japan',
    xlsxFile: 'props_japan_order.xlsx',
    downloadName: '注文書_株式会社プロップスジャパン.xlsx',
    csvName: 'プロップスジャパン_注文書.csv',
    defaultDate: '2026-09-21',
    titleMatch: 'プロップスジャパン',
  },
  national_azabu: {
    cols: 13,
    dayStartCol: 6,
    dayStep: 1,
    storageKey: 'ocr_today_order_sheet_v1_national_azabu',
    legacyStorageKey: null,
    xlsxFile: 'national_azabu_order.xlsx',
    downloadName: '発注書_ナショナル麻布株式会社御中.xlsx',
    csvName: 'ナショナル麻布_発注書.csv',
    defaultDate: '2026-10-19',
    titleMatch: 'ナショナル麻布',
  },
  tsukiji: {
    cols: 11,
    dayStartCol: 4,
    dayStep: 1,
    storageKey: 'ocr_today_order_sheet_v1_tsukiji',
    legacyStorageKey: null,
    xlsxFile: 'tsukiji_chiba_order.xlsx',
    downloadName: '発注書_築地産直ファーム（千葉分）.xlsx',
    csvName: '築地産直ファーム_発注書.csv',
    defaultDate: '2026-10-26',
    titleMatch: '築地',
  },
  nanohana: {
    cols: 16,
    dayStartCol: 6,
    dayStep: 2,
    dayCount: 5,
    storageKey: 'ocr_today_order_sheet_v4_nanohana',
    legacyStorageKey: null,
    xlsxFile: 'nanohana_order.xlsx',
    downloadName: '発注書_なのはな生活協同組合.xlsx',
    csvName: 'なのはな生活協同組合_発注書.csv',
    defaultDate: '2026-11-04',
    titleMatch: 'なのはな',
  },
  fusui: {
    cols: 6,
    dayStartCol: null,
    dayStep: 1,
    storageKey: 'ocr_today_order_sheet_v1_fusui',
    legacyStorageKey: null,
    xlsxFile: 'fusui_order.xlsx',
    downloadName: '発注書_株式会社風水プロジェクト.xlsx',
    csvName: '風水プロジェクト_発注書.csv',
    defaultDate: '2026-10-22',
    titleMatch: '風水プロジェクト',
  },
  greenworld: {
    cols: 7,
    dayStartCol: null,
    dayStep: 1,
    storageKey: 'ocr_today_order_sheet_v1_greenworld',
    legacyStorageKey: null,
    xlsxFile: 'greenworld_order.xlsx',
    downloadName: '発注書_グリーンワールド株式会社.xlsx',
    csvName: 'グリーンワールド_発注書.csv',
    defaultDate: '2026-10-08',
    titleMatch: 'グリーンワールド',
  },
  rosen: {
    cols: 13,
    dayStartCol: 5,
    dayStep: 1,
    dayCount: 7,
    storageKey: 'ocr_today_order_sheet_v1_rosen',
    legacyStorageKey: null,
    xlsxFile: 'rosen_order.xlsx',
    downloadName: '週間発注リスト_株式会社相鉄ローゼン.xlsx',
    csvName: '相鉄ローゼン_週間発注リスト.csv',
    defaultDate: '2026-10-24',
    titleMatch: '相鉄ローゼン',
  },
  worlddelica: {
    cols: 5,
    dayStartCol: null,
    dayStep: 1,
    storageKey: 'ocr_today_order_sheet_v1_worlddelica',
    legacyStorageKey: null,
    xlsxFile: 'worlddelica_order.xlsx',
    downloadName: '発注書_株式会社ワールドデリカ.xlsx',
    csvName: 'ワールドデリカ_発注書.csv',
    defaultDate: '2026-10-25',
    titleMatch: 'ワールドデリカ',
  },
  santoku: {
    cols: 10,
    dayStartCol: 3,
    dayStep: 1,
    dayCount: 6,
    storageKey: 'ocr_today_order_sheet_v1_santoku',
    legacyStorageKey: null,
    xlsxFile: 'santoku_order.xlsx',
    downloadName: '発注書_株式会社三徳.xlsx',
    csvName: '三徳_発注書.csv',
    defaultDate: '2026-09-28',
    titleMatch: '三徳',
  },
  josoSeikyo: {
    cols: 8,
    dayStartCol: null,
    dayStep: 1,
    dayCount: 0,
    storageKey: 'ocr_today_order_sheet_v1_joso',
    legacyStorageKey: null,
    xlsxFile: 'joso_order.xlsx',
    downloadName: '発注明細書_常総生協.xlsx',
    csvName: '常総生協_発注明細書.csv',
    defaultDate: '2026-10-29',
    titleMatch: '常総生協',
  },
};
const _nanaBlankDays = () => ({ cp: ['','','','',''], qty: ['','','','',''] });
const TODAY_NANOHANA_PRESETS = [
  { orderNo: '648',    toku: '', name: '有機じゃが芋',        spec: '600g',   price: '230.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '650',    toku: '', name: '有機玉ねぎ',          spec: '600g',   price: '230.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '658',    toku: '', name: '有機ルッコラ',        spec: '50g',    price: '120.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '665',    toku: '', name: '有機生しい茸（菌床）', spec: '90g',    price: '178.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '666',    toku: '', name: '有機きくらげ',        spec: '60g',    price: '147.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '667',    toku: '', name: '有機たもぎたけ',      spec: '100g',   price: '210.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '668',    toku: '', name: 'じゃが芋',            spec: '500g',   price: '165.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '669',    toku: '', name: 'じゃが芋',            spec: '1kg',    price: '280.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '672',    toku: '', name: '玉ねぎ',              spec: '500g',   price: '165.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '673',    toku: '', name: '玉ねぎ',              spec: '1kg',    price: '265.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '675',    toku: '', name: 'ごぼう（カット）',    spec: '200g',   price: '160.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '680',    toku: '', name: '大根（カット）',      spec: '1本分',  price: '180.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '681',    toku: '', name: '大根（ハーフ）',      spec: '1/2本',  price: '120.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '687',    toku: '', name: '白菜',                spec: '1個',    price: '290.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '688',    toku: '', name: 'ミニ白菜',            spec: '1個',    price: '155.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '689',    toku: '', name: 'キャベツ',            spec: '1個',    price: '190.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '705',    toku: '', name: '葉ねぎ',              spec: '100g',   price: '130.0', irisu: '', ..._nanaBlankDays() },
  { orderNo: '199401', toku: '', name: '長ねぎ（カット）',    spec: '300g',   price: '280.0', irisu: '', ..._nanaBlankDays() },
];
const TODAY_FUSUI_PRESETS = [
  { code: '1029510171', name: '有機青じそ 10枚P 有機認証（広島県）出来商店', spec: '10枚P', qty: '100', price: '125', amount: '12,500' },
];
const TODAY_GREENWORLD_PRESETS = [
  { no: '1', name: '有機カリーノケール（長野県産）', spec: '1ケース', irisu: '', cases: '2', price: '', total: '' },
];
const TODAY_ROSEN_PRESETS = [
  { code: '', name: '特別栽培ベビーリーフ40gパック', irisu: '', cost: '', total: '', days: ['', '', '', '', '', '', ''], note: '' },
  { code: '', name: '特別栽培小松菜250g袋', irisu: '', cost: '', total: '', days: ['', '', '', '', '', '', ''], note: '' },
];
const TODAY_WORLDDELICA_PRESETS = [
  { date: '', name: '群馬県産有機サニーレタス15入', qty: '', unit: '箱', note: '' },
  { date: '', name: '有機玉ねぎ 20kg', qty: '', unit: '箱', note: '' },
  { date: '', name: '有機カタローニャ', qty: '', unit: '袋', note: '' },
  { date: '', name: '有機ステッキオ', qty: '', unit: '袋', note: '' },
  { date: '', name: '有機フィノッキオ', qty: '', unit: '袋', note: '' },
  { date: '', name: '群馬県産有機カリーノケール5入', qty: '', unit: '箱', note: '' },
];
const TODAY_SANTOKU_PRESETS = [
  { name: 'ベジコープ 小松菜', origin: '千葉・茨城', spec: '200g', days: Array(6).fill('') },
  { name: 'ベジコープ ベビーリーフ', origin: '千葉', spec: '40g', days: Array(6).fill('') },
  { name: 'ベジコープ グリーンリーフ', origin: '千葉・群馬', spec: 'L', days: Array(6).fill('') },
  { name: 'ベジコープ サニーレタス', origin: '千葉・群馬', spec: 'L', days: Array(6).fill('') },
];
const TODAY_JOSO_PRESETS = [
  { ocr: '51', name: '館野さんの梨（新高）', spec: '2〜3玉（約1kg）', tanka: '470', irisu: '1' },
  { ocr: '70', name: 'レタス', spec: '1玉', tanka: '170', irisu: '1' },
  { ocr: '71', name: 'サニーレタス', spec: '1玉', tanka: '155', irisu: '1' },
  { ocr: '74', name: '小松菜', spec: '1束（200g）', tanka: '155', irisu: '1' },
  { ocr: '78', name: 'ベビーリーフ', spec: '40g', tanka: '145', irisu: '1' },
  { ocr: '84', name: '白菜', spec: '1玉', tanka: '320', irisu: '1' },
  { ocr: '85', name: 'ミニ白菜', spec: '1玉（600〜800g）', tanka: '165', irisu: '1' },
  { ocr: '91', name: 'キャベツ', spec: '1玉', tanka: '200', irisu: '1' },
  { ocr: '92', name: 'キャベツ（カット）', spec: '1/2カット（500g）', tanka: '140', irisu: '1' },
  { ocr: '93', name: '大根', spec: '1本（900g前後）', tanka: '180', irisu: '1' },
  { ocr: '94', name: '大根（カット）', spec: '1/2本（500g前後）', tanka: '125', irisu: '1' },
];
const TODAY_PRESET_ITEMS = ['大根', '赤からし水菜', '小江戸菜', 'スイスチャード', 'ほうれん草', 'キャベツ', 'ホテル風か様用'];
const TODAY_TSUKIJI_PRESETS = [
  { division: '', origin: '千葉', name: 'ベビーリーフ', unit: 'pc', days: ['10', '10', '', '10', '10', '10'], note: '' },
  { division: '', origin: '千葉', name: 'ルッコラ', unit: 'pc', days: ['', '', '休止', '', '', ''], note: '' },
  { division: 'レア', origin: '千葉', name: 'ライフ・レアベジタブル用スイスチャード50g', unit: 'pc', days: ['85', '', '', '', '94', ''], note: '10/30は仮' },
  { division: 'レア', origin: '千葉', name: 'ケールバラ5kg（アクト農場）', unit: '箱', days: ['1', '', '3', '', '4', ''], note: '新規' },
  { division: '', origin: '千葉', name: '人参10kg', unit: '箱', days: ['2', '', '2', '', '2', ''], note: '' },
  { division: '風か様', origin: '千葉', name: 'ホテル風か様用・有機人参10kg', unit: '箱', days: ['', '', '', '', '', ''], note: '数量記入なし' },
  { division: '', origin: '', name: '箱数（原本の合計）', unit: '', days: ['588', '10', '311', '10', '596', '10'], note: '千葉・群馬合算' },
  { division: '', origin: '', name: '物流', unit: '', days: ['千葉経由', '千葉経由', '千葉経由', '千葉経由', '千葉経由', '千葉経由'], note: '' },
];
const TODAY_PROPS_PRESETS = [
  { code: 'Y682', name: '有機たまねぎ400g', unit: 'パック', lot: '10', days: ['', '', '', '', '', '40'] },
  { code: '0636', name: 'インカのめざめ500g', unit: 'パック', lot: '10', days: ['', '', '', '', '', '40'] },
  { code: '0663', name: 'シャドークイーン500g', unit: 'パック', lot: '10', days: ['', '', '', '', '', '10'] },
  { code: '0667', name: 'アンデスレッド500g', unit: 'パック', lot: '10', days: ['', '', '', '', '', '20'] },
  { code: '0855', name: '金美にんじん400g', unit: 'パック', lot: '10', days: ['', '', '', '', '', '20'] },
  { code: '0995', name: 'リーキ', unit: 'パック', lot: '10', days: ['', '', '', '', '', '10'] },
  { code: '0827', name: 'ゆりね', unit: 'パック', lot: '10', days: ['', '', '', '', '', '10'] },
];
const TODAY_HAIBUKIYA_CATEGORIES = ['葉物類', '葉菜類', '根菜類', '果物類', 'イタリア・レストラン野菜'];
const TODAY_NATIONAL_AZABU_CATEGORIES = ['果菜類', '根菜類', '果物類'];
const TODAY_NATIONAL_AZABU_PRESETS = [
  { category: '果菜類', name: 'ズッキーニ', origin: '長野', spec: '1本/10p', priceP: '250', priceCs: '2,500', jan: '4514811010289', days: ['', '1cs', '', '1cs', '', '1cs', ''], note: '' },
  { category: '果菜類', name: 'イエローズッキーニ', origin: '長野', spec: '1本/10p', priceP: '190', priceCs: '1,900', jan: '4514811011460', days: ['', '1cs', '', '', '', '1cs', ''], note: '' },
  { category: '根菜類', name: '人参', origin: '青森・北海道・山梨', spec: '400g/18p', priceP: '220', priceCs: '3,960', jan: '4514811010111', days: ['', '1cs', '', '1cs', '1cs', '1cs', ''], note: '' },
  { category: '根菜類', name: 'にんにく', origin: '栃木', spec: '1コ/10p', priceP: '198', priceCs: '1,980', jan: '4514811011187', days: ['1cs', '1cs', '', '1cs', '1cs', '1cs', ''], note: '' },
  { category: '果物類', name: 'レモン', origin: '熊本', spec: '2コ/10p', priceP: '245', priceCs: '2,450', jan: '4514811010678', days: ['1cs', '', '', '', '', '', ''], note: '' },
];
const TODAY_HAIBUKIYA_PRESETS = [
  { category: '葉物類', name: '水菜', origin: '千葉', cultivation: '特別栽培', spec: '150g/5p', priceP: '165', priceCs: '825', jan: '4514811010524', days: ['1', '', '', '', '', '', '6', '1', '', '', '', ''], note: '生育不良により欠品の可能性あり' },
  { category: '葉物類', name: 'ベビーリーフ', origin: '千葉', cultivation: '特別栽培', spec: '40g/5p', priceP: '165', priceCs: '825', jan: '4514811010470', days: ['1', '', '', '', '', '', '1', '6', '', '', '', ''], note: '生育不良により欠品の可能性あり' },
  { category: '葉菜類', name: 'サニーレタス', origin: '群馬・長野', cultivation: '特別栽培', spec: 'L/5玉', priceP: '190', priceCs: '950', jan: '4514811010036', days: ['5', '', '', '', '', '', '5', '', '', '', '', ''], note: '' },
  { category: '根菜類', name: '人参', origin: '青森・北海道・山梨', cultivation: '特別栽培', spec: '400g/5p', priceP: '225', priceCs: '1,125', jan: '4514811010111', days: ['1', '', '', '', '', '', '', '', '', '', '', ''], note: '' },
  { category: '根菜類', name: 'じゃが芋', origin: '青森・岩手・北海道', cultivation: '特別栽培', spec: '約500g/5p', priceP: '275', priceCs: '1,375', jan: '4514811010128', days: ['', '', '', '', '', '', '1', '', '', '', '', ''], note: '' },
  { category: '根菜類', name: '玉ねぎ', origin: '北海道', cultivation: '特別栽培', spec: '500g/5p', priceP: '280', priceCs: '1,400', jan: '4514811050339', days: ['', '', '', '', '', '', '1', '', '', '', '', ''], note: '' },
  { category: '根菜類', name: '生姜', origin: '熊本・千葉', cultivation: '特別栽培', spec: '50g/5p', priceP: '145', priceCs: '725', jan: '4514811013730', days: ['1', '', '', '', '', '', '', '', '', '', '', ''], note: '' },
  { category: '根菜類', name: 'にんにく', origin: '長野', cultivation: '特別栽培', spec: '1〜2コ/5p', priceP: '198', priceCs: '990', jan: '4514811011187', days: ['1', '', '', '', '', '', '', '', '', '', '', ''], note: '群馬県産終了' },
  { category: '果物類', name: 'レモン', origin: '香川', cultivation: '特別栽培', spec: '2コ/5p', priceP: '245', priceCs: '1,225', jan: '4514811010678', days: ['1', '', '', '', '', '', '', '', '', '', '', ''], note: '' },
  { category: 'イタリア・レストラン野菜', name: 'カリーノケール', origin: '群馬・長野', cultivation: '特別栽培', spec: '100g/5p', priceP: '155', priceCs: '775', jan: '4514811014966', days: ['3', '', '', '', '', '', '3', '', '', '', '', ''], note: '生育不良により欠品の可能性あり' },
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

function _isValidFormatRows(rows, fmt = _todayOrderCurrentFormat) {
  if (!Array.isArray(rows) || rows.length < 5) return false;
  const cfg = TODAY_ORDER_FORMATS[fmt];
  if (!cfg) return false;
  const hdr = rows.find(r => r && r.type === 'header');
  if (!hdr || !Array.isArray(hdr.cells) || hdr.cells.length !== cfg.cols) return false;
  const titleRow = rows.find(r => r && r.type === 'title');
  const titleText = String(titleRow?.cells?.[0] || '');
  if (cfg.titleMatch && !titleText.includes(cfg.titleMatch)) return false;
  return true;
}

function _createTodayOrderInitialRows(fmt = _todayOrderCurrentFormat) {
  if (fmt === 'haibukiya') {
    const ncols = TODAY_ORDER_FORMATS.haibukiya.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',    cells: pad('発注書　株式会社灰吹屋 御中（全列フォーマット）') },
      { type: 'meta',     cells: pad('販売部 部長 石川様　／　宮前平店 店長 佐藤様　／　発注先：㈱ベジコープ（FAX 03-6808-0900）') },
      { type: 'meta',     cells: pad('見積期間：2026年10月19日（月）〜10月24日（土）販売分　／　価格は店着価格（税別）　／　作成：2026年10月19日 佐藤・栗山') },
      { type: 'spacer',   cells: Array(ncols).fill('') },
      { type: 'header',   cells: [
        '品目', '産地', '栽培区分', '規格・入数', '単価/p', '単価/cs', 'JANコード',
        '10/19\n月', '変更',
        '10/20\n火', '変更',
        '10/21\n水', '変更',
        '10/22\n木', '変更',
        '10/23\n金', '変更',
        '10/24\n土', '変更',
        '備考・産地状況'
      ] },
      { type: 'category', cells: pad('葉物類') },
      { type: 'item',     cells: ['水菜', '千葉', '特別栽培', '150g/5p', '165', '825', '4514811010524', '1', '', '', '', '', '', '6', '1', '', '', '', '', '生育不良により欠品の可能性あり'] },
      { type: 'item',     cells: ['ベビーリーフ', '千葉', '特別栽培', '40g/5p', '165', '825', '4514811010470', '1', '', '', '', '', '', '1', '6', '', '', '', '', '生育不良により欠品の可能性あり'] },
      { type: 'category', cells: pad('葉菜類') },
      { type: 'item',     cells: ['サニーレタス', '群馬・長野', '特別栽培', 'L/5玉', '190', '950', '4514811010036', '5', '', '', '', '', '', '5', '', '', '', '', '', ''] },
      { type: 'category', cells: pad('根菜類') },
      { type: 'item',     cells: ['人参', '青森・北海道・山梨', '特別栽培', '400g/5p', '225', '1,125', '4514811010111', '1', '', '', '', '', '', '', '', '', '', '', '', ''] },
      { type: 'item',     cells: ['じゃが芋', '青森・岩手・北海道', '特別栽培', '約500g/5p', '275', '1,375', '4514811010128', '', '', '', '', '', '', '1', '', '', '', '', '', ''] },
      { type: 'item',     cells: ['玉ねぎ', '北海道', '特別栽培', '500g/5p', '280', '1,400', '4514811050339', '', '', '', '', '', '', '1', '', '', '', '', '', ''] },
      { type: 'item',     cells: ['生姜', '熊本・千葉', '特別栽培', '50g/5p', '145', '725', '4514811013730', '1', '', '', '', '', '', '', '', '', '', '', '', ''] },
      { type: 'item',     cells: ['にんにく', '長野', '特別栽培', '1〜2コ/5p', '198', '990', '4514811011187', '1', '', '', '', '', '', '', '', '', '', '', '', '群馬県産終了'] },
      { type: 'category', cells: pad('果物類') },
      { type: 'item',     cells: ['レモン', '香川', '特別栽培', '2コ/5p', '245', '1,225', '4514811010678', '1', '', '', '', '', '', '', '', '', '', '', '', ''] },
      { type: 'category', cells: pad('イタリア・レストラン野菜') },
      { type: 'item',     cells: ['カリーノケール', '群馬・長野', '特別栽培', '100g/5p', '155', '775', '4514811014966', '3', '', '', '', '', '', '3', '', '', '', '', '', '生育不良により欠品の可能性あり'] },
      { type: 'spacer',   cells: Array(ncols).fill('') },
      { type: 'note',     cells: pad('※ 原本の各曜日には「発注数量」と「変更」の2列が用意されています（変更発生時は変更後数量を記載）。') },
      { type: 'note',     cells: pad('※ 10/21（水）は納品なし（グレー）。店舗直納のため、1回あたりの発注合計は8,000円以上でお願いします。') },
      { type: 'note',     cells: pad('※ 発注数の入っている品目のみ表示（発注なし・休止の品目は省略）。') },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  if (fmt === 'nanohana') {
    const ncols = TODAY_ORDER_FORMATS.nanohana.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',  cells: pad('発注書　なのはな生活協同組合') },
      { type: 'meta',   cells: pad('宛先：株式会社ベジコープ 御中　／　発注番号：0455971　／　担当：渡邊') },
      { type: 'meta',   cells: pad('発注日：2026年11月1日（土）　／　11月1回　／　納品日：2026年11月4日（火）　／　納品場所：なのはな生活協同組合') },
      { type: 'meta',   cells: pad('発注元：〒263-0001 千葉市稲毛区長沼原町678-2　TEL 043-216-7087　FAX 043-215-0510') },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'header', cells: ['注文No.', '特価', '商品名', '納品日', '', '', '11/4(水)', '', '11/5(木)', '', '11/6(金)', '', '11/7(土)', '', '11/8(日)', ''] },
      { type: 'header', cells: ['', '', '', '規格容量', '納入価格', '入数', 'C/P', '総数', 'C/P', '総数', 'C/P', '総数', 'C/P', '総数', 'C/P', '総数'] },
      ...TODAY_NANOHANA_PRESETS.map(p => ({
        type: 'item',
        cells: [p.orderNo, p.toku, p.name, p.spec, p.price, p.irisu,
                ...p.cp.flatMap((v, i) => [v, p.qty[i]])]
      })),
      { type: 'data',   cells: ['合計', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''] },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'note',   cells: pad('※ 午前着指定で発送をお願いします。') },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  if (fmt === 'fusui') {
    const ncols = TODAY_ORDER_FORMATS.fusui.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',  cells: pad('発注書　株式会社風水プロジェクト（ゆうき市場）') },
      { type: 'meta',   cells: pad('株式会社ベジコープ 御中（12765）　／　発注者：青果発注 宮島　／　No.000000437576') },
      { type: 'meta',   cells: pad('ゆうき市場事業本部 ㈱風水プロジェクト 〒155-0032 東京都世田谷区代沢　TEL 050-5527-2131　FAX 03-5433-4185') },
      { type: 'meta',   cells: pad('発注日：2026年10月22日　／　納品指定日：2026年10月25日（日）　／　納品場所：引取にて') },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'header', cells: ['商品コード', '商品名', '規格', '数量', '単価（円）', '金額（円）'] },
      ...TODAY_FUSUI_PRESETS.map(p => ({
        type: 'item',
        cells: [p.code, p.name, p.spec, p.qty, p.price, p.amount]
      })),
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'note',   cells: pad('※ 上記住所は納品場所ではありません。受注の返信FAXは上記の番号へお願いします。') },
      { type: 'note',   cells: pad('※ 内容確認後、返信をお願いします。変更がある場合はお電話ください。') },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  if (fmt === 'greenworld') {
    const ncols = TODAY_ORDER_FORMATS.greenworld.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',  cells: pad('発注書　グリーンワールド株式会社') },
      { type: 'meta',   cells: pad('宛先：株式会社ベジコープ ご担当者様　／　担当：中谷（TEL 03-3857-7330　FAX 03-3857-7337）') },
      { type: 'meta',   cells: pad('発注日：2026年10月8日　／　店着予定日：2026年10月11日') },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'header', cells: ['No.', '商品名', '規格', '入数', 'ケース数', '価格（CS）', '合計'] },
      ...TODAY_GREENWORLD_PRESETS.map(p => ({
        type: 'item',
        cells: [p.no, p.name, p.spec, p.irisu, p.cases, p.price, p.total]
      })),
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'data',   cells: ['合計（ケース数）', '', '', '', '2', '', ''] },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'note',   cells: pad('※ 今回の発注は「有機カリーノケール（長野県産）2ケース」のみ（黄色）。価格欄は原本で未記入。') },
      { type: 'note',   cells: pad('※ ご確認のうえ、納品書の返信をお願いします。') },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  if (fmt === 'rosen') {
    const ncols = TODAY_ORDER_FORMATS.rosen.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',  cells: pad('週間発注リスト 株式会社相鉄ローゼン') },
      { type: 'meta',   cells: pad('宛先：株式会社ベジコープ 御中') },
      { type: 'meta',   cells: pad('発注期間：2026年10月24日（土）〜10月30日（金）') },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'header', cells: ['商品コード', '商品名', '入数', '原価', '総数', '10/24\n土', '10/25\n日', '10/26\n月', '10/27\n火', '10/28\n水', '10/29\n木', '10/30\n金', '備考'] },
      ...TODAY_ROSEN_PRESETS.map(p => ({
        type: 'item',
        cells: [p.code, p.name, p.irisu, p.cost, p.total, ...p.days, p.note]
      })),
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'note',   cells: pad('※ 発注数の入っている品目のみ表示（発注なし・休止の品目は省略）。') },
      { type: 'note',   cells: pad('※ 原本の通りに数量を入力してください。') },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  if (fmt === 'santoku') {
    const cfg = TODAY_ORDER_FORMATS.santoku;
    const ncols = cfg.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const [sy, sm, sd] = cfg.defaultDate.split('-').map(Number);
    const _stWdays = ['日', '月', '火', '水', '木', '金', '土'];
    const autoDateLabels = [];
    for (let i = 0; i < cfg.dayCount; i++) {
      const dt = new Date(sy, sm - 1, sd + i);
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      autoDateLabels.push(`${mm}/${dd}\n${_stWdays[dt.getDay()]}`);
    }
    const rows = [
      { type: 'title',  cells: pad('発注書　株式会社三徳') },
      { type: 'meta',   cells: pad('宛先：株式会社ベジコープ 御中　／　発注者：㈱三徳 中小原') },
      { type: 'meta',   cells: pad(`対象期間：2026年${sm}月${sd}日〜`) },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'header', cells: ['商品名', '産地', '規格', ...autoDateLabels, '総計'] },
      ...TODAY_SANTOKU_PRESETS.map(p => ({
        type: 'item',
        cells: [p.name, p.origin, p.spec, ...Array(cfg.dayCount).fill(''), '']
      })),
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'note',   cells: pad(`※ いつもお世話になっております。${sm}/${sd}〜の発注書です。宜しくお願いします。`) },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  if (fmt === 'josoSeikyo') {
    const cfg = TODAY_ORDER_FORMATS.josoSeikyo;
    const ncols = cfg.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',  cells: pad('常総生協　発注明細書') },
      { type: 'meta',   cells: pad('納期：2026年10月29日（木）　10月4回 ／ 発注日：2026年10月23日') },
      { type: 'meta',   cells: pad('発注元：常総生活協同組合　本部物流システムG ／ 納入先：茨城県守谷市本町281') },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'header', cells: ['OCR No.', '商品名', '規格', '納品数', '単価（円）', '入数', '発注数', '金額（円）'] },
      ...TODAY_JOSO_PRESETS.map(p => ({
        type: 'item',
        cells: [p.ocr, p.name, p.spec, '', p.tanka, p.irisu, '', '']
      })),
      { type: 'merged', cells: ['合計', '', '', '', '', '', '', ''] },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'note',   cells: pad('※ 納品はAM必着でお願いいたします。PMになる場合はご連絡ください。') },
      { type: 'note',   cells: pad('※ 納品書には発送日ではなく、上記の納期を納品日として記入してください。') },
      { type: 'note',   cells: pad('※ 金額は単価×発注数で算出した参考値です。') },
    ];
    for (let i = 0; i < 4; i++) rows.push({ type: 'data', cells: Array(ncols).fill('') });
    return rows;
  }

  if (fmt === 'worlddelica') {
    const ncols = TODAY_ORDER_FORMATS.worlddelica.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',  cells: pad('発注書　株式会社ワールドデリカ') },
      { type: 'meta',   cells: pad('宛先：株式会社ベジコープ 御中　／　発注日：10月22日　発注書No.18') },
      { type: 'meta',   cells: pad('発注元：㈱ワールドデリカ（㈱東果内）担当 長谷川・堀切　TEL 0479-86-5178　FAX 0479-86-5177') },
      { type: 'meta',   cells: pad('再送：サニーレタス追加') },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'header', cells: ['納品日', '商品名', '数量', '単位', '備考'] },
      ...TODAY_WORLDDELICA_PRESETS.map(p => ({
        type: 'item',
        cells: [p.date, p.name, p.qty, p.unit, p.note]
      })),
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'note',   cells: pad('※ デリカフーズ納品先：〒121-0073 東京都足立区六町4-12-12 デリカフーズ㈱東京事務所 東京FSセンター（03-3858-8293）') },
      { type: 'note',   cells: pad('※ 10/27・10/30・10/31は発注なし。') },
      { type: 'note',   cells: pad('※ ご記入の上、FAX（0479-86-5177）にて返信をお願いします。') },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  if (fmt === 'props_japan') {
    const ncols = TODAY_ORDER_FORMATS.props_japan.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',  cells: pad('注文書　株式会社プロップスジャパン（発注分のみ）') },
      { type: 'meta',   cells: pad('宛先：ベジコープ 御中　／　担当：井上（TEL 045-474-5221　FAX 045-474-5222）') },
      { type: 'meta',   cells: pad('納品期間：2026年9月21日（月）〜9月26日（土）　／　作成：2026年9月25日') },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'header', cells: ['品番', '品名', '単位', 'ロット', '9/21\n月', '9/22\n火', '9/23\n水', '9/24\n木', '9/25\n金', '9/26\n土'] },
      ...TODAY_PROPS_PRESETS.map(p => ({ type: 'item', cells: [p.code, p.name, p.unit, p.lot, ...p.days] })),
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'note',   cells: pad('※ 急な欠品等は携帯電話（090-9857-5210）へご連絡ください。') },
      { type: 'note',   cells: pad('※ 発注数の入っている品目のみ表示（発注なしの品目は省略）。') },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  if (fmt === 'tsukiji') {
    const ncols = TODAY_ORDER_FORMATS.tsukiji.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',  cells: pad('発注書　築地産直ファーム（千葉分）') },
      { type: 'meta',   cells: pad('宛先：千葉および群馬（榛東集配センター）御中') },
      { type: 'meta',   cells: pad('納品期間：2026年10月26日（月）〜10月31日（土）') },
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'header', cells: ['区分', '産地', '品目', '単位', '10/26\n月', '10/27\n火', '10/28\n水', '10/29\n木', '10/30\n金', '10/31\n土', '備考'] },
      ...TODAY_TSUKIJI_PRESETS.map(p => ({
        type: 'item',
        cells: [p.division, p.origin, p.name, p.unit, ...p.days, p.note]
      })),
      { type: 'spacer', cells: Array(ncols).fill('') },
      { type: 'note',   cells: pad('※ レアベジタブル・ホテル風か様分はシール貼付をお願いします。') },
      { type: 'note',   cells: pad('※ 黄色＝レアベジタブル用　／　橙＝ホテル風か様用') },
      { type: 'note',   cells: pad('※ 箱数は原本の数値（千葉・群馬の合算）をそのまま記載しています。') },
    ];
    for (let i = 0; i < 4; i++) {
      rows.push({ type: 'data', cells: Array(ncols).fill('') });
    }
    return rows;
  }

  if (fmt === 'national_azabu') {
    const ncols = TODAY_ORDER_FORMATS.national_azabu.cols;
    const pad = (text) => [text, ...Array(ncols - 1).fill('')];
    const rows = [
      { type: 'title',    cells: pad('発注書　ナショナル麻布株式会社 御中（発注分のみ）') },
      { type: 'meta',     cells: pad('青果部 沖津様　／　発注先：㈱ベジコープ（FAX 03-6808-0900）') },
      { type: 'meta',     cells: pad('見積期間：2026年10月19日（月）〜10月24日（土）販売分　／　単価は税別　／　作成：2026年10月13日 内藤 渉') },
      { type: 'spacer',   cells: Array(ncols).fill('') },
      { type: 'header',   cells: ['品目', '産地', '規格・入数', '単価/p', '単価/cs', 'JANコード', '10/19\n月', '10/20\n火', '10/21\n水', '10/22\n木', '10/23\n金', '10/24\n土', '備考・産地状況'] },
      { type: 'category', cells: pad('果菜類') },
      { type: 'item',     cells: ['ズッキーニ', '長野', '1本/10p', '250', '2,500', '4514811010289', '', '1cs', '', '1cs', '', '1cs', ''] },
      { type: 'item',     cells: ['イエローズッキーニ', '長野', '1本/10p', '190', '1,900', '4514811011460', '', '1cs', '', '', '', '1cs', ''] },
      { type: 'category', cells: pad('根菜類') },
      { type: 'item',     cells: ['人参', '青森・北海道・山梨', '400g/18p', '220', '3,960', '4514811010111', '', '1cs', '', '1cs', '1cs', '1cs', ''] },
      { type: 'item',     cells: ['にんにく', '栃木', '1コ/10p', '198', '1,980', '4514811011187', '1cs', '1cs', '', '1cs', '1cs', '1cs', ''] },
      { type: 'category', cells: pad('果物類') },
      { type: 'item',     cells: ['レモン', '熊本', '2コ/10p', '245', '2,450', '4514811010678', '1cs', '', '', '', '', '', ''] },
      { type: 'spacer',   cells: Array(ncols).fill('') },
      { type: 'note',     cells: pad('※ 発注数の単位はケース（cs）。10/21（水）は納品なし（グレー）。') },
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
    if (!silent) showToast('ブラウザに保存しました（サーバー同期: ' + e.message + '）', true);
    return false;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function _ensureNanohanaHeaders() {
  const ncols = TODAY_ORDER_FORMATS.nanohana.cols;
  const hasHeaders = _todayOrderRows.some(r => r.type === 'header');
  if (hasHeaders) return;
  // Find first item row to insert before it
  const firstItemIdx = _todayOrderRows.findIndex(r => r.type === 'item' || r.type === 'data');
  const insertAt = firstItemIdx >= 0 ? firstItemIdx : _todayOrderRows.length;
  const hdr1 = { type: 'header', cells: ['注文No.', '特価', '商品名', '納品日', '', '', '11/4(水)', '', '11/5(木)', '', '11/6(金)', '', '11/7(土)', '', '11/8(日)', ''] };
  const hdr2 = { type: 'header', cells: ['', '', '', '規格容量', '納入価格', '入数', 'C/P', '総数', 'C/P', '総数', 'C/P', '総数', 'C/P', '総数', 'C/P', '総数'] };
  _todayOrderRows.splice(insertAt, 0, hdr1, hdr2);
}

async function loadTodayOrderSheet(fmt = _todayOrderCurrentFormat) {
  const cfg = _todayFmtCfg(fmt);
  try {
    const r = await fetch(`${API_BASE}/api/today-order?format=${encodeURIComponent(fmt)}`);
    if (r.ok) {
      const data = await r.json();
      if (data && !data.is_default && Array.isArray(data.rows) && data.rows.length) {
        if (_isValidFormatRows(data.rows, fmt)) {
          _todayOrderRows = _normalizeTodayOrderRowsClient(data.rows, fmt);
          if (fmt === 'nanohana') _ensureNanohanaHeaders();
          _persistTodayOrderLocal(fmt);
          return;
        }
      }
      // Server has no saved data — try product master JSON
      if (data && data.is_default) {
        try {
          const pr = await fetch(`${API_BASE}/api/today-order/products?format=${encodeURIComponent(fmt)}`);
          if (pr.ok) {
            const { rows: productRows, ncols, base_cols } = await pr.json();
            if (Array.isArray(productRows) && productRows.some(r => r.type === 'item')) {
              const baseRows = _createTodayOrderInitialRows(fmt);
              let lastHdrIdx = -1;
              for (let i = 0; i < baseRows.length; i++) {
                if (baseRows[i].type === 'header') lastHdrIdx = i;
              }
              if (lastHdrIdx >= 0) {
                const masterRows = productRows.map(row => {
                  if (row.type === 'item') {
                    const base = (row.cells || []).slice(0, base_cols);
                    while (base.length < base_cols) base.push('');
                    return { type: 'item', cells: [...base, ...Array(ncols - base_cols).fill('')] };
                  }
                  if (row.type === 'category') {
                    const cells = (row.cells || []).slice();
                    while (cells.length < ncols) cells.push('');
                    return { type: 'category', cells };
                  }
                  return row;
                });
                masterRows.push({ type: 'spacer', cells: Array(ncols).fill('') });
                for (let i = 0; i < 4; i++) masterRows.push({ type: 'data', cells: Array(ncols).fill('') });
                _todayOrderRows = [...baseRows.slice(0, lastHdrIdx + 1), ...masterRows];
                if (fmt === 'nanohana') _ensureNanohanaHeaders();
                _persistTodayOrderLocal(fmt);
                return;
              }
            }
          }
        } catch {}
      }
    }
  } catch {}
  try {
    const cached = localStorage.getItem(cfg.storageKey) || (cfg.legacyStorageKey ? localStorage.getItem(cfg.legacyStorageKey) : null);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length && _isValidFormatRows(parsed, fmt)) {
        _todayOrderRows = _normalizeTodayOrderRowsClient(parsed, fmt);
        if (fmt === 'nanohana') _ensureNanohanaHeaders();
        return;
      }
    }
  } catch {}
  _todayOrderRows = _createTodayOrderInitialRows(fmt);
  _persistTodayOrderLocal(fmt);
}

function _renderTodayPresetChips() {
  const modalEl = document.getElementById('todayItemPresetChips');
  const isHaibukiya = _todayOrderCurrentFormat === 'haibukiya';
  const isProps = _todayOrderCurrentFormat === 'props_japan';
  const isNationalAzabu = _todayOrderCurrentFormat === 'national_azabu';
  const isTsukiji = _todayOrderCurrentFormat === 'tsukiji';
  const isNanohana = _todayOrderCurrentFormat === 'nanohana';
  const isFusui = _todayOrderCurrentFormat === 'fusui';
  const isGreenworld = _todayOrderCurrentFormat === 'greenworld';
  const isRosen = _todayOrderCurrentFormat === 'rosen';
  const isWorldDelica = _todayOrderCurrentFormat === 'worlddelica';
  const isSantoku = _todayOrderCurrentFormat === 'santoku';
  const isJosoSeikyo = _todayOrderCurrentFormat === 'josoSeikyo';
  const items = isHaibukiya
    ? TODAY_HAIBUKIYA_PRESETS.map(p => p.name)
    : (isProps ? TODAY_PROPS_PRESETS.map(p => p.name) : (isNationalAzabu ? TODAY_NATIONAL_AZABU_PRESETS.map(p => p.name) : (isTsukiji ? TODAY_TSUKIJI_PRESETS.map(p => p.name) : (isNanohana ? TODAY_NANOHANA_PRESETS.map(p => p.name) : (isFusui ? TODAY_FUSUI_PRESETS.map(p => p.name) : (isGreenworld ? TODAY_GREENWORLD_PRESETS.map(p => p.name) : (isRosen ? TODAY_ROSEN_PRESETS.map(p => p.name) : (isWorldDelica ? TODAY_WORLDDELICA_PRESETS.map(p => p.name) : (isSantoku ? TODAY_SANTOKU_PRESETS.map(p => p.name) : (isJosoSeikyo ? TODAY_JOSO_PRESETS.map(p => p.name) : TODAY_PRESET_ITEMS))))))))));

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
      } else if (_todayOrderCurrentFormat === 'props_japan') {
        TODAY_PROPS_PRESETS.forEach(p => {
          if (!existing.has(p.name)) {
            const tr = _appendTodayModalItemRow({ ...p });
            if (!firstAdded) firstAdded = tr;
          }
        });
      } else if (_todayOrderCurrentFormat === 'national_azabu') {
        TODAY_NATIONAL_AZABU_PRESETS.forEach(p => {
          if (!existing.has(p.name)) {
            const tr = _appendTodayModalItemRow({ ...p, days: [...p.days] });
            if (!firstAdded) firstAdded = tr;
          }
        });
      } else if (_todayOrderCurrentFormat === 'tsukiji') {
        TODAY_TSUKIJI_PRESETS.forEach(p => {
          if (!existing.has(p.name)) {
            const tr = _appendTodayModalItemRow({ ...p });
            if (!firstAdded) firstAdded = tr;
          }
        });
      } else if (_todayOrderCurrentFormat === 'nanohana') {
        TODAY_NANOHANA_PRESETS.forEach(p => {
          if (!existing.has(p.name)) {
            const tr = _appendTodayModalItemRow({ ...p });
            if (!firstAdded) firstAdded = tr;
          }
        });
      } else if (_todayOrderCurrentFormat === 'fusui') {
        TODAY_FUSUI_PRESETS.forEach(p => {
          if (!existing.has(p.name)) {
            const tr = _appendTodayModalItemRow({ ...p });
            if (!firstAdded) firstAdded = tr;
          }
        });
      } else if (_todayOrderCurrentFormat === 'greenworld') {
        TODAY_GREENWORLD_PRESETS.forEach(p => {
          if (!existing.has(p.name)) {
            const tr = _appendTodayModalItemRow({ ...p });
            if (!firstAdded) firstAdded = tr;
          }
        });
      } else if (_todayOrderCurrentFormat === 'rosen') {
        TODAY_ROSEN_PRESETS.forEach(p => {
          if (!existing.has(p.name)) {
            const tr = _appendTodayModalItemRow({ ...p, days: [...p.days] });
            if (!firstAdded) firstAdded = tr;
          }
        });
      } else if (_todayOrderCurrentFormat === 'worlddelica') {
        TODAY_WORLDDELICA_PRESETS.forEach(p => {
          if (!existing.has(p.name)) {
            const tr = _appendTodayModalItemRow({ ...p });
            if (!firstAdded) firstAdded = tr;
          }
        });
      } else if (_todayOrderCurrentFormat === 'santoku') {
        TODAY_SANTOKU_PRESETS.forEach(p => {
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
      (firstAdded?.querySelector('.today-m-day') || firstAdded?.querySelector('.today-m-unit'))?.focus();
    });
  }
}

async function switchTodayOrderFormat(fmt) {
  const nextFmt = TODAY_ORDER_FORMATS[fmt] ? fmt : Object.keys(TODAY_ORDER_FORMATS)[0];
  _todayOrderCurrentFormat = nextFmt;

  const sel = document.getElementById('todayOrderFormatSelect');
  if (sel) sel.value = nextFmt;

  document.querySelectorAll('#todayOrderSheetTabs .xls-sheet-tab').forEach(tab => {
    const isActive = tab.dataset.format === nextFmt;
    tab.classList.toggle('active', isActive);
    if (isActive) {
      try { tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); } catch {}
    }
  });

  const addCatBtn = document.getElementById('todayOrderAddCategoryBtn');
  if (addCatBtn) addCatBtn.classList.toggle('hidden', nextFmt !== 'haibukiya' && nextFmt !== 'national_azabu');

  const searchInp = document.getElementById('todayOrderSearch');
  if (searchInp) {
    searchInp.placeholder = (nextFmt === 'haibukiya' || nextFmt === 'national_azabu')
      ? '品目・産地・JAN・備考で検索…'
      : (nextFmt === 'tsukiji'
          ? '区分・産地・品目・備考で検索…'
          : (nextFmt === 'nanohana'
              ? '注文No.・商品名・規格容量で検索…'
              : (nextFmt === 'fusui'
                  ? '商品コード・商品名・規格で検索…'
                  : (nextFmt === 'greenworld'
                      ? 'No.・商品名・規格で検索…'
                      : (nextFmt === 'rosen'
                          ? '商品コード・商品名・備考で検索…'
                          : (nextFmt === 'worlddelica'
                              ? '納品日・商品名・備考で検索…'
                              : (nextFmt === 'santoku'
                                  ? '商品名・産地・規格で検索…'
                                  : (nextFmt === 'props_japan' ? '品番・品名・単位で検索…' : '品目・単位・備考で検索…'))))))));
  }

  _renderTodayPresetChips();
  await loadTodayOrderSheet(nextFmt);
  _todayOrderSelRow = 0;
  _todayOrderSelCol = 0;
  _markTodayOrderDirty(false);
  _renderTodayOrderGrid();
  const fmtToast = nextFmt === 'haibukiya'
    ? '発注書フォーマットを「灰吹屋 御中（全20列）」に切り替えました'
    : (nextFmt === 'props_japan'
        ? '発注書フォーマットを「株式会社プロップスジャパン（10列・1週間）」に切り替えました'
        : (nextFmt === 'national_azabu'
            ? '発注書フォーマットを「ナショナル麻布株式会社 御中（13列）」に切り替えました'
            : (nextFmt === 'tsukiji'
                ? '発注書フォーマットを「築地産直ファーム（11列）」に切り替えました'
                : (nextFmt === 'nanohana'
                    ? '発注書フォーマットを「なのはな生活協同組合（6列）」に切り替えました'
                    : (nextFmt === 'fusui'
                        ? '発注書フォーマットを「株式会社風水プロジェクト（6列）」に切り替えました'
                        : (nextFmt === 'greenworld'
                            ? '発注書フォーマットを「グリーンワールド株式会社（7列）」に切り替えました'
                             : (nextFmt === 'rosen'
                                 ? '発注書フォーマットを「株式会社相鉄ローゼン（13列・7日間）」に切り替えました'
                                 : (nextFmt === 'worlddelica'
                                     ? '発注書フォーマットを「株式会社ワールドデリカ（5列）」に切り替えました'
                                     : (nextFmt === 'santoku'
                                         ? '発注書フォーマットを「株式会社三徳（8列・4日間）」に切り替えました'
                                         : '発注書フォーマットを「千葉自動発注書（8列）」に切り替えました')))))))));
  showToast(fmtToast);
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
  if (!hdr) {
    if (_todayOrderCurrentFormat === 'haibukiya') return '10/19〜10/24';
    if (_todayOrderCurrentFormat === 'props_japan') return '9/21〜9/26';
    if (_todayOrderCurrentFormat === 'tsukiji') return '10/26〜10/31';
    if (_todayOrderCurrentFormat === 'nanohana') return '11/4〜11/8';
    if (_todayOrderCurrentFormat === 'fusui') return '10/22〜10/25';
    if (_todayOrderCurrentFormat === 'greenworld') return '10/8〜10/11';
    if (_todayOrderCurrentFormat === 'rosen') return '10/24〜10/30';
    if (_todayOrderCurrentFormat === 'worlddelica') return '10/25〜10/29';
    if (_todayOrderCurrentFormat === 'santoku') return '9/28〜10/3';
    if (_todayOrderCurrentFormat === 'josoSeikyo') return '10/29';
    return '10/26〜10/31';
  }
  if (_todayOrderCurrentFormat === 'haibukiya') {
    const startRaw = String(hdr.cells[7] || '').split('\n')[0].trim() || '10/19';
    const endRaw = String(hdr.cells[17] || '').split('\n')[0].trim() || '10/24';
    return `${startRaw}〜${endRaw}`;
  }
  if (_todayOrderCurrentFormat === 'tsukiji') {
    const startRaw = String(hdr.cells[4] || '').split('\n')[0].trim() || '10/26';
    const endRaw = String(hdr.cells[9] || '').split('\n')[0].trim() || '10/31';
    return `${startRaw}〜${endRaw}`;
  }
  if (_todayOrderCurrentFormat === 'props_japan') {
    const startRaw = String(hdr.cells[4] || '').split('\n')[0].trim() || '9/21';
    const endRaw = String(hdr.cells[9] || '').split('\n')[0].trim() || '9/26';
    return `${startRaw}〜${endRaw}`;
  }
  if (_todayOrderCurrentFormat === 'nanohana') {
    const startRaw = String(hdr.cells[6] || '').split('\n')[0].trim() || '11/4';
    const endRaw   = String(hdr.cells[14] || '').split('\n')[0].trim() || '11/8';
    return `${startRaw}〜${endRaw}`;
  }
  if (_todayOrderCurrentFormat === 'fusui') {
    return '10/22〜10/25';
  }
  if (_todayOrderCurrentFormat === 'greenworld') {
    return '10/8〜10/11';
  }
  if (_todayOrderCurrentFormat === 'rosen') {
    const startRaw = String(hdr.cells[5] || '').split('\n')[0].trim() || '10/24';
    const endRaw = String(hdr.cells[11] || '').split('\n')[0].trim() || '10/30';
    return `${startRaw}〜${endRaw}`;
  }
  if (_todayOrderCurrentFormat === 'worlddelica') {
    return '10/25〜10/29';
  }
  if (_todayOrderCurrentFormat === 'santoku') {
    const startRaw = String(hdr.cells[3] || '').split('\n')[0].trim() || '9/28';
    const endRaw = String(hdr.cells[8] || '').split('\n')[0].trim() || '10/3';
    return `${startRaw}〜${endRaw}`;
  }
  if (_todayOrderCurrentFormat === 'josoSeikyo') {
    return '10/29';
  }
  const startRaw = String(hdr.cells[startCol] || '').split('\n')[0].trim() || '10/26';
  const endRaw = String(hdr.cells[startCol + 5] || '').split('\n')[0].trim() || '10/31';
  return `${startRaw}〜${endRaw}`;
}

function _syncTodayOrderMergedNotice() {
  if (_todayOrderCurrentFormat === 'haibukiya' || _todayOrderCurrentFormat === 'props_japan' || _todayOrderCurrentFormat === 'national_azabu' || _todayOrderCurrentFormat === 'tsukiji' || _todayOrderCurrentFormat === 'nanohana' || _todayOrderCurrentFormat === 'fusui' || _todayOrderCurrentFormat === 'greenworld' || _todayOrderCurrentFormat === 'rosen' || _todayOrderCurrentFormat === 'worlddelica' || _todayOrderCurrentFormat === 'santoku' || _todayOrderCurrentFormat === 'josoSeikyo') return;
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
  const isProps = _todayOrderCurrentFormat === 'props_japan';
  const isNationalAzabu = _todayOrderCurrentFormat === 'national_azabu';
  const isTsukiji = _todayOrderCurrentFormat === 'tsukiji';
  const isNanohana = _todayOrderCurrentFormat === 'nanohana';
  const isFusui = _todayOrderCurrentFormat === 'fusui';
  const isGreenworld = _todayOrderCurrentFormat === 'greenworld';
  const isRosen = _todayOrderCurrentFormat === 'rosen';
  const isJoso = _todayOrderCurrentFormat === 'josoSeikyo';
  let cls = 'xls-cell';
  if (rowObj.type === 'title') cls += ' today-xls-title';
  else if (rowObj.type === 'meta') cls += ' today-xls-meta';
  else if (rowObj.type === 'category') cls += ' today-xls-category';
  else if (rowObj.type === 'header') {
    cls += ' today-xls-header';
    if (isHaibukiya) {
      if (ci <= 2 || ci === 19) cls += ' today-xls-header-left';
      else if (ci === 3 || ci === 4 || ci === 5) cls += ' today-xls-header-right';
      else if (ci === 8 || ci === 10 || ci === 12 || ci === 14 || ci === 16 || ci === 18) {
        cls += ' today-xls-header-center today-th-h-chg';
      } else {
        cls += ' today-xls-header-center today-th-h-day';
      }
    } else if (isNationalAzabu) {
      if (ci === 0 || ci === 1 || ci === 2 || ci === 12) cls += ' today-xls-header-left';
      else if (ci === 3 || ci === 4) cls += ' today-xls-header-right';
      else cls += ' today-xls-header-center today-th-na-day';
    } else if (isTsukiji) {
      if (ci <= 3 || ci === 10) cls += ' today-xls-header-left';
      else cls += ' today-xls-header-center today-th-tsukiji-day';
    } else if (isProps) {
      if (ci === 1) cls += ' today-xls-header-left';
      else if (ci === 3) cls += ' today-xls-header-right';
      else cls += ' today-xls-header-center';
    } else if (isNanohana) {
      if (ci <= 2) cls += ' today-xls-header-left';
      else cls += ' today-xls-header-right';
    } else if (isFusui) {
      if (ci <= 2) cls += ' today-xls-header-left';
      else cls += ' today-xls-header-right';
    } else if (isGreenworld) {
      if (ci === 1) cls += ' today-xls-header-left';
      else if (ci >= 3) cls += ' today-xls-header-right';
      else cls += ' today-xls-header-center';
    } else if (_todayOrderCurrentFormat === 'worlddelica') {
      if (ci === 1) cls += ' today-xls-header-left';
      else if (ci === 2) cls += ' today-xls-header-right';
      else cls += ' today-xls-header-center';
    } else if (_todayOrderCurrentFormat === 'santoku') {
      if (ci === 0) cls += ' today-xls-header-left';
      else if (ci === 2) cls += ' today-xls-header-right';
      else cls += ' today-xls-header-center';
    } else if (isJoso) {
      if (ci === 0 || ci === 1 || ci === 2) cls += ' today-xls-header-left';
      else cls += ' today-xls-header-right';
    } else {
      if (ci === 0) cls += ' today-xls-header-left';
      else if (ci === 1) cls += ' today-xls-header-right';
      else cls += ' today-xls-header-center';
    }
  } else if (rowObj.type === 'merged') cls += ' today-xls-merged';
  else if (rowObj.type === 'note') cls += ' today-xls-note';
  else if (isTsukiji) {
    if (ci === 0 || ci === 1) cls += ' today-xls-text';
    else if (rowObj.type === 'item' && ci === 2) cls += ' today-xls-item-name';
    else if (ci === 3) cls += ' today-xls-item-unit';
    else if (ci >= 4 && ci <= 9) {
      if (val === '休止') cls += ' today-cell-paused';
      else if (val === '千葉経由') cls += ' today-cell-logistics';
      else if (val && /^\d+$/.test(val.trim())) cls += ' today-xls-num today-cell-day';
      else cls += ' today-xls-text';
    } else if (ci === 10) cls += ' today-xls-note';
  } else if (isNationalAzabu) {
    if (rowObj.type === 'item' && ci === 0) cls += ' today-xls-item-name';
    else if (ci === 1 || ci === 2) cls += ' today-xls-text';
    else if (ci === 3 || ci === 4) cls += ' today-xls-num';
    else if (ci === 5) cls += ' today-xls-jan';
    else if (ci >= 6 && ci <= 11) cls += ' today-xls-num today-cell-day';
    else if (ci === 12) cls += ' today-xls-note';
    if (ci === 8 && (rowObj.type === 'item' || rowObj.type === 'data')) cls += ' today-xls-wed-off';
  } else if (isHaibukiya) {
    if (rowObj.type === 'item' && ci === 0) cls += ' today-xls-item-name';
    else if (ci === 1 || ci === 2 || ci === 3) cls += ' today-xls-text';
    else if (ci === 4 || ci === 5) cls += ' today-xls-num';
    else if (ci === 6) cls += ' today-xls-jan';
    else if (ci === 7 || ci === 9 || ci === 11 || ci === 13 || ci === 15 || ci === 17) cls += ' today-xls-num today-cell-day';
    else if (ci === 8 || ci === 10 || ci === 12 || ci === 14 || ci === 16 || ci === 18) cls += ' today-xls-num today-xls-change';
    else if (ci === 19) cls += ' today-xls-note';
    if ((ci === 11 || ci === 12) && (rowObj.type === 'item' || rowObj.type === 'data')) cls += ' today-xls-wed-off';
  } else if (isProps) {
    if (ci === 0) cls += ' today-xls-item-code';
    else if (rowObj.type === 'item' && ci === 1) cls += ' today-xls-item-name';
    else if (ci === 2 && (rowObj.type === 'item' || String(rowObj.cells?.[1] || '').trim())) {
      cls += ' today-xls-item-unit';
      if (!_validateTodayUnit(val).valid) cls += ' today-cell-invalid';
    } else if (rowObj.type === 'item' && ci === 2) cls += ' today-xls-item-unit';
    else if (ci >= 3 || (val && /^[\d,，.\-￥¥\s]+$/.test(val) && /\d/.test(val))) cls += ' today-xls-num';
  } else if (isNanohana) {
    if (rowObj.type === 'header' || rowObj.type === 'header_top' || rowObj.type === 'header_sub') {
      cls += ' today-xls-header-center';
    } else if (ci === 0) cls += ' today-xls-item-code';
    else if (rowObj.type === 'item' && ci === 2) cls += ' today-xls-item-name';
    else if (ci === 1 || ci === 3) cls += ' today-xls-text';
    else cls += ' today-xls-num';
  } else if (isFusui) {
    if (ci === 0) cls += ' today-xls-item-code';
    else if (rowObj.type === 'item' && ci === 1) cls += ' today-xls-item-name';
    else if (ci === 2) cls += ' today-xls-text';
    else if (ci >= 3) cls += ' today-xls-num';
  } else if (isGreenworld) {
    if (ci === 0) cls += ' today-xls-item-code';
    else if (rowObj.type === 'item' && ci === 1) cls += ' today-xls-item-name';
    else if (ci === 2 || ci === 3) cls += ' today-xls-text';
    else if (ci >= 4) cls += ' today-xls-num';
  } else if (isRosen) {
    if (ci === 0) cls += ' today-xls-item-code';
    else if (rowObj.type === 'item' && ci === 1) cls += ' today-xls-item-name';
    else if (ci === 2 || ci === 3) cls += ' today-xls-text';
    else if (ci >= 4 && ci <= 11) cls += ' today-xls-num today-cell-day';
    else if (ci === 12) cls += ' today-xls-note';
  } else if (_todayOrderCurrentFormat === 'worlddelica') {
    if (ci === 0) cls += ' today-xls-item-code';
    else if (rowObj.type === 'item' && ci === 1) cls += ' today-xls-item-name';
    else if (ci === 2) cls += ' today-xls-num';
    else if (ci === 3) cls += ' today-xls-item-unit';
    else if (ci === 4) cls += ' today-xls-note';
  } else if (_todayOrderCurrentFormat === 'santoku') {
    if (rowObj.type === 'item' && ci === 0) cls += ' today-xls-item-name';
    else if (ci === 1) cls += ' today-xls-text';
    else if (ci === 2) cls += ' today-xls-text';
    else if (ci >= 3 && ci <= 8) cls += ' today-xls-num today-cell-day';
    else if (ci === 9) cls += ' today-xls-num';
  } else if (isJoso) {
    if (ci === 0) cls += ' today-xls-num';
    else if (ci === 1) cls += rowObj.type === 'item' ? ' today-xls-item-name' : ' today-xls-text';
    else if (ci === 2) cls += ' today-xls-text';
    else if (ci >= 3 && ci <= 7) cls += ' today-xls-num';
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
  const endDt = new Date(y, m - 1, d + (_todayFmtCfg().dayCount ?? 6) - 1);
  const wdays = ['日', '月', '火', '水', '木', '金', '土'];
  const span = `${startDt.getFullYear()}年${startDt.getMonth() + 1}月${startDt.getDate()}日（${wdays[startDt.getDay()]}）〜${endDt.getMonth() + 1}月${endDt.getDate()}日（${wdays[endDt.getDay()]}）`;
  if (_todayOrderCurrentFormat === 'props_japan' || _todayOrderCurrentFormat === 'tsukiji') {
    return `納品期間：${span}`;
  }
  if (_todayOrderCurrentFormat === 'haibukiya' || _todayOrderCurrentFormat === 'national_azabu') {
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
    if (_todayOrderCurrentFormat === 'haibukiya' || _todayOrderCurrentFormat === 'props_japan' || _todayOrderCurrentFormat === 'national_azabu' || _todayOrderCurrentFormat === 'tsukiji') {
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
    if (_todayOrderCurrentFormat === 'haibukiya') {
      const dayStart = 7;
      for (let offset = 0; offset < 6; offset++) {
        const dt = new Date(y, m - 1, d + offset);
        const mStr = dt.getMonth() + 1;
        const dStr = dt.getDate();
        const wStr = wdays[dt.getDay()];
        hdr.cells[dayStart + offset * 2] = `${mStr}/${dStr}\n${wStr}`;
        hdr.cells[dayStart + offset * 2 + 1] = '変更';
      }
    } else if (startCol != null) {
      for (let offset = 0; offset < (_todayFmtCfg().dayCount ?? 6); offset++) {
        const dt = new Date(y, m - 1, d + offset);
        hdr.cells[startCol + offset] = `${dt.getMonth() + 1}/${dt.getDate()}\n${wdays[dt.getDay()]}`;
      }
    }
  }
  if (_todayOrderCurrentFormat === 'haibukiya' || _todayOrderCurrentFormat === 'national_azabu') {
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

function _getNationalAzabuCategoriesInSheet() {
  const cats = new Set(TODAY_NATIONAL_AZABU_CATEGORIES);
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
    for (let offset = 0; offset < (_todayFmtCfg().dayCount ?? 6); offset++) {
      const dt = new Date(y, m - 1, d + offset);
      dayLabels.push(`${dt.getMonth() + 1}/${dt.getDate()} (${wdays[dt.getDay()]})`);
    }
  } else {
    const hdr = _todayOrderRows.find(r => r.type === 'header');
    const startCol = _todayDayStartCol();
    const step = _todayFmtCfg().dayStep || 1;
    for (let offset = 0; offset < (_todayFmtCfg().dayCount ?? 6); offset++) {
      const rawHdr = String(hdr?.cells?.[startCol + offset * step] || '').trim();
      dayLabels.push(rawHdr ? rawHdr.replace(/\n+/g, ' (') + (rawHdr.includes('\n') ? ')' : '') : `日 ${offset + 1}`);
    }
  }

  if (_todayOrderCurrentFormat === 'haibukiya') {
    const catOpts = _getHaibukiyaCategoriesInSheet().map(c => `<option value="${esc(c)}"></option>`).join('');
    thead.innerHTML =
      `<tr>
        <th style="width:28px">#</th>
        <th style="min-width:100px">カテゴリ<datalist id="todayHaibukiyaCatList">${catOpts}</datalist></th>
        <th style="min-width:115px">品目名 <span class="required">*</span></th>
        <th style="min-width:90px">産地</th>
        <th style="min-width:75px">栽培区分</th>
        <th style="min-width:80px">規格・入数</th>
        <th style="width:64px">単価/p</th>
        <th style="width:68px">単価/cs</th>
        <th style="min-width:105px">JANコード</th>
        ${dayLabels.map((lbl, idx) => `
          <th id="todayModalDayHdr${idx}" style="width:52px">${esc(lbl)}</th>
          <th style="width:48px;background:rgba(220,38,38,0.08);color:#991b1b">変更</th>
        `).join('')}
        <th style="min-width:130px">備考・産地状況</th>
        <th style="width:34px"></th>
      </tr>`;
  } else if (_todayOrderCurrentFormat === 'national_azabu') {
    const catOpts = _getNationalAzabuCategoriesInSheet().map(c => `<option value="${esc(c)}"></option>`).join('');
    thead.innerHTML =
      `<tr>
        <th style="width:28px">#</th>
        <th style="min-width:90px">カテゴリ<datalist id="todayNationalAzabuCatList">${catOpts}</datalist></th>
        <th style="min-width:115px">品目名 <span class="required">*</span></th>
        <th style="min-width:80px">産地</th>
        <th style="min-width:80px">規格・入数</th>
        <th style="width:64px">単価/p</th>
        <th style="width:68px">単価/cs</th>
        <th style="min-width:105px">JANコード</th>
        ${dayLabels.map((lbl, idx) => `<th id="todayModalDayHdr${idx}" style="width:52px">${esc(lbl)}</th>`).join('')}
        <th style="min-width:130px">備考・産地状況</th>
        <th style="width:34px"></th>
      </tr>`;
  } else if (_todayOrderCurrentFormat === 'tsukiji') {
    thead.innerHTML =
      `<tr>
        <th style="width:32px">#</th>
        <th style="width:68px">区分</th>
        <th style="width:68px">産地</th>
        <th style="min-width:180px">品目 <span class="required">*</span></th>
        <th style="width:64px">単位</th>
        ${dayLabels.map((lbl, idx) => `<th id="todayModalDayHdr${idx}">${esc(lbl)}</th>`).join('')}
        <th style="min-width:120px">備考</th>
        <th style="width:42px"></th>
      </tr>`;
  } else if (_todayOrderCurrentFormat === 'props_japan') {
    thead.innerHTML =
      `<tr>
        <th style="width:32px">#</th>
        <th style="width:88px">品番</th>
        <th style="min-width:170px">品名 <span class="required">*</span></th>
        <th style="width:92px">単位 <span class="required">*</span></th>
        <th style="width:72px">ロット</th>
        ${dayLabels.map((lbl, idx) => `<th id="todayModalDayHdr${idx}">${esc(lbl)}</th>`).join('')}
        <th style="width:42px"></th>
      </tr>`;
  } else if (_todayOrderCurrentFormat === 'greenworld') {
    thead.innerHTML =
      `<tr>
        <th style="width:32px">#</th>
        <th style="width:50px">No.</th>
        <th style="min-width:260px">商品名 <span class="required">*</span></th>
        <th style="width:90px">規格</th>
        <th style="width:72px">入数</th>
        <th style="width:85px">ケース数</th>
        <th style="width:90px">価格（CS）</th>
        <th style="width:90px">合計</th>
        <th style="width:42px"></th>
      </tr>`;
  } else if (_todayOrderCurrentFormat === 'rosen') {
    thead.innerHTML =
      `<tr>
        <th style="width:32px">#</th>
        <th style="width:90px">商品コード</th>
        <th style="min-width:200px">商品名 <span class="required">*</span></th>
        <th style="width:60px">入数</th>
        <th style="width:72px">原価</th>
        <th style="width:72px">総数</th>
        ${dayLabels.map((lbl, idx) => `<th id="todayModalDayHdr${idx}">${esc(lbl)}</th>`).join('')}
        <th style="min-width:120px">備考</th>
        <th style="width:42px"></th>
      </tr>`;
  } else if (_todayOrderCurrentFormat === 'worlddelica') {
    thead.innerHTML =
      `<tr>
        <th style="width:32px">#</th>
        <th style="width:90px">納品日</th>
        <th style="min-width:200px">商品名 <span class="required">*</span></th>
        <th style="width:70px">数量</th>
        <th style="width:70px">単位</th>
        <th style="min-width:140px">備考</th>
        <th style="width:42px"></th>
      </tr>`;
  } else if (_todayOrderCurrentFormat === 'santoku') {
    thead.innerHTML =
      `<tr>
        <th style="width:32px">#</th>
        <th style="min-width:160px">商品名 <span class="required">*</span></th>
        <th style="min-width:80px">産地</th>
        <th style="min-width:80px">規格</th>
        ${dayLabels.map((lbl, idx) => `<th id="todayModalDayHdr${idx}" style="width:60px">${esc(lbl)}</th>`).join('')}
        <th style="width:42px"></th>
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
    for (let offset = 0; offset < (_todayFmtCfg().dayCount ?? 6); offset++) {
      const dt = new Date(y, m - 1, d + offset);
      const th = document.getElementById(`todayModalDayHdr${offset}`);
      if (th) th.textContent = `${dt.getMonth() + 1}/${dt.getDate()} (${wdays[dt.getDay()]})`;
    }
  } else {
    const hdr = _todayOrderRows.find(r => r.type === 'header');
    const metaRows = _todayOrderRows.filter(r => r.type === 'meta');
    const startCol = _todayDayStartCol();
    const step = _todayFmtCfg().dayStep || 1;
    if (previewEl) previewEl.textContent = metaRows[1]?.cells?.[0] || '';
    for (let offset = 0; offset < (_todayFmtCfg().dayCount ?? 6); offset++) {
      const th = document.getElementById(`todayModalDayHdr${offset}`);
      const rawHdr = String(hdr?.cells?.[startCol + offset * step] || '').trim();
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
  const isProps = _todayOrderCurrentFormat === 'props_japan';
  const isNationalAzabu = _todayOrderCurrentFormat === 'national_azabu';
  const isTsukiji = _todayOrderCurrentFormat === 'tsukiji';
  const isNanohana = _todayOrderCurrentFormat === 'nanohana';
  const isFusui = _todayOrderCurrentFormat === 'fusui';
  const isRosen = _todayOrderCurrentFormat === 'rosen';
  const data = itemData || {
    category: '', code: '', name: '', origin: '', cultivation: '特別栽培', spec: '', priceP: '', priceCs: '', jan: '',
    division: '',
    unit: isProps ? 'パック' : '', lot: isProps ? '10' : '',
    days: Array(isHaibukiya ? 12 : (isRosen ? 7 : 6)).fill(''), note: ''
  };
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
    inp.value = val != null ? String(val) : '';
    if (listId) inp.setAttribute('list', listId);
    inp.addEventListener('input', () => {
      inp.classList.remove('today-input-error');
      _setTodayModalValMsg('');
    });
    td.appendChild(inp);
    return { td, inp };
  };

  if (isHaibukiya) {
    const { td: catTd }  = makeInput('today-m-cat', '葉物類', data.category || '', 'todayHaibukiyaCatList');
    const { td: nameTd } = makeInput('today-m-name', '品目名', data.name || '');
    const { td: origTd } = makeInput('today-m-origin', '産地', data.origin || '');
    const { td: cultTd } = makeInput('today-m-cult', '特別栽培', data.cultivation != null ? data.cultivation : '特別栽培');
    const { td: specTd } = makeInput('today-m-spec', '150g/5p', data.spec || '');
    const { td: ppTd }   = makeInput('today-m-pricep today-m-num', '165', data.priceP || '');
    const { td: pcsTd }  = makeInput('today-m-pricecs today-m-num', '825', data.priceCs || '');
    const { td: janTd }  = makeInput('today-m-jan', '4514811...', data.jan || '');
    tr.appendChild(catTd);
    tr.appendChild(nameTd);
    tr.appendChild(origTd);
    tr.appendChild(cultTd);
    tr.appendChild(specTd);
    tr.appendChild(ppTd);
    tr.appendChild(pcsTd);
    tr.appendChild(janTd);

    const daysArr = Array.isArray(data.days) ? data.days : [];
    for (let d = 0; d < 6; d++) {
      const qVal = daysArr[d * 2] != null ? String(daysArr[d * 2]) : '';
      const cVal = daysArr[d * 2 + 1] != null ? String(daysArr[d * 2 + 1]) : '';
      const { td: dayTd } = makeInput('today-m-day', '0', qVal);
      const { td: chgTd } = makeInput('today-m-day today-m-day-chg', '', cVal);
      tr.appendChild(dayTd);
      tr.appendChild(chgTd);
    }
    const { td: noteTd } = makeInput('today-m-note', '備考', data.note || '');
    tr.appendChild(noteTd);
  } else if (isNationalAzabu) {
    const { td: catTd }  = makeInput('today-m-cat', '果菜類', data.category || '', 'todayNationalAzabuCatList');
    const { td: nameTd } = makeInput('today-m-name', '品目名', data.name || '');
    const { td: origTd } = makeInput('today-m-origin', '産地', data.origin || '');
    const { td: specTd } = makeInput('today-m-spec', '1本/10p', data.spec || '');
    const { td: ppTd }   = makeInput('today-m-pricep today-m-num', '250', data.priceP || '');
    const { td: pcsTd }  = makeInput('today-m-pricecs today-m-num', '2,500', data.priceCs || '');
    const { td: janTd }  = makeInput('today-m-jan', '4514811...', data.jan || '');
    tr.appendChild(catTd);
    tr.appendChild(nameTd);
    tr.appendChild(origTd);
    tr.appendChild(specTd);
    tr.appendChild(ppTd);
    tr.appendChild(pcsTd);
    tr.appendChild(janTd);

    const daysArr = Array.isArray(data.days) ? data.days : [];
    for (let d = 0; d < 6; d++) {
      const { td: dayTd } = makeInput('today-m-day', '0', daysArr[d] != null ? String(daysArr[d]) : '');
      tr.appendChild(dayTd);
    }
    const { td: noteTd } = makeInput('today-m-note', '備考', data.note || '');
    tr.appendChild(noteTd);
  } else if (isTsukiji) {
    const { td: divTd }  = makeInput('today-m-division', '区分', data.division || '');
    const { td: origTd } = makeInput('today-m-origin', '千葉', data.origin || '千葉');
    const { td: nameTd } = makeInput('today-m-name', '品目名', data.name || '');
    const { td: unitTd } = makeInput('today-m-unit', 'pc/箱', data.unit || '');
    tr.appendChild(divTd);
    tr.appendChild(origTd);
    tr.appendChild(nameTd);
    tr.appendChild(unitTd);

    const daysArr = Array.isArray(data.days) ? data.days : [];
    for (let d = 0; d < 6; d++) {
      const { td: dayTd } = makeInput('today-m-day', '', daysArr[d] != null ? String(daysArr[d]) : '');
      tr.appendChild(dayTd);
    }
    const { td: noteTd } = makeInput('today-m-note', '備考', data.note || '');
    tr.appendChild(noteTd);
  } else if (isNanohana) {
    const { td: orderNoTd } = makeInput('today-m-orderno', 'No.', data.orderNo || '');
    const { td: tokuTd }    = makeInput('today-m-toku', '特価', data.toku || '');
    const { td: nameTd }    = makeInput('today-m-name', '商品名', data.name || '');
    const { td: specTd }    = makeInput('today-m-spec', '規格', data.spec || '');
    const { td: priceTd }   = makeInput('today-m-price today-m-num', '価格', data.price || '');
    const { td: irisuTd }   = makeInput('today-m-irisu today-m-num', '入数', data.irisu || '');
    tr.appendChild(orderNoTd);
    tr.appendChild(tokuTd);
    tr.appendChild(nameTd);
    tr.appendChild(specTd);
    tr.appendChild(priceTd);
    tr.appendChild(irisuTd);
    for (let _di = 0; _di < 5; _di++) {
      const { td: cpTd }  = makeInput('today-m-nana-cp', 'C/P', (data.cp || [])[_di] || '');
      const { td: qtyTd } = makeInput('today-m-nana-qty today-m-num', '総数', (data.qty || [])[_di] || '');
      tr.appendChild(cpTd);
      tr.appendChild(qtyTd);
    }
  } else if (isFusui) {
    const { td: codeTd }   = makeInput('today-m-code', '1029510171', data.code || '');
    const { td: nameTd }   = makeInput('today-m-name', '商品名', data.name || '');
    const { td: specTd }   = makeInput('today-m-spec', '10枚P', data.spec || '');
    const { td: qtyTd }    = makeInput('today-m-qty today-m-num', '100', data.qty || '');
    const { td: priceTd }  = makeInput('today-m-price today-m-num', '125', data.price || '');
    const { td: amountTd } = makeInput('today-m-amount today-m-num', '12,500', data.amount || '');
    tr.appendChild(codeTd);
    tr.appendChild(nameTd);
    tr.appendChild(specTd);
    tr.appendChild(qtyTd);
    tr.appendChild(priceTd);
    tr.appendChild(amountTd);
  } else if (_todayOrderCurrentFormat === 'greenworld') {
    const { td: noTd }     = makeInput('today-m-no', '1', data.no || '');
    const { td: nameTd }   = makeInput('today-m-name', '商品名', data.name || '');
    const { td: specTd }   = makeInput('today-m-spec', '1ケース', data.spec || '');
    const { td: irisuTd }  = makeInput('today-m-irisu today-m-num', '', data.irisu || '');
    const { td: casesTd }  = makeInput('today-m-cases today-m-num', '2', data.cases || '');
    const { td: priceTd }  = makeInput('today-m-price today-m-num', '', data.price || '');
    const { td: totalTd }  = makeInput('today-m-total today-m-num', '', data.total || '');
    tr.appendChild(noTd);
    tr.appendChild(nameTd);
    tr.appendChild(specTd);
    tr.appendChild(irisuTd);
    tr.appendChild(casesTd);
    tr.appendChild(priceTd);
    tr.appendChild(totalTd);
  } else if (isRosen) {
    const { td: codeTd }  = makeInput('today-m-code', '', data.code || '');
    const { td: nameTd }  = makeInput('today-m-name', '商品名', data.name || '');
    const { td: irisuTd } = makeInput('today-m-irisu today-m-num', '', data.irisu || '');
    const { td: costTd }  = makeInput('today-m-cost today-m-num', '', data.cost || '');
    const { td: totalTd } = makeInput('today-m-total today-m-num', '', data.total || '');
    tr.appendChild(codeTd);
    tr.appendChild(nameTd);
    tr.appendChild(irisuTd);
    tr.appendChild(costTd);
    tr.appendChild(totalTd);
    const daysArr = Array.isArray(data.days) ? data.days : [];
    for (let d = 0; d < 7; d++) {
      const { td: dayTd } = makeInput('today-m-day', '', daysArr[d] != null ? String(daysArr[d]) : '');
      tr.appendChild(dayTd);
    }
    const { td: noteTd } = makeInput('today-m-note', '備考', data.note || '');
    tr.appendChild(noteTd);
  } else if (_todayOrderCurrentFormat === 'worlddelica') {
    const { td: dateTd }  = makeInput('today-m-date', '10/25', data.date || '');
    const { td: nameTd }  = makeInput('today-m-name', '商品名', data.name || '');
    const { td: qtyTd }   = makeInput('today-m-qty today-m-num', '', data.qty || '');
    const { td: unitTd }  = makeInput('today-m-unit', '箱/袋', data.unit || '');
    const { td: noteTd }  = makeInput('today-m-note', '備考', data.note || '');
    tr.appendChild(dateTd);
    tr.appendChild(nameTd);
    tr.appendChild(qtyTd);
    tr.appendChild(unitTd);
    tr.appendChild(noteTd);
  } else if (_todayOrderCurrentFormat === 'santoku') {
    const { td: nameTd }  = makeInput('today-m-name', '商品名', data.name || '');
    const { td: origTd }  = makeInput('today-m-origin', '産地', data.origin || '');
    const { td: specTd }  = makeInput('today-m-spec', '規格', data.spec || '');
    tr.appendChild(nameTd);
    tr.appendChild(origTd);
    tr.appendChild(specTd);
    const daysArr = Array.isArray(data.days) ? data.days : [];
    for (let d = 0; d < 6; d++) {
      const { td: dayTd } = makeInput('today-m-day', '', daysArr[d] != null ? String(daysArr[d]) : '');
      tr.appendChild(dayTd);
    }
  } else if (_todayOrderCurrentFormat === 'josoSeikyo') {
    const { td: ocrTd }   = makeInput('today-m-ocr', 'OCR No.', data.ocr || '');
    const { td: nameTd }  = makeInput('today-m-name', '商品名', data.name || '');
    const { td: specTd }  = makeInput('today-m-spec', '規格', data.spec || '');
    const { td: tankaTd } = makeInput('today-m-tanka today-m-num', '単価', data.tanka || '');
    const { td: irisuTd } = makeInput('today-m-irisu today-m-num', '入数', data.irisu || '1');
    const { td: qtyTd }   = makeInput('today-m-qty today-m-num', '発注数', data.qty || '');
    tr.appendChild(ocrTd);
    tr.appendChild(nameTd);
    tr.appendChild(specTd);
    tr.appendChild(tankaTd);
    tr.appendChild(irisuTd);
    tr.appendChild(qtyTd);
  } else {
    if (isProps) {
      const { td: codeTd } = makeInput('today-m-code', '例: Y682', data.code || '');
      tr.appendChild(codeTd);
    }
    const { td: nameTd, inp: nameInp } = makeInput('today-m-name', isProps ? '品名（例: 有機たまねぎ400g）' : '品目名（例: 大根）', data.name || '');
    tr.appendChild(nameTd);

    const unitTd = document.createElement('td');
    const unitInp = document.createElement('input');
    unitInp.type = 'text';
    unitInp.className = 'today-m-input today-m-unit';
    unitInp.setAttribute('list', 'todayItemUnitList');
    unitInp.placeholder = isProps ? 'パック' : '例: cs / 束';
    unitInp.autocomplete = 'off';
    unitInp.value = data.unit || (isProps ? 'パック' : '');

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

    if (isProps) {
      const { td: lotTd } = makeInput('today-m-lot today-m-num', '10', data.lot != null ? data.lot : '');
      tr.appendChild(lotTd);
    }
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
  const isHaibukiya = _todayOrderCurrentFormat === 'haibukiya';
  const isProps = _todayOrderCurrentFormat === 'props_japan';
  const isNationalAzabu = _todayOrderCurrentFormat === 'national_azabu';
  const isTsukiji = _todayOrderCurrentFormat === 'tsukiji';
  const isNanohana = _todayOrderCurrentFormat === 'nanohana';
  const isFusui = _todayOrderCurrentFormat === 'fusui';
  const isGreenworld = _todayOrderCurrentFormat === 'greenworld';
  const presetObj = isHaibukiya
    ? (TODAY_HAIBUKIYA_PRESETS.find(p => p.name === presetName) || { name: presetName, cultivation: '特別栽培', days: Array(12).fill('') })
    : (isNationalAzabu
        ? (TODAY_NATIONAL_AZABU_PRESETS.find(p => p.name === presetName) || { category: '', name: presetName, spec: '', priceP: '', priceCs: '', jan: '', days: Array(6).fill(''), note: '' })
        : (isTsukiji
            ? (TODAY_TSUKIJI_PRESETS.find(p => p.name === presetName) || { division: '', origin: '千葉', name: presetName, unit: 'pc', days: Array(6).fill(''), note: '' })
            : (isProps
                ? (TODAY_PROPS_PRESETS.find(p => p.name === presetName) || { code: '', name: presetName, unit: 'パック', lot: '10', days: Array(6).fill('') })
                : (isNanohana
                    ? (TODAY_NANOHANA_PRESETS.find(p => p.name === presetName) || { orderNo: '', toku: '', name: presetName, spec: '', price: '', irisu: '', cp: ['','','','',''], qty: ['','','','',''] })
                    : (isFusui
                        ? (TODAY_FUSUI_PRESETS.find(p => p.name === presetName) || { code: '', name: presetName, spec: '', qty: '', price: '', amount: '' })
                        : (isGreenworld
                            ? (TODAY_GREENWORLD_PRESETS.find(p => p.name === presetName) || { no: '', name: presetName, spec: '', irisu: '', cases: '', price: '', total: '' })
                             : (_todayOrderCurrentFormat === 'rosen'
                                 ? (TODAY_ROSEN_PRESETS.find(p => p.name === presetName) || { code: '', name: presetName, irisu: '', cost: '', total: '', days: Array(7).fill(''), note: '' })
                                 : (_todayOrderCurrentFormat === 'worlddelica'
                                     ? (TODAY_WORLDDELICA_PRESETS.find(p => p.name === presetName) || { date: '', name: presetName, qty: '', unit: '', note: '' })
                                     : (_todayOrderCurrentFormat === 'santoku'
                                         ? (TODAY_SANTOKU_PRESETS.find(p => p.name === presetName) || { name: presetName, origin: '', spec: '', days: Array(6).fill('') })
                                         : (_todayOrderCurrentFormat === 'josoSeikyo'
                                             ? (TODAY_JOSO_PRESETS.find(p => p.name === presetName) || { ocr: '', name: presetName, spec: '', tanka: '', irisu: '1' })
                                             : { name: presetName, unit: '', days: Array(6).fill('') }))))))))));
  const emptyRow = Array.from(tbody.children).find(tr => {
    const inp = tr.querySelector('.today-m-name');
    return inp && !inp.value.trim();
  });
  if (emptyRow) {
    if (isHaibukiya) {
      if (emptyRow.querySelector('.today-m-cat')) emptyRow.querySelector('.today-m-cat').value = presetObj.category || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-origin')) emptyRow.querySelector('.today-m-origin').value = presetObj.origin || '';
      if (emptyRow.querySelector('.today-m-cult')) emptyRow.querySelector('.today-m-cult').value = presetObj.cultivation || '特別栽培';
      if (emptyRow.querySelector('.today-m-spec')) emptyRow.querySelector('.today-m-spec').value = presetObj.spec || '';
      if (emptyRow.querySelector('.today-m-pricep')) emptyRow.querySelector('.today-m-pricep').value = presetObj.priceP || '';
      if (emptyRow.querySelector('.today-m-pricecs')) emptyRow.querySelector('.today-m-pricecs').value = presetObj.priceCs || '';
      if (emptyRow.querySelector('.today-m-jan')) emptyRow.querySelector('.today-m-jan').value = presetObj.jan || '';
      const dayInps = Array.from(emptyRow.querySelectorAll('.today-m-day'));
      dayInps.forEach((inp, idx) => { inp.value = (presetObj.days && presetObj.days[idx]) || ''; });
      if (emptyRow.querySelector('.today-m-note')) emptyRow.querySelector('.today-m-note').value = presetObj.note || '';
      dayInps[0]?.focus();
    } else if (isNationalAzabu) {
      if (emptyRow.querySelector('.today-m-cat')) emptyRow.querySelector('.today-m-cat').value = presetObj.category || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-origin')) emptyRow.querySelector('.today-m-origin').value = presetObj.origin || '';
      if (emptyRow.querySelector('.today-m-spec')) emptyRow.querySelector('.today-m-spec').value = presetObj.spec || '';
      if (emptyRow.querySelector('.today-m-pricep')) emptyRow.querySelector('.today-m-pricep').value = presetObj.priceP || '';
      if (emptyRow.querySelector('.today-m-pricecs')) emptyRow.querySelector('.today-m-pricecs').value = presetObj.priceCs || '';
      if (emptyRow.querySelector('.today-m-jan')) emptyRow.querySelector('.today-m-jan').value = presetObj.jan || '';
      const dayInps = Array.from(emptyRow.querySelectorAll('.today-m-day'));
      dayInps.forEach((inp, idx) => { inp.value = (presetObj.days && presetObj.days[idx]) || ''; });
      if (emptyRow.querySelector('.today-m-note')) emptyRow.querySelector('.today-m-note').value = presetObj.note || '';
      dayInps[0]?.focus();
    } else if (isTsukiji) {
      if (emptyRow.querySelector('.today-m-division')) emptyRow.querySelector('.today-m-division').value = presetObj.division || '';
      if (emptyRow.querySelector('.today-m-origin')) emptyRow.querySelector('.today-m-origin').value = presetObj.origin || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-unit')) emptyRow.querySelector('.today-m-unit').value = presetObj.unit || '';
      const dayInps = Array.from(emptyRow.querySelectorAll('.today-m-day'));
      dayInps.forEach((inp, idx) => { inp.value = (presetObj.days && presetObj.days[idx]) || ''; });
      if (emptyRow.querySelector('.today-m-note')) emptyRow.querySelector('.today-m-note').value = presetObj.note || '';
      dayInps[0]?.focus();
    } else if (isProps) {
      if (emptyRow.querySelector('.today-m-code')) emptyRow.querySelector('.today-m-code').value = presetObj.code || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-unit')) emptyRow.querySelector('.today-m-unit').value = presetObj.unit || 'パック';
      if (emptyRow.querySelector('.today-m-lot')) emptyRow.querySelector('.today-m-lot').value = presetObj.lot || '10';
      const dayInps = Array.from(emptyRow.querySelectorAll('.today-m-day'));
      dayInps.forEach((inp, idx) => { inp.value = (presetObj.days && presetObj.days[idx]) || ''; });
      (dayInps[0] || emptyRow.querySelector('.today-m-name'))?.focus();
    } else if (isNanohana) {
      if (emptyRow.querySelector('.today-m-orderno')) emptyRow.querySelector('.today-m-orderno').value = presetObj.orderNo || '';
      if (emptyRow.querySelector('.today-m-toku')) emptyRow.querySelector('.today-m-toku').value = presetObj.toku || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-spec')) emptyRow.querySelector('.today-m-spec').value = presetObj.spec || '';
      if (emptyRow.querySelector('.today-m-price')) emptyRow.querySelector('.today-m-price').value = presetObj.price || '';
      if (emptyRow.querySelector('.today-m-irisu')) emptyRow.querySelector('.today-m-irisu').value = presetObj.irisu || '';
      const _cpInps = emptyRow.querySelectorAll('.today-m-nana-cp');
      const _qtyInps = emptyRow.querySelectorAll('.today-m-nana-qty');
      (presetObj.cp || []).forEach((v, i) => { if (_cpInps[i]) _cpInps[i].value = v; });
      (presetObj.qty || []).forEach((v, i) => { if (_qtyInps[i]) _qtyInps[i].value = v; });
      emptyRow.querySelector('.today-m-name')?.focus();
    } else if (isFusui) {
      if (emptyRow.querySelector('.today-m-code')) emptyRow.querySelector('.today-m-code').value = presetObj.code || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-spec')) emptyRow.querySelector('.today-m-spec').value = presetObj.spec || '';
      if (emptyRow.querySelector('.today-m-qty')) emptyRow.querySelector('.today-m-qty').value = presetObj.qty || '';
      if (emptyRow.querySelector('.today-m-price')) emptyRow.querySelector('.today-m-price').value = presetObj.price || '';
      if (emptyRow.querySelector('.today-m-amount')) emptyRow.querySelector('.today-m-amount').value = presetObj.amount || '';
      (emptyRow.querySelector('.today-m-qty') || emptyRow.querySelector('.today-m-name'))?.focus();
    } else if (isGreenworld) {
      if (emptyRow.querySelector('.today-m-no')) emptyRow.querySelector('.today-m-no').value = presetObj.no || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-spec')) emptyRow.querySelector('.today-m-spec').value = presetObj.spec || '';
      if (emptyRow.querySelector('.today-m-irisu')) emptyRow.querySelector('.today-m-irisu').value = presetObj.irisu || '';
      if (emptyRow.querySelector('.today-m-cases')) emptyRow.querySelector('.today-m-cases').value = presetObj.cases || '';
      if (emptyRow.querySelector('.today-m-price')) emptyRow.querySelector('.today-m-price').value = presetObj.price || '';
      if (emptyRow.querySelector('.today-m-total')) emptyRow.querySelector('.today-m-total').value = presetObj.total || '';
      (emptyRow.querySelector('.today-m-cases') || emptyRow.querySelector('.today-m-name'))?.focus();
    } else if (_todayOrderCurrentFormat === 'rosen') {
      if (emptyRow.querySelector('.today-m-code')) emptyRow.querySelector('.today-m-code').value = presetObj.code || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-irisu')) emptyRow.querySelector('.today-m-irisu').value = presetObj.irisu || '';
      if (emptyRow.querySelector('.today-m-cost')) emptyRow.querySelector('.today-m-cost').value = presetObj.cost || '';
      if (emptyRow.querySelector('.today-m-total')) emptyRow.querySelector('.today-m-total').value = presetObj.total || '';
      const dayInps = Array.from(emptyRow.querySelectorAll('.today-m-day'));
      dayInps.forEach((inp, idx) => { inp.value = (presetObj.days && presetObj.days[idx]) || ''; });
      (dayInps[0] || emptyRow.querySelector('.today-m-name'))?.focus();
    } else if (_todayOrderCurrentFormat === 'worlddelica') {
      if (emptyRow.querySelector('.today-m-date')) emptyRow.querySelector('.today-m-date').value = presetObj.date || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-qty')) emptyRow.querySelector('.today-m-qty').value = presetObj.qty || '';
      if (emptyRow.querySelector('.today-m-unit')) emptyRow.querySelector('.today-m-unit').value = presetObj.unit || '';
      if (emptyRow.querySelector('.today-m-note')) emptyRow.querySelector('.today-m-note').value = presetObj.note || '';
      (emptyRow.querySelector('.today-m-qty') || emptyRow.querySelector('.today-m-name'))?.focus();
    } else if (_todayOrderCurrentFormat === 'santoku') {
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-origin')) emptyRow.querySelector('.today-m-origin').value = presetObj.origin || '';
      if (emptyRow.querySelector('.today-m-spec')) emptyRow.querySelector('.today-m-spec').value = presetObj.spec || '';
      const dayInps = Array.from(emptyRow.querySelectorAll('.today-m-day'));
      dayInps.forEach((inp, idx) => { inp.value = (presetObj.days && presetObj.days[idx]) || ''; });
      dayInps[0]?.focus();
    } else if (_todayOrderCurrentFormat === 'josoSeikyo') {
      if (emptyRow.querySelector('.today-m-ocr')) emptyRow.querySelector('.today-m-ocr').value = presetObj.ocr || '';
      emptyRow.querySelector('.today-m-name').value = presetObj.name || '';
      if (emptyRow.querySelector('.today-m-spec')) emptyRow.querySelector('.today-m-spec').value = presetObj.spec || '';
      if (emptyRow.querySelector('.today-m-tanka')) emptyRow.querySelector('.today-m-tanka').value = presetObj.tanka || '';
      if (emptyRow.querySelector('.today-m-irisu')) emptyRow.querySelector('.today-m-irisu').value = presetObj.irisu || '1';
      (emptyRow.querySelector('.today-m-qty') || emptyRow.querySelector('.today-m-name'))?.focus();
    } else {
      emptyRow.querySelector('.today-m-name').value = presetName;
      emptyRow.querySelector('.today-m-unit')?.focus();
    }
    return;
  }
  const newTr = _appendTodayModalItemRow({ ...presetObj, days: [...(presetObj.days || [])] });
  (newTr?.querySelector('.today-m-unit') || newTr?.querySelector('.today-m-day'))?.focus();
}

function openTodayOrderItemModal(rowIdx = null, presetName = '', options = {}) {
  const backdrop = document.getElementById('todayOrderItemModalBackdrop');
  if (!backdrop) return;
  _todayOrderEditRowIdx = rowIdx;
  const isHaibukiya = _todayOrderCurrentFormat === 'haibukiya';
  const isProps = _todayOrderCurrentFormat === 'props_japan';
  const isNationalAzabu = _todayOrderCurrentFormat === 'national_azabu';
  const isTsukiji = _todayOrderCurrentFormat === 'tsukiji';
  const isNanohana = _todayOrderCurrentFormat === 'nanohana';
  const isFusui = _todayOrderCurrentFormat === 'fusui';
  const isGreenworld = _todayOrderCurrentFormat === 'greenworld';
  const isRosen = _todayOrderCurrentFormat === 'rosen';
  const isWorldDelica = _todayOrderCurrentFormat === 'worlddelica';
  const isSantoku = _todayOrderCurrentFormat === 'santoku';
  const isJosoSeikyo = _todayOrderCurrentFormat === 'josoSeikyo';

  const modalBox = backdrop.querySelector('.modal-box');
  if (modalBox) {
    modalBox.classList.toggle('today-modal-box-haibukiya', isHaibukiya);
    modalBox.classList.toggle('today-modal-box-national-azabu', isNationalAzabu);
  }

  const hintEl = document.getElementById('todayModalHint');
  if (hintEl) {
    hintEl.textContent = isHaibukiya
      ? '※ 品目名・産地・栽培区分・単価等を入力して保存すると、指定カテゴリ配下に全20列で反映されます（数量は「6→1」表記も可）。'
      : (isNationalAzabu
          ? '※ 品目名・産地・単価等を入力して保存すると、指定カテゴリ配下に13列で反映されます。発注数はケース（cs）単位。'
          : (isTsukiji
              ? '※ 区分（レア / 風か様 等）・産地・品目名・単位・日別数量（または休止）・備考を入力してください。'
              : (isProps
                  ? '※ 品番・品名・単位（パック 等）・ロット・発注数を入力してください。'
                  : (isNanohana
                      ? '※ 注文No.・商品名・規格容量・納入価格・総数（P）・金額を入力してください。'
                      : (isFusui
                          ? '※ 商品コード・商品名・規格・数量・単価・金額を入力してください。'
                          : (isGreenworld
                              ? '※ No.・商品名・規格・入数・ケース数・価格・合計を入力してください。'
                              : (isRosen
                                  ? '※ 商品コード・商品名・入数・原価・総数・7日分の発注数・備考を入力してください。'
                                  : (isWorldDelica
                                      ? '※ 納品日・商品名・数量・単位・備考を入力してください。'
                                      : (isSantoku
                                          ? '※ 商品名・産地・規格・日別数量を入力してください。総計は自動計算されます。'
                                          : (isJosoSeikyo
                                              ? '※ OCR No.・商品名・規格・単価・入数・発注数を入力してください。納品数・金額は自動計算されます。'
                                              : '※ 品目名と単位（cs, p, kg, 束, 袋, 箱, 本, 個 など）は必須です。'))))))))));
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
          cultivation: row.cells[2] || '特別栽培',
          spec: row.cells[3] || '',
          priceP: row.cells[4] || '',
          priceCs: row.cells[5] || '',
          jan: row.cells[6] || '',
          days: row.cells.slice(7, 19),
          note: row.cells[19] || '',
        })
      : (isNationalAzabu
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
          : (isTsukiji
              ? _appendTodayModalItemRow({
                  division: row.cells[0] || '',
                  origin: row.cells[1] || '',
                  name: row.cells[2] || '',
                  unit: row.cells[3] || '',
                  days: row.cells.slice(4, 10),
                  note: row.cells[10] || '',
                })
              : (isProps
                  ? _appendTodayModalItemRow({
                      code: row.cells[0] || '',
                      name: row.cells[1] || '',
                      unit: row.cells[2] || '',
                      lot: row.cells[3] || '',
                      days: row.cells.slice(4, 10),
                    })
                  : (isNanohana
                      ? _appendTodayModalItemRow({
                          orderNo: row.cells[0] || '',
                          toku:    row.cells[1] || '',
                          name:    row.cells[2] || '',
                          spec:    row.cells[3] || '',
                          price:   row.cells[4] || '',
                          irisu:   row.cells[5] || '',
                          cp:  [0,1,2,3,4].map(i => row.cells[6 + i*2] || ''),
                          qty: [0,1,2,3,4].map(i => row.cells[7 + i*2] || ''),
                        })
                      : (isFusui
                          ? _appendTodayModalItemRow({
                              code: row.cells[0] || '',
                              name: row.cells[1] || '',
                              spec: row.cells[2] || '',
                              qty: row.cells[3] || '',
                              price: row.cells[4] || '',
                              amount: row.cells[5] || '',
                            })
                          : (isGreenworld
                              ? _appendTodayModalItemRow({
                                  no: row.cells[0] || '',
                                  name: row.cells[1] || '',
                                  spec: row.cells[2] || '',
                                  irisu: row.cells[3] || '',
                                  cases: row.cells[4] || '',
                                  price: row.cells[5] || '',
                                  total: row.cells[6] || '',
                                })
                              : (isRosen
                                  ? _appendTodayModalItemRow({
                                      code: row.cells[0] || '',
                                      name: row.cells[1] || '',
                                      irisu: row.cells[2] || '',
                                      cost: row.cells[3] || '',
                                      total: row.cells[4] || '',
                                      days: row.cells.slice(5, 12),
                                      note: row.cells[12] || '',
                                    })
                                  : (isWorldDelica
                                      ? _appendTodayModalItemRow({
                                          date: row.cells[0] || '',
                                          name: row.cells[1] || '',
                                          qty: row.cells[2] || '',
                                          unit: row.cells[3] || '',
                                          note: row.cells[4] || '',
                                        })
                                      : (isSantoku
                                          ? _appendTodayModalItemRow({
                                              name: row.cells[0] || '',
                                              origin: row.cells[1] || '',
                                              spec: row.cells[2] || '',
                                              days: row.cells.slice(3, 9),
                                            })
                                          : (isJosoSeikyo
                                              ? _appendTodayModalItemRow({
                                                  ocr: row.cells[0] || '',
                                                  name: row.cells[1] || '',
                                                  spec: row.cells[2] || '',
                                                  tanka: row.cells[4] || '',
                                                  irisu: row.cells[5] || '',
                                                  qty: row.cells[6] || '',
                                                })
                                              : _appendTodayModalItemRow({
                                                  name: row.cells[0] || '',
                                                  unit: row.cells[1] || '',
                                                  days: row.cells.slice(2, 8),
                                                })))))))))));
    if (delBtn) delBtn.classList.remove('hidden');
    focusEl = tr?.querySelector('.today-m-name');
  } else if (options.fillAllPresets) {
    if (titleEl) titleEl.textContent = '複数品目を一括追加（全列入力）';
    if (isHaibukiya) {
      TODAY_HAIBUKIYA_PRESETS.forEach((p, idx) => {
        const tr = _appendTodayModalItemRow({ ...p, days: [...p.days] });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-name');
      });
    } else if (isNationalAzabu) {
      TODAY_NATIONAL_AZABU_PRESETS.forEach((p, idx) => {
        const tr = _appendTodayModalItemRow({ ...p, days: [...p.days] });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-name');
      });
    } else if (isTsukiji) {
      TODAY_TSUKIJI_PRESETS.forEach((p, idx) => {
        const tr = _appendTodayModalItemRow({ ...p });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-name');
      });
    } else if (isProps) {
      TODAY_PROPS_PRESETS.forEach((p, idx) => {
        const tr = _appendTodayModalItemRow({ ...p });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-day');
      });
    } else if (isRosen) {
      TODAY_ROSEN_PRESETS.forEach((p, idx) => {
        const tr = _appendTodayModalItemRow({ ...p, days: [...(p.days || Array(7).fill(''))] });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-name');
      });
    } else if (isWorldDelica) {
      TODAY_WORLDDELICA_PRESETS.forEach((p, idx) => {
        const tr = _appendTodayModalItemRow({ ...p });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-qty');
      });
    } else if (isSantoku) {
      TODAY_SANTOKU_PRESETS.forEach((p, idx) => {
        const tr = _appendTodayModalItemRow({ ...p, days: [...p.days] });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-day');
      });
    } else if (isJosoSeikyo) {
      TODAY_JOSO_PRESETS.forEach((p, idx) => {
        const tr = _appendTodayModalItemRow({ ...p });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-qty');
      });
    } else {
      TODAY_PRESET_ITEMS.forEach((pName, idx) => {
        const tr = _appendTodayModalItemRow({ name: pName, unit: '', days: Array(6).fill('') });
        if (idx === 0) focusEl = tr?.querySelector('.today-m-unit');
      });
    }
    if (delBtn) delBtn.classList.add('hidden');
  } else {
    if (titleEl) titleEl.textContent = '発注品目を追加（複数品目・全列設定）';
    const defCat = options.defaultCategory || '';
    if (presetName) {
      if (isHaibukiya) {
        const pObj = TODAY_HAIBUKIYA_PRESETS.find(p => p.name === presetName) || { category: defCat, name: presetName, cultivation: '特別栽培', days: Array(12).fill('') };
        const tr1 = _appendTodayModalItemRow({ ...pObj, days: [...(pObj.days || Array(12).fill(''))] });
        _appendTodayModalItemRow({ category: pObj.category || defCat, name: '', cultivation: '特別栽培', days: Array(12).fill('') });
        focusEl = tr1?.querySelector('.today-m-name');
      } else if (isNationalAzabu) {
        const pObj = TODAY_NATIONAL_AZABU_PRESETS.find(p => p.name === presetName) || { category: defCat, name: presetName, spec: '', priceP: '', priceCs: '', jan: '', days: Array(6).fill(''), note: '' };
        const tr1 = _appendTodayModalItemRow({ ...pObj, days: [...(pObj.days || Array(6).fill(''))] });
        _appendTodayModalItemRow({ category: pObj.category || defCat, name: '', spec: '', priceP: '', priceCs: '', jan: '', days: Array(6).fill(''), note: '' });
        focusEl = tr1?.querySelector('.today-m-name');
      } else if (isTsukiji) {
        const pObj = TODAY_TSUKIJI_PRESETS.find(p => p.name === presetName) || { division: '', origin: '千葉', name: presetName, unit: 'pc', days: Array(6).fill(''), note: '' };
        const tr1 = _appendTodayModalItemRow({ ...pObj });
        _appendTodayModalItemRow({ division: '', origin: '千葉', name: '', unit: 'pc', days: Array(6).fill(''), note: '' });
        focusEl = tr1?.querySelector('.today-m-day');
      } else if (isProps) {
        const pObj = TODAY_PROPS_PRESETS.find(p => p.name === presetName) || { code: '', name: presetName, unit: 'パック', lot: '10', days: Array(6).fill('') };
        const tr1 = _appendTodayModalItemRow({ ...pObj, days: [...(pObj.days || Array(6).fill(''))] });
        _appendTodayModalItemRow();
        focusEl = tr1?.querySelector('.today-m-day');
      } else if (isRosen) {
        const pObj = TODAY_ROSEN_PRESETS.find(p => p.name === presetName) || { code: '', name: presetName, irisu: '', cost: '', total: '', days: Array(7).fill(''), note: '' };
        const tr1 = _appendTodayModalItemRow({ ...pObj, days: [...(pObj.days || Array(7).fill(''))] });
        _appendTodayModalItemRow({ code: '', name: '', irisu: '', cost: '', total: '', days: Array(7).fill(''), note: '' });
        focusEl = tr1?.querySelector('.today-m-name');
      } else if (isWorldDelica) {
        const pObj = TODAY_WORLDDELICA_PRESETS.find(p => p.name === presetName) || { date: '', name: presetName, qty: '', unit: '', note: '' };
        const tr1 = _appendTodayModalItemRow({ ...pObj });
        _appendTodayModalItemRow({ date: '', name: '', qty: '', unit: '', note: '' });
        focusEl = tr1?.querySelector('.today-m-qty');
      } else if (isSantoku) {
        const pObj = TODAY_SANTOKU_PRESETS.find(p => p.name === presetName) || { name: presetName, origin: '', spec: '', days: Array(6).fill('') };
        const tr1 = _appendTodayModalItemRow({ ...pObj, days: [...(pObj.days || Array(6).fill(''))] });
        _appendTodayModalItemRow({ name: '', origin: '', spec: '', days: Array(6).fill('') });
        focusEl = tr1?.querySelector('.today-m-day');
      } else if (isJosoSeikyo) {
        const pObj = TODAY_JOSO_PRESETS.find(p => p.name === presetName) || { ocr: '', name: presetName, spec: '', tanka: '', irisu: '1' };
        const tr1 = _appendTodayModalItemRow({ ...pObj });
        _appendTodayModalItemRow({ ocr: '', name: '', spec: '', tanka: '', irisu: '1', qty: '' });
        focusEl = tr1?.querySelector('.today-m-qty');
      } else {
        const tr1 = _appendTodayModalItemRow({ name: presetName, unit: '', days: Array(6).fill('') });
        _appendTodayModalItemRow();
        focusEl = tr1?.querySelector('.today-m-unit');
      }
    } else {
      const naBlank = { category: defCat, name: '', spec: '', priceP: '', priceCs: '', jan: '', days: Array(6).fill(''), note: '' };
      const tsukijiBlank = { division: '', origin: '千葉', name: '', unit: '', days: Array(6).fill(''), note: '' };
      const nanohanaBlank = { orderNo: '', toku: '', name: '', spec: '', price: '', irisu: '', cp: ['','','','',''], qty: ['','','','',''] };
      const fusuiBlank = { code: '', name: '', spec: '', qty: '', price: '', amount: '' };
      const worlddelicaBlank = { date: '', name: '', qty: '', unit: '', note: '' };
      const rosenBlank = { code: '', name: '', irisu: '', cost: '', total: '', days: Array(7).fill(''), note: '' };
      const santokuBlank = { name: '', origin: '', spec: '', days: Array(6).fill('') };
      const josoBlank = { ocr: '', name: '', spec: '', tanka: '', irisu: '1', qty: '' };
      const blankObj = isNationalAzabu ? naBlank : (isTsukiji ? tsukijiBlank : (isNanohana ? nanohanaBlank : (isFusui ? fusuiBlank : (isWorldDelica ? worlddelicaBlank : (isRosen ? rosenBlank : (isSantoku ? santokuBlank : (isJosoSeikyo ? josoBlank : { category: defCat, name: '', cultivation: '特別栽培', unit: isProps ? 'パック' : '', lot: isProps ? '10' : '', days: Array(isHaibukiya ? 12 : 6).fill('') })))))));
      const tr1 = _appendTodayModalItemRow(blankObj);
      _appendTodayModalItemRow({ ...blankObj });
      _appendTodayModalItemRow({ ...blankObj });
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
  if (rowObj.type === 'title' || rowObj.type === 'header' || rowObj.type === 'header_top' || rowObj.type === 'header_sub') {
    showToast('タイトル行・見出し行は削除できません', true);
    return;
  }
  const label = rowObj.cells[0] ? `「${rowObj.cells[0]}」` : `行 ${ri + 1}`;
  if (!skipConfirm && !(await showConfirmToast(`${label} を削除しますか？`))) return;

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
  const isProps = _todayOrderCurrentFormat === 'props_japan';
  const isNationalAzabu = _todayOrderCurrentFormat === 'national_azabu';
  const isTsukiji = _todayOrderCurrentFormat === 'tsukiji';
  const isNanohana = _todayOrderCurrentFormat === 'nanohana';
  const isFusui = _todayOrderCurrentFormat === 'fusui';
  const isGreenworld = _todayOrderCurrentFormat === 'greenworld';
  const isRosen = _todayOrderCurrentFormat === 'rosen';
  const isWorldDelica = _todayOrderCurrentFormat === 'worlddelica';
  const isSantoku = _todayOrderCurrentFormat === 'santoku';
  const isJoso = _todayOrderCurrentFormat === 'josoSeikyo';
  const ncols = _todayColCount();

  _updateTodayOrderHeaderBadges();
  const inlineDateEl = document.getElementById('todayOrderInlineDate');
  if (inlineDateEl) inlineDateEl.value = _extractTodayBaseIsoDate();

  const rows = _todayOrderRows;
  const colLetters = Array.from({ length: ncols }, (_, i) => _colLetter(i));
  const cellMatrix = [];
  const rowNumCells = [];
  const trList = [];
  let selectedTd = null;
  let selectedColIdx = -1;
  let selectedRowIdx = -1;

  const table = document.createElement('table');
  table.className = 'xls-table today-xls-table' + (isHaibukiya ? ' format-haibukiya' : (isNationalAzabu ? ' format-national-azabu' : (isTsukiji ? ' format-tsukiji' : (isProps ? ' format-props-japan' : (isNanohana ? ' format-nanohana' : (isFusui ? ' format-fusui' : (isGreenworld ? ' format-greenworld' : (isRosen ? ' format-rosen' : (isWorldDelica ? ' format-worlddelica' : (isSantoku ? ' format-santoku' : (isJoso ? ' format-joso' : '')))))))))));

  const colgroup = document.createElement('colgroup');
  const rnCol = document.createElement('col');
  rnCol.className = 'today-col-rn';
  colgroup.appendChild(rnCol);
  for (let ci = 0; ci < ncols; ci++) {
    const colEl = document.createElement('col');
    if (isHaibukiya) {
      if (ci >= 7 && ci <= 18) {
        colEl.className = (ci % 2 === 1) ? 'today-col-h-day' : 'today-col-h-chg';
      } else {
        colEl.className = `today-col-h-${ci}`;
      }
    } else if (isNationalAzabu) {
      if (ci >= 6 && ci <= 11) colEl.className = 'today-col-na-day';
      else colEl.className = `today-col-na-${ci}`;
    } else if (isTsukiji) {
      if (ci >= 4 && ci <= 9) colEl.className = 'today-col-tsukiji-day';
      else colEl.className = `today-col-t-${ci}`;
    } else if (isProps) {
      colEl.className = ci >= 4 ? 'today-col-p-day' : `today-col-p-${ci}`;
    } else if (isNanohana) {
      colEl.className = `today-col-nanohana-${ci}`;
    } else if (isFusui) {
      colEl.className = `today-col-fusui-${ci}`;
    } else if (isGreenworld) {
      colEl.className = `today-col-gw-${ci}`;
    } else if (isRosen) {
      colEl.className = `today-col-rs-${ci}`;
    } else if (isWorldDelica) {
      colEl.className = `today-col-wd-${ci}`;
    } else if (isSantoku) {
      colEl.className = ci >= 3 && ci <= 8 ? 'today-col-st-day' : `today-col-st-${ci}`;
    } else if (isJoso) {
      colEl.className = `today-col-joso-${ci}`;
    } else {
      colEl.className = ci === 0 ? 'today-col-a' : (ci === 1 ? 'today-col-1' : 'today-col-other');
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
      const hCls = (ci >= 7 && ci <= 18)
        ? ((ci % 2 === 1) ? 'today-th-h-day' : 'today-th-h-chg')
        : `today-th-h-${ci}`;
      th.className = 'xls-th-col ' + hCls;
    } else if (isNationalAzabu) {
      th.className = 'xls-th-col ' + (ci >= 6 && ci <= 11 ? 'today-th-na-day' : `today-th-na-${ci}`);
    } else if (isTsukiji) {
      th.className = 'xls-th-col ' + (ci >= 4 && ci <= 9 ? 'today-th-tsukiji-day' : `today-th-t-${ci}`);
    } else if (isProps) {
      th.className = 'xls-th-col ' + (ci >= 4 ? 'today-th-p-day' : `today-th-p-${ci}`);
    } else if (isNanohana) {
      th.className = `xls-th-col today-th-nanohana-${ci}`;
    } else if (isFusui) {
      th.className = `xls-th-col today-th-fusui-${ci}`;
    } else if (isGreenworld) {
      th.className = `xls-th-col today-th-gw-${ci}`;
    } else if (isRosen) {
      th.className = `xls-th-col today-th-rs-${ci}`;
    } else if (isWorldDelica) {
      th.className = `xls-th-col today-th-wd-${ci}`;
    } else if (isSantoku) {
      th.className = `xls-th-col today-th-st-${ci}`;
    } else if (isJoso) {
      th.className = `xls-th-col today-th-joso-${ci}`;
    } else {
      th.className = 'xls-th-col ' + (ci === 0 ? 'today-th-col-a' : (ci === 1 ? 'today-th-col-1' : 'today-th-col-other'));
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
      if (selectedRowIdx >= 0) {
        rowNumCells[selectedRowIdx]?.classList.remove('xls-row-sel');
        trList[selectedRowIdx]?.classList.remove('xls-row-active');
      }
    }

    selectedRowIdx = ri;
    selectedColIdx = ci;
    selectedTd = cellMatrix[ri]?.[ci] || null;
    _todayOrderSelRow = ri;
    _todayOrderSelCol = ci;

    selectedTd?.classList.add('xls-sel');
    colHeaders[ci]?.classList.add('xls-col-sel');
    rowNumCells[ri]?.classList.add('xls-row-sel');
    trList[ri]?.classList.add('xls-row-active');

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
    const unitColIdx = isProps ? 2 : (isTsukiji ? 3 : 1);
    const nameColIdx = (isProps || isRosen) ? 1 : (isTsukiji ? 2 : 0);
    const isUnitCell = !isHaibukiya && !isNationalAzabu && !isNanohana && !isFusui && !isGreenworld && !isRosen && !isWorldDelica && !isSantoku && !isJoso && ci === unitColIdx && (rowObj.type === 'item' || String(rowObj.cells[nameColIdx] || '').trim());
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
    if (rowObj.type === 'data' && finalVal.trim() && ci === nameColIdx) {
      rowObj.type = 'item';
    }
    const td = cellMatrix[ri]?.[ci];
    if (td && !td.classList.contains('xls-editing')) {
      const colClass = isHaibukiya
        ? ` today-td-h-${ci}`
        : (isNationalAzabu
            ? (ci >= 6 && ci <= 11 ? ' today-td-na-day' : ` today-td-na-${ci}`)
            : (isTsukiji
                ? (ci >= 4 && ci <= 9 ? ' today-td-tsukiji-day' : ` today-td-t-${ci}`)
                : (isProps
                    ? (ci >= 4 ? ' today-td-p-day' : ` today-td-p-${ci}`)
                    : (isNanohana
                        ? ` today-td-nanohana-${ci}`
                        : (isFusui
                            ? ` today-td-fusui-${ci}`
                            : (isGreenworld
                                ? ` today-td-gw-${ci}`
                                : (isRosen
                                    ? ` today-td-rs-${ci}`
                                    : (isWorldDelica
                                        ? ` today-td-wd-${ci}`
                                        : (isSantoku
                                            ? ` today-td-st-${ci}`
                                            : (isJoso
                                                ? ` today-td-joso-${ci}`
                                                : (ci === 0 ? ' today-td-col-a' : (ci === 1 ? ' today-td-col-1' : ` today-td-col-${ci}`))))))))))))
      td.className = _getTodayRowCellClass(rowObj, ci, finalVal) + colClass + (selectedRowIdx === ri && selectedColIdx === ci ? ' xls-sel' : '');
      td.textContent = finalVal;
      td.title = finalVal;
    }
    if (isJoso && rowObj.type === 'item' && ci === 6) {
      const tanka = parseFloat(String(rowObj.cells[4] || '').replace(/,/g, '')) || 0;
      const hatchu = parseFloat(String(rowObj.cells[6] || '').replace(/,/g, '')) || 0;
      const nouhin = hatchu > 0 ? String(hatchu) : '';
      const kin = (tanka > 0 && hatchu > 0) ? (tanka * hatchu).toLocaleString('ja-JP') : '';
      rowObj.cells[3] = nouhin;
      rowObj.cells[7] = kin;
      const nd = cellMatrix[ri]?.[3];
      if (nd && !nd.classList.contains('xls-editing')) { nd.textContent = nouhin; nd.title = nouhin; }
      const kd = cellMatrix[ri]?.[7];
      if (kd && !kd.classList.contains('xls-editing')) { kd.textContent = kin; kd.title = kin; }
      const totRow = rows.find(r => r.type === 'merged' && String(r.cells[0] || '').trim() === '合計');
      if (totRow) {
        const tIdx = rows.indexOf(totRow);
        const sumH = rows.filter(r => r.type === 'item').reduce((s, r) => s + (parseFloat(String(r.cells[6] || '').replace(/,/g, '')) || 0), 0);
        const sumK = rows.filter(r => r.type === 'item').reduce((s, r) => s + (parseFloat(String(r.cells[7] || '').replace(/,/g, '')) || 0), 0);
        totRow.cells[6] = sumH > 0 ? String(sumH) : '';
        totRow.cells[7] = sumK > 0 ? sumK.toLocaleString('ja-JP') : '';
        const t6 = cellMatrix[tIdx]?.[6];
        if (t6) { t6.textContent = totRow.cells[6]; t6.title = totRow.cells[6]; }
        const t7 = cellMatrix[tIdx]?.[7];
        if (t7) { t7.textContent = totRow.cells[7]; t7.title = totRow.cells[7]; }
      }
    }
    if (!isHaibukiya && !isNationalAzabu && !isTsukiji && !isNanohana && !isFusui && !isGreenworld && !isRosen && !isWorldDelica && !isSantoku && !isJoso && ci === nameColIdx) {
      const unitTd = cellMatrix[ri]?.[unitColIdx];
      if (unitTd) {
        const unitVal = rowObj.cells[unitColIdx] != null ? String(rowObj.cells[unitColIdx]) : '';
        unitTd.className = _getTodayRowCellClass(rowObj, 1, unitVal) + ' today-td-col-1' + (selectedRowIdx === ri && selectedColIdx === 1 ? ' xls-sel' : '');
      }
    }
    if (cellValEl && selectedRowIdx === ri && selectedColIdx === ci && document.activeElement !== cellValEl) {
      cellValEl.value = finalVal;
    }
    _markTodayOrderDirty(true);
    _persistTodayOrderLocal();
    _updateTodayOrderHeaderBadges();
    _refreshEmptyDayCol(ci);
    const inlineDateEl = document.getElementById('todayOrderInlineDate');
    if (inlineDateEl) inlineDateEl.value = _extractTodayBaseIsoDate();
  }

  function startInlineEdit(ri, ci, initialChar = null) {
    if (_isTodayRowSpanned(rows[ri])) ci = 0;
    const isUnitCol = !isHaibukiya && !isNationalAzabu && !isNanohana && !isFusui && !isGreenworld && !isRosen && !isWorldDelica && !isSantoku && !isJoso && ci === 1 && rows[ri]?.type !== 'header';
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
      if (_isTodayRowSpanned(rows[ri])) {
        td.innerHTML = `<span class="today-sticky-text">${esc(finalVal)}</span>`;
      } else {
        td.textContent = finalVal;
      }
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

  function _refreshEmptyDayCol(changedCi) {
    if (_todayOrderCurrentFormat === 'fusui' || _todayOrderCurrentFormat === 'nanohana' || _todayOrderCurrentFormat === 'greenworld') return;
    const cfg = _todayFmtCfg();
    const dStart = cfg.dayStartCol;
    const dStep  = cfg.dayStep || 1;
    if (dStart == null) return;
    for (let d = 0; d < (cfg.dayCount ?? 6); d++) {
      const ci = dStart + d * dStep;
      if (ci >= ncols) break;
      if (changedCi !== undefined && ci !== changedCi) continue;
      const isEmpty = rows.every(r =>
        r.type !== 'item' && r.type !== 'data' || !String(r.cells?.[ci] || '').trim()
      );
      rows.forEach(function(_, ri) {
        const td = cellMatrix[ri]?.[ci];
        if (!td) return;
        td.classList.add('today-day-col');
        if (isEmpty) td.classList.add('today-day-col-empty');
        else         td.classList.remove('today-day-col-empty');
      });
    }
  }

  let _nanohanaHdr1Done = false;
  rows.forEach((rowObj, ri) => {
    const tr = document.createElement('tr');
    trList[ri] = tr;
    const rowText = rowObj.cells.join(' ').toLowerCase();
    const matchesSearch = searchQ && rowText.includes(searchQ);
    if (rowObj.type === 'item') tr.classList.add('today-row-item');
    if (isTsukiji) {
      const divVal = String(rowObj.cells?.[0] || '').trim();
      const itemVal = String(rowObj.cells?.[2] || '').trim();
      if (divVal === 'レア') tr.classList.add('today-row-rare');
      else if (divVal === '風か様') tr.classList.add('today-row-fuuka');
      if (itemVal.includes('箱数')) tr.classList.add('today-row-summary');
      else if (itemVal === '物流') tr.classList.add('today-row-logistics');
    }
    if (isNanohana || isFusui) {
      const firstCell = String(rowObj.cells?.[0] || '').trim();
      if (firstCell === '合計') tr.classList.add('today-row-summary');
    }
    if (matchesSearch && ['item', 'data', 'category', 'merged', 'note'].includes(rowObj.type)) {
      tr.classList.add('today-row-match');
    }
    if (searchQ && rowObj.type === 'item' && !matchesSearch) {
      tr.classList.add('hidden');
    }

    // なのはな: 2-row merged header
    // rn1 + cols 0-2 use rowspan=2; act1 has NO rowspan; tr2 fills only cols 3-15 + act2
    if (isNanohana && rowObj.type === 'header') {
      if (!_nanohanaHdr1Done) {
        _nanohanaHdr1Done = true;
        // ── Row 1 ──
        tr.classList.add('today-xls-row', 'today-xls-row-header');
        const rn1 = document.createElement('td');
        rn1.className = 'xls-td-row';
        rn1.rowSpan = 2;
        rn1.textContent = ri + 1;
        rn1.addEventListener('click', e => { e.stopPropagation(); selectCell(ri, 0, true); });
        tr.appendChild(rn1);
        rowNumCells[ri] = rn1;
        cellMatrix[ri] = [];
        // cols 0-2: 注文No. / 特価 / 商品名 — rowspan=2 (true merged cells)
        for (let ci = 0; ci < 3; ci++) {
          const td = document.createElement('td');
          td.rowSpan = 2;
          const v = String(rowObj.cells[ci] || '');
          td.className = `${_getTodayRowCellClass(rowObj, ci, v)} today-td-nanohana-${ci}`;
          td.textContent = v;
          td.style.verticalAlign = 'middle';
          td.addEventListener('click', () => selectCell(ri, ci, true));
          td.addEventListener('dblclick', e2 => { e2.stopPropagation(); startInlineEdit(ri, ci); });
          tr.appendChild(td);
          cellMatrix[ri][ci] = td;
        }
        // 納品日: colspan=3
        const nohiTd = document.createElement('td');
        nohiTd.colSpan = 3;
        nohiTd.className = 'today-xls-header today-xls-header-center today-td-nanohana-3';
        nohiTd.textContent = '納品日';
        nohiTd.addEventListener('click', () => selectCell(ri, 3, true));
        tr.appendChild(nohiTd);
        cellMatrix[ri][3] = nohiTd; cellMatrix[ri][4] = nohiTd; cellMatrix[ri][5] = nohiTd;
        // 5 date cols: colspan=2 each
        for (let d = 0; d < 5; d++) {
          const ci = 6 + d * 2;
          const v = String(rowObj.cells[ci] || '');
          const td = document.createElement('td');
          td.colSpan = 2;
          td.className = `${_getTodayRowCellClass(rowObj, ci, v)} today-td-nanohana-${ci}`;
          td.textContent = v;
          td.style.textAlign = 'center';
          td.addEventListener('click', () => selectCell(ri, ci, true));
          td.addEventListener('dblclick', e2 => { e2.stopPropagation(); openTodayOrderMetaModal('date'); });
          tr.appendChild(td);
          cellMatrix[ri][ci] = td; cellMatrix[ri][ci + 1] = td;
        }
        // act1: NO rowspan — row 2 gets its own act2
        const act1 = document.createElement('td');
        act1.className = 'today-xls-actions today-xls-actions-hdr';
        act1.textContent = '操作';
        tr.appendChild(act1);
        tbody.appendChild(tr);
        // ── Row 2: cols 0-3 covered by rowspan → only cols 3-15 + act2 ──
        const subRow = rows[ri + 1];
        if (subRow && subRow.type === 'header') {
          const tr2 = document.createElement('tr');
          tr2.classList.add('today-xls-row', 'today-xls-row-header');
          cellMatrix[ri + 1] = [];
          // point covered cols at the rowspanned cells
          rowNumCells[ri + 1] = rn1;
          for (let ci = 0; ci < 3; ci++) cellMatrix[ri + 1][ci] = cellMatrix[ri][ci];
          // cols 3-15: 規格容量/納入価格/入数 + C/P・総数 × 5
          for (let ci = 3; ci < ncols; ci++) {
            const v = String(subRow.cells[ci] || '');
            const td = document.createElement('td');
            td.className = `${_getTodayRowCellClass(subRow, ci, v)} today-td-nanohana-${ci}`;
            td.textContent = v;
            td.addEventListener('click', () => selectCell(ri + 1, ci, true));
            tr2.appendChild(td);
            cellMatrix[ri + 1][ci] = td;
          }
          // act2
          const act2 = document.createElement('td');
          act2.className = 'today-xls-actions today-xls-actions-hdr';
          tr2.appendChild(act2);
          trList[ri + 1] = tr2;
          tbody.appendChild(tr2);
        }
        return;
      } else {
        cellMatrix[ri] = cellMatrix[ri] || [];
        return;
      }
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
      td.className = _getTodayRowCellClass(rowObj, 0, val) + ' today-td-spanned';
      td.title = val;
      td.innerHTML = `<span class="today-sticky-text">${esc(val)}</span>`;
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
        const colClass = isHaibukiya
          ? ` today-td-h-${ci}`
          : (isNationalAzabu
              ? (ci >= 6 && ci <= 11 ? ' today-td-na-day' : ` today-td-na-${ci}`)
              : (isTsukiji
                  ? (ci >= 4 && ci <= 9 ? ' today-td-tsukiji-day' : ` today-td-t-${ci}`)
                  : (isProps
                      ? (ci >= 4 ? ' today-td-p-day' : ` today-td-p-${ci}`)
                      : (isNanohana
                          ? ` today-td-nanohana-${ci}`
                          : (isFusui
                              ? ` today-td-fusui-${ci}`
                              : (isGreenworld
                                  ? ` today-td-gw-${ci}`
                                  : (isRosen
                                      ? ` today-td-rs-${ci}`
                                      : (isWorldDelica
                                          ? ` today-td-wd-${ci}`
                                          : (isSantoku
                                              ? ` today-td-st-${ci}`
                                              : (isJoso
                                                  ? ` today-td-joso-${ci}`
                                                  : (ci === 0 ? ' today-td-col-a' : (ci === 1 ? ' today-td-col-1' : ` today-td-col-${ci}`))))))))))))
        td.className = _getTodayRowCellClass(rowObj, ci, val) + colClass;
        td.title = val;
        td.textContent = val;
        td.addEventListener('click', () => selectCell(ri, ci, true));
        td.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (rowObj.type === 'header' && dayStartCol != null && ci >= dayStartCol && ci < dayStartCol + (_todayFmtCfg().dayCount ?? 6)) {
            openTodayOrderMetaModal('date');
            return;
          }
          startInlineEdit(ri, ci);
        });
        tr.appendChild(td);
        cellMatrix[ri][ci] = td;
      }
    }

    // Per-row CRUD Actions cell (Professional Excel hover reveal)
    const actTd = document.createElement('td');
    actTd.className = 'today-xls-actions' + (rowObj.type === 'header' ? ' today-xls-actions-hdr' : '');
    const hasContent = (rowObj.cells || []).some(c => c != null && String(c).trim() !== '');

    if (rowObj.type === 'header') {
      actTd.textContent = '操作';
    } else if (rowObj.type === 'category') {
      const grp = document.createElement('div');
      grp.className = 'today-row-act-group';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'today-row-act-btn add';
      addBtn.title = 'このカテゴリに品目を追加';
      addBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTodayOrderItemModal(null, '', { defaultCategory: rowObj.cells[0] || '' });
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'today-row-act-btn del';
      delBtn.title = 'このカテゴリ行を削除';
      delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteTodayOrderRow(ri); });
      grp.appendChild(addBtn);
      grp.appendChild(delBtn);
      actTd.appendChild(grp);
    } else if (rowObj.type === 'merged') {
      if (hasContent) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'today-row-act-btn add';
        btn.title = '発注品目を追加';
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>';
        btn.addEventListener('click', (e) => { e.stopPropagation(); openTodayOrderItemModal(null); });
        actTd.appendChild(btn);
      }
    } else if ((rowObj.type === 'item' || rowObj.type === 'data') && hasContent) {
      const grp = document.createElement('div');
      grp.className = 'today-row-act-group';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'today-row-act-btn add';
      addBtn.title = '行・品目を追加';
      addBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTodayOrderItemModal(null, '', { defaultCategory: _getRowPrecedingCategory(ri) });
      });
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'today-row-act-btn edit';
      editBtn.title = 'この行を編集';
      editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); openTodayOrderItemModal(ri); });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'today-row-act-btn del';
      delBtn.title = 'この行を削除';
      delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
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
  _refreshEmptyDayCol();

  gridWrap.innerHTML = '';
  gridWrap.appendChild(table);

  if (cellValEl) {
    cellValEl.onfocus = () => {
      cellValEl.dataset.origRawVal = rows[_todayOrderSelRow]?.cells?.[_todayOrderSelCol] ?? '';
    };
    cellValEl.oninput = () => {
      if (selectedRowIdx >= 0 && selectedColIdx >= 0) {
        if (!isHaibukiya && !isNationalAzabu && !isNanohana && !isFusui && !isGreenworld && !isRosen && !isWorldDelica && !isSantoku && !isJoso && selectedColIdx === 1 && rows[selectedRowIdx]?.type !== 'header' && /[0-9０-９]/.test(cellValEl.value)) {
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
      if (!isHaibukiya && !isNationalAzabu && !isNanohana && !isFusui && !isGreenworld && !isRosen && !isWorldDelica && !isSantoku && !isJoso && selectedColIdx === 1 && rows[selectedRowIdx]?.type !== 'header' && /^[0-9０-９]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
      const unitColIdx = isProps ? 2 : 1;
      if (!isHaibukiya && !isNationalAzabu && !isNanohana && !isFusui && !isGreenworld && !isRosen && !isWorldDelica && !isSantoku && !isJoso && selectedColIdx === unitColIdx && rows[selectedRowIdx]?.type !== 'header' && /^[0-9０-９]$/.test(e.key)) {
        showToast('単位列には数値を入力できません', true);
        return;
      }
      startInlineEdit(selectedRowIdx, selectedColIdx, e.key);
    }
  };

  selectCell(_todayOrderSelRow, _todayOrderSelCol, false);

  if (statusEl) {
    const itemCount = _countTodayOrderItems();
    const isNanohana = _todayOrderCurrentFormat === 'nanohana';
    const isFusui = _todayOrderCurrentFormat === 'fusui';
    const fmtLabel = isHaibukiya ? '灰吹屋 発注書' : (isNationalAzabu ? 'ナショナル麻布 発注書' : (isTsukiji ? '築地産直ファーム 発注書' : (isProps ? 'プロップスジャパン 注文書' : (isFusui ? '風水プロジェクト 発注書' : (isNanohana ? 'なのはな生協 発注書' : (isGreenworld ? 'グリーンワールド 発注書' : (isRosen ? '相鉄ローゼン 発注リスト' : (isWorldDelica ? 'ワールドデリカ 発注書' : (isSantoku ? '株式会社三徳 発注書' : '千葉自動発注書')))))))));
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

/* ── Today OCR list (shown after DB save) ───────────────────────── */

let _todayOcrData = null;

function _isDateColumn(header) {
  if (!header) return false;
  const h = String(header).replace(/\s/g, '');
  // matches 9/21月, 9/21(月), bare weekday — also allows trailing text like "変更"
  return /\d{1,2}\/\d{1,2}[月火水木金土日]/.test(h) ||
         /\d{1,2}\/\d{1,2}\([月火水木金土日]\)/.test(h) ||
         /^[月火水木金土日]$/.test(h);
}

function _renderTodayOcrList(result) {
  const container = document.getElementById('todayOcrList');
  if (!container) return;

  const sheets = (result && Array.isArray(result.custom_sheets))
    ? result.custom_sheets.filter(s => s.name !== 'Full Text' && Array.isArray(s.rows) && s.rows.length > 1)
    : [];

  if (!sheets.length) {
    container.innerHTML = `<div class="today-ocr-empty">
      <svg width="40" height="40" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 17v-2m3 2v-4m3 4v-6M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"/></svg>
      <p>表示できるデータがありません</p>
    </div>`;
    return;
  }

  let html = '';
  for (const sheet of sheets) {
    const rows = sheet.rows;
    // find header row
    const hdrIdx = typeof sheet.headerIdx === 'number' ? sheet.headerIdx
      : (sheet.hasHeader ? 0 : -1);
    const headers = hdrIdx >= 0 ? rows[hdrIdx] : null;
    const dataRows = rows.filter((_, i) => i !== hdrIdx);

    // detect date columns
    let dateColIndices = [];
    if (headers) {
      headers.forEach((h, i) => { if (_isDateColumn(h)) dateColIndices.push(i); });
    }

    // filter: only keep rows with at least one non-empty date-column value
    const filteredRows = (dateColIndices.length >= 2)
      ? dataRows.filter(row =>
          dateColIndices.some(ci => {
            const v = String(row[ci] ?? '').trim();
            return v !== '' && v !== '0' && v !== '-' && v !== '変更';
          })
        )
      : dataRows;

    if (!filteredRows.length) continue;

    // show 品名 column + date columns (or all columns if no date columns detected)
    let visibleIndices;
    if (dateColIndices.length >= 2) {
      const hinmeiIdx = headers ? headers.findIndex(h => String(h ?? '').replace(/\s/g, '').includes('品名')) : -1;
      visibleIndices = hinmeiIdx >= 0
        ? [hinmeiIdx, ...dateColIndices]
        : dateColIndices;
    } else {
      visibleIndices = headers ? headers.map((_, i) => i) : filteredRows[0].map((_, i) => i);
    }

    const dispHeaders = headers
      ? visibleIndices.map(i => String(headers[i] ?? '').replace(/\n/g, ' ').trim())
      : visibleIndices.map(i => String(i + 1));

    html += `<div class="today-ocr-info">
      <span class="today-ocr-filename">${esc(sheet.name)}</span>
      ${result.filename ? `<span class="today-ocr-client">${esc(result.filename)}</span>` : ''}
      <span class="today-ocr-client">${filteredRows.length}行</span>
    </div>`;

    html += `<div class="today-ocr-table-wrap"><table class="today-ocr-table"><thead><tr>`;
    dispHeaders.forEach(h => { html += `<th>${esc(h)}</th>`; });
    html += `</tr></thead><tbody>`;
    for (const row of filteredRows) {
      html += '<tr>';
      visibleIndices.forEach(ci => {
        const v = String(row[ci] ?? '').replace(/\n/g, ' ').trim();
        html += `<td${v ? ' style="font-weight:600"' : ''}>${esc(v)}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  container.innerHTML = html || `<div class="today-ocr-empty">
    <svg width="40" height="40" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 17v-2m3 2v-4m3 4v-6M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1z"/></svg>
    <p>対象データがありません</p>
  </div>`;
}

function _navigateToTodayOrder(result) {
  _todayOcrData = result;
  // switch sidebar nav
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('.nav-item[data-view="todayOrder"]');
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const view = document.getElementById('viewTodayOrder');
  if (view) view.classList.remove('hidden');
  _renderTodayOcrList(result);
}

async function initTodayOrderView() {
  // Render saved OCR data if available
  if (_todayOcrData) _renderTodayOcrList(_todayOcrData);
  if (!_todayOrderInitialized) {
    // Fetch format list from server (falls back to hardcoded if unavailable)
    let _serverFormatList = null;
    try {
      const fr = await fetch(`${API_BASE}/api/today-order/formats`);
      if (fr.ok) _serverFormatList = await fr.json();
    } catch {}
    // Build tabs and format-select from server list or hardcoded fallback
    const tabsContainer = document.getElementById('todayOrderSheetTabs');
    if (tabsContainer) {
      const tabEntries = _serverFormatList
        ? _serverFormatList.map(f => [f.key, f.tab || f.label])
        : Object.entries(TODAY_FMT_LABELS);
      tabsContainer.innerHTML = tabEntries
        .filter(([key]) => TODAY_ORDER_FORMATS[key])
        .map(([key, label]) =>
          `<div class="xls-sheet-tab${key === _todayOrderCurrentFormat ? ' active' : ''}" data-format="${esc(key)}">${esc(label)}</div>`
        ).join('');
    }
    const fmtSelect = document.getElementById('todayOrderFormatSelect');
    if (fmtSelect) {
      if (_serverFormatList) {
        fmtSelect.innerHTML = _serverFormatList
          .filter(f => TODAY_ORDER_FORMATS[f.key])
          .map(f => `<option value="${esc(f.key)}">${esc(f.label)}</option>`)
          .join('');
      } else {
        fmtSelect.innerHTML = Object.entries(TODAY_ORDER_FORMATS).map(([key, cfg]) => {
          const label = cfg.downloadName.replace(/\.xlsx?$/i, '').replace(/_/g, ' ').replace(/^(発注書|発注明細書|注文書|週間発注リスト)\s*/u, '');
          return `<option value="${esc(key)}">${esc(label)}</option>`;
        }).join('');
      }
      fmtSelect.value = _todayOrderCurrentFormat;
    }

    await switchTodayOrderFormat(_todayOrderCurrentFormat);

    document.getElementById('todayOrderFormatSelect')?.addEventListener('change', (e) => {
      switchTodayOrderFormat(e.target.value);
    });

    const bindSheetTab = (tab) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        if (tab.dataset.format) {
          switchTodayOrderFormat(tab.dataset.format);
        }
      });
    };
    document.querySelectorAll('#todayOrderSheetTabs .xls-sheet-tab').forEach(bindSheetTab);

    // Delegated click handler on the sheet tab bar to ensure clicks are never missed
    const sheetTabsContainer = document.getElementById('todayOrderSheetTabs');
    sheetTabsContainer?.addEventListener('click', (e) => {
      const tab = e.target.closest('.xls-sheet-tab');
      if (tab && tab.dataset.format) {
        e.preventDefault();
        switchTodayOrderFormat(tab.dataset.format);
      }
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

    document.getElementById('todayOrderClearDataBtn')?.addEventListener('click', () => {
      if (!confirm('ヘッダー以下のデータ行をすべて削除しますか？')) return;
      let lastHdrIdx = -1;
      for (let i = 0; i < _todayOrderRows.length; i++) {
        if (_todayOrderRows[i].type === 'header') lastHdrIdx = i;
      }
      if (lastHdrIdx < 0) { showToast('ヘッダー行が見つかりません', true); return; }
      const ncols = (_todayOrderRows[lastHdrIdx].cells || []).length || 8;
      const emptyRows = [];
      for (let i = 0; i < 6; i++) emptyRows.push({ type: 'data', cells: Array(ncols).fill('') });
      _todayOrderRows = [..._todayOrderRows.slice(0, lastHdrIdx + 1), ...emptyRows];
      _markTodayOrderDirty(true);
      _renderTodayOrderGrid();
      showToast('データ行を削除しました');
    });

    document.getElementById('todayOrderMetaBtn')?.addEventListener('click', () => {
      openTodayOrderMetaModal();
    });

    document.getElementById('todayOrderSaveBtn')?.addEventListener('click', () => {
      saveTodayOrderSheet(false);
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
      const isProps = _todayOrderCurrentFormat === 'props_japan';
      const isNationalAzabu = _todayOrderCurrentFormat === 'national_azabu';
      const isTsukiji = _todayOrderCurrentFormat === 'tsukiji';
      const isNanohana = _todayOrderCurrentFormat === 'nanohana';
      const isFusui = _todayOrderCurrentFormat === 'fusui';
      const isGreenworld = _todayOrderCurrentFormat === 'greenworld';
      const isSantoku = _todayOrderCurrentFormat === 'santoku';
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
            const cult = (tr.querySelector('.today-m-cult')?.value || '').trim();
            const spec = (tr.querySelector('.today-m-spec')?.value || '').trim();
            const priceP = (tr.querySelector('.today-m-pricep')?.value || '').trim();
            const priceCs = (tr.querySelector('.today-m-pricecs')?.value || '').trim();
            const jan = (tr.querySelector('.today-m-jan')?.value || '').trim();
            const note = (tr.querySelector('.today-m-note')?.value || '').trim();
            const dayInps = Array.from(tr.querySelectorAll('.today-m-day'));
            const daysRaw = dayInps.map(inp => (inp.value || '').trim());
            const hasAny = Boolean(cat || name || origin || cult || spec || priceP || priceCs || jan || note || daysRaw.some(Boolean));
            if (!hasAny) continue;

            if (!name) {
              nameInp?.classList.add('today-input-error');
              validationError = `${idx + 1} 行目: 品目名を入力してください`;
              errorFocusEl = nameInp;
              break;
            }

            const normalizedDays = [];
            for (let d = 0; d < 12; d++) {
              const rawD = (daysRaw[d] || '').normalize('NFKC').trim();
              if (rawD && !/^\d+(?:\.\d+)?(?:\s*(?:→|->)+\s*\d+(?:\.\d+)?)?$/.test(rawD)) {
                dayInps[d]?.classList.add('today-input-error');
                validationError = `${idx + 1} 行目（${name}）: 数量は数値で入力してください`;
                errorFocusEl = dayInps[d];
                break;
              }
              normalizedDays.push(rawD.replace(/\s*->+\s*/g, '→').replace(/\s*→\s*/g, '→'));
            }
            if (validationError) break;

            collected.push({
              category: cat,
              cells: [name, origin, cult, spec, priceP, priceCs, jan, ...normalizedDays, note],
            });
          } else if (isNationalAzabu) {
            const cat = (tr.querySelector('.today-m-cat')?.value || '').trim();
            const origin = (tr.querySelector('.today-m-origin')?.value || '').trim();
            const spec = (tr.querySelector('.today-m-spec')?.value || '').trim();
            const priceP = (tr.querySelector('.today-m-pricep')?.value || '').trim();
            const priceCs = (tr.querySelector('.today-m-pricecs')?.value || '').trim();
            const jan = (tr.querySelector('.today-m-jan')?.value || '').trim();
            const noteVal = (tr.querySelector('.today-m-note')?.value || '').trim();
            const dayInps = Array.from(tr.querySelectorAll('.today-m-day'));
            const daysRaw = dayInps.map(inp => (inp.value || '').trim());
            const hasAny = Boolean(cat || name || origin || spec || priceP || priceCs || jan || noteVal || daysRaw.some(Boolean));
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
              normalizedDays.push(rawD);
            }
            if (validationError) break;

            collected.push({
              category: cat,
              cells: [name, origin, spec, priceP, priceCs, jan, ...normalizedDays, noteVal],
            });
          } else if (isProps) {
            const code = (tr.querySelector('.today-m-code')?.value || '').trim();
            const unitInp = tr.querySelector('.today-m-unit');
            const lotInp = tr.querySelector('.today-m-lot');
            const dayInps = Array.from(tr.querySelectorAll('.today-m-day'));
            const unitRaw = (unitInp?.value || '').trim();
            const lotRaw = (lotInp?.value || '').normalize('NFKC').trim();
            const daysRaw = dayInps.map(inp => (inp.value || '').trim());
            const hasAny = Boolean(code || name || unitRaw || lotRaw || daysRaw.some(Boolean));
            if (!hasAny) continue;

            if (!name) {
              nameInp?.classList.add('today-input-error');
              validationError = `${idx + 1} 行目: 品名を入力してください`;
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

            if (lotRaw && !/^\d+(\.\d+)?$/.test(lotRaw)) {
              lotInp?.classList.add('today-input-error');
              validationError = `${idx + 1} 行目（${name}）: ロットは0以上の数値で入力してください`;
              errorFocusEl = lotInp;
              break;
            }

            const normalizedDays = [];
            for (let d = 0; d < 6; d++) {
              const rawD = (daysRaw[d] || '').normalize('NFKC').trim();
              if (rawD && !/^\d+(\.\d+)?$/.test(rawD)) {
                dayInps[d]?.classList.add('today-input-error');
                validationError = `${idx + 1} 行目（${name}）: 発注数は0以上の数値で入力してください`;
                errorFocusEl = dayInps[d];
                break;
              }
              normalizedDays.push(rawD);
            }
            if (validationError) break;

            collected.push({ category: '', cells: [code, name, unitCheck.normalized, lotRaw, ...normalizedDays] });
          } else if (isTsukiji) {
            const division = (tr.querySelector('.today-m-division')?.value || '').trim();
            const origin = (tr.querySelector('.today-m-origin')?.value || '').trim();
            const unitRaw = (tr.querySelector('.today-m-unit')?.value || '').trim();
            const note = (tr.querySelector('.today-m-note')?.value || '').trim();
            const dayInps = Array.from(tr.querySelectorAll('.today-m-day'));
            const daysRaw = dayInps.map(inp => (inp.value || '').trim());
            const hasAny = Boolean(division || origin || name || unitRaw || note || daysRaw.some(Boolean));
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
              normalizedDays.push(rawD);
            }

            collected.push({ category: '', cells: [division, origin, name, unitRaw, ...normalizedDays, note] });
          } else if (isNanohana) {
            const orderNo = (tr.querySelector('.today-m-orderno')?.value || '').trim();
            const toku    = (tr.querySelector('.today-m-toku')?.value || '').trim();
            const spec    = (tr.querySelector('.today-m-spec')?.value || '').trim();
            const price   = (tr.querySelector('.today-m-price')?.value || '').trim();
            const irisu   = (tr.querySelector('.today-m-irisu')?.value || '').trim();
            const _cpInps  = Array.from(tr.querySelectorAll('.today-m-nana-cp'));
            const _qtyInps = Array.from(tr.querySelectorAll('.today-m-nana-qty'));
            const cp  = _cpInps.map(i => i.value.trim());
            const qty = _qtyInps.map(i => i.value.trim());
            const hasAny = Boolean(orderNo || name || spec || price || irisu || cp.some(v=>v) || qty.some(v=>v));
            if (!hasAny) continue;

            if (!name) {
              nameInp?.classList.add('today-input-error');
              validationError = `${idx + 1} 行目: 商品名を入力してください`;
              errorFocusEl = nameInp;
              break;
            }

            const _nanaCells = [orderNo, toku, name, spec, price, irisu];
            for (let _ni = 0; _ni < 5; _ni++) _nanaCells.push(cp[_ni] || '', qty[_ni] || '');
            collected.push({ category: '', cells: _nanaCells });
          } else if (isFusui) {
            const code = (tr.querySelector('.today-m-code')?.value || '').trim();
            const spec = (tr.querySelector('.today-m-spec')?.value || '').trim();
            const qty = (tr.querySelector('.today-m-qty')?.value || '').trim();
            const price = (tr.querySelector('.today-m-price')?.value || '').trim();
            const amount = (tr.querySelector('.today-m-amount')?.value || '').trim();
            const hasAny = Boolean(code || name || spec || qty || price || amount);
            if (!hasAny) continue;

            if (!name) {
              nameInp?.classList.add('today-input-error');
              validationError = `${idx + 1} 行目: 商品名を入力してください`;
              errorFocusEl = nameInp;
              break;
            }

            collected.push({ category: '', cells: [code, name, spec, qty, price, amount] });
          } else if (isGreenworld) {
            const no = (tr.querySelector('.today-m-no')?.value || '').trim();
            const spec = (tr.querySelector('.today-m-spec')?.value || '').trim();
            const irisu = (tr.querySelector('.today-m-irisu')?.value || '').trim();
            const cases = (tr.querySelector('.today-m-cases')?.value || '').trim();
            const price = (tr.querySelector('.today-m-price')?.value || '').trim();
            const total = (tr.querySelector('.today-m-total')?.value || '').trim();
            const hasAny = Boolean(no || name || spec || irisu || cases || price || total);
            if (!hasAny) continue;

            if (!name) {
              nameInp?.classList.add('today-input-error');
              validationError = `${idx + 1} 行目: 商品名を入力してください`;
              errorFocusEl = nameInp;
              break;
            }

            collected.push({ category: '', cells: [no, name, spec, irisu, cases, price, total] });
          } else if (_todayOrderCurrentFormat === 'rosen') {
            const code = (tr.querySelector('.today-m-code')?.value || '').trim();
            const irisu = (tr.querySelector('.today-m-irisu')?.value || '').trim();
            const costVal = (tr.querySelector('.today-m-cost')?.value || '').trim();
            const total = (tr.querySelector('.today-m-total')?.value || '').trim();
            const noteVal = (tr.querySelector('.today-m-note')?.value || '').trim();
            const dayInps = Array.from(tr.querySelectorAll('.today-m-day'));
            const daysRaw = dayInps.map(inp => (inp.value || '').trim());
            const hasAny = Boolean(code || name || irisu || costVal || total || noteVal || daysRaw.some(Boolean));
            if (!name) { nameInp?.classList.add('today-input-error'); validationError = `${idx + 1} 行目： 商品名を入力してください`; errorFocusEl = nameInp; break; }
            if (!name) { nameInp?.classList.add('today-input-error'); validationError = "${idx + 1} 行目： 商品名を入力してください"; errorFocusEl = nameInp; break; }
            const normalizedDays = [];
            for (let d = 0; d < 7; d++) { const rawD = (daysRaw[d] || '').normalize('NFKC').trim(); normalizedDays.push(rawD); }
            if (validationError) break;
            collected.push({ category: '', cells: [code, name, irisu, costVal, total, ...normalizedDays, noteVal] });
          } else if (_todayOrderCurrentFormat === 'worlddelica') {
            const dateVal = (tr.querySelector('.today-m-date')?.value || '').trim();
            const qtyVal  = (tr.querySelector('.today-m-qty')?.value || '').trim();
            const unitVal = (tr.querySelector('.today-m-unit')?.value || '').trim();
            const noteVal = (tr.querySelector('.today-m-note')?.value || '').trim();
            const hasAny  = Boolean(dateVal || name || qtyVal || unitVal || noteVal);
            if (!hasAny) continue;
            if (!name) { nameInp?.classList.add('today-input-error'); validationError = `${idx + 1} 行目: 商品名を入力してください`; errorFocusEl = nameInp; break; }
            collected.push({ category: '', cells: [dateVal, name, qtyVal, unitVal, noteVal] });
          } else if (isSantoku) {
            const origin = (tr.querySelector('.today-m-origin')?.value || '').trim();
            const spec   = (tr.querySelector('.today-m-spec')?.value || '').trim();
            const dayInps = Array.from(tr.querySelectorAll('.today-m-day'));
            const daysRaw = dayInps.map(inp => (inp.value || '').trim());
            const hasAny = Boolean(name || origin || spec || daysRaw.some(Boolean));
            if (!hasAny) continue;
            if (!name) { nameInp?.classList.add('today-input-error'); validationError = `${idx + 1} 行目: 商品名を入力してください`; errorFocusEl = nameInp; break; }
            const normalizedDays = [];
            for (let d = 0; d < 6; d++) {
              const rawD = (daysRaw[d] || '').normalize('NFKC').trim();
              normalizedDays.push(rawD);
            }
            const totalVal = normalizedDays.reduce((s, v) => s + (parseFloat(v) || 0), 0);
            const totalStr = totalVal > 0 ? String(totalVal) : '';
            collected.push({ category: '', cells: [name, origin, spec, ...normalizedDays, totalStr] });
          } else if (_todayOrderCurrentFormat === 'josoSeikyo') {
            const ocr   = (tr.querySelector('.today-m-ocr')?.value || '').trim();
            const spec  = (tr.querySelector('.today-m-spec')?.value || '').trim();
            const tanka = (tr.querySelector('.today-m-tanka')?.value || '').trim();
            const irisu = (tr.querySelector('.today-m-irisu')?.value || '').trim() || '1';
            const qty   = (tr.querySelector('.today-m-qty')?.value || '').trim();
            const hasAny = Boolean(ocr || name || spec || tanka || qty);
            if (!hasAny) continue;
            if (!name) { nameInp?.classList.add('today-input-error'); validationError = `${idx + 1} 行目: 商品名を入力してください`; errorFocusEl = nameInp; break; }
            const tankaNum = parseFloat(String(tanka).replace(/,/g, '')) || 0;
            const qtyNum   = parseFloat(String(qty).replace(/,/g, '')) || 0;
            const nouhin   = qtyNum > 0 ? String(qtyNum) : '';
            const kin      = (tankaNum > 0 && qtyNum > 0) ? (tankaNum * qtyNum).toLocaleString('ja-JP') : '';
            collected.push({ category: '', cells: [ocr, name, spec, nouhin, tanka, irisu, qty, kin] });
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
        const msg = (isHaibukiya || isNationalAzabu) ? '品目名を1件以上入力してください' : '品目名と単位を1件以上入力してください';
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
      } else if (isHaibukiya || isNationalAzabu) {
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
          for (let offset = 0; offset < (_todayFmtCfg().dayCount ?? 6); offset++) {
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

    // ── Week date config ───────────────────────────────────────
    document.getElementById('todayOrderWeekBtn')?.addEventListener('click', () => {
      const fmt = _todayOrderCurrentFormat;
      // Use a hidden date input to show the native date picker
      const inp = document.createElement('input');
      inp.type = 'date';
      inp.style.cssText = 'position:fixed;opacity:0;pointer-events:none;top:0;left:0;width:0;height:0';
      document.body.appendChild(inp);
      inp.addEventListener('change', async () => {
        const dateStr = inp.value;
        document.body.removeChild(inp);
        if (!dateStr) return;
        const btn = document.getElementById('todayOrderWeekBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 設定中…'; }
        try {
          const r = await fetch(`${API_BASE}/api/today-order/week?format=${encodeURIComponent(fmt)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ week_start: dateStr }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const { date_cols, date_start_col, date_count } = await r.json();
          // Find the last header row and update its date cells
          let hdrRow = null;
          for (const row of _todayOrderRows) {
            if (row.type === 'header') hdrRow = row;
          }
          if (!hdrRow) { showToast('ヘッダー行が見つかりません', true); return; }
          hdrRow.cells.splice(date_start_col, date_count, ...date_cols);
          _markTodayOrderDirty(true);
          _renderTodayOrderGrid();
          showToast(`週を ${dateStr} 開始に設定しました`);
        } catch (e) {
          showToast('週設定に失敗しました: ' + e.message, true);
        } finally {
          const btn2 = document.getElementById('todayOrderWeekBtn');
          if (btn2) { btn2.disabled = false; btn2.textContent = '📅 週設定'; }
        }
      });
      inp.addEventListener('cancel', () => { document.body.removeChild(inp); });
      inp.click();
    });

    // ── Product master load ────────────────────────────────────
    document.getElementById('todayOrderMasterLoadBtn')?.addEventListener('click', async () => {
      const fmt = _todayOrderCurrentFormat;
      const btn = document.getElementById('todayOrderMasterLoadBtn');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ 読込中…'; }
      try {
        const r = await fetch(`${API_BASE}/api/today-order/products?format=${encodeURIComponent(fmt)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { rows: productRows, ncols, base_cols } = await r.json();

        // Find last 'header' row in current sheet
        let lastHdrIdx = -1;
        for (let i = 0; i < _todayOrderRows.length; i++) {
          if (_todayOrderRows[i].type === 'header') lastHdrIdx = i;
        }
        if (lastHdrIdx < 0) { showToast('ヘッダー行が見つかりません', true); return; }

        const newRows = productRows.map(row => {
          if (row.type === 'item') {
            const base = (row.cells || []).slice(0, base_cols);
            while (base.length < base_cols) base.push('');
            return { type: 'item', cells: [...base, ...Array(ncols - base_cols).fill('')] };
          }
          if (row.type === 'category') {
            const cells = (row.cells || []).slice();
            while (cells.length < ncols) cells.push('');
            return { type: 'category', cells };
          }
          return row;
        });
        newRows.push({ type: 'spacer', cells: Array(ncols).fill('') });
        for (let i = 0; i < 4; i++) newRows.push({ type: 'data', cells: Array(ncols).fill('') });

        _todayOrderRows = [..._todayOrderRows.slice(0, lastHdrIdx + 1), ...newRows];
        _markTodayOrderDirty(true);
        _renderTodayOrderGrid();
        const itemCount = productRows.filter(r => r.type === 'item').length;
        showToast(`商品マスタから ${itemCount} 品目を読み込みました`);
      } catch (e) {
        showToast('マスタ読込に失敗しました: ' + e.message, true);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📋 マスタ読込'; }
      }
    });

    // ── Product master save ────────────────────────────────────
    document.getElementById('todayOrderMasterSaveBtn')?.addEventListener('click', async () => {
      const fmt = _todayOrderCurrentFormat;
      const btn = document.getElementById('todayOrderMasterSaveBtn');
      const productRows = _todayOrderRows.filter(r => ['category', 'item', 'note'].includes(r.type));
      if (!productRows.some(r => r.type === 'item')) {
        showToast('保存する品目がありません', true); return;
      }
      if (btn) { btn.disabled = true; btn.textContent = '⏳ 保存中…'; }
      try {
        const r = await fetch(`${API_BASE}/api/today-order/products?format=${encodeURIComponent(fmt)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: productRows }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const itemCount = productRows.filter(r => r.type === 'item').length;
        showToast(`商品マスタを保存しました（${itemCount} 品目）`);
      } catch (e) {
        showToast('マスタ保存に失敗しました: ' + e.message, true);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '💾 マスタ保存'; }
      }
    });

    _todayOrderInitialized = true;
  }
  _renderTodayOrderGrid();
}

async function reloadOrderSheet() {
  const tbody = document.getElementById('orderSheetBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="11" class="sheet-loading">読み込み中…</td></tr>';

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
  if (!(await showConfirmToast(`発注書「${label}」を削除しますか？\nこの操作は元に戻せません。`))) return false;
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
    else if (col === 'data')   { av = (a.page_count ?? 0) + (a.table_count ?? 0); bv = (b.page_count ?? 0) + (b.table_count ?? 0); }
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
    tbody.innerHTML = '<tr><td colspan="11" class="sheet-empty">条件に一致する発注書データが見つかりませんでした。</td></tr>';
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
    // Confidence: treat 0.0 as unavailable (PaddleOCR doesn't report confidence)
    const confVal    = (j.confidence_avg != null && j.confidence_avg > 0.001) ? j.confidence_avg * 100 : null;
    const confStr    = confVal != null ? confVal.toFixed(1) + '%' : '—';
    const confClass  = confVal == null ? '' : confVal >= 85 ? '' : confVal >= 65 ? 'conf-warn' : 'conf-low';
    const confBar    = confVal != null
      ? `<div class="conf-bar-wrap"><div class="conf-bar" style="width:${Math.round(confVal)}%"></div></div>`
      : '';
    const date       = j.created_at ? j.created_at.replace('T',' ').slice(0,16) : '—';
    const timeStr    = j.processing_time_s != null ? j.processing_time_s + 's' : '—';
    // Data summary: page count + extracted tables
    const pages      = j.page_count != null && j.page_count > 0 ? j.page_count : null;
    const tables     = j.table_count != null ? Number(j.table_count) : 0;
    const dataParts  = [];
    if (pages) dataParts.push(`${pages}P`);
    if (tables > 0) dataParts.push(`${tables}テーブル`);
    const dataStr    = dataParts.length ? dataParts.join(' / ') : '—';
    return `<tr class="${idx % 2 === 1 ? 'row-alt' : ''}${isChecked ? ' row-selected' : ''}"
               data-job-id="${esc(j.job_id)}" data-filename="${esc(j.filename)}">
      <td class="col-check"><input type="checkbox" class="order-row-chk" data-job-id="${esc(j.job_id)}" ${isChecked ? 'checked' : ''} /></td>
      <td class="col-no">${idx + 1}</td>
      <td class="col-client">${clientName}</td>
      <td class="col-file" title="${esc(j.filename)}">${esc(j.filename)}</td>
      <td class="col-engine"><span class="badge badge-engine">${engine}</span></td>
      <td class="col-status"><span class="${statusCls}"><span class="badge-dot"></span>${statusText}</span></td>
      <td class="col-data"><span class="data-summary">${esc(dataStr)}</span></td>
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
  if (!(await showConfirmToast(`選択した ${ids.length} 件の発注書を削除しますか？\nこの操作は元に戻せません。`))) return;
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

document.getElementById('orderDeleteAllBtn')?.addEventListener('click', async () => {
  const total = _orderAllJobs.length;
  if (!total) { showToast('削除するデータがありません'); return; }
  if (!(await showConfirmToast(`発注一覧のすべての ${total} 件を削除しますか？\nこの操作は元に戻せません。`))) return;
  const btn = document.getElementById('orderDeleteAllBtn');
  if (btn) btn.disabled = true;
  try {
    const ids = _orderAllJobs.map(j => j.job_id);
    const r = await fetch(`${API_BASE}/api/db/jobs/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_ids: ids }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.statusText);
    }
    const { deleted } = await r.json();
    _orderAllJobs = [];
    _orderSelectedIds.clear();
    renderOrderSheet();
    document.getElementById('orderPreview')?.classList.add('hidden');
    syncHomeHistoryRemoved(ids);
    showToast(`${deleted ?? ids.length} 件のデータをすべて削除しました`);
  } catch (e) {
    showToast('削除に失敗しました: ' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
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
  const rowInput      = document.getElementById('clientHeadingRow');
  const colsInput     = document.getElementById('clientHeadingColumns');
  const skipInput     = document.getElementById('clientSkipPatterns');
  const presetSel     = document.getElementById('clientHeadingPreset');
  const previewDateInput = document.getElementById('clientHeadingPreviewDate');

  const curRow  = client.header_row != null ? client.header_row : 1;
  const curCols = client.heading_columns || '';
  const curSkip = client.skip_patterns  || '';

  if (rowInput)  rowInput.value  = curRow;
  if (colsInput) colsInput.value = curCols;
  if (skipInput) skipInput.value = curSkip;
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
  const skipVal = (document.getElementById('clientSkipPatterns')?.value || '').trim();

  const saveBtn = document.getElementById('clientHeadingSave');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }

  try {
    const r = await dbFetch(`/api/db/clients/${_clientHeadingTarget.id}/heading-format`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        header_row: rowVal,
        heading_columns: colsVal,
        skip_patterns: skipVal
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
        currentResult.client.skip_patterns = skipVal;
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
      if (!(await showConfirmToast(`取引先「${label}」を削除しますか？ 既存の発注書データは保持されます。`))) return;
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
  const trList = [];

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
      if (selectedRowIdx >= 0) {
        rowNumCells[selectedRowIdx]?.classList.remove('xls-row-sel');
        trList[selectedRowIdx]?.classList.remove('xls-row-active');
      }
    }
    selectedRowIdx = ri;
    selectedColIdx = ci;
    selectedTd = cellMatrix[ri]?.[ci] || null;
    sheet._selRow = ri;
    sheet._selCol = ci;

    selectedTd?.classList.add('xls-sel');
    colHeaders[ci]?.classList.add('xls-col-sel');
    rowNumCells[ri]?.classList.add('xls-row-sel');
    trList[ri]?.classList.add('xls-row-active');

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

  // detect date columns for row filtering
  const _dateColIndices = [];
  for (let _ci = 0; _ci < maxCols; _ci++) {
    if (_isDateColumn(_resolveSheetColHeading(sheet, _ci))) _dateColIndices.push(_ci);
  }
  const _shouldHideRow = (rowCells) => {
    if (_dateColIndices.length < 2) return false;
    return _dateColIndices.every(ci => {
      const v = String(rowCells[ci] ?? '').trim();
      return v === '' || v === '0' || v === '-' || v === '変更';
    });
  };

  let visibleRowNum = 0;
  rows.forEach((rowCells, ri) => {
    const isHdr = hasHeader && ri === headerIdx;
    if (hideHeaderRowInBody && isHdr) return;
    if (!isHdr && _shouldHideRow(rowCells)) return;

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
    trList[ri] = tr;
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

function _buildClientExtractedSheet(sheets, client) {
  if (!client) return null;
  const cols = _parseClientHeadingCols(client);
  if (!cols.length) return null;

  const mainSheet = sheets.find(s => s.name !== 'Full Text') || sheets[0];
  if (!mainSheet || !mainSheet.rows || mainSheet.rows.length < 2) return null;

  const rows = mainSheet.rows;
  const headerRowHint = Math.max(0, (parseInt(client.header_row, 10) || 1) - 1);

  const norm = s => String(s || '').replace(/[　\s]+/g, '').toLowerCase();

  const findHeaderRow = () => {
    let bestIdx = -1;
    let bestScore = 0;
    const scan = (start, end) => {
      for (let ri = start; ri < end; ri++) {
        let matches = 0;
        cols.forEach(col => {
          const colN = norm(col);
          if (rows[ri].some(cell => { const cn = norm(cell); return cn && (cn.includes(colN) || colN.includes(cn)); })) matches++;
        });
        const score = matches / cols.length;
        if (score > bestScore) { bestScore = score; bestIdx = ri; }
      }
    };
    scan(Math.max(0, headerRowHint - 2), Math.min(rows.length, headerRowHint + 10));
    if (bestScore < 0.3) scan(0, rows.length);
    return bestScore >= 0.3 ? bestIdx : -1;
  };

  const hdrIdx = findHeaderRow();
  if (hdrIdx < 0) return null;

  const hdrRow = rows[hdrIdx].map(c => String(c || ''));
  const colIndices = cols.map(clientCol => {
    const colN = norm(clientCol);
    let bestCi = -1; let bestScore = 0;
    hdrRow.forEach((cell, ci) => {
      const cn = norm(cell);
      if (!cn) return;
      let score = 0;
      if (cn === colN) score = 1.0;
      else if (cn.includes(colN) || colN.includes(cn)) score = 0.7;
      else {
        const minLen = Math.min(cn.length, colN.length);
        if (minLen > 1) {
          let common = 0;
          for (let i = 0; i < minLen; i++) { if (cn[i] === colN[i]) common++; }
          score = (common / Math.max(cn.length, colN.length)) * 0.5;
        }
      }
      if (score > bestScore) { bestScore = score; bestCi = ci; }
    });
    return bestScore >= 0.3 ? bestCi : -1;
  });

  // Parse skip patterns: "pattern" (any col) or "col_name:pattern" (specific col)
  const skipRules = String(client.skip_patterns || '')
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const ci = s.indexOf(':');
      if (ci > 0) {
        return { col: norm(s.slice(0, ci)), pattern: norm(s.slice(ci + 1)) };
      }
      return { col: null, pattern: norm(s) };
    })
    .filter(r => r.pattern);

  const colNormsMap = cols.map(norm);

  const shouldSkipRow = (outRow) => {
    if (!skipRules.length) return false;
    return skipRules.some(rule => {
      if (rule.col) {
        const ci = colNormsMap.indexOf(rule.col);
        if (ci < 0) return false;
        return norm(outRow[ci]).includes(rule.pattern);
      }
      return outRow.some(v => norm(v).includes(rule.pattern));
    });
  };

  const outRows = [cols.slice()];
  for (let ri = hdrIdx + 1; ri < rows.length; ri++) {
    const outRow = colIndices.map(ci => ci >= 0 ? String(rows[ri][ci] || '') : '');
    if (outRow.every(v => !v.trim())) continue;
    if (shouldSkipRow(outRow)) continue;
    outRows.push(outRow);
  }
  if (outRows.length <= 1) return null;

  return {
    name: (client.name_ja || client.code || '') + ' 発注書',
    rows: outRows,
    hasHeader: true,
    headerIdx: 0,
    customHeaders: [],
    clientHeaders: [],
    clientHeadingId: null,
  };
}

function _buildNanohanaExtractedSheet(sheets) {
  const mainSheet = sheets.find(s => s.name !== 'Full Text') || sheets[0];
  if (!mainSheet || !mainSheet.rows || mainSheet.rows.length < 3) return null;
  const rows = mainSheet.rows;

  // Find lower header row: contains "注文No" and "商品名"
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const rStr = rows[i].map(c => String(c || '')).join('');
    if ((rStr.includes('注文No') || rStr.includes('注文Ｎｏ')) && rStr.includes('商品名')) {
      hdrIdx = i; break;
    }
  }
  if (hdrIdx < 0) return null;

  const hdrRow  = rows[hdrIdx].map(c => String(c || '').trim());
  const dateRow = hdrIdx > 0 ? rows[hdrIdx - 1].map(c => String(c || '').trim()) : [];

  const findCol = (...terms) => {
    for (let ci = 0; ci < hdrRow.length; ci++) {
      if (terms.some(t => hdrRow[ci].includes(t))) return ci;
    }
    return -1;
  };
  const colOrderNo = findCol('注文No', '注文Ｎｏ', '注文no');
  const colToku    = findCol('特価');
  const colName    = findCol('商品名');
  const colSpec    = findCol('規格容量', '規格・容量', '規格/容量');
  const colPrice   = findCol('納入価格', '仕入価格');
  const colIrisu   = findCol('入数');
  if (colOrderNo < 0 || colName < 0) return null;

  // Identify C/P + 総数 column pairs from header row
  const pairs = [];
  for (let ci = 0; ci < hdrRow.length; ci++) {
    const v = hdrRow[ci];
    if (v === 'C/P' || v === 'C／P' || v === 'CP' || v === 'Ｃ／Ｐ' || v === 'C / P') {
      const nci = ci + 1;
      if (nci < hdrRow.length && hdrRow[nci].includes('総数')) {
        // Date is in dateRow at the C/P column position (or one before if merged)
        let dateLabel = (dateRow[ci] || '').trim();
        if (!dateLabel && ci > 0) dateLabel = (dateRow[ci - 1] || '').trim();
        pairs.push({ cpCol: ci, qtyCol: nci, dateLabel });
        ci = nci;
      }
    }
  }
  if (pairs.length === 0) return null;

  // Keep only pairs where the date header is a real date (not empty / not 納品日)
  const isDateStr = s => s !== '' && s !== '納品日' && !/^[\s/]+$/.test(s);
  const activePairs = pairs.filter(p => isDateStr(p.dateLabel));
  if (activePairs.length === 0) return null;

  const fixedCols = [
    { idx: colOrderNo, label: '注文No.' },
    { idx: colToku,    label: '特価' },
    { idx: colName,    label: '商品名' },
    { idx: colSpec,    label: '規格容量' },
    { idx: colPrice,   label: '納入価格' },
    { idx: colIrisu,   label: '入数' },
  ].filter(c => c.idx >= 0);

  // Upper row: blank for most fixed cols, 納品日 above 規格容量, then date labels
  const upperRow = fixedCols.map(c => c.label === '規格容量' ? '納品日' : '');
  activePairs.forEach(p => { upperRow.push(p.dateLabel); upperRow.push(''); });

  // Lower row: fixed column labels + C/P + 総数 for each active date
  const lowerRow = fixedCols.map(c => c.label);
  activePairs.forEach(() => { lowerRow.push('C/P'); lowerRow.push('総数'); });

  const outRows = [upperRow, lowerRow];

  for (let ri = hdrIdx + 1; ri < rows.length; ri++) {
    const row = rows[ri].map(c => String(c || ''));
    const orderVal = (row[colOrderNo] || '').trim();
    if (!orderVal || !/^\d/.test(orderVal)) continue;
    const outRow = fixedCols.map(c => row[c.idx] || '');
    activePairs.forEach(p => { outRow.push(row[p.cpCol] || ''); outRow.push(row[p.qtyCol] || ''); });
    outRows.push(outRow);
  }

  if (outRows.length <= 2) return null;

  return {
    name: 'なのはな発注書',
    rows: outRows,
    hasHeader: true,
    headerIdx: 1,
    customHeaders: [],
    clientHeaders: [],
    clientHeadingId: null,
  };
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

  if (!result) { loading.textContent = 'データを読み込めませんでした。'; return; }

  try {
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
    // Auto-apply client heading for the detected client across all sheets
    if (initialClientId) {
      const detectedClient = _xlsAllClients.find(c => String(c.id) === String(initialClientId));
      if (detectedClient) {
        _xlsSheets.forEach(sheet => {
          if (sheet.clientHeadingId == null) {
            _applyClientHeadingToSheet(sheet, detectedClient);
          }
        });
      }
    }
  }

  // Inject extracted sheet as first tab: なのはな uses special multi-date extraction; other clients use heading_columns config
  {
    const jobMeta2 = Array.isArray(_orderAllJobs) ? _orderAllJobs.find(j => j.job_id === jobId) : null;
    const isNanohana =
      (jobMeta2?.client_name_ja || '').includes('なのはな') ||
      (result.fused_text || result.text || '').includes('なのはな');
    if (isNanohana) {
      const nanoSheet = _buildNanohanaExtractedSheet(_xlsSheets);
      if (nanoSheet) _xlsSheets.unshift(nanoSheet);
    } else {
      const detectedClientId = clientSelectEl ? clientSelectEl.value : '';
      if (detectedClientId) {
        const detectedClient = _xlsAllClients.find(c => String(c.id) === String(detectedClientId));
        if (detectedClient && detectedClient.heading_columns) {
          const extractedSheet = _buildClientExtractedSheet(_xlsSheets, detectedClient);
          if (extractedSheet) _xlsSheets.unshift(extractedSheet);
        }
      }
    }
  }

  // Document View tab (default)
  const docTab = document.createElement('div');
  docTab.className = 'xls-sheet-tab xls-sheet-tab-doc';
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
  if (_xlsSheets.length > 0) {
    _xlsActiveSheet = 0;
    document.getElementById('xlsDocWrap').classList.add('hidden');
    document.getElementById('xlsGridWrap').classList.remove('hidden');
    const _fbar = document.querySelector('.xls-formulabar');
    if (_fbar) _fbar.classList.remove('xls-formulabar-hidden');
    const _cbar = document.getElementById('xlsClientHeadingBar');
    if (_cbar) _cbar.classList.remove('xls-client-bar-hidden');
    const firstSheetTab = sheetTabsEl.querySelector('.xls-sheet-tab:not(.xls-sheet-tab-doc)');
    if (firstSheetTab) firstSheetTab.classList.add('active');
    _renderXlsGrid(_xlsSheets[0]);
    _updateXlsClientBarUI();
  } else {
    _xlsActiveSheet = -1;
    document.getElementById('xlsDocWrap').classList.remove('hidden');
    const _fbar = document.querySelector('.xls-formulabar');
    if (_fbar) _fbar.classList.add('xls-formulabar-hidden');
    const _cbar = document.getElementById('xlsClientHeadingBar');
    if (_cbar) _cbar.classList.add('xls-client-bar-hidden');
    docTab.classList.add('active');
    _renderDocumentView(_xlsResult);
  }

  } catch(err) {
    loading.classList.remove('hidden');
    loading.textContent = 'エラー: ' + (err && err.message ? err.message : String(err));
    console.error('[openOrderPreview]', err);
    return;
  }

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
  if (cid.startsWith('__fmt__:')) {
    const key = cid.slice(8);
    const cfg = TODAY_ORDER_FORMATS[key];
    if (cfg) return { mode: 'today_fmt', fmt: key, cfg, label: TODAY_FMT_LABELS[key] || key };
    return null;
  }
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
  if (!info) {
    preview.classList.add('hidden');
    return;
  }
  const { mode } = info;
  preview.classList.remove('hidden');

  if (mode === 'today_fmt') {
    if (modeBadge) {
      modeBadge.classList.toggle('mode-manual', true);
      modeBadge.classList.toggle('mode-auto', false);
      modeBadge.textContent = '📋 発注書フォーマット指定';
    }
    if (nameEl) nameEl.textContent = info.label;
    if (rowBadge) rowBadge.textContent = `${info.cfg.cols} 列`;
    if (colsEl) colsEl.textContent = info.cfg.downloadName.replace(/\.xlsx?$/i, '');
    return;
  }

  if (!info.client) { preview.classList.add('hidden'); return; }
  const { client } = info;
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
  if (!info) {
    showToast('見出しを設定する取引先をプルダウンから選択してください', true);
    return;
  }
  if (info.mode === 'today_fmt') {
    showToast('本日の発注書フォーマットには見出し設定はありません。取引先マスタから選択してください。', true);
    return;
  }
  if (!info.client) {
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

  // Auto-select matching client from filename
  const upSel = document.getElementById('uploadClientSelect');
  if (upSel && _xlsAllClients.length) {
    const autoClient = _detectClientFromFilenameClientSide(file.name, _xlsAllClients);
    upSel.value = autoClient ? String(autoClient.id) : '';
  }

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
    const _rawClientVal = document.getElementById("uploadClientSelect")?.value || "";
    // __fmt__: values are today-order hints for display only; strip them before sending to the backend
    const selectedClientId = _rawClientVal.startsWith('__fmt__:') ? '' : _rawClientVal;
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
        if (!currentResult) throw new Error("Server returned an empty result");
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
  if (!res) return;
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

  // --- 取引先 OCR tab: extract only the client's configured columns --------
  const _clientOcrTabBtn = document.querySelector('[data-tab="client-ocr"]');
  const _clientOcrPanel  = document.getElementById('tab-client-ocr');
  let _clientOcrActivate = false;

  if (_clientOcrTabBtn && _clientOcrPanel && activeClient && activeClient.heading_columns) {
    const _clientCols = _parseClientHeadingCols(activeClient);
    let _ocrCols = null, _ocrDataRows = null;

    // Priority 1: paddle_extracted_rows — bbox-based alignment (best for image/PDF)
    if (Array.isArray(res.paddle_extracted_rows) && res.paddle_extracted_rows.length > 0) {
      const allKeys = _clientCols.length ? [..._clientCols] : [];
      res.paddle_extracted_rows.forEach(row => { Object.keys(row).forEach(k => { if (!allKeys.includes(k)) allKeys.push(k); }); });
      if (allKeys.length) { _ocrCols = allKeys; _ocrDataRows = res.paddle_extracted_rows.map(row => allKeys.map(k => row[k] || '')); }
    }

    // Priority 2: client_extracted_rows from Docling tables
    if (!_ocrDataRows) {
      const exTbl = (res.tables || []).find(t => Array.isArray(t.client_extracted_rows) && t.client_extracted_rows.length > 0);
      if (exTbl) {
        _ocrCols = exTbl.client_headers || _clientCols;
        _ocrDataRows = exTbl.client_extracted_rows.map(row => _ocrCols.map(k => row[k] || ''));
      }
    }

    // Priority 3: build from custom_sheets (Excel files)
    if (!_ocrDataRows && Array.isArray(res.custom_sheets) && res.custom_sheets.some(s => s.name !== 'Full Text' && Array.isArray(s.rows) && s.rows.length > 1)) {
      const builtSheet = _buildClientExtractedSheet(_buildSheets(res), activeClient);
      if (builtSheet && builtSheet.rows.length > 1) {
        _ocrCols = builtSheet.rows[0];
        _ocrDataRows = builtSheet.rows.slice(1);
      }
    }

    if (_ocrCols && _ocrDataRows && _ocrDataRows.length > 0) {
      const _thead = `<thead><tr>${_ocrCols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
      const _tbody = `<tbody>${_ocrDataRows.map((r, ri) =>
        `<tr class="${ri % 2 === 1 ? 'tbl-alt' : ''}">${r.map(v => `<td>${esc(v || '')}</td>`).join('')}</tr>`
      ).join('')}</tbody>`;
      _clientOcrPanel.innerHTML = `
        <div class="client-ocr-header">
          <span class="client-ocr-name">${esc(activeClient.name_ja || activeClient.code || '')}</span>
          <div class="client-ocr-cols">${_ocrCols.map(c => `<span class="client-col-chip">${esc(c)}</span>`).join('')}</div>
          <span class="client-ocr-count">${_ocrDataRows.length} 行抽出</span>
        </div>
        <div class="tbl-scroll"><table class="tbl-grid">${_thead}${_tbody}</table></div>
        <p class="client-ocr-note">設定された見出し列のみ表示しています。値が見つからない場合は空白で表示されます。</p>
      `;
      _clientOcrTabBtn.classList.remove('hidden');
      _clientOcrActivate = !preserveTab;
    } else {
      _clientOcrTabBtn.classList.add('hidden');
    }
  } else if (_clientOcrTabBtn) {
    _clientOcrTabBtn.classList.add('hidden');
  }

  if (!preserveTab) {
    if (_clientOcrActivate) {
      // Activate 取引先 OCR tab
      document.querySelectorAll(".tab").forEach(t => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
      _clientOcrTabBtn.classList.add("active");
      _clientOcrTabBtn.setAttribute("aria-selected", "true");
      _clientOcrPanel.classList.remove("hidden");
    } else {
      // Reset to Fused tab (default when no client extraction)
      document.querySelectorAll(".tab").forEach(t => {
        const isFused = t.dataset.tab === "fused";
        t.classList.toggle("active", isFused);
        t.setAttribute("aria-selected", String(isFused));
      });
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
      document.getElementById("tab-fused").classList.remove("hidden");
    }
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
      if (typeof window._onJobSaved === "function") window._onJobSaved(saved, currentResult);
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
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("toast-err", !!isErr);
  el.style.background = "";
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), duration);
}

function showConfirmToast(message, opts = {}) {
  const {
    confirmText = "削除する",
    cancelText = "キャンセル",
    danger = true,
  } = opts;
  return new Promise((resolve) => {
    let container = document.getElementById("confirmToastContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "confirmToastContainer";
      container.className = "confirm-toast-container";
      document.body.appendChild(container);
    }
    container.innerHTML = "";

    const card = document.createElement("div");
    card.className = "confirm-toast" + (danger ? "" : " primary");
    card.setAttribute("role", "alertdialog");

    const body = document.createElement("div");
    body.className = "confirm-toast-body";

    const icon = document.createElement("div");
    icon.className = "confirm-toast-icon";
    icon.textContent = danger ? "🗑" : "⚠";

    const msgEl = document.createElement("div");
    msgEl.className = "confirm-toast-msg";
    msgEl.textContent = message;

    body.appendChild(icon);
    body.appendChild(msgEl);

    const actions = document.createElement("div");
    actions.className = "confirm-toast-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "confirm-toast-btn cancel";
    cancelBtn.textContent = cancelText;

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "confirm-toast-btn ok";
    okBtn.textContent = confirmText;

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    card.appendChild(body);
    card.appendChild(actions);
    container.appendChild(card);

    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      card.remove();
      resolve(result);
    }
    function onKey(e) {
      if (e.key === "Escape") finish(false);
    }
    document.addEventListener("keydown", onKey);
    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", () => finish(true));
    cancelBtn.focus();
  });
}

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
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
          if (!(await showConfirmToast('この解析履歴を削除しますか？'))) return;
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
      if (!(await showConfirmToast(`${ids.length} 件の解析履歴を削除しますか？\nこの操作は元に戻せません。`))) return;
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
  window._onJobSaved = function(saved, ocrResult) {
    if (origSavedHandler) origSavedHandler(saved, ocrResult);
    setTimeout(() => { loadClients(); loadHistory(); }, 250);
    if (ocrResult) _navigateToTodayOrder(ocrResult);
  };
})();

/* ═══════════════════════════════════════════════════════════
   Authentication Guard, User Badge, Change Password & Logout
═══════════════════════════════════════════════════════════ */
(function initAuthModule() {
  // Redirect to /login on any 401 response from API endpoints
  const nativeFetch = window.fetch.bind(window);
  let _redirectingToLogin = false;
  window.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const res = await nativeFetch(input, init);
    if (res.status === 401 && !url.includes("/api/auth/login") && !_redirectingToLogin) {
      _redirectingToLogin = true;
      window.location.replace("/login");
    }
    return res;
  };

  async function loadCurrentUser() {
    try {
      const res = await nativeFetch("/api/auth/me", { credentials: "same-origin" });
      if (res.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const user = data && data.user;
      if (!user) return;
      const nameEl = document.getElementById("sidebarUserName");
      const roleEl = document.getElementById("sidebarUserRole");
      const avatarEl = document.getElementById("sidebarUserAvatar");
      const display = user.display_name || user.username || "User";
      if (nameEl) nameEl.textContent = display;
      if (roleEl) roleEl.textContent = user.role || "user";
      if (avatarEl) avatarEl.textContent = display.trim().charAt(0).toUpperCase() || "U";
      const settingsBtn = document.getElementById("openSettingsBtn");
      if (settingsBtn && user.role === "admin") {
        settingsBtn.style.display = "";
      }
    } catch (_) {
      // Ignore transient network errors on initial user badge load
    }
  }

  function setupAuthControls() {
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        logoutBtn.disabled = true;
        try {
          await nativeFetch("/api/auth/logout", {
            method: "POST",
            credentials: "same-origin",
          });
        } catch (_) {
          // Proceed to login even if logout request fails
        }
        window.location.replace("/login");
      });
    }

    const backdrop = document.getElementById("changePwModalBackdrop");
    const openBtn = document.getElementById("openChangePwBtn");
    const cancelBtn = document.getElementById("cpCancelBtn");
    const saveBtn = document.getElementById("cpSaveBtn");
    const curInput = document.getElementById("cpCurrentPw");
    const newInput = document.getElementById("cpNewPw");
    const confirmInput = document.getElementById("cpConfirmPw");
    const errBox = document.getElementById("cpError");

    function showErr(msg) {
      if (!errBox) return;
      if (!msg) {
        errBox.style.display = "none";
        errBox.textContent = "";
      } else {
        errBox.textContent = msg;
        errBox.style.display = "block";
      }
    }

    function openModal() {
      if (!backdrop) return;
      if (curInput) curInput.value = "";
      if (newInput) newInput.value = "";
      if (confirmInput) confirmInput.value = "";
      showErr("");
      backdrop.classList.remove("hidden");
      if (curInput) curInput.focus();
    }

    function closeModal() {
      if (!backdrop) return;
      backdrop.classList.add("hidden");
      showErr("");
    }

    if (openBtn) openBtn.addEventListener("click", openModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
    if (backdrop) {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) closeModal();
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const curPw = curInput ? curInput.value : "";
        const newPw = newInput ? newInput.value : "";
        const confirmPw = confirmInput ? confirmInput.value : "";

        if (!curPw || !newPw || !confirmPw) {
          showErr("All password fields are required.");
          return;
        }
        if (newPw.length < 8) {
          showErr("New password must be at least 8 characters.");
          return;
        }
        if (newPw !== confirmPw) {
          showErr("New passwords do not match.");
          return;
        }

        saveBtn.disabled = true;
        showErr("");
        try {
          const res = await nativeFetch("/api/auth/change-password", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ current_password: curPw, new_password: newPw }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            showErr(body.detail || "Failed to update password.");
            saveBtn.disabled = false;
            return;
          }
          closeModal();
          window.location.replace("/login");
        } catch (_) {
          showErr("Network error while updating password.");
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    // Admin System Settings Modal
    const sBackdrop = document.getElementById("settingsModalBackdrop");
    const sOpenBtn = document.getElementById("openSettingsBtn");
    const sCancelBtn = document.getElementById("settingsCancelBtn");
    const sSaveBtn = document.getElementById("settingsSaveBtn");
    const sList = document.getElementById("settingsList");
    const sErr = document.getElementById("settingsError");

    function showSettingsErr(msg) {
      if (!sErr) return;
      if (!msg) {
        sErr.style.display = "none";
        sErr.textContent = "";
      } else {
        sErr.textContent = msg;
        sErr.style.display = "block";
      }
    }

    async function openSettingsModal() {
      if (!sBackdrop || !sList) return;
      showSettingsErr("");
      sList.innerHTML = '<div style="color:#64748b;font-size:13px;">読み込み中...</div>';
      sBackdrop.classList.remove("hidden");
      try {
        const res = await nativeFetch("/api/settings", { credentials: "same-origin" });
        if (res.status === 401) {
          window.location.replace("/login");
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showSettingsErr(data.detail || "設定の取得に失敗しました。");
          sList.innerHTML = "";
          return;
        }
        const items = data.settings || [];
        sList.innerHTML = "";
        items.forEach((item) => {
          const wrap = document.createElement("div");
          wrap.className = "settings-item";

          const head = document.createElement("div");
          head.className = "settings-item-head";
          const keySpan = document.createElement("span");
          keySpan.className = "settings-item-key";
          keySpan.textContent = item.setting_key;
          const catSpan = document.createElement("span");
          catSpan.className = "settings-item-cat";
          catSpan.textContent = item.category || "general";
          head.appendChild(keySpan);
          head.appendChild(catSpan);

          const desc = document.createElement("div");
          desc.className = "settings-item-desc";
          desc.textContent = item.description || "";

          const input = document.createElement("input");
          input.className = "modal-input settings-input";
          input.dataset.settingKey = item.setting_key;
          input.type = item.value_type === "int" ? "number" : (item.is_secret ? "password" : "text");
          input.value = item.setting_value || "";
          if (item.is_secret) {
            input.placeholder = "未設定 (変更する場合のみ入力)";
          }

          wrap.appendChild(head);
          wrap.appendChild(desc);
          wrap.appendChild(input);
          sList.appendChild(wrap);
        });
      } catch (_) {
        showSettingsErr("設定の読み込み中に通信エラーが発生しました。");
        sList.innerHTML = "";
      }
    }

    function closeSettingsModal() {
      if (!sBackdrop) return;
      sBackdrop.classList.add("hidden");
      showSettingsErr("");
    }

    if (sOpenBtn) sOpenBtn.addEventListener("click", openSettingsModal);
    if (sCancelBtn) sCancelBtn.addEventListener("click", closeSettingsModal);
    if (sBackdrop) {
      sBackdrop.addEventListener("click", (e) => {
        if (e.target === sBackdrop) closeSettingsModal();
      });
    }
    if (sSaveBtn) {
      sSaveBtn.addEventListener("click", async () => {
        if (!sList) return;
        const inputs = sList.querySelectorAll(".settings-input");
        const payload = {};
        inputs.forEach((inp) => {
          if (inp.dataset.settingKey) {
            payload[inp.dataset.settingKey] = inp.value;
          }
        });
        sSaveBtn.disabled = true;
        showSettingsErr("");
        try {
          const res = await nativeFetch("/api/settings", {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings: payload }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            showSettingsErr(body.detail || "設定の保存に失敗しました。");
            sSaveBtn.disabled = false;
            return;
          }
          closeSettingsModal();
        } catch (_) {
          showSettingsErr("設定の保存中に通信エラーが発生しました。");
        } finally {
          sSaveBtn.disabled = false;
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      loadCurrentUser();
      setupAuthControls();
    });
  } else {
    loadCurrentUser();
    setupAuthControls();
  }
})();

// ============================================================
// Saved JSON Viewer
// ============================================================
let _savedJsonJobs     = [];
let _savedJsonLoaded   = false;
let _savedJsonSelId    = null;
let _savedJsonTab      = 'data'; // 'data' | 'json' | 'summary'

function initSavedJsonView() {
  const refreshBtn    = document.getElementById('savedJsonRefreshBtn');
  const searchEl      = document.getElementById('savedJsonSearch');
  const allExcelBtn   = document.getElementById('savedJsonAllExcelBtn');
  if (refreshBtn && !refreshBtn._sjBound) {
    refreshBtn._sjBound = true;
    refreshBtn.addEventListener('click', () => {
      _savedJsonLoaded = false;
      _loadSavedJsonJobs();
    });
  }
  if (searchEl && !searchEl._sjBound) {
    searchEl._sjBound = true;
    searchEl.addEventListener('input', () => _renderSavedJsonList(searchEl.value || ''));
  }
  if (allExcelBtn && !allExcelBtn._sjBound) {
    allExcelBtn._sjBound = true;
    allExcelBtn.addEventListener('click', async () => {
      const q = document.getElementById('savedJsonSearch')?.value?.toLowerCase() || '';
      const targetJobs = q
        ? _savedJsonJobs.filter(j =>
            (j.filename || '').toLowerCase().includes(q) ||
            (j.client_name_ja || j.client_name || '').toLowerCase().includes(q))
        : _savedJsonJobs;
      const ids = (targetJobs.length ? targetJobs : _savedJsonJobs).map(j => j.job_id).filter(Boolean);
      if (!ids.length) { showToast('エクスポートするデータがありません', true); return; }
      allExcelBtn.disabled = true;
      allExcelBtn.textContent = `⏳ 変換中 (${ids.length}件)…`;
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 60000);
        let r;
        try {
          r = await fetch(`${API_BASE}/api/ocr/export-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_ids: ids }),
            signal: ctrl.signal,
          });
        } finally { clearTimeout(tid); }
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          const msg = typeof err.detail === 'string' ? err.detail : `HTTP ${r.status}`;
          throw new Error(msg);
        }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        a.href = url;
        a.download = `ocr_batch_${today}.xlsx`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
        showToast(`${ids.length}件をExcelにエクスポートしました`);
      } catch (e) {
        const msg = e.name === 'AbortError' ? 'タイムアウト' : e.message;
        showToast('全件Excel変換に失敗しました: ' + msg, true);
      } finally {
        allExcelBtn.disabled = false;
        allExcelBtn.textContent = '📊 全件 Excel';
      }
    });
  }
  if (!_savedJsonLoaded) _loadSavedJsonJobs();
}

async function _loadSavedJsonJobs() {
  const listEl  = document.getElementById('savedJsonList');
  const countEl = document.getElementById('savedJsonCount');
  if (!listEl) return;
  listEl.innerHTML = '<div class="saved-json-placeholder">読み込み中…</div>';
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 10000);
    let r;
    try {
      r = await fetch(`${API_BASE}/api/db/jobs?limit=500`, { signal: ctrl.signal });
    } finally {
      clearTimeout(tid);
    }
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      throw new Error(detail.detail || `HTTP ${r.status}`);
    }
    _savedJsonJobs   = await r.json();
    _savedJsonLoaded = true;
    if (countEl) countEl.textContent = `${_savedJsonJobs.length} 件`;
    _renderSavedJsonList(document.getElementById('savedJsonSearch')?.value || '');
  } catch (err) {
    if (countEl) countEl.textContent = '— 件';
    const msg = err.name === 'AbortError' ? 'タイムアウト（MySQL未接続の可能性があります）' : esc(err.message);
    listEl.innerHTML = `<div class="saved-json-placeholder" style="color:#dc2626">エラー: ${msg}</div>`;
  }
}

function _renderSavedJsonList(query) {
  const listEl = document.getElementById('savedJsonList');
  if (!listEl) return;
  const q = query.toLowerCase();
  const rows = q
    ? _savedJsonJobs.filter(j =>
        (j.filename || '').toLowerCase().includes(q) ||
        (j.client_name_ja || j.client_name || '').toLowerCase().includes(q))
    : _savedJsonJobs;

  if (!rows.length) {
    listEl.innerHTML = '<div class="saved-json-placeholder">データがありません</div>';
    return;
  }

  listEl.innerHTML = rows.map(j => {
    const name   = esc(j.filename || j.job_id || '—');
    const client = esc(j.client_name_ja || j.client_name || '—');
    const dt     = esc((j.created_at || '').replace('T', ' ').substring(0, 16));
    const isActive = j.job_id === _savedJsonSelId ? ' active' : '';
    const statusColor = j.status === 'done' ? 'var(--success)' : j.status === 'error' ? '#dc2626' : 'var(--accent)';
    return `<div class="saved-json-item${isActive}" data-job-id="${esc(j.job_id)}">
      <div class="saved-json-item-name" title="${name}">${name}</div>
      <div class="saved-json-item-meta">
        <span class="saved-json-badge">${client}</span>
        <span class="saved-json-date">${dt}</span>
        <span style="margin-left:auto;font-size:11px;color:${statusColor}">${esc(j.status || '')}</span>
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.saved-json-item').forEach(el => {
    el.addEventListener('click', () => {
      _savedJsonSelId = el.dataset.jobId;
      listEl.querySelectorAll('.saved-json-item').forEach(i => i.classList.remove('active'));
      el.classList.add('active');
      _loadSavedJsonDetail(el.dataset.jobId);
    });
  });
}

async function _loadSavedJsonDetail(jobId) {
  const viewerEl = document.getElementById('savedJsonViewer');
  if (!viewerEl) return;
  viewerEl.innerHTML = '<div class="saved-json-placeholder">読み込み中…</div>';
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 10000);
    let r;
    try {
      r = await fetch(`${API_BASE}/api/db/jobs/${encodeURIComponent(jobId)}`, { signal: ctrl.signal });
    } finally {
      clearTimeout(tid);
    }
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      throw new Error(detail.detail || `HTTP ${r.status}`);
    }
    const data = await r.json();
    _renderSavedJsonDetail(viewerEl, data);
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'タイムアウト' : esc(err.message);
    viewerEl.innerHTML = `<div class="saved-json-placeholder" style="color:#dc2626">エラー: ${msg}</div>`;
  }
}

// Extract displayable OCR data from a saved job result.
// The API returns a DB row where `result_json` is a raw string containing
// the full OCR output. This helper parses that string first, then walks the
// priority chain: paddle_extracted_rows > client_extracted_rows > tables[].data
// > db tables[].data_json > custom_sheets > fused_text.
// Returns { type, cols, rows, tables, text, source } or null.
function _extractSavedJobDisplayData(data) {
  if (!data || typeof data !== 'object') return null;

  // Parse result_json string into the full OCR result object
  let parsed = data;
  if (typeof data.result_json === 'string' && data.result_json.trim()) {
    try {
      const full = JSON.parse(data.result_json);
      if (full && typeof full === 'object') parsed = full;
    } catch (_) {}
  }

  // Priority 1: paddle_extracted_rows — bbox-aligned, best for image/PDF
  const paddleRows = parsed.paddle_extracted_rows;
  if (Array.isArray(paddleRows) && paddleRows.length > 0 && typeof paddleRows[0] === 'object') {
    const cols = [];
    paddleRows.forEach(row => { Object.keys(row).forEach(k => { if (!cols.includes(k)) cols.push(k); }); });
    if (cols.length) {
      return { type: 'table', cols, rows: paddleRows.map(r => cols.map(k => String(r[k] ?? ''))), source: 'PaddleOCR' };
    }
  }

  // Priority 2: client_extracted_rows from Docling tables (inside result_json)
  const rjTables = Array.isArray(parsed.tables) ? parsed.tables : [];
  for (const tbl of rjTables) {
    const exRows = tbl.client_extracted_rows;
    if (Array.isArray(exRows) && exRows.length > 0 && typeof exRows[0] === 'object') {
      const cols = Array.isArray(tbl.client_headers) && tbl.client_headers.length
        ? [...tbl.client_headers] : Object.keys(exRows[0]);
      return { type: 'table', cols, rows: exRows.map(r => cols.map(k => String(r[k] ?? ''))), source: 'Docling' };
    }
  }

  // Priority 3: raw tables[].data inside result_json
  const docTables = [];
  for (const tbl of rjTables) {
    const tData = tbl.data;
    if (Array.isArray(tData) && tData.length > 0 && typeof tData[0] === 'object' && !Array.isArray(tData[0])) {
      const cols = Object.keys(tData[0]);
      if (cols.length) docTables.push({ cols, rows: tData.map(r => cols.map(k => String(r[k] ?? ''))), title: tbl.name || '' });
    }
  }
  if (docTables.length) return { type: 'multi_table', tables: docTables, source: 'Docling' };

  // Priority 4: DB tables (data.tables from /api/db/jobs/{id}) — each row has data_json
  const dbTables = [];
  for (const tbl of (Array.isArray(data.tables) ? data.tables : [])) {
    let tData = tbl.data_json;
    if (typeof tData === 'string') { try { tData = JSON.parse(tData); } catch (_) { tData = null; } }
    if (Array.isArray(tData) && tData.length > 0 && typeof tData[0] === 'object' && !Array.isArray(tData[0])) {
      const cols = Object.keys(tData[0]);
      if (cols.length) dbTables.push({ cols, rows: tData.map(r => cols.map(k => String(r[k] ?? ''))), title: tbl.caption || '' });
    }
  }
  if (dbTables.length) return { type: 'multi_table', tables: dbTables, source: 'Docling' };

  // Priority 5: custom_sheets (Excel input, inside result_json)
  const customSheets = Array.isArray(parsed.custom_sheets) ? parsed.custom_sheets : [];
  const dataSheets = customSheets.filter(s => s.name !== 'Full Text' && Array.isArray(s.rows) && s.rows.length > 1);
  if (dataSheets.length) {
    const sheetTables = dataSheets.map(s => {
      const hdrIdx = typeof s.headerIdx === 'number' ? s.headerIdx : 0;
      const cols = (s.rows[hdrIdx] || []).map(c => String(c ?? ''));
      const bodyRows = s.rows.slice(hdrIdx + 1).map(r => r.map(v => String(v ?? '')));
      return { cols, rows: bodyRows, title: s.name || '' };
    });
    return { type: 'multi_table', tables: sheetTables, source: 'Excel' };
  }

  // Priority 6: fused_text — top-level DB column or inside result_json
  const text = data.fused_text || parsed.fused_text || data.text || parsed.text;
  if (text && String(text).trim()) return { type: 'text', text: String(text), source: 'OCR テキスト' };

  return null;
}

// Build TSV string from extracted display data (for clipboard copy).
function _extractedDataToTsv(extracted) {
  if (!extracted) return null;
  if (extracted.type === 'text') return extracted.text;
  const src = extracted.type === 'table' ? [extracted] : (extracted.tables || []);
  return src.map(t => [
    t.cols.join('\t'),
    ...t.rows.map(r => r.join('\t'))
  ].join('\n')).join('\n\n');
}

function _renderSavedJsonDetail(viewerEl, data) {
  const filename = esc(data.filename || data.job_id || '');
  const json     = JSON.stringify(data, null, 2);

  // Metadata summary (scalar top-level fields only, excluding technical internals)
  const SKIP_META = new Set(['job_id','engine_requested','client_id','status','primary_engine',
    'confidence_avg','processing_time_s','error_message','raw_json','result_json','fused_text',
    'text','markdown','paddle_extracted_rows','tables','custom_sheets','engines','client','client_ocr','paddle']);
  const summaryRows = Object.entries(data)
    .filter(([k, v]) => !SKIP_META.has(k) && v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `<tr><td style="color:var(--text-muted);white-space:nowrap">${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
    .join('');

  // Extract displayable OCR data once; reused by tab renderer and copy button
  const extractedData = _extractSavedJobDisplayData(data);

  const jobId = data.job_id || '';
  const baseName = filename.replace(/\.[^.]+$/, '') || jobId;

  // Ensure default tab is valid; if previously on 'table' (old name) fall back to 'data'
  if (_savedJsonTab === 'table') _savedJsonTab = 'data';

  const _srcLabel = extractedData ? `<span class="saved-json-src-label">${esc(extractedData.source)}</span>` : '';
  viewerEl.innerHTML = `
    <div class="saved-json-viewer-header">
      <span class="saved-json-viewer-title" title="${filename}">${filename}</span>
      <button class="btn-sm" id="savedJsonExcelBtn" title="Excelファイルとしてダウンロード" style="color:#1a7641;border-color:#1a7641">📊 Excel</button>
      <button class="btn-sm" id="savedJsonCopyBtn" title="表データをTSVでコピー（Excelに貼り付け可能）">📋 コピー</button>
      <a class="btn-sm" id="savedJsonDlBtn" title="JSONをダウンロード" download="${baseName}_result.json">⬇ DL</a>
    </div>
    <div class="saved-json-viewer-tabs">
      <button class="saved-json-tab${_savedJsonTab === 'data' ? ' active' : ''}" data-tab="data">📊 データ</button>
      <button class="saved-json-tab${_savedJsonTab === 'json' ? ' active' : ''}" data-tab="json">📄 JSON</button>
      <button class="saved-json-tab${_savedJsonTab === 'summary' ? ' active' : ''}" data-tab="summary">📋 サマリー</button>
    </div>
    <div id="savedJsonTabContent" style="flex:1;overflow:auto;display:flex;flex-direction:column"></div>
  `;

  const copyBtn = viewerEl.querySelector('#savedJsonCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const tsv = _extractedDataToTsv(extractedData);
      const textToCopy = tsv || json;
      const msg = tsv && extractedData.type !== 'text' ? '表データをコピーしました (TSV)' : 'JSONをコピーしました';
      navigator.clipboard.writeText(textToCopy).then(() => showToast(msg)).catch(() => {});
    });
  }

  const dlBtn = viewerEl.querySelector('#savedJsonDlBtn');
  if (dlBtn) {
    const blob = new Blob([json], { type: 'application/json' });
    dlBtn.href = URL.createObjectURL(blob);
  }

  const excelBtn = viewerEl.querySelector('#savedJsonExcelBtn');
  if (excelBtn && jobId) {
    excelBtn.addEventListener('click', async () => {
      excelBtn.disabled = true;
      excelBtn.textContent = '⏳ 変換中…';
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 30000);
        let r;
        try {
          r = await fetch(`${API_BASE}/api/ocr/export/${encodeURIComponent(jobId)}?format=xlsx`, { signal: ctrl.signal });
        } finally {
          clearTimeout(tid);
        }
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          const detail = err.detail;
          const msg = typeof detail === 'string' ? detail
            : Array.isArray(detail) ? detail.map(d => d.msg || JSON.stringify(d)).join(', ')
            : detail ? JSON.stringify(detail) : `HTTP ${r.status}`;
          throw new Error(msg);
        }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}_result.xlsx`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
        showToast('Excelファイルをダウンロードしました');
      } catch (e) {
        const msg = e.name === 'AbortError' ? 'タイムアウト' : e.message;
        showToast('Excel変換に失敗しました: ' + msg, true);
      } finally {
        excelBtn.disabled = false;
        excelBtn.textContent = '📊 Excel';
      }
    });
  } else if (excelBtn) {
    excelBtn.disabled = true;
    excelBtn.title = 'ジョブIDが不明';
  }

  viewerEl.querySelectorAll('.saved-json-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _savedJsonTab = tab.dataset.tab;
      viewerEl.querySelectorAll('.saved-json-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === _savedJsonTab));
      _renderSavedJsonTabContent(viewerEl, json, summaryRows, extractedData);
    });
  });

  _renderSavedJsonTabContent(viewerEl, json, summaryRows, extractedData);
}

function _renderSavedJsonTabContent(viewerEl, json, summaryRows, extractedData) {
  const content = viewerEl.querySelector('#savedJsonTabContent');
  if (!content) return;

  if (_savedJsonTab === 'json') {
    content.innerHTML = `<div class="saved-json-code-wrap"><pre class="saved-json-code">${esc(json)}</pre></div>`;
    return;
  }

  if (_savedJsonTab === 'summary') {
    content.innerHTML = `<div class="saved-json-table-wrap"><table class="saved-json-table">
      <thead><tr><th>フィールド</th><th>値</th></tr></thead>
      <tbody>${summaryRows || '<tr><td colspan="2" style="text-align:center;color:var(--text-muted)">表示できるメタデータがありません</td></tr>'}</tbody>
    </table></div>`;
    return;
  }

  // ── 📊 データ tab: show extracted OCR rows ──────────────────────
  if (!extractedData) {
    content.innerHTML = `<div class="saved-json-empty-data">
      <div class="saved-json-empty-icon">📄</div>
      <div>抽出されたデータがありません</div>
      <div class="saved-json-empty-hint">📄 JSON タブで生データを確認できます</div>
    </div>`;
    return;
  }

  if (extractedData.type === 'text') {
    content.innerHTML = `<div class="saved-json-data-wrap">
      <div class="saved-json-src-row"><span class="saved-json-src-label">ソース: ${esc(extractedData.source)}</span></div>
      <pre class="saved-json-code" style="margin:0;border-radius:0;border-left:none;border-right:none">${esc(extractedData.text)}</pre>
    </div>`;
    return;
  }

  const renderOneTable = (t, index) => {
    if (!t.cols.length && !t.rows.length) return '';
    const titleBar = t.title ? `<div class="saved-json-sheet-label">${esc(t.title)}</div>` : '';
    const thead = `<thead><tr>${t.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${t.rows.map((r, ri) =>
      `<tr class="${ri % 2 === 1 ? 'tbl-alt' : ''}">${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`
    ).join('')}</tbody>`;
    const info = `<div class="saved-json-data-info">${t.rows.length} 行 × ${t.cols.length} 列</div>`;
    return `${titleBar}<div class="tbl-scroll"><table class="tbl-grid">${thead}${tbody}</table></div>${info}`;
  };

  const sources = extractedData.type === 'table' ? [extractedData] : (extractedData.tables || []);
  const srcLabel = `<div class="saved-json-src-row"><span class="saved-json-src-label">ソース: ${esc(extractedData.source)}</span></div>`;
  const tableHtml = sources.map((t, i) =>
    (i > 0 ? '<hr class="saved-json-sheet-sep">' : '') + renderOneTable(t, i)
  ).join('');

  content.innerHTML = `<div class="saved-json-data-wrap">${srcLabel}${tableHtml}</div>`;
}

