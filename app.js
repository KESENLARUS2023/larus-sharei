'use strict';

/* ============================================================
 * 支給ルール（KESEN LARUS BASKETBALL CLUB 交通費等及び謝礼金支給規程 第5条・第6条 等）
 * ============================================================ */
const RULES = {
  referee: {
    label: '帯同審判',
    gametype: {
      practice_game: {
        label: '練習試合',
        /* 気仙管内・気仙管外とも基本額は同じ。気仙管外はさらに交通費(定額)または弁当支給が加わる */
        base: { half: 2000, full: 4000 },
      },
      official_game: { label: '公式戦', flat: 2500 },
    },
  },
  commissioner: {
    label: 'コミッショナー',
    /* 謝礼は試合数分。気仙管外はさらに交通費(定額・1日1回のみ)または弁当支給が加わる */
    honorarium: 1000,
  },
};

/* 気仙管外の場合に加算される交通費の定額（弁当支給を選んだ場合は加算しない） */
const OUT_SUPPLEMENT = 1000;
const OUT_SUPPLY_LABEL = { transport: '交通費', bento: '弁当' };

const ROLE_LABELS = { referee: '帯同審判', commissioner: 'コミッショナー', other: 'その他' };
const LOCATION_LABEL = { in: '気仙管内', out: '気仙管外' };
const DURATION_LABEL = { half: '半日（4h以内・1試合）', full: '1日（4h超）' };

/* 審判の公式戦・コミッショナーは1試合あたりの金額のため、試合数(最大3)を掛ける */
function gameCountApplies(role, gametype) {
  return role === 'commissioner' || (role === 'referee' && gametype === 'official_game');
}

function outSupplement(location, outSupply) {
  return location === 'out' && outSupply !== 'bento' ? OUT_SUPPLEMENT : 0;
}

function calcAmount(role, { gametype, location, duration, gamecount, outSupply }) {
  if (role === 'referee') {
    const gt = RULES.referee.gametype[gametype];
    if (!gt) return 0;
    if (gt.flat !== undefined) return gt.flat * (gamecount || 1);
    return (gt.base[duration] ?? 0) + outSupplement(location, outSupply);
  }
  if (role === 'commissioner') {
    return RULES.commissioner.honorarium * (gamecount || 1) + outSupplement(location, outSupply);
  }
  return 0;
}

function amountBreakdownText(role, { gametype, location, gamecount, outSupply }) {
  const parts = [];
  if (role === 'referee' && gametype === 'official_game') {
    parts.push(`${yen(RULES.referee.gametype.official_game.flat)} × ${gamecount}試合`);
  } else if (role === 'commissioner') {
    parts.push(`謝礼 ${yen(RULES.commissioner.honorarium)} × ${gamecount}試合`);
  }
  if (location === 'out') {
    parts.push(outSupply === 'bento' ? '弁当支給（気仙管外）' : `交通費 ${yen(OUT_SUPPLEMENT)}（気仙管外）`);
  }
  return parts.join(' + ');
}

function roleLabel(role) {
  return ROLE_LABELS[role] ?? role;
}

function describeEntry(r) {
  if (r.role === 'other') {
    return r.otherContent || '';
  }
  if (r.role === 'referee') {
    const gt = RULES.referee.gametype[r.gametype];
    const parts = [gt?.label];
    if (r.gametype === 'practice_game') {
      parts.push(LOCATION_LABEL[r.location], DURATION_LABEL[r.duration]);
      if (r.location === 'out') parts.push(OUT_SUPPLY_LABEL[r.outSupply] ?? OUT_SUPPLY_LABEL.transport);
    } else if (r.gametype === 'official_game' && r.gamecount) {
      parts.push(`${r.gamecount}試合`);
    }
    return parts.filter(Boolean).join(' / ');
  }
  if (r.role === 'commissioner') {
    const parts = [LOCATION_LABEL[r.location]];
    if (r.gamecount) parts.push(`${r.gamecount}試合`);
    if (r.location === 'out') parts.push(OUT_SUPPLY_LABEL[r.outSupply] ?? OUT_SUPPLY_LABEL.transport);
    return parts.filter(Boolean).join(' / ');
  }
  return '';
}

/* ============================================================
 * データストア（Firestoreに保存。window.FirebaseDataはfirebase-bundle.jsが用意する）
 * ============================================================ */
let records = [];
let rosterNames = [];
let contactsCache = { addresses: {}, phones: {} };

function yen(n) {
  return '¥' + Number(n || 0).toLocaleString('ja-JP');
}

function monthKey(dateStr) {
  return (dateStr || '').slice(0, 7); // YYYY-MM
}

/* 今日の日付（YYYY-MM-DD）。toISOString()は世界標準時のため、日本時間の0時〜9時に前日になってしまう */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ============================================================
 * タブ切り替え
 * ============================================================ */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab));
  if (tab === 'list') renderList();
  if (tab === 'dashboard') renderDashboard();
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

/* ============================================================
 * 入力フォーム
 * ============================================================ */
/* 選択肢の少ない項目はボタンで選べるようにする。値はこれまでどおり非表示のselectが持ち、
 * ボタンを押すとselectの値を変えてchangeイベントを発火する（計算・表示切替のロジックはselectのまま） */
const SEGMENTED_SELECT_IDS = ['f-role', 'f-gametype', 'f-location', 'f-duration', 'f-out-supply', 'f-gamecount'];

function enhanceSelectAsSegments(select) {
  const group = document.createElement('div');
  group.className = 'segmented';
  group.setAttribute('role', 'group');
  [...select.options].forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.dataset.value = opt.value;
    btn.textContent = opt.dataset.short || opt.textContent;
    btn.addEventListener('click', () => {
      if (select.value === opt.value) return;
      select.value = opt.value;
      select.dispatchEvent(new Event('change'));
    });
    group.appendChild(btn);
  });
  select.hidden = true;
  select.after(group);
  select.addEventListener('change', () => syncSegments(select));
  syncSegments(select);
}

function syncSegments(select) {
  const group = select.nextElementSibling;
  if (!group || !group.classList.contains('segmented')) return;
  group.querySelectorAll('.seg-btn').forEach((btn) => {
    const on = btn.dataset.value === select.value;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

function syncAllSegments() {
  SEGMENTED_SELECT_IDS.forEach((id) => syncSegments(document.getElementById(id)));
}

let selectedNames = []; // 選択中の対象者（よく依頼する人）
let otherNameSelected = false; // 「その他（自由入力）」を選んでいるか
let editingId = null; // 編集中の記録のID（新規登録中はnull）

function initForm() {
  const form = document.getElementById('entry-form');

  document.getElementById('f-date').value = todayLocal();
  SEGMENTED_SELECT_IDS.forEach((id) => enhanceSelectAsSegments(document.getElementById(id)));

  document.getElementById('f-role').addEventListener('change', () => {
    updateConditionalFields();
    updateUnitAmount();
  });
  document.getElementById('f-gametype').addEventListener('change', () => {
    updateConditionalFields();
    updateUnitAmount();
  });
  document.getElementById('f-location').addEventListener('change', () => {
    updateConditionalFields();
    updateUnitAmount();
  });
  document.getElementById('f-duration').addEventListener('change', updateUnitAmount);
  document.getElementById('f-gamecount').addEventListener('change', updateUnitAmount);
  document.getElementById('f-out-supply').addEventListener('change', updateUnitAmount);
  document.getElementById('btn-edit-cancel').addEventListener('click', () => {
    exitEditMode();
    switchTab('list');
  });

  updateConditionalFields();
  updateUnitAmount();
  renderNameChips();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const base = readFormRecord();
    if (!base) return;
    if (otherNameSelected && !document.getElementById('f-name-other').value.trim()) {
      alert('お名前を入力してください');
      return;
    }
    const names = selectedTargetNames();
    if (names.length === 0) {
      alert('対象者を選択してください');
      return;
    }

    const submitBtn = document.getElementById('btn-submit');
    submitBtn.disabled = true;
    const isEdit = editingId !== null;
    let job;
    if (isEdit) {
      job = window.FirebaseData.updateRecord(editingId, toFirestorePatch({ ...base, name: names[0] })).then(() => {
        showToast('更新しました');
        exitEditMode();
        switchTab('list');
      });
    } else {
      const recs = names.map((name) => ({ ...base, name }));
      const save = recs.length === 1 ? window.FirebaseData.addRecord(recs[0]) : window.FirebaseData.addRecords(recs);
      job = save.then(() => {
        showToast(recs.length === 1 ? '登録しました' : `${recs.length}名分を登録しました`);
        clearFormAfterSave();
      });
    }
    job
      .catch((err) => {
        console.error(isEdit ? 'updateRecord failed' : 'addRecord failed', err);
        alert((isEdit ? '更新' : '登録') + 'に失敗しました: ' + err.message);
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });
}

/* フォームの入力内容から、対象者以外の記録の中身を作る（明細itemsも登録時点の内容で保存する）。
 * 入力に不備があればアラートを出してnullを返す */
function readFormRecord() {
  const date = document.getElementById('f-date').value;
  if (!date) {
    alert('日付を入力してください');
    return null;
  }
  const role = document.getElementById('f-role').value;
  const note = document.getElementById('f-note').value;
  const venue = document.getElementById('f-venue').value.trim();
  let record;

  if (role === 'other') {
    const otherContent = document.getElementById('f-other-content').value.trim();
    const amountText = document.getElementById('f-other-amount').value.trim();
    const amount = Number(amountText);
    if (!otherContent) {
      alert('内容を入力してください');
      return null;
    }
    if (amountText === '' || !Number.isInteger(amount) || amount < 0) {
      alert('支給額を0以上の整数で入力してください');
      return null;
    }
    record = { date, role, otherContent, amount, note, venue };
  } else {
    const gametype = role === 'referee' ? document.getElementById('f-gametype').value : undefined;
    const showLocation = role === 'commissioner' || (role === 'referee' && gametype === 'practice_game');
    const location = showLocation ? document.getElementById('f-location').value : undefined;
    const duration = role === 'referee' && gametype === 'practice_game' ? document.getElementById('f-duration').value : undefined;
    const applyCount = gameCountApplies(role, gametype);
    const gamecount = applyCount ? Number(document.getElementById('f-gamecount').value) : undefined;
    const outSupply = showLocation && location === 'out' ? document.getElementById('f-out-supply').value : undefined;
    const amount = calcAmount(role, { gametype, location, duration, gamecount, outSupply });
    record = { date, role, gametype, location, duration, gamecount, outSupply, amount, note, venue };
  }
  record.items = computeReceiptRows(record);
  return record;
}

/* 記録として保存する項目。編集で区分を変えたときに古い項目が残らないよう、使わない項目はnullで上書きする
 * （updateDocはundefinedを受け付けない） */
const RECORD_FIELDS = ['date', 'name', 'role', 'gametype', 'location', 'duration', 'gamecount', 'outSupply', 'otherContent', 'amount', 'note', 'venue', 'items'];

function toFirestorePatch(record) {
  const patch = {};
  RECORD_FIELDS.forEach((k) => {
    patch[k] = record[k] === undefined ? null : record[k];
  });
  return patch;
}

function clearFormAfterSave() {
  document.getElementById('f-note').value = '';
  document.getElementById('f-other-content').value = '';
  document.getElementById('f-other-amount').value = '';
  document.getElementById('f-name-other').value = '';
  selectedNames = [];
  otherNameSelected = false;
  renderNameChips();
}

function setSelectValue(id, value) {
  const el = document.getElementById(id);
  if (value != null && [...el.options].some((o) => o.value === String(value))) el.value = String(value);
}

/* 一覧の記録を入力フォームに読み込んで編集を始める */
function startEdit(record) {
  editingId = record.id;
  document.getElementById('f-date').value = record.date || todayLocal();
  setSelectValue('f-role', record.role);
  setSelectValue('f-gametype', record.gametype);
  setSelectValue('f-location', record.location);
  setSelectValue('f-duration', record.duration);
  setSelectValue('f-gamecount', record.gamecount);
  setSelectValue('f-out-supply', record.outSupply || 'transport');
  document.getElementById('f-other-content').value = record.otherContent || '';
  document.getElementById('f-other-amount').value = record.role === 'other' ? record.amount : '';
  document.getElementById('f-venue').value = record.venue || '';
  document.getElementById('f-note').value = record.note || '';
  if (rosterNames.includes(record.name)) {
    selectedNames = [record.name];
    otherNameSelected = false;
    document.getElementById('f-name-other').value = '';
  } else {
    selectedNames = [];
    otherNameSelected = true;
    document.getElementById('f-name-other').value = record.name || '';
  }
  updateConditionalFields();
  updateUnitAmount();
  syncAllSegments();
  renderNameChips();

  document.getElementById('edit-banner-text').textContent = `${record.date}　${record.name}　${roleLabel(record.role)}`;
  const calc = record.role === 'other' ? Number(record.amount) : calcAmount(record.role, record);
  document.getElementById('edit-banner-note').textContent =
    calc !== Number(record.amount)
      ? `一覧で修正した支給額（${yen(record.amount)}）は、更新すると入力内容から計算した金額（${yen(calc)}）に置き換わります。`
      : '';
  document.getElementById('edit-banner').hidden = false;
  document.getElementById('name-hint').textContent = '編集中は1人だけ選べます';
  switchTab('entry');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function exitEditMode() {
  editingId = null;
  document.getElementById('edit-banner').hidden = true;
  document.getElementById('name-hint').textContent = '複数選ぶと、同じ内容でまとめて登録できます';
  document.getElementById('f-date').value = todayLocal();
  document.getElementById('f-venue').value = '';
  clearFormAfterSave();
  updateConditionalFields();
  updateUnitAmount();
}

function updateConditionalFields() {
  const role = document.getElementById('f-role').value;
  const gametype = document.getElementById('f-gametype').value;
  const location = document.getElementById('f-location').value;
  const isOther = role === 'other';
  const isPracticeGame = role === 'referee' && gametype === 'practice_game';
  const showLocation = !isOther && (role === 'commissioner' || isPracticeGame);
  const showGamecount = !isOther && gameCountApplies(role, gametype);
  const showOutSupply = showLocation && location === 'out';

  document.getElementById('group-gametype').style.display = role === 'referee' ? '' : 'none';
  document.getElementById('group-location').style.display = showLocation ? '' : 'none';
  document.getElementById('group-duration').style.display = isPracticeGame ? '' : 'none';
  document.getElementById('group-out-supply').style.display = showOutSupply ? '' : 'none';
  document.getElementById('group-gamecount').style.display = showGamecount ? '' : 'none';
  document.getElementById('group-unit-amount').style.display = isOther ? 'none' : '';
  document.getElementById('group-other-fields').style.display = isOther ? '' : 'none';
}

function updateUnitAmount() {
  const role = document.getElementById('f-role').value;
  if (role === 'other') return;
  const gametype = document.getElementById('f-gametype').value;
  const isPracticeGame = role === 'referee' && gametype === 'practice_game';
  const showLocation = role === 'commissioner' || isPracticeGame;
  const location = showLocation ? document.getElementById('f-location').value : undefined;
  const duration = document.getElementById('f-duration').value;
  const outSupply = document.getElementById('f-out-supply').value;
  const applyCount = gameCountApplies(role, gametype);
  const gamecount = applyCount ? Number(document.getElementById('f-gamecount').value) : 1;
  const total = calcAmount(role, { gametype, location, duration, gamecount, outSupply });

  document.getElementById('f-unit-amount').textContent = yen(total);
  document.getElementById('f-unit-amount-detail').textContent = amountBreakdownText(role, { gametype, location, gamecount, outSupply });
}

/* 対象者はボタンで選ぶ。新規登録では複数人を選んで同じ内容をまとめて登録できる（編集中は1人だけ） */
function renderNameChips() {
  const wrap = document.getElementById('f-name-chips');
  selectedNames = selectedNames.filter((n) => rosterNames.includes(n));
  const chip = (attrs, label, on) => `<button type="button" class="name-chip${on ? ' active' : ''}" ${attrs} aria-pressed="${on}">${label}</button>`;
  wrap.innerHTML =
    rosterNames.map((n) => chip(`data-name="${escapeHtml(n)}"`, escapeHtml(n), selectedNames.includes(n))).join('') +
    chip('data-other="1"', 'その他（自由入力）', otherNameSelected);
  wrap.querySelectorAll('.name-chip').forEach((btn) => btn.addEventListener('click', () => toggleNameChip(btn)));
  updateNameFieldVisibility();
  updateSubmitLabel();
}

function toggleNameChip(btn) {
  const single = editingId !== null;
  if (btn.dataset.other) {
    otherNameSelected = !otherNameSelected;
    if (single && otherNameSelected) selectedNames = [];
  } else {
    const name = btn.dataset.name;
    if (selectedNames.includes(name)) selectedNames = selectedNames.filter((n) => n !== name);
    else selectedNames = single ? [name] : [...selectedNames, name];
    if (single && selectedNames.length > 0) otherNameSelected = false;
  }
  renderNameChips();
  if (btn.dataset.other && otherNameSelected) document.getElementById('f-name-other').focus();
}

function updateNameFieldVisibility() {
  document.getElementById('group-name-other').style.display = otherNameSelected ? '' : 'none';
}

function selectedTargetNames() {
  const names = [...selectedNames];
  if (otherNameSelected) {
    const other = document.getElementById('f-name-other').value.trim();
    if (other) names.push(other);
  }
  return [...new Set(names)];
}

function updateSubmitLabel() {
  const btn = document.getElementById('btn-submit');
  if (editingId !== null) {
    btn.textContent = '更新する';
    return;
  }
  const count = selectedNames.length + (otherNameSelected ? 1 : 0);
  btn.textContent = count > 1 ? `${count}名分を登録する` : '登録する';
}

/* 大会開催地は、過去に入力したものを新しい順に候補として出す */
function renderVenueOptions() {
  const seen = new Set();
  const venues = [...records]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((r) => (r.venue || '').trim())
    .filter((v) => v && !seen.has(v) && seen.add(v));
  document.getElementById('venue-options').innerHTML = venues.map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
}

/* ============================================================
 * 対象者ロースター（よく依頼する人を登録・削除。たまにの人はその他で自由入力）
 * ============================================================ */
function renderRosterList() {
  const ul = document.getElementById('roster-list');
  if (rosterNames.length === 0) {
    ul.innerHTML = '<li class="roster-empty-hint">まだ登録がありません</li>';
    return;
  }
  ul.innerHTML = rosterNames
    .map((n) => `<li>${escapeHtml(n)}<button type="button" data-remove="${escapeHtml(n)}" aria-label="削除">×</button></li>`)
    .join('');
  ul.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeRosterName(btn.dataset.remove));
  });
}

function saveRoster(names) {
  window.FirebaseData.saveRoster(names).catch((err) => {
    console.error('saveRoster failed', err);
    alert('対象者リストの保存に失敗しました: ' + err.message);
  });
}

function addRosterName(name) {
  if (!name || rosterNames.includes(name)) return;
  rosterNames = [...rosterNames, name];
  saveRoster(rosterNames);
}

function removeRosterName(name) {
  if (!confirm(`「${name}」を対象者リストから削除しますか？（過去の登録記録は残ります）`)) return;
  rosterNames = rosterNames.filter((n) => n !== name);
  saveRoster(rosterNames);
}

function initRoster() {
  document.getElementById('roster-add-btn').addEventListener('click', () => {
    const input = document.getElementById('roster-new-name');
    const name = input.value.trim();
    if (!name) return;
    if (rosterNames.includes(name)) {
      showToast('すでに登録されています');
      return;
    }
    addRosterName(name);
    input.value = '';
  });
  document.getElementById('roster-new-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('roster-add-btn').click();
    }
  });
}

/* ============================================================
 * 一覧（スプレッドシート風）
 * ============================================================ */
let listMonthFilterTouched = false;
let lastListRecords = []; // 一覧に表示中の記録（Excel出力用）
let lastListMonth = '';

function renderList() {
  closeRowMenu();
  let monthFilter = document.getElementById('list-month-filter').value;
  if (!listMonthFilterTouched) {
    const months = [...new Set(records.map((r) => monthKey(r.date)))].sort().reverse();
    monthFilter = months[0] || monthKey(todayLocal());
  }
  const nameFilter = document.getElementById('list-name-filter').value.trim();

  const filtered = records
    .filter((r) => !monthFilter || monthKey(r.date) === monthFilter)
    .filter((r) => !nameFilter || r.name.includes(nameFilter))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  lastListRecords = filtered;
  lastListMonth = monthFilter;

  const tbody = document.getElementById('list-tbody');
  tbody.innerHTML = '';

  let total = 0;
  filtered.forEach((r) => {
    total += Number(r.amount) || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="c-date">${escapeHtml(r.date)}</td>
      <td class="c-name">${escapeHtml(r.name)}</td>
      <td class="c-role"><span class="role-tag role-${escapeHtml(r.role)}">${escapeHtml(roleLabel(r.role))}</span></td>
      <td class="c-content wrap">${escapeHtml(describeEntry(r))}</td>
      <td class="c-amount num"><input type="number" class="amount-edit" value="${Number(r.amount) || 0}" data-id="${r.id}" step="1" min="0" aria-label="支給額"></td>
      <td class="c-note wrap">${escapeHtml(r.note || '')}</td>
      <td class="c-actions actions">
        <div class="row-actions">
          <button type="button" class="btn-secondary receipt-btn" data-receipt="${r.id}">精算書</button>
          <button type="button" class="btn-secondary receipt-btn" data-envelope="${r.id}">封筒</button>
          <button type="button" class="row-menu-btn" data-menu="${r.id}" aria-label="その他の操作（編集・削除）" aria-haspopup="menu">…</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr class="list-empty"><td colspan="7">この条件の記録はありません</td></tr>';
  }

  document.getElementById('list-total').textContent = yen(total);
  document.getElementById('list-count').textContent = filtered.length + ' 件';

  const findRecord = (id) => filtered.find((r) => r.id === id);
  tbody.querySelectorAll('.amount-edit').forEach((input) => {
    input.addEventListener('change', () => handleAmountEdit(input, findRecord(input.dataset.id)));
  });
  tbody.querySelectorAll('[data-receipt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const record = findRecord(btn.dataset.receipt);
      if (record) handleReceiptClick(record);
    });
  });
  tbody.querySelectorAll('[data-envelope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const record = findRecord(btn.dataset.envelope);
      if (record) handleEnvelopeClick(record);
    });
  });
  tbody.querySelectorAll('[data-menu]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const record = findRecord(btn.dataset.menu);
      if (record) toggleRowMenu(btn, record);
    });
  });

  populateMonthOptions(monthFilter);
}

/* 一覧での支給額の変更は、空欄・マイナス・小数を受け付けず、変更前後の金額を確認してから保存する */
function handleAmountEdit(input, record) {
  if (!record) return;
  const before = Number(record.amount) || 0;
  const text = input.value.trim();
  const after = Number(text);
  if (text === '' || !Number.isInteger(after) || after < 0) {
    alert('支給額は0以上の整数で入力してください');
    input.value = before;
    return;
  }
  if (after === before) return;
  if (!confirm(`${record.date} ${record.name}さんの支給額を\n${yen(before)} → ${yen(after)}\nに変更しますか？`)) {
    input.value = before;
    return;
  }
  window.FirebaseData.updateRecord(record.id, { amount: after })
    .then(() => showToast('支給額を変更しました'))
    .catch((err) => {
      console.error('updateRecord failed', err);
      alert('更新に失敗しました: ' + err.message);
      input.value = before;
    });
}

function confirmDeleteRecord(record) {
  if (!confirm(`${record.date} ${record.name}さん（${roleLabel(record.role)}・${yen(record.amount)}）の記録を削除しますか？\nこの操作は元に戻せません。`)) return;
  window.FirebaseData.deleteRecord(record.id)
    .then(() => showToast('削除しました'))
    .catch((err) => {
      console.error('deleteRecord failed', err);
      alert('削除に失敗しました: ' + err.message);
    });
}

/* 各行の「…」から開く操作メニュー（編集・削除）。表の横スクロール領域で切れないよう、画面に固定配置する */
let rowMenuRecord = null;

function toggleRowMenu(btn, record) {
  const menu = document.getElementById('row-menu');
  if (!menu.hidden && rowMenuRecord && rowMenuRecord.id === record.id) {
    closeRowMenu();
    return;
  }
  rowMenuRecord = record;
  menu.hidden = false;
  const rect = btn.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const top = rect.bottom + 4 + h > window.innerHeight - 8 ? rect.top - h - 4 : rect.bottom + 4;
  const left = Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8));
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
}

function closeRowMenu() {
  const menu = document.getElementById('row-menu');
  if (menu) menu.hidden = true;
  rowMenuRecord = null;
}

function initRowMenu() {
  const menu = document.createElement('div');
  menu.id = 'row-menu';
  menu.className = 'row-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.innerHTML =
    '<button type="button" role="menuitem" data-action="edit">編集する</button>' +
    '<button type="button" role="menuitem" data-action="delete" class="danger">削除する</button>';
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item || !rowMenuRecord) return;
    const record = rowMenuRecord;
    closeRowMenu();
    if (item.dataset.action === 'edit') startEdit(record);
    else confirmDeleteRecord(record);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeRowMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRowMenu();
  });
  window.addEventListener('scroll', closeRowMenu, true);
  window.addEventListener('resize', closeRowMenu);
}

function handleListExportClick() {
  if (lastListRecords.length === 0) {
    alert('出力できる記録がありません');
    return;
  }
  const nameFilter = document.getElementById('list-name-filter').value.trim();
  const bytes = buildXlsxFile('謝礼金記録', BACKUP_HEADER, buildBackupRows(lastListRecords));
  const fileName = `謝礼金_${lastListMonth || '全期間'}${nameFilter ? '_' + nameFilter : ''}.xlsx`;
  downloadBytes(bytes, fileName, XLSX_MIME);
  showToast('Excelファイルを出力しました');
}

function populateMonthOptions(current) {
  const thisMonth = monthKey(todayLocal());
  const months = [...new Set([...records.map((r) => monthKey(r.date)), thisMonth].filter(Boolean))].sort().reverse();
  const sel = document.getElementById('list-month-filter');
  const keep = current || sel.value;
  sel.innerHTML = '<option value="">すべての月</option>' + months.map((m) => `<option value="${m}">${m}</option>`).join('');
  sel.value = keep || '';
}

function initList() {
  document.getElementById('list-month-filter').addEventListener('change', () => {
    listMonthFilterTouched = true;
    renderList();
  });
  document.getElementById('list-name-filter').addEventListener('input', renderList);
  document.getElementById('btn-list-export').addEventListener('click', handleListExportClick);
  initRowMenu();
}

/* ============================================================
 * 精算書用の連絡先・住所（よく依頼する対象者ごとに設定。Firestoreで共有）
 * ============================================================ */
function saveContacts(contacts) {
  window.FirebaseData.saveContacts(contacts).catch((err) => {
    console.error('saveContacts failed', err);
    alert('連絡先の保存に失敗しました: ' + err.message);
  });
}

function renderContactSettingsBody() {
  const body = document.getElementById('contact-settings-body');
  if (rosterNames.length === 0) {
    body.innerHTML = '<p class="import-hint">「よく依頼する対象者の登録・削除」で対象者を登録すると、ここで連絡先・住所を設定できるようになります。</p>';
    return;
  }
  body.innerHTML = rosterNames
    .map(
      (name, i) => `
    <fieldset class="contact-person">
      <legend>${escapeHtml(name)}</legend>
      <label class="field-group">
        住所
        <input type="text" id="c-address-${i}" data-name="${escapeHtml(name)}" data-field="address" placeholder="例）陸前高田市高田町字中和野14-1">
      </label>
      <label class="field-group">
        電話番号
        <input type="text" id="c-phone-${i}" data-name="${escapeHtml(name)}" data-field="phone" placeholder="080-0000-0000">
      </label>
    </fieldset>`
    )
    .join('');

  body.querySelectorAll('input').forEach((input) => {
    const name = input.dataset.name;
    const field = input.dataset.field;
    input.addEventListener('input', () => {
      const target = field === 'address' ? contactsCache.addresses : contactsCache.phones;
      target[name] = input.value;
      saveContacts(contactsCache);
    });
  });

  refreshContactInputs();
}

function refreshContactInputs() {
  document.querySelectorAll('#contact-settings-body input').forEach((input) => {
    if (document.activeElement === input) return; // 入力中の欄は上書きしない
    const name = input.dataset.name;
    const field = input.dataset.field;
    const store = field === 'address' ? contactsCache.addresses : contactsCache.phones;
    input.value = store[name] || '';
  });
}

/* ============================================================
 * 精算書（謝礼金精算書）PDF出力
 * ============================================================ */
const RECEIPT_TITLES = { referee: '審判謝礼精算書', commissioner: 'コミッショナー謝礼精算書', other: '謝礼金精算書' };

function numFmt(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

function formatDateDot(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y}.${m}.${d}`;
}

function eventLabel(r) {
  const d = formatDateDot(r.date);
  let typeText = '';
  if (r.role === 'referee') typeText = RULES.referee.gametype[r.gametype]?.label ?? '';
  else if (r.role === 'commissioner') typeText = 'コミッショナー';
  else if (r.role === 'other') typeText = r.otherContent || '';
  return { date: d, item: typeText };
}

function outSupplyRow(r) {
  if (r.location !== 'out') return null;
  if (r.outSupply === 'bento') return { label: '弁当（気仙管外）', inKind: true };
  return { label: '交通費（気仙管外）', amount: OUT_SUPPLEMENT };
}

/* 規程のルールから明細を組み立てる（登録時に記録へ保存する。保存がない古い記録の精算書でも使う） */
function computeReceiptRows(r) {
  if (r.role === 'referee') {
    if (r.gametype === 'practice_game') {
      const base = RULES.referee.gametype.practice_game.base[r.duration] ?? 0;
      const rows = [{ label: DURATION_LABEL[r.duration] || '', amount: base }];
      const supply = outSupplyRow(r);
      if (supply) rows.push(supply);
      return rows;
    }
    if (r.gametype === 'official_game') {
      const unit = RULES.referee.gametype.official_game.flat;
      return [{ label: `公式戦（${yen(unit)} × ${r.gamecount || 1}試合）`, amount: r.amount }];
    }
  }
  if (r.role === 'commissioner') {
    const gamecount = r.gamecount || 1;
    const honorarium = RULES.commissioner.honorarium * gamecount;
    const rows = [{ label: `謝礼（${yen(RULES.commissioner.honorarium)} × ${gamecount}試合）`, amount: honorarium }];
    const supply = outSupplyRow(r);
    if (supply) rows.push(supply);
    return rows;
  }
  if (r.role === 'other') {
    return [{ label: r.otherContent || '内容', amount: r.amount }];
  }
  return [{ label: '', amount: r.amount }];
}

/* 精算書右側の金額欄（バスケットボール柄の円）。座標は様式PDF（A5横・pt単位）に合わせている */
const RECEIPT_BALL_SVG = `
  <svg class="rc-ball" viewBox="396 108 150 150" aria-hidden="true">
    <line x1="470.65" y1="109.9" x2="470.65" y2="254.6" stroke="#aaa" stroke-width="1.13"/>
    <line x1="398" y1="182.25" x2="543.3" y2="182.25" stroke="#aaa" stroke-width="1.13"/>
    <path d="M423.8 121.6 C454.9 155.6 454.9 212.3 423.8 246.3" fill="none" stroke="#aaa" stroke-width="1.13"/>
    <path d="M520.1 121.6 C489 155.6 489 212.3 520.1 246.3" fill="none" stroke="#aaa" stroke-width="1.13"/>
    <circle cx="470.65" cy="182.25" r="72.4" fill="none" stroke="#222" stroke-width="1.5"/>
    <rect x="417.8" y="157.5" width="105.7" height="49.5" rx="5.6" fill="#fff"/>
  </svg>`;

const RECEIPT_WAVE_SVG = `
  <svg class="rc-waves" viewBox="0 394 595.3 22" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 401.2 C49.1 396.2 98.3 396.2 147.4 401.2 C196.5 406.1 246.6 406.1 297.6 401.2 C348.7 396.2 398.7 396.2 447.9 401.2 C497 406.1 546.1 406.1 595.3 401.2" fill="none" stroke="#999" stroke-width="0.8"/>
    <path d="M0 408.6 C49.1 403.7 98.3 403.7 147.4 408.6 C196.5 413.6 246.6 413.6 297.6 408.6 C348.7 403.7 398.7 403.7 447.9 408.6 C497 413.6 546.1 413.6 595.3 408.6" fill="none" stroke="#999" stroke-width="0.8"/>
  </svg>`;

/* 精算書の明細。金額は必ず記録の支給額（一覧の金額）に合わせる。
 * 登録時に保存した明細を優先し、明細の合計が支給額と合わない場合（一覧で金額を修正した記録など）は
 * 支給額を1行で表示する（後から規程の金額を変えても、過去の精算書の金額は変わらない） */
function receiptRowsFor(r) {
  const amount = Number(r.amount) || 0;
  const rows = Array.isArray(r.items) && r.items.length > 0 ? r.items : computeReceiptRows(r);
  const sum = rows.reduce((s, row) => s + (Number(row.amount) || 0), 0);
  if (sum === amount) return rows;
  const label = r.role === 'other' ? r.otherContent || '謝礼' : `${eventLabel(r).item || roleLabel(r.role)} 謝礼`;
  return [{ label, amount }];
}

function renderReceiptPrintArea(recordsToPrint) {
  document.getElementById('envelope-print-area').innerHTML = '';
  const area = document.getElementById('receipt-print-area');
  area.innerHTML = recordsToPrint
    .map((r) => {
      const rows = receiptRowsFor(r);
      const total = Number(r.amount) || 0;
      const phone = contactsCache.phones[r.name] || '';
      const address = contactsCache.addresses[r.name] || '';
      const event = eventLabel(r);
      const rowsHtml = rows
        .map((row) => `<div class="rc-detail-row"><span>${escapeHtml(row.label)}</span><span>${row.inKind ? '支給' : numFmt(row.amount) + '円'}</span></div>`)
        .join('');

      return `
      <div class="receipt-page">
        <img class="rc-logo" src="logo.png" alt="KESEN LARUS BASKETBALL CLUB">
        <div class="rc-title">${escapeHtml(RECEIPT_TITLES[r.role] ?? '謝礼金精算書')}</div>
        <div class="rc-header-rule"></div>
        <div class="rc-info">
          <div class="rc-info-row"><span class="rc-label">項目</span><span class="rc-value">${escapeHtml(event.date)}${event.item ? '　' + escapeHtml(event.item) : ''}</span></div>
          <div class="rc-info-row"><span class="rc-label">開催地</span><span class="rc-value receipt-venue-text">${escapeHtml(r.venue || '')}</span></div>
          <div class="rc-info-row"><span class="rc-label">名前</span><span class="rc-value">${escapeHtml(formatDisplayName(r.name))}</span><span class="rc-seal">印</span></div>
          <div class="rc-info-row"><span class="rc-label">連絡先</span><span class="rc-value">${escapeHtml(phone)}</span></div>
          <div class="rc-info-row"><span class="rc-label">住所</span><span class="rc-value receipt-venue-text">${escapeHtml(address)}</span></div>
        </div>
        ${r.note ? `<p class="rc-note">備考：${escapeHtml(r.note)}</p>` : ''}
        ${RECEIPT_BALL_SVG}
        <div class="rc-amount">
          <span class="rc-amount-label">金額</span>
          <span class="rc-amount-value">${numFmt(total)}<span class="rc-amount-unit">円</span></span>
        </div>
        <div class="rc-detail">
          ${rowsHtml}
          <div class="rc-detail-row rc-total-row"><span>合計</span><span>${numFmt(total)}円</span></div>
        </div>
        ${RECEIPT_WAVE_SVG}
      </div>`;
    })
    .join('');

  fitReceiptVenueText();
}

/* 開催地・住所は改行させず、欄の幅に収まるまでフォントサイズを縮小する（元のサイズより拡大はしない）。
 * 通常時はreceipt-print-areaがdisplay:noneのため、計測中だけ一時的に表示させて実寸を測る */
function fitReceiptVenueText() {
  const area = document.getElementById('receipt-print-area');
  const prevDisplay = area.style.display;
  area.style.display = 'block';
  document.querySelectorAll('.receipt-venue-text').forEach((el) => {
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth && size > 8) {
      size -= 0.5;
      el.style.fontSize = size + 'px';
    }
  });
  area.style.display = prevDisplay;
}

/* 精算書のWebフォント（Noto Sans JP）が読み込まれる前に印刷すると代替フォントで出力されるため、
 * 読み込みを待ってから印刷する（オフライン等で読み込めない場合も最大2秒で印刷に進む） */
function waitForReceiptFonts() {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  // Google Fontsの日本語フォントは文字ごとに分割配信されるため、精算書に実際に使う文字で読み込む
  const text = document.getElementById('receipt-print-area').textContent.replace(/\s+/g, '') + '0123456789,円';
  const loads = Promise.all(['400', '500', '700'].map((w) => document.fonts.load(`${w} 12pt "Noto Sans JP"`, text)))
    .then(() => document.fonts.ready)
    .catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
  return Promise.race([loads, timeout]);
}

function handleReceiptClick(record) {
  renderReceiptPrintArea([record]);
  waitForReceiptFonts().then(() => {
    fitReceiptVenueText();
    printWithPageSize('210mm 148mm');
  });
}

function initContactSettings() {
  renderContactSettingsBody();
}

/* ============================================================
 * バックアップ（Excel出力・CSV取込）
 * ============================================================ */
const BACKUP_HEADER = ['日付', '氏名', '区分', '試合種別', '活動場所', '拘束時間', '試合数', '管外支給', '内容', '支給額', '大会開催地', '備考'];
const DURATION_SIMPLE_LABEL = { half: '半日', full: '1日' };
const DURATION_SIMPLE_REVERSE = { 半日: 'half', '1日': 'full' };
const ROLE_LABEL_REVERSE = { 帯同審判: 'referee', コミッショナー: 'commissioner', その他: 'other' };
const LOCATION_LABEL_REVERSE = { 気仙管内: 'in', 気仙管外: 'out' };
const OUT_SUPPLY_LABEL_REVERSE = { 交通費: 'transport', 弁当: 'bento' };
const GAMETYPE_LABEL_REVERSE = { 練習試合: 'practice_game', 公式戦: 'official_game' };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function buildBackupRows(list = records) {
  const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return sorted.map((r) => [
    r.date,
    r.name,
    roleLabel(r.role),
    r.role === 'referee' ? RULES.referee.gametype[r.gametype]?.label ?? '' : '',
    r.location ? LOCATION_LABEL[r.location] : '',
    r.duration ? DURATION_SIMPLE_LABEL[r.duration] ?? '' : '',
    r.gamecount ?? '',
    r.location === 'out' ? OUT_SUPPLY_LABEL[r.outSupply] ?? OUT_SUPPLY_LABEL.transport : '',
    r.otherContent ?? '',
    r.amount,
    r.venue ?? '',
    r.note ?? '',
  ]);
}

function handleBackupExportClick() {
  if (records.length === 0) {
    alert('出力できる記録がありません');
    return;
  }
  const rows = buildBackupRows();
  const bytes = buildXlsxFile('謝礼金記録', BACKUP_HEADER, rows);
  const today = todayLocal().replace(/-/g, '');
  downloadBytes(bytes, `謝礼金_バックアップ_${today}.xlsx`, XLSX_MIME);
  showToast('バックアップを出力しました');
}

/* CSVを行・セルの2次元配列にする。""で囲まれたセル内のカンマ・改行・""にも対応する */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n') {
      row.push(cur);
      cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  row.push(cur);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/* CSVの文字コードを判定して読む。UTF-8として正しく読めなければ、日本語版ExcelのCSV保存形式(Shift_JIS)として読む */
function decodeCsvBytes(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (e) {
    return new TextDecoder('shift_jis').decode(buffer);
  }
}

/* .xlsxファイル（zip）から最初のシートを行・セルの2次元配列で読み出す。外部ライブラリは使わず、
 * zipの展開はブラウザ標準のDecompressionStreamで行う */
async function readXlsxRows(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Excelファイル（.xlsx）として読み込めませんでした');
  const entryCount = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = {};
  const utf8 = new TextDecoder('utf-8');
  for (let n = 0; n < entryCount; n++) {
    const nameLen = view.getUint16(p + 28, true);
    entries[utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen))] = {
      method: view.getUint16(p + 10, true),
      size: view.getUint32(p + 20, true),
      offset: view.getUint32(p + 42, true),
    };
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  const readEntry = async (name) => {
    const e = entries[name];
    if (!e) return null;
    const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
    const data = bytes.subarray(start, start + e.size);
    if (e.method === 0) return utf8.decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return utf8.decode(await new Response(stream).arrayBuffer());
  };
  const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');
  // ふりがな(rPh)は除いて、セルの文字だけをつなげる
  const textOf = (node) =>
    [...node.getElementsByTagName('t')].filter((t) => !t.parentNode || t.parentNode.nodeName !== 'rPh').map((t) => t.textContent).join('');

  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = await readEntry('xl/workbook.xml');
  const rels = await readEntry('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const firstSheet = parseXml(workbook).getElementsByTagName('sheet')[0];
    const rid = firstSheet && firstSheet.getAttribute('r:id');
    const rel = [...parseXml(rels).getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
    if (rel) {
      const target = rel.getAttribute('Target');
      sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    }
  }
  const sharedXml = await readEntry('xl/sharedStrings.xml');
  const shared = sharedXml ? [...parseXml(sharedXml).getElementsByTagName('si')].map(textOf) : [];
  const sheetXml = await readEntry(sheetPath);
  if (!sheetXml) throw new Error('Excelファイルにシートが見つかりませんでした');

  const colIndex = (ref) => {
    const letters = (ref || '').replace(/[0-9]/g, '');
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  return [...parseXml(sheetXml).getElementsByTagName('row')]
    .map((rowEl) => {
      const cells = [];
      [...rowEl.getElementsByTagName('c')].forEach((c, i) => {
        const idx = c.getAttribute('r') ? colIndex(c.getAttribute('r')) : i;
        const type = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0];
        let value = '';
        if (type === 's') value = shared[Number(v && v.textContent)] ?? '';
        else if (type === 'inlineStr') value = textOf(c);
        else value = v ? v.textContent : '';
        cells[idx] = value;
      });
      return Array.from(cells, (x) => x ?? '');
    })
    .filter((cells) => cells.some((x) => String(x).trim() !== ''));
}

/* 日付を「YYYY-MM-DD」にそろえる。Excelで開き直したファイルの「2026/9/25」や日付シリアル値にも対応する */
function normalizeImportDate(value) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return v;
}

/* CSVの1行(cells)を、バックアップ形式のヘッダー(header)を手がかりに記録オブジェクトへ変換する。
 * 必須項目が欠けている・区分や試合種別が認識できない場合はnullを返す */
function parseBackupRow(cells, header) {
  const idx = (name) => header.indexOf(name);
  const get = (name) => {
    const i = idx(name);
    return i === -1 ? '' : (cells[i] ?? '').trim();
  };

  const date = normalizeImportDate(get('日付'));
  const name = get('氏名');
  const role = ROLE_LABEL_REVERSE[get('区分')];
  const amount = Number(get('支給額'));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name || !role || !Number.isFinite(amount)) return null;

  const record = { date, name, role, amount, venue: get('大会開催地'), note: get('備考') };

  if (role === 'referee') {
    const gametype = GAMETYPE_LABEL_REVERSE[get('試合種別')];
    if (!gametype) return null;
    record.gametype = gametype;
    if (gametype === 'practice_game') {
      const location = LOCATION_LABEL_REVERSE[get('活動場所')];
      const duration = DURATION_SIMPLE_REVERSE[get('拘束時間')];
      if (!location || !duration) return null;
      record.location = location;
      record.duration = duration;
    } else {
      const gc = Number(get('試合数'));
      record.gamecount = Number.isFinite(gc) && gc > 0 ? gc : 1;
    }
  } else if (role === 'commissioner') {
    const location = LOCATION_LABEL_REVERSE[get('活動場所')];
    if (!location) return null;
    record.location = location;
    const gc = Number(get('試合数'));
    record.gamecount = Number.isFinite(gc) && gc > 0 ? gc : 1;
  } else if (role === 'other') {
    const otherContent = get('内容');
    if (!otherContent) return null;
    record.otherContent = otherContent;
  }

  if (record.location === 'out') {
    record.outSupply = OUT_SUPPLY_LABEL_REVERSE[get('管外支給')] || 'transport';
  }

  return record;
}

const sameValue = (a, b) => (a ?? null) === (b ?? null);
const isSameRecord = (a, b) =>
  a.date === b.date &&
  a.name === b.name &&
  a.role === b.role &&
  sameValue(a.gametype, b.gametype) &&
  sameValue(a.location, b.location) &&
  sameValue(a.duration, b.duration) &&
  sameValue(a.gamecount, b.gamecount) &&
  sameValue(a.outSupply, b.outSupply) &&
  sameValue(a.otherContent, b.otherContent) &&
  Number(a.amount) === Number(b.amount);

async function handleImportRows(rows) {
  const resultEl = document.getElementById('import-result');
  if (rows.length === 0) {
    resultEl.textContent = 'ファイルが空です';
    return;
  }
  const header = rows[0].map((h) => String(h).trim());
  if (!header.includes('日付') || !header.includes('氏名') || !header.includes('区分') || !header.includes('支給額')) {
    resultEl.textContent = 'ファイルの形式が正しくありません（日付・氏名・区分・支給額の列が必要です）';
    return;
  }

  let duplicated = 0;
  let invalid = 0;
  const toAdd = [];

  rows.slice(1).forEach((cells) => {
    if (cells.length < 2) return;
    const record = parseBackupRow(cells.map((c) => String(c ?? '')), header);
    if (!record) {
      invalid++;
      return;
    }
    if (records.some((r) => isSameRecord(r, record)) || toAdd.some((r) => isSameRecord(r, record))) {
      duplicated++;
      return;
    }
    toAdd.push(record);
  });

  const skipped = [];
  if (duplicated > 0) skipped.push(`重複のためスキップ: ${duplicated}件`);
  if (invalid > 0) skipped.push(`形式不正のためスキップ: ${invalid}件`);
  const skippedText = skipped.length ? `（${skipped.join('、')}）` : '';

  if (toAdd.length === 0) {
    resultEl.textContent = `追加する記録はありませんでした${skippedText}`;
    return;
  }
  resultEl.textContent = '取り込み中...';
  try {
    await window.FirebaseData.addRecords(toAdd);
    resultEl.textContent = `${toAdd.length}件を追加しました${skippedText}`;
    showToast(`${toAdd.length}件を取り込みました`);
  } catch (err) {
    console.error('addRecords failed', err);
    resultEl.textContent = '取込に失敗しました: ' + err.message;
  }
}

async function handleImportFile(file) {
  const resultEl = document.getElementById('import-result');
  try {
    const buffer = await file.arrayBuffer();
    const isXlsx = /\.xlsx$/i.test(file.name) || new Uint8Array(buffer.slice(0, 2)).join() === '80,75'; // "PK"
    const rows = isXlsx ? await readXlsxRows(buffer) : parseCsv(decodeCsvBytes(buffer));
    await handleImportRows(rows);
  } catch (err) {
    console.error('import failed', err);
    resultEl.textContent = 'ファイルを読み込めませんでした: ' + err.message;
  }
}

function initBackup() {
  document.getElementById('btn-backup-export').addEventListener('click', handleBackupExportClick);
  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    handleImportFile(file);
    e.target.value = '';
  });
}

/* ============================================================
 * 封筒印刷（長形3号・120x235mm、一覧の記録1件の日付・対象者分）
 * ============================================================ */
function formatDisplayName(name) {
  return name.length === 4 ? name.slice(0, 2) + '　' + name.slice(2) : name;
}

function reiwaYearOf(y) {
  return y - 2018;
}

/* 「令和8年8月15日」の形式で日付を表示する */
function formatEraDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `令和${reiwaYearOf(y)}年${m}月${d}日`;
}

/* 同じ日付・同じ対象者の記録（例: 同日に審判とコミッショナーを担当）は1枚の封筒に合算する */
function buildEnvelopeEntry(record) {
  const total = records
    .filter((r) => r.name === record.name && r.date === record.date)
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  return { name: record.name, total, date: record.date };
}

function renderEnvelopePrintArea(entries, feeLabel) {
  document.getElementById('receipt-print-area').innerHTML = '';
  const area = document.getElementById('envelope-print-area');
  area.innerHTML = entries
    .map(
      (e) => `
      <div class="envelope-page">
        <div class="env-top">
          <img class="env-logo" src="logo.png" alt="KESEN LARUS BASKETBALL CLUB">
          <div class="env-logo-rule"></div>
        </div>
        <div class="env-mid">
          <div class="env-name-block"><div class="env-name">${escapeHtml(formatDisplayName(e.name))}<span class="sama">様</span></div></div>
          <div class="env-period-block">
            <span class="env-label">日付</span>
            <div class="env-period">${escapeHtml(formatEraDate(e.date))}</div>
            <div class="env-fee-type">${escapeHtml(feeLabel)}</div>
          </div>
          <div class="env-amount-block"><span class="env-amount-num">${numFmt(e.total)}</span><span class="env-amount-unit">円</span></div>
        </div>
        <div class="env-footer">KESEN LARUS BASKETBALL CLUB</div>
      </div>`
    )
    .join('');
}

/* 封筒(長形3号)と精算書(A5)で必要な用紙サイズが異なるため、
 * 印刷直前だけ動的にスタイルを差し込み、印刷後に取り除く */
function printWithPageSize(sizeCss) {
  const style = document.createElement('style');
  style.textContent = `@page { size: ${sizeCss}; margin: 0; }`;
  document.head.appendChild(style);
  const cleanup = () => {
    style.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 60000);
  window.print();
}

function printWithEnvelopePageSize() {
  printWithPageSize('120mm 235mm');
}

function handleEnvelopeClick(record) {
  renderEnvelopePrintArea([buildEnvelopeEntry(record)], '謝礼金');
  printWithEnvelopePageSize();
}

/* ============================================================
 * ダッシュボード
 * ============================================================ */
const CATEGORY_CHART_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
const PEOPLE_CHART_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)'];
const FISCAL_MONTH_LABELS = ['4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月', '1月', '2月', '3月'];
const DASH_CATEGORY_DEFS = [
  { label: '帯同審判(練習試合)', match: (r) => r.role === 'referee' && r.gametype === 'practice_game' },
  { label: '帯同審判(公式戦)', match: (r) => r.role === 'referee' && r.gametype === 'official_game' },
  { label: 'コミッショナー', match: (r) => r.role === 'commissioner' },
  { label: 'その他', match: (r) => r.role === 'other' },
];
const DASH_PEOPLE_CHART_LIMIT = 12;

/* 年度は4月始まり(その年の4月〜翌年3月)。fiscalYearOfは年度の開始年(西暦)を返す */
function fiscalYearOf(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  return m >= 4 ? y : y - 1;
}

function fiscalMonthIndex(dateStr) {
  const m = Number(dateStr.slice(5, 7));
  return m >= 4 ? m - 4 : m + 8;
}

function fiscalYearLabel(fy) {
  const reiwaYear = fy - 2018;
  return `令和${reiwaYear}年度（${fy}年4月〜${fy + 1}年3月）`;
}

function getFiscalYearsWithData() {
  const years = new Set(records.map((r) => fiscalYearOf(r.date)));
  years.add(fiscalYearOf(todayLocal()));
  return [...years].sort((a, b) => b - a);
}

function computeAnnualData(fiscalYear) {
  const yearRecords = records.filter((r) => fiscalYearOf(r.date) === fiscalYear);

  const monthly = Array(12).fill(0);
  yearRecords.forEach((r) => {
    monthly[fiscalMonthIndex(r.date)] += Number(r.amount) || 0;
  });
  const total = monthly.reduce((a, b) => a + b, 0);
  const count = yearRecords.length;

  const categories = DASH_CATEGORY_DEFS.map((def) => ({
    label: def.label,
    total: yearRecords.filter(def.match).reduce((s, r) => s + (Number(r.amount) || 0), 0),
  }));

  const amountByName = new Map();
  const countByName = new Map();
  yearRecords.forEach((r) => {
    amountByName.set(r.name, (amountByName.get(r.name) || 0) + (Number(r.amount) || 0));
    countByName.set(r.name, (countByName.get(r.name) || 0) + 1);
  });
  const people = [...amountByName.keys()]
    .map((name) => ({ name, amount: amountByName.get(name), count: countByName.get(name) }))
    .sort((a, b) => b.amount - a.amount);

  const monthsWithData = monthly.filter((v) => v > 0).length;
  const monthlyAverage = monthsWithData === 0 ? 0 : Math.round(total / monthsWithData);
  const topPerson = people[0] || null;

  return { fiscalYear, monthly, total, count, categories, people, monthlyAverage, topPerson };
}

function initDashboard() {
  document.getElementById('dash-year').addEventListener('change', renderDashboard);
}

function renderDashboard() {
  const yearSel = document.getElementById('dash-year');
  const years = getFiscalYearsWithData();
  const keep = yearSel.value ? Number(yearSel.value) : fiscalYearOf(todayLocal());
  yearSel.innerHTML = years.map((y) => `<option value="${y}">${escapeHtml(fiscalYearLabel(y))}</option>`).join('');
  yearSel.value = years.includes(keep) ? keep : years[0];

  const data = computeAnnualData(Number(yearSel.value));
  renderDashTiles(data);
  renderMonthlyChart(data);
  renderCategoryChart(data);
  renderPeopleChart(data);
}

function renderDashTiles(data) {
  const tiles = [
    { label: '年間合計費用', value: yen(data.total) },
    { label: '支払件数', value: `${data.count} 件` },
    { label: '活動月平均費用', value: yen(data.monthlyAverage), sub: '記録のある月の平均' },
    {
      label: '支払額トップ',
      value: data.topPerson ? data.topPerson.name : '-',
      sub: data.topPerson ? `${yen(data.topPerson.amount)}（${data.topPerson.count}件）` : '',
    },
  ];
  document.getElementById('dash-tiles').innerHTML = tiles
    .map(
      (t) => `
    <div class="stat-tile">
      <div class="stat-tile-label">${escapeHtml(t.label)}</div>
      <div class="stat-tile-value">${escapeHtml(String(t.value))}</div>
      ${t.sub ? `<div class="stat-tile-sub">${escapeHtml(t.sub)}</div>` : ''}
    </div>`
    )
    .join('');
}

function showChartTooltip(evt, text) {
  const tip = document.getElementById('chart-tooltip');
  tip.textContent = text;
  tip.style.left = evt.clientX + 'px';
  tip.style.top = evt.clientY + 'px';
  tip.classList.add('show');
}
function moveChartTooltip(evt) {
  const tip = document.getElementById('chart-tooltip');
  tip.style.left = evt.clientX + 'px';
  tip.style.top = evt.clientY + 'px';
}
function hideChartTooltip() {
  document.getElementById('chart-tooltip').classList.remove('show');
}

function renderBarChart(containerId, items, colors, options = {}) {
  const container = document.getElementById(containerId);
  const max = Math.max(...items.map((i) => i.value), 1);
  const showValueLabel = options.showValueLabel !== false;

  container.innerHTML = items
    .map((item, i) => {
      const heightPct = item.value > 0 ? Math.max((item.value / max) * 100, 2) : 0;
      const color = typeof colors === 'function' ? colors(i) : colors[i % colors.length];
      const tooltip = `${item.label}: ${yen(item.value)}`;
      return `
      <div class="chart-bar-col" data-tooltip="${escapeHtml(tooltip)}">
        ${showValueLabel && item.value > 0 ? `<div class="chart-bar-value">${yen(item.value)}</div>` : ''}
        <div class="chart-bar" style="height:${heightPct}%; background:${color}"></div>
        <div class="chart-bar-label">${escapeHtml(item.label)}</div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.chart-bar-col').forEach((col) => {
    col.addEventListener('mouseenter', (e) => showChartTooltip(e, col.dataset.tooltip));
    col.addEventListener('mousemove', moveChartTooltip);
    col.addEventListener('mouseleave', hideChartTooltip);
  });
}

function renderMonthlyChart(data) {
  const items = data.monthly.map((v, i) => ({ label: FISCAL_MONTH_LABELS[i], value: v }));
  renderBarChart('dash-monthly-chart', items, ['var(--primary)'], { showValueLabel: false });

  document.getElementById('dash-monthly-table').innerHTML = items
    .map((it) => `<tr><td>${escapeHtml(it.label)}</td><td class="num">${yen(it.value)}</td></tr>`)
    .join('');
}

function renderCategoryChart(data) {
  renderBarChart(
    'dash-category-chart',
    data.categories.map((c) => ({ label: c.label, value: c.total })),
    CATEGORY_CHART_COLORS
  );

  document.getElementById('dash-category-legend').innerHTML = data.categories
    .map(
      (c, i) =>
        `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${CATEGORY_CHART_COLORS[i]}"></span>${escapeHtml(c.label)}</span>`
    )
    .join('');

  document.getElementById('dash-category-table').innerHTML = data.categories
    .map((c) => {
      const pct = data.total === 0 ? 0 : Math.round((c.total / data.total) * 100);
      return `<tr><td>${escapeHtml(c.label)}</td><td class="num">${yen(c.total)}</td><td class="num">${pct}%</td></tr>`;
    })
    .join('');
}

function renderPeopleChart(data) {
  const chartPeople = data.people.slice(0, DASH_PEOPLE_CHART_LIMIT);
  renderBarChart(
    'dash-people-chart',
    chartPeople.map((p) => ({ label: p.name, value: p.amount })),
    PEOPLE_CHART_COLORS
  );

  document.getElementById('dash-people-legend').innerHTML =
    chartPeople
      .map(
        (p, i) =>
          `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${PEOPLE_CHART_COLORS[i % PEOPLE_CHART_COLORS.length]}"></span>${escapeHtml(p.name)}</span>`
      )
      .join('') + (data.people.length > DASH_PEOPLE_CHART_LIMIT ? `<span class="chart-legend-item">他 ${data.people.length - DASH_PEOPLE_CHART_LIMIT} 名</span>` : '');

  document.getElementById('dash-people-table').innerHTML = data.people
    .map((p) => {
      const pct = data.total === 0 ? 0 : Math.round((p.amount / data.total) * 100);
      return `<tr><td>${escapeHtml(p.name)}</td><td class="num">${yen(p.amount)}</td><td class="num">${p.count}件</td><td class="num">${pct}%</td></tr>`;
    })
    .join('');
}

/* ============================================================
 * 認証（共有の合言葉でFirebase Authenticationにログイン。交通費アプリと同じアカウント）
 * ============================================================ */
function initAuth() {
  const loginForm = document.getElementById('login-form');
  const loginPin = document.getElementById('login-pin');
  const loginError = document.getElementById('login-error');
  const loginStatus = document.getElementById('login-status');
  const logoutBtn = document.getElementById('btn-logout');

  let unsubscribeRecords = null;
  let unsubscribeRoster = null;
  let unsubscribeContacts = null;
  let autoLoginAttempted = false;

  const urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey) {
    loginStatus.textContent = '自動ログイン中...';
  }

  function tryAutoLogin() {
    if (autoLoginAttempted || !urlKey) return;
    autoLoginAttempted = true;
    window.FirebaseData.signIn(urlKey)
      .then(() => {
        history.replaceState(null, '', location.pathname + location.hash);
      })
      .catch((err) => {
        console.error('auto signIn failed', err);
        loginError.textContent = 'URLの合言葉が正しくありません。手動で入力してください';
      });
  }

  window.FirebaseData.onAuthChange((user) => {
    loginStatus.style.display = 'none';

    if (!user) {
      // signIn()が同じonAuthChangeコールバックを同期的に再入呼び出しするため、
      // 今回のコールバック処理が完了してから実行する
      setTimeout(tryAutoLogin, 0);
    }

    if (user) {
      document.body.classList.remove('auth-locked');
      loginError.textContent = '';
      loginPin.value = '';
      if (!unsubscribeRecords) {
        unsubscribeRecords = window.FirebaseData.subscribeRecords((recs) => {
          records = recs;
          renderList();
          renderDashboard();
          renderVenueOptions();
        });
      }
      if (!unsubscribeRoster) {
        unsubscribeRoster = window.FirebaseData.subscribeRoster((names) => {
          rosterNames = names;
          renderNameChips();
          renderRosterList();
          renderContactSettingsBody();
        });
      }
      if (!unsubscribeContacts) {
        unsubscribeContacts = window.FirebaseData.subscribeContacts((c) => {
          contactsCache = c;
          refreshContactInputs();
        });
      }
    } else {
      document.body.classList.add('auth-locked');
      if (unsubscribeRecords) {
        unsubscribeRecords();
        unsubscribeRecords = null;
      }
      if (unsubscribeRoster) {
        unsubscribeRoster();
        unsubscribeRoster = null;
      }
      if (unsubscribeContacts) {
        unsubscribeContacts();
        unsubscribeContacts = null;
      }
      records = [];
      rosterNames = [];
      contactsCache = { addresses: {}, phones: {} };
    }
  });

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = loginPin.value;
    if (!pin) return;
    loginError.textContent = '';
    window.FirebaseData.signIn(pin).catch((err) => {
      console.error('signIn failed', err);
      loginError.textContent = '合言葉が正しくありません';
    });
  });

  logoutBtn.addEventListener('click', () => {
    window.FirebaseData.signOut();
  });
}

/* ============================================================
 * 初期化
 * ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initForm();
  initRoster();
  initContactSettings();
  initList();
  initDashboard();
  initBackup();
  initAuth();
});
