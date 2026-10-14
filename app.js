/* ================= Product query system with auto-load ================= */

const SKU_KEYS = ['jdsku', 'sku', 'jingsku', 'jdsuite', 'productid'];
const MAT_KEYS = ['material', 'matno', 'partno', 'liaohao'];
const SKU_CN_KEYS = ['京东sku', '京东套餐sku', '子sku', '京东商品编号'];
const MAT_CN_KEYS = ['最新料号', '雷士物料号', '物料号', '订单部最新料号', '厂送料号', '雷士料号', '料号', '旧料号', '技改料号', '最旧料号'];
const BAD_SKU_CN_KEYS = ['数量', '金额', '单价', '总价', '件数', '销量'];

// 数据版本号 - 更新数据时需要修改此版本号
const DATA_VERSION = '2026-10-14-v1';
const DATA_URL = 'data/products.json.gz';

function normKey(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').replace(/[（）()]/g, '').toLowerCase();
}

function hasAny(text, keys) {
  return keys.some(k => text.includes(normKey(k)));
}

function isSkuHeader(h) {
  const n = normKey(h);
  if (!n) return false;
  if (hasAny(n, BAD_SKU_CN_KEYS)) return false;
  return SKU_KEYS.some(k => n.includes(k)) || hasAny(n, SKU_CN_KEYS);
}

function isMatHeader(h) {
  const n = normKey(h);
  if (!n || n.includes('sku')) return false;
  return MAT_KEYS.some(k => n.includes(k)) || hasAny(n, MAT_CN_KEYS);
}

function normVal(v) {
  return String(v == null ? '' : v).replace(/[\s,，、；;]+/g, '').trim().toLowerCase();
}

function splitValues(v) {
  return String(v == null ? '' : v).split(/[\s,，、；;]+/).map(normVal).filter(Boolean);
}

function parseDateFromName(name) {
  let m = name.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})?\s*日?/);
  if (m) return { year: +m[1], month: +m[2], day: m[3] ? +m[3] : 1 };
  m = name.match(/(\d{4})[-_.\/]?(\d{1,2})(?:[-_.\/]?(\d{1,2}))?/);
  if (m) return { year: +m[1], month: +m[2], day: m[3] ? +m[3] : 1 };
  return null;
}

function ymKey(y, mth) {
  return y * 12 + (mth - 1);
}

const DB_NAME = 'jd_product_db';
const STORE = 'tables';
const META_STORE = 'metadata';
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = e => {
      _db = e.target.result;
      resolve(_db);
    };
    req.onerror = e => reject(e.target.error);
  });
}

function idbPut(rec) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  }));
}

function idbGetAllMeta() {
  return openDB().then(db => new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE, 'readonly');
    const cur = tx.objectStore(STORE).openCursor();
    cur.onsuccess = e => {
      const c = e.target.result;
      if (!c) return resolve(out);
      const v = c.value;
      out.push({
        id: v.id,
        name: v.name,
        year: v.year,
        month: v.month,
        day: v.day,
        sheets: (v.sheets || []).map(s => ({ name: s.name, rowCount: (s.rows || []).length }))
      });
      c.continue();
    };
    cur.onerror = e => reject(e.target.error);
  }));
}

function idbGet(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  }));
}

function idbDelete(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  }));
}

function idbClear() {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  }));
}

function idbGetMeta(key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  }));
}

function idbPutMeta(key, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  }));
}

async function autoLoadData() {
  try {
    const stored = await idbGetMeta('dataVersion');
    if (stored && stored.value === DATA_VERSION) {
      console.log('数据已是最新版本:', DATA_VERSION);
      return true;
    }

    console.log('开始自动加载数据...');
    showProgress(true);
    setProgress(0, '正在下载产品数据 (约 5MB)...');

    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error('数据加载失败');

    const blob = await response.blob();
    setProgress(0.3, '正在解压数据...');

    const ds = new DecompressionStream('gzip');
    const decompressedStream = blob.stream().pipeThrough(ds);
    const decompressedBlob = await new Response(decompressedStream).blob();
    const text = await decompressedBlob.text();

    setProgress(0.6, '正在导入数据到本地缓存...');
    const data = JSON.parse(text);

    await idbClear();

    for (let i = 0; i < data.length; i++) {
      const table = data[i];
      const id = `${table.year}-${table.month}-${table.day}-${table.name}`;
      await idbPut({ id, ...table });
      setProgress(0.6 + (0.4 * (i + 1) / data.length), `导入中 ${i + 1}/${data.length}`);
    }

    await idbPutMeta('dataVersion', DATA_VERSION);
    await idbPutMeta('loadTime', new Date().toISOString());

    showProgress(false);
    console.log('数据加载完成!');
    return true;

  } catch (err) {
    showProgress(false);
    console.error('自动加载失败:', err);
    alert('数据加载失败：' + err.message + '\n\n请刷新页面重试，或联系管理员。');
    return false;
  }
}

let META = [];
let SIDEBAR_COLLAPSED = true;

const $ = id => document.getElementById(id);
const fileInput = $('fileInput');
const yearSelect = $('yearSelect');
const monthSelect = $('monthSelect');
const searchInput = $('searchInput');
const resultArea = $('resultArea');
const resultMeta = $('resultMeta');
const matchHint = $('matchHint');

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;
  showProgress(true);
  let done = 0;

  for (const file of files) {
    try {
      await importOneFile(file);
    } catch (err) {
      console.error('Import failed', file.name, err);
      alert('文件解析失败：' + file.name + '\n' + err.message);
    }
    done++;
    setProgress(done / files.length, `正在导入 ${done}/${files.length}：${file.name}`);
  }

  fileInput.value = '';
  showProgress(false);
  await refreshMeta();
  rebuildFilters();
  renderWaitingState();
});

function importOneFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const dt = parseDateFromName(file.name) || { year: 0, month: 0, day: 0 };
        const sheets = [];

        for (const sname of wb.SheetNames) {
          const ws = wb.Sheets[sname];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
          if (!rows.length) continue;
          const { headerRowIndex, header } = detectHeader(rows);
          const body = rows.slice(headerRowIndex + 1);
          const skuCols = header.map((h, i) => isSkuHeader(h) ? i : -1).filter(i => i >= 0);
          const matCols = header.map((h, i) => isMatHeader(h) ? i : -1).filter(i => i >= 0);
          sheets.push({ name: sname, header, rows: body, skuCols, matCols });
        }

        const id = `${dt.year}-${dt.month}-${dt.day}-${file.name}`;
        await idbPut({ id, name: file.name, year: dt.year, month: dt.month, day: dt.day, sheets });
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function detectHeader(rows) {
  const scan = Math.min(rows.length, 5);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < scan; i++) {
    const r = rows[i] || [];
    const nonEmpty = r.filter(c => String(c).trim() !== '').length;
    const hasKey = r.some(c => isSkuHeader(c) || isMatHeader(c)) ? 5 : 0;
    const score = nonEmpty + hasKey;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return { headerRowIndex: best, header: (rows[best] || []).map(x => String(x)) };
}

async function refreshMeta() {
  META = await idbGetAllMeta();
  $('tableCount').textContent = META.length;
  if ($('sidebarCount')) $('sidebarCount').textContent = META.length;

  const sidebar = $('sidebar');
  const list = $('tableList');
  const reopen = $('sidebarReopenWrap');

  if (!META.length) {
    sidebar.hidden = true;
    if (reopen) reopen.hidden = true;
    list.innerHTML = '';
    return;
  }

  list.innerHTML = META.slice().sort(sortByDateDesc).map(m => {
    const total = m.sheets.reduce((a, s) => a + s.rowCount, 0);
    const label = m.year ? `${m.year}年${m.month}月${m.day}日` : m.name;
    return `<li title="${escapeHtml(m.name)}"><span class="name">${escapeHtml(label)}</span><span class="rows">${total} 行</span></li>`;
  }).join('');

  sidebar.hidden = SIDEBAR_COLLAPSED;
  if (reopen) reopen.hidden = !SIDEBAR_COLLAPSED;
}

function sortByDateDesc(a, b) {
  return ymKeyOf(b) - ymKeyOf(a) || (b.day - a.day);
}

function ymKeyOf(m) {
  return (m.year || 0) * 12 + ((m.month || 1) - 1);
}

function rebuildFilters() {
  const years = [...new Set(META.filter(m => m.year).map(m => m.year))].sort((a, b) => b - a);
  const prevYear = yearSelect.value;
  yearSelect.innerHTML = '<option value="">全部年份</option>' + years.map(y => `<option value="${y}">${y}年</option>`).join('');
  if (years.includes(+prevYear)) yearSelect.value = prevYear;
  rebuildMonths();
}

function rebuildMonths() {
  const y = yearSelect.value;
  const prev = monthSelect.value;
  let html = '<option value="">全部月份</option>';
  for (let mo = 1; mo <= 12; mo++) {
    html += `<option value="${mo}">${mo}月</option>`;
  }
  monthSelect.innerHTML = html;
  if (prev) monthSelect.value = prev;
}

yearSelect.addEventListener('change', () => {
  rebuildMonths();
  autoSearch();
});
monthSelect.addEventListener('change', autoSearch);
$('searchBtn').addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

let _searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(_searchTimer);
  if (!searchInput.value.trim()) {
    matchHint.innerHTML = '';
    resultMeta.textContent = '';
    renderWaitingState();
    return;
  }
  _searchTimer = setTimeout(doSearch, 300);
});

function autoSearch() {
  if (searchInput.value.trim()) doSearch();
}

async function doSearch() {
  const raw = searchInput.value.trim();
  matchHint.innerHTML = '';
  if (!raw) {
    matchHint.textContent = '请输入 SKU 或物料号';
    return;
  }
  if (!META.length) {
    matchHint.textContent = '请先导入表格';
    return;
  }

  const query = normVal(raw);
  const targetY = yearSelect.value ? +yearSelect.value : null;
  const targetM = monthSelect.value ? +monthSelect.value : null;
  let candidates = META.filter(m => m.year);
  if (targetY) candidates = candidates.filter(m => m.year === targetY);
  if (!candidates.length) candidates = META.slice();

  let usedTable = null;
  resultMeta.textContent = '查询中...';
  resultArea.innerHTML = '';

  if (targetM) {
    const baseY = targetY || Math.max(...candidates.map(m => m.year || 0));
    const targetKey = ymKey(baseY, targetM);
    const ranked = candidates
      .map(m => ({ m, dist: Math.abs(ymKey(m.year || baseY, m.month || targetM) - targetKey) }))
      .sort((a, b) => a.dist - b.dist || sortByDateDesc(a.m, b.m));

    for (const { m } of ranked) {
      const full = await idbGet(m.id);
      const hit = findInTable(full, query);
      if (hit.found) {
        usedTable = { meta: m, full, hit };
        break;
      }
    }
  } else {
    const ranked = candidates.slice().sort(sortByDateDesc);
    for (const m of ranked) {
      const full = await idbGet(m.id);
      const hit = findInTable(full, query);
      if (hit.found) {
        usedTable = { meta: m, full, hit };
        break;
      }
    }
  }

  if (!usedTable) {
    resultMeta.textContent = '';
    resultArea.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg></div>
        <h3>无匹配结果</h3>
        <p>未找到与 "${escapeHtml(raw)}" 匹配的记录。</p>
        <p class="text-muted">试试切换年份/月份，或确认输入的 SKU / 物料号是否正确。</p>
      </div>`;
    matchHint.innerHTML = '';
    return;
  }

  renderResult(usedTable, raw);
}

function isFuzzyMatch(value, query) {
  return Boolean(query) && normVal(value).includes(query);
}

function isFuzzySplitMatch(value, query) {
  return Boolean(query) && splitValues(value).some(part => part.includes(query));
}

function findInTable(full, query) {
  const result = { found: false, matchType: null, sheets: [] };
  if (!full || !Array.isArray(full.sheets)) return result;

  for (const sh of full.sheets) {
    const matchedRows = [];
    let sheetMatchType = null;
    for (const row of sh.rows || []) {
      let hitSku = false;
      let hitMat = false;
      for (const c of sh.skuCols || []) if (isFuzzyMatch(row[c], query)) hitSku = true;
      for (const c of sh.matCols || []) if (isFuzzySplitMatch(row[c], query)) hitMat = true;
      if (hitSku || hitMat) {
        matchedRows.push(row);
        if (hitSku && !sheetMatchType) sheetMatchType = 'sku';
        if (hitMat && !sheetMatchType) sheetMatchType = 'mat';
      }
    }
    if (matchedRows.length) {
      result.found = true;
      result.matchType = result.matchType || sheetMatchType;
      result.sheets.push({ name: sh.name, header: sh.header || [], skuCols: sh.skuCols || [], matCols: sh.matCols || [], rows: matchedRows, matchType: sheetMatchType });
    }
  }
  return result;
}

function renderResult(usedTable, raw) {
  const { meta, hit } = usedTable;
  const query = normVal(raw);
  const dateLabel = meta.year ? `${meta.year}年${meta.month}月${meta.day}日` : meta.name;
  const inputType = hit.matchType;
  const hlSku = inputType === 'mat';
  const hlMat = inputType === 'sku';
  const hintParts = [];
  hintParts.push(`识别输入：<b>${inputType === 'sku' ? 'SKU' : '物料号'}</b>`);
  hintParts.push(inputType === 'sku' ? '已高亮 <span class="col-tag mat">物料</span> 列' : '已高亮 <span class="col-tag sku">SKU</span> 列');

  matchHint.innerHTML = hintParts.join(' · ');

  const totalHits = hit.sheets.reduce((a, s) => a + s.rows.length, 0);
  resultMeta.innerHTML = `匹配表：<b>${escapeHtml(dateLabel)}</b> · 命中 <b>${totalHits}</b> 行，共 <b>${hit.sheets.length}</b> 个工作表 · 关键字：<b>${escapeHtml(raw)}</b>`;

  let html = '';
  for (const sh of hit.sheets) {
    const skuSet = new Set(sh.skuCols);
    const matSet = new Set(sh.matCols);
    html += '<div class="sheet-block">';
    html += `<div class="sheet-title">工作表：${escapeHtml(sh.name)}（${sh.rows.length} 行）</div>`;
    html += '<table class="result-table"><thead><tr>';
    sh.header.forEach((h, i) => {
      let cls = '';
      let tag = '';
      if (skuSet.has(i)) {
        tag = '<span class="col-tag sku">SKU</span>';
        if (hlSku) cls = 'hl-sku';
      } else if (matSet.has(i)) {
        tag = '<span class="col-tag mat">物料</span>';
        if (hlMat) cls = 'hl-mat';
      }
      html += `<th class="${cls}">${escapeHtml(h || ('列 ' + (i + 1)))}${tag}</th>`;
    });
    html += '</tr></thead><tbody>';
    for (const row of sh.rows) {
      html += '<tr class="row-filtered">';
      sh.header.forEach((_, i) => {
        const classes = [];
        if (skuSet.has(i) && hlSku) classes.push('hl-sku');
        else if (matSet.has(i) && hlMat) classes.push('hl-mat');
        if (isMatchedCell(row, i, query, skuSet, matSet, inputType)) classes.push('cell-filtered');
        const v = row[i] == null ? '' : row[i];
        html += `<td class="${classes.join(' ')}" title="${escapeHtml(String(v))}">${escapeHtml(String(v))}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }
  resultArea.innerHTML = html;
}

function isMatchedCell(row, colIndex, query, skuSet, matSet, inputType) {
  if (inputType === 'sku' && skuSet.has(colIndex)) return isFuzzyMatch(row[colIndex], query);
  if (inputType === 'mat' && matSet.has(colIndex)) return isFuzzySplitMatch(row[colIndex], query);
  return false;
}

$('manageBtn').addEventListener('click', async () => {
  await refreshMeta();
  const box = $('manageList');
  if (!META.length) {
    box.innerHTML = '<div style="padding: 40px 0; text-align: center; color: var(--text-muted);">还没有导入任何数据。</div>';
  } else {
    box.innerHTML = META.slice().sort(sortByDateDesc).map(m => {
      const label = m.year ? `${m.year}年${m.month}月${m.day}日` : m.name;
      const total = m.sheets.reduce((a, s) => a + s.rowCount, 0);
      return `<div class="manage-item"><div class="info-col"><div class="name">${escapeHtml(label)}</div><div class="meta">${escapeHtml(m.name)} · ${m.sheets.length} 个表 · ${total} 行</div></div><button class="btn btn-danger-outline" data-del="${escapeHtml(m.id)}">删除</button></div>`;
    }).join('');
    box.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await idbDelete(btn.getAttribute('data-del'));
        await refreshMeta();
        rebuildFilters();
        $('manageBtn').click();
      });
    });
  }
  $('manageModal').hidden = false;
});

$('closeManage').addEventListener('click', () => {
  $('manageModal').hidden = true;
});

$('manageModal').addEventListener('click', e => {
  if (e.target.id === 'manageModal') $('manageModal').hidden = true;
});

$('clearAllBtn').addEventListener('click', async () => {
  if (!META.length) {
    alert('缓存已是空的。');
    return;
  }
  if (!confirm(`确定清空全部 ${META.length} 个已导入表格的缓存吗？此操作不可撤销。`)) return;
  await idbClear();
  await idbPutMeta('dataVersion', '');
  await refreshMeta();
  rebuildFilters();
  renderWaitingState();
  resultMeta.textContent = '';
  location.reload();
});

$('sidebarToggle').addEventListener('click', () => setSidebar(false));
$('sidebarReopen').addEventListener('click', () => setSidebar(true));

function setSidebar(open) {
  SIDEBAR_COLLAPSED = !open;
  $('sidebar').hidden = !open;
  if ($('sidebarReopenWrap')) $('sidebarReopenWrap').hidden = open || !META.length;
}

function renderWaitingState() {
  resultArea.innerHTML = META.length
    ? `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></div><h3>等待查询</h3><p>已从缓存读取 <b>${META.length}</b> 个表格。</p><p class="text-muted">输入 SKU 或物料号即可自动查询。</p></div>`
    : `<div class="empty-state" id="emptyState"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg></div><h3>正在加载数据</h3><p>首次访问需要下载约 5MB 数据...</p><p class="text-muted">加载完成后将自动缓存到本地，下次打开即用。</p></div>`;
}

function showProgress(on) {
  $('progress').hidden = !on;
  if (!on) setProgress(0, '');
}

function setProgress(ratio, text) {
  $('progressFill').style.width = Math.round(ratio * 100) + '%';
  $('progressText').textContent = text || '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

(async function init() {
  try {
    await autoLoadData();
    await refreshMeta();
    rebuildFilters();
    renderWaitingState();
  } catch (e) {
    console.error(e);
    alert('初始化失败：' + e.message);
  }
})();
