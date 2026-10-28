// ---------- 상수 ----------
const PHASES = {
  cut:  { name: '다이어트', color: 'var(--cut)',  kcalMul: 0.80, proteinPerKg: 2.2, desc: '체지방 감량. 근손실을 막기 위해 단백질을 높게 유지합니다.' },
  lean: { name: '린매스업', color: 'var(--lean)', kcalMul: 1.07, proteinPerKg: 2.0, desc: '지방은 최소로, 근육은 천천히. 소폭 잉여 칼로리.' },
  bulk: { name: '벌크업',   color: 'var(--bulk)', kcalMul: 1.15, proteinPerKg: 1.8, desc: '근육량 증가에 집중. 충분한 잉여 칼로리.' },
};
const FAT_RATIO = 0.25;
const MEALS = ['아침', '점심', '저녁', '간식'];
const SRC_LABEL = { db: '기본', my: '내 음식', mfds: '식약처', off: '바코드DB' };  // off = Open Food Facts
const SCANNER_URL = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

// ---------- 저장소 ----------
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem('myhealth.' + key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('myhealth.' + key, JSON.stringify(value)); } catch {}
  },
};

let profile = store.get('profile', { sex: 'M', age: '', height: '', activity: '1.375', phase: null });
let inbody  = store.get('inbody', []);   // [{date, weight, smm, bodyFat, bmr}]
let foods   = store.get('foods', {});    // {'YYYY-MM-DD': [{id, meal, name, amount, kcal, carb, protein, fat}]}
let myFoods = store.get('myFoods', []);  // [음식 객체 + barcode?]
let recent  = store.get('recent', []);   // 최근 기록한 음식 객체
let mfdsKey = store.get('mfdsKey', '');

// 음식 객체: { src, name, brand?, barcode?, servingLabel, servingG|null, n: {kcal, carb, protein, fat} (1 제공량 기준) }

// ---------- 유틸 ----------
const $ = (id) => document.getElementById(id);
const num = (v) => Number(v) || 0;
const round = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
const toKey = (d) => {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};
const foodKey = (f) => `${f.src}|${f.barcode || ''}|${f.name}|${f.servingLabel}`;
let currentDate = new Date();

// ---------- 계산 ----------
function latestInbody() {
  return [...inbody].sort((a, b) => a.date.localeCompare(b.date)).at(-1) || null;
}

function recommendPhase(sex, bodyFat) {
  const [high, low] = sex === 'F' ? [28, 20] : [20, 12];
  if (bodyFat > high) return 'cut';
  if (bodyFat < low) return 'bulk';
  return 'lean';
}

function calcTargets() {
  const ib = latestInbody();
  if (!ib) return null;
  const lbm = ib.weight * (1 - ib.bodyFat / 100);
  const bmr = ib.bmr || (370 + 21.6 * lbm);   // Katch-McArdle
  const tdee = bmr * num(profile.activity);
  const recommended = recommendPhase(profile.sex, ib.bodyFat);
  const phase = profile.phase || recommended;
  const p = PHASES[phase];

  const kcal = tdee * p.kcalMul;
  const protein = ib.weight * p.proteinPerKg;
  const fat = (kcal * FAT_RATIO) / 9;
  const carb = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);

  return { ib, lbm, bmr, tdee, recommended, phase, kcal, protein, fat, carb };
}

function dayTotals(key) {
  return (foods[key] || []).reduce((t, f) => ({
    kcal: t.kcal + f.kcal, carb: t.carb + f.carb, protein: t.protein + f.protein, fat: t.fat + f.fat,
  }), { kcal: 0, carb: 0, protein: 0, fat: 0 });
}

// ---------- 음식 검색 ----------
function searchLocal(q) {
  const k = norm(q);
  return [...myFoods, ...FOOD_DB].filter((f) => norm(f.name + (f.brand || '')).includes(k));
}

// 식약처 식품영양성분DB (공공데이터포털)
async function searchMfds(q) {
  if (!mfdsKey) return [];
  const url = 'https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02'
    + `?serviceKey=${encodeURIComponent(mfdsKey)}&pageNo=1&numOfRows=30&type=json&FOOD_NM_KR=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`식약처 API 오류 (${res.status})`);
  const data = await res.json();
  let items = data?.body?.items ?? [];
  if (!Array.isArray(items)) items = items.item ? [].concat(items.item) : [];
  return items.map((it) => {
    const serving = it.SERVING_SIZE || '100g';
    const g = parseFloat(serving);
    return {
      src: 'mfds',
      name: it.FOOD_NM_KR,
      brand: it.MAKER_NM && it.MAKER_NM !== '해당없음' ? it.MAKER_NM : '',
      servingLabel: serving,
      servingG: /g|ml/i.test(serving) && g > 0 ? g : null,
      n: { kcal: num(it.AMT_NUM1), protein: num(it.AMT_NUM3), fat: num(it.AMT_NUM4), carb: num(it.AMT_NUM6) },
    };
  }).filter((f) => f.name);
}

// Open Food Facts → 공통 음식 객체
function fromOff(p, code) {
  const nm = p.nutriments || {};
  const kcal100 = nm['energy-kcal_100g'] ?? (nm.energy_100g != null ? nm.energy_100g / 4.184 : null);
  if (kcal100 == null) return null;
  const per100 = { kcal: num(kcal100), carb: num(nm.carbohydrates_100g), protein: num(nm.proteins_100g), fat: num(nm.fat_100g) };
  const sq = num(p.serving_quantity);
  return {
    src: 'off',
    barcode: code || p.code,
    name: p.product_name_ko || p.product_name || '이름 없는 제품',
    brand: p.brands || '',
    servingLabel: sq ? (p.serving_size || `${sq}g`) : '100g',
    servingG: sq || 100,
    n: sq ? scale(per100, sq / 100) : per100,
  };
}

async function lookupBarcode(code) {
  const mine = myFoods.find((f) => f.barcode === code);
  if (mine) return mine;
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`
    + '?fields=code,product_name,product_name_ko,brands,serving_size,serving_quantity,nutriments',
    { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.status === 1 ? fromOff(data.product, code) : null;
}

let searchSeq = 0;
let lastResults = [];

async function runSearch(q) {
  q = q.trim();
  const seq = ++searchSeq;
  if (!q) { lastResults = []; renderResults(); return; }

  lastResults = searchLocal(q);
  renderResults('온라인에서 찾는 중…');

  const online = await Promise.allSettled([searchMfds(q)]);
  if (seq !== searchSeq) return;   // 더 최근 검색이 있으면 무시
  const errors = [];
  online.forEach((r) => {
    if (r.status === 'fulfilled') lastResults.push(...r.value);
    else if (r.reason?.message?.startsWith('식약처')) errors.push(r.reason.message);
  });
  const seen = new Set();
  lastResults = lastResults.filter((f) => !seen.has(foodKey(f)) && seen.add(foodKey(f)));
  renderResults(errors.join(' / ') || (!mfdsKey ? '설정에서 식약처 API 키를 넣으면 더 많은 음식이 검색돼요.' : ''));
}

function renderResults(note = '') {
  const list = lastResults.slice(0, 50);
  $('results').innerHTML = list.map((f, i) => `
    <div class="result" data-i="${i}">
      <div><span class="src ${f.src}">${SRC_LABEL[f.src]}</span>${esc(f.name)}
        ${f.brand ? `<br><small class="muted">${esc(f.brand)}</small>` : ''}</div>
      <div style="white-space:nowrap;text-align:right">${round(f.n.kcal)} kcal<br><small class="muted">${esc(f.servingLabel)}</small></div>
    </div>`).join('')
    + (note ? `<p class="muted">${esc(note)}</p>` : '')
    + ($('searchInput').value.trim() && !list.length && !note ? `<p class="muted">검색 결과가 없어요. 아래 "직접 입력"을 사용하세요.</p>` : '');
}

// ---------- 음식 상세 시트 ----------
let sheetFood = null;

function scale(n, m) {
  return { kcal: n.kcal * m, carb: n.carb * m, protein: n.protein * m, fat: n.fat * m };
}

function sheetMultiplier() {
  const amt = num($('sAmount').value);
  return $('sUnit').value === 'g' ? amt / sheetFood.servingG : amt;
}

function openFoodSheet(food) {
  sheetFood = food;
  $('sName').textContent = food.name;
  $('sMeta').textContent = [SRC_LABEL[food.src], food.brand, `${food.servingLabel} 기준`, food.barcode && `바코드 ${food.barcode}`]
    .filter(Boolean).join(' · ');
  $('sUnit').innerHTML = `<option value="serving">${esc(food.servingLabel)}</option>`
    + (food.servingG ? `<option value="g">g (그램)</option>` : '');
  $('sAmount').value = 1;
  $('sMeal').value = guessMeal();
  $('sSaveWrap').classList.toggle('hidden', food.src === 'my');
  $('sSave').checked = !!food.barcode;   // 바코드로 찾은 제품은 기본으로 저장
  updateSheetMacros();
  $('foodSheet').classList.remove('hidden');
}

function updateSheetMacros() {
  const n = scale(sheetFood.n, sheetMultiplier());
  $('sMacros').innerHTML = `
    <div><b>${round(n.kcal)}</b><small>kcal</small></div>
    <div><b>${r1(n.carb)}</b><small>탄수화물 g</small></div>
    <div><b>${r1(n.protein)}</b><small>단백질 g</small></div>
    <div><b>${r1(n.fat)}</b><small>지방 g</small></div>`;
}

function guessMeal() {
  const h = new Date().getHours();
  return h < 10 ? '아침' : h < 15 ? '점심' : h < 21 ? '저녁' : '간식';
}

// ---------- 기록 ----------
function logFood(food, multiplier, meal, amountText) {
  const n = scale(food.n, multiplier);
  const key = toKey(currentDate);
  (foods[key] ||= []).push({
    id: Date.now() + Math.random(), meal, name: food.name, amount: amountText,
    kcal: r1(n.kcal), carb: r1(n.carb), protein: r1(n.protein), fat: r1(n.fat),
  });
  store.set('foods', foods);

  recent = [food, ...recent.filter((f) => foodKey(f) !== foodKey(food))].slice(0, 10);
  store.set('recent', recent);
  renderToday();
}

function saveMyFood(food) {
  const mine = { ...food, src: 'my' };
  myFoods = [mine, ...myFoods.filter((f) => !(f.name === mine.name && f.barcode === mine.barcode))];
  store.set('myFoods', myFoods);
  return mine;
}

// ---------- 렌더: 오늘 ----------
function bar(label, value, goal, color, unit) {
  const pct = goal ? Math.min(100, (value / goal) * 100) : 0;
  const over = goal && value > goal;
  return `
    <div class="stat-row" style="border:0;padding:0">
      <span>${label}</span>
      <span class="${over ? 'over' : ''}">${round(value)} / ${goal ? round(goal) : '-'} ${unit}</span>
    </div>
    <div class="bar"><div style="width:${pct}%;background:${color}"></div></div>`;
}

function renderToday() {
  const key = toKey(currentDate);
  $('dateLabel').textContent = key === toKey(new Date()) ? `오늘 (${key})` : key;

  const t = dayTotals(key);
  const g = calcTargets();
  const remain = g ? round(g.kcal - t.kcal) : null;

  $('summary').innerHTML = g ? `
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="muted">섭취 칼로리</div>
        <div class="big">${round(t.kcal)}<span class="muted"> / ${round(g.kcal)} kcal</span></div>
        <div class="${remain < 0 ? 'over' : 'muted'}">${remain >= 0 ? `${remain} kcal 남음` : `${-remain} kcal 초과`}</div>
      </div>
      <span class="tag" style="background:${PHASES[g.phase].color}">${PHASES[g.phase].name}</span>
    </div>
    <div style="margin-top:14px">
      ${bar('칼로리', t.kcal, g.kcal, 'var(--accent)', 'kcal')}
      ${bar('탄수화물', t.carb, g.carb, 'var(--carb)', 'g')}
      ${bar('단백질', t.protein, g.protein, 'var(--protein)', 'g')}
      ${bar('지방', t.fat, g.fat, 'var(--fat)', 'g')}
    </div>` : `
    <div class="muted">섭취 칼로리</div>
    <div class="big">${round(t.kcal)} kcal</div>
    <p class="muted">인바디 탭에서 정보를 입력하면 목표 칼로리와 탄단지가 계산됩니다.</p>`;

  $('recentChips').innerHTML = recent.length
    ? `<span class="muted" style="width:100%">최근 먹은 음식</span>`
      + recent.map((f, i) => `<button data-recent="${i}">${esc(f.name)}</button>`).join('')
    : '';

  const list = foods[key] || [];
  $('mealList').innerHTML = `<h2>먹은 음식</h2>` + (list.length ? MEALS.map((meal) => {
    const items = list.filter((f) => f.meal === meal);
    if (!items.length) return '';
    const sum = items.reduce((s, f) => s + f.kcal, 0);
    return `<div class="meal"><h3>${meal} · ${round(sum)} kcal</h3>` + items.map((f) => `
      <div class="food">
        <div>${esc(f.name)}${f.amount ? ` <small>${esc(f.amount)}</small>` : ''}<br>
          <small>탄 ${r1(f.carb)}g · 단 ${r1(f.protein)}g · 지 ${r1(f.fat)}g</small></div>
        <div style="white-space:nowrap">${round(f.kcal)} kcal <button data-del="${f.id}" title="삭제">×</button></div>
      </div>`).join('') + `</div>`;
  }).join('') : `<p class="muted">아직 기록이 없습니다.</p>`);
}

// ---------- 렌더: 인바디 ----------
function renderInbody() {
  $('pSex').value = profile.sex;
  $('pAge').value = profile.age;
  $('pHeight').value = profile.height;
  $('pActivity').value = profile.activity;

  const ib = latestInbody();
  $('iDate').value = toKey(new Date());
  if (ib) {
    $('iWeight').value = ib.weight;
    $('iSmm').value = ib.smm;
    $('iFat').value = ib.bodyFat;
    $('iBmr').value = ib.bmr || '';
  }

  const g = calcTargets();
  if (!g) {
    $('analysis').innerHTML = `<h2>분석 결과</h2><p class="muted">인바디 값을 입력하고 저장하세요.</p>`;
    return;
  }
  const p = PHASES[g.phase];
  $('analysis').innerHTML = `
    <h2>분석 결과</h2>
    <p class="muted">체지방률 기준 추천: <b style="color:${PHASES[g.recommended].color}">${PHASES[g.recommended].name}</b></p>
    <div class="phase-pick">
      ${Object.entries(PHASES).map(([k, v]) =>
        `<button data-p="${k}" class="${g.phase === k ? 'on' : ''}">${v.name}${g.recommended === k ? ' ⭐' : ''}</button>`).join('')}
    </div>
    <p class="muted" style="margin:10px 0">${p.desc}</p>
    <div class="stat-row"><span>제지방량</span><b>${g.lbm.toFixed(1)} kg</b></div>
    <div class="stat-row"><span>기초대사량 ${g.ib.bmr ? '(인바디)' : '(계산)'}</span><b>${round(g.bmr)} kcal</b></div>
    <div class="stat-row"><span>하루 소비 칼로리 (TDEE)</span><b>${round(g.tdee)} kcal</b></div>
    <div class="stat-row"><span>목표 칼로리</span><b style="color:${p.color}">${round(g.kcal)} kcal</b></div>
    <div class="stat-row"><span>탄수화물</span><b>${round(g.carb)} g</b></div>
    <div class="stat-row"><span>단백질</span><b>${round(g.protein)} g</b></div>
    <div class="stat-row"><span>지방</span><b>${round(g.fat)} g</b></div>
    ${profile.phase ? `<button class="btn ghost" id="resetPhase">추천 단계로 되돌리기</button>` : ''}`;
}

// ---------- 렌더: 기록 ----------
function renderHistory() {
  const g = calcTargets();
  const days = Object.keys(foods).filter((k) => foods[k].length).sort().reverse();
  $('historyTable').innerHTML = days.length ? `
    <table><tr><th>날짜</th><th>칼로리</th><th>단백질</th><th>목표 대비</th></tr>
    ${days.map((k) => {
      const t = dayTotals(k);
      const diff = g ? round(t.kcal - g.kcal) : null;
      return `<tr><td>${k}</td><td>${round(t.kcal)}</td><td>${round(t.protein)}g</td>
        <td class="${diff > 0 ? 'over' : ''}">${diff === null ? '-' : (diff > 0 ? '+' : '') + diff}</td></tr>`;
    }).join('')}</table>` : `<p class="muted">기록이 없습니다.</p>`;

  const ibs = [...inbody].sort((a, b) => b.date.localeCompare(a.date));
  $('inbodyTable').innerHTML = ibs.length ? `
    <table><tr><th>날짜</th><th>체중</th><th>골격근</th><th>체지방률</th></tr>
    ${ibs.map((i) => `<tr><td>${i.date}</td><td>${i.weight}</td><td>${i.smm}</td><td>${i.bodyFat}%</td></tr>`).join('')}
    </table>` : `<p class="muted">인바디 기록이 없습니다.</p>`;
}

// ---------- 렌더: 설정 ----------
function renderSettings() {
  $('mfdsKey').value = mfdsKey;
  $('myFoodsList').innerHTML = myFoods.length ? myFoods.map((f, i) => `
    <div class="food">
      <div>${esc(f.name)}<br><small>${esc(f.servingLabel)} · ${round(f.n.kcal)} kcal${f.barcode ? ` · 바코드 ${esc(f.barcode)}` : ''}</small></div>
      <button data-delmy="${i}" title="삭제">×</button>
    </div>`).join('') : `<p class="muted">저장된 음식이 없어요.</p>`;
}

// ---------- 바코드 스캐너 ----------
let scanner = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Html5Qrcode) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('스캐너를 불러오지 못했어요 (인터넷 연결 확인)'));
    document.head.appendChild(s);
  });
}

function barcodeFormats() {
  const F = Html5QrcodeSupportedFormats;
  return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128];
}

let scanSession = 0;   // 카메라가 켜지는 도중 창이 닫히면 켜진 카메라를 바로 끄기 위함

async function openScanner() {
  const session = ++scanSession;
  $('scanSheet').classList.remove('hidden');
  $('barcodeInput').value = '';
  $('scanStatus').textContent = '카메라를 켜는 중…';
  try {
    await loadScript(SCANNER_URL);
    if (session !== scanSession) return;
    const s = scanner = new Html5Qrcode('reader', { formatsToSupport: barcodeFormats(), verbose: false });
    await s.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h, w) * 0.45) }) },
      (code) => handleBarcode(code),
    );
    if (session !== scanSession) { await s.stop().catch(() => {}); return; }
    $('scanStatus').textContent = '카메라를 바코드에 맞춰주세요.';
  } catch (e) {
    if (session === scanSession) {
      $('scanStatus').textContent = `카메라를 사용할 수 없어요: ${e.message || e}. 아래 "사진 찍어서 인식"을 써보세요.`;
    }
  }
}

async function closeScanner() {
  scanSession++;
  $('scanSheet').classList.add('hidden');
  if (scanner) {
    try { if (scanner.isScanning) await scanner.stop(); scanner.clear(); } catch {}
    scanner = null;
  }
}

let barcodeBusy = false;
async function handleBarcode(code) {
  code = String(code).replace(/\D/g, '');
  if (!code || barcodeBusy) return;
  barcodeBusy = true;
  $('scanStatus').textContent = `바코드 ${code} 조회 중…`;
  try {
    const food = await lookupBarcode(code);
    await closeScanner();
    if (food) {
      openFoodSheet(food);
    } else {
      // 등록되지 않은 제품 → 영양성분표 보고 직접 입력, 바코드와 함께 저장
      alert(`바코드 ${code} 제품 정보를 찾지 못했어요.\n포장지의 영양정보를 보고 직접 입력하면 다음부터는 바로 불러와요.`);
      $('manualBox').open = true;
      $('fBarcode').value = code;
      $('fBarcodeNote').textContent = `바코드 ${code} 와 함께 저장됩니다.`;
      $('fBarcodeNote').classList.remove('hidden');
      $('fSave').checked = true;
      $('fName').focus();
    }
  } catch (e) {
    $('scanStatus').textContent = `조회 실패: ${e.message}`;
  } finally {
    barcodeBusy = false;
  }
}

// ---------- 이벤트 ----------
const renderers = { today: renderToday, inbody: renderInbody, history: renderHistory, settings: renderSettings };
document.querySelectorAll('nav button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + btn.dataset.tab));
  renderers[btn.dataset.tab]();
  window.scrollTo(0, 0);
}));

$('prevDay').onclick = () => { currentDate.setDate(currentDate.getDate() - 1); renderToday(); };
$('nextDay').onclick = () => { currentDate.setDate(currentDate.getDate() + 1); renderToday(); };

// 검색: 내장 DB는 입력 즉시, 온라인은 입력이 멈춘 뒤 실행
let searchTimer;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  lastResults = q.trim() ? searchLocal(q.trim()) : [];
  renderResults();
  if (q.trim()) searchTimer = setTimeout(() => runSearch(q), 600);
});
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value); e.target.blur(); }
});
$('results').onclick = (e) => {
  const el = e.target.closest('[data-i]');
  if (el) openFoodSheet(lastResults[el.dataset.i]);
};
$('recentChips').onclick = (e) => {
  const i = e.target.dataset.recent;
  if (i !== undefined) openFoodSheet(recent[i]);
};

$('sAmount').oninput = updateSheetMacros;
$('sUnit').onchange = () => {
  $('sAmount').value = $('sUnit').value === 'g' ? sheetFood.servingG : 1;
  updateSheetMacros();
};
$('sAdd').onclick = () => {
  const m = sheetMultiplier();
  if (!(m > 0)) return alert('양을 입력하세요.');
  let food = sheetFood;
  if ($('sSave').checked && food.src !== 'my') food = saveMyFood(food);
  const amountText = $('sUnit').value === 'g' ? `${num($('sAmount').value)}g` : `${food.servingLabel} × ${num($('sAmount').value)}`;
  logFood(food, m, $('sMeal').value, amountText);
  $('foodSheet').classList.add('hidden');
  $('searchInput').value = '';
  lastResults = [];
  renderResults();
};

$('addManual').onclick = () => {
  const name = $('fName').value.trim();
  const kcal = num($('fKcal').value);
  if (!name || !$('fKcal').value) return alert('음식 이름과 칼로리를 입력하세요.');
  let food = {
    src: 'my', name, barcode: $('fBarcode').value || undefined,
    servingLabel: $('fServing').value.trim() || '1회', servingG: null,
    n: { kcal, carb: num($('fCarb').value), protein: num($('fProtein').value), fat: num($('fFat').value) },
  };
  if ($('fSave').checked) food = saveMyFood(food);
  logFood(food, 1, guessMeal(), food.servingLabel);
  ['fName', 'fServing', 'fKcal', 'fCarb', 'fProtein', 'fFat', 'fBarcode'].forEach((id) => ($(id).value = ''));
  $('fBarcodeNote').classList.add('hidden');
  $('manualBox').open = false;
};

$('mealList').onclick = (e) => {
  const id = e.target.dataset.del;
  if (!id) return;
  const key = toKey(currentDate);
  foods[key] = foods[key].filter((f) => String(f.id) !== id);
  store.set('foods', foods);
  renderToday();
};

$('scanBtn').onclick = openScanner;
$('barcodeGo').onclick = () => handleBarcode($('barcodeInput').value);
$('scanFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('scanStatus').textContent = '사진에서 바코드를 찾는 중…';
  try {
    await loadScript(SCANNER_URL);
    if (scanner?.isScanning) await scanner.stop();
    scanner ||= new Html5Qrcode('reader', { formatsToSupport: barcodeFormats(), verbose: false });
    handleBarcode(await scanner.scanFile(file, false));
  } catch {
    $('scanStatus').textContent = '사진에서 바코드를 찾지 못했어요. 더 가까이, 밝은 곳에서 찍거나 숫자를 직접 입력하세요.';
  }
};

document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => {
  if (b.closest('#scanSheet')) closeScanner();
  else $('foodSheet').classList.add('hidden');
}));

$('saveInbody').onclick = () => {
  profile = { ...profile, sex: $('pSex').value, age: $('pAge').value, height: $('pHeight').value, activity: $('pActivity').value };
  store.set('profile', profile);

  const entry = { date: $('iDate').value, weight: num($('iWeight').value), smm: num($('iSmm').value), bodyFat: num($('iFat').value), bmr: num($('iBmr').value) || null };
  if (!entry.date || !entry.weight || !entry.bodyFat) return alert('측정일, 체중, 체지방률은 필수입니다.');
  inbody = inbody.filter((i) => i.date !== entry.date).concat(entry);
  store.set('inbody', inbody);
  renderInbody();
};

$('analysis').onclick = (e) => {
  if (e.target.dataset.p) profile.phase = e.target.dataset.p;
  else if (e.target.id === 'resetPhase') profile.phase = null;
  else return;
  store.set('profile', profile);
  renderInbody();
};

$('saveKey').onclick = () => {
  mfdsKey = $('mfdsKey').value.trim();
  store.set('mfdsKey', mfdsKey);
  alert(mfdsKey ? '저장했어요. 오늘 탭에서 검색해보세요.' : '키를 지웠어요.');
};

$('myFoodsList').onclick = (e) => {
  const i = e.target.dataset.delmy;
  if (i === undefined || !confirm(`"${myFoods[i].name}"을(를) 내 음식에서 삭제할까요?`)) return;
  myFoods.splice(i, 1);
  store.set('myFoods', myFoods);
  renderSettings();
};

$('exportBtn').onclick = () => {
  const data = { version: 1, profile, inbody, foods, myFoods, recent };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `myhealth-backup-${toKey(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('importFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm('지금 기기의 기록을 백업 파일 내용으로 바꿀까요?')) return;
    ({ profile, inbody, foods, myFoods = [], recent = [] } = data);
    Object.entries({ profile, inbody, foods, myFoods, recent }).forEach(([k, v]) => store.set(k, v));
    alert('불러왔어요.');
    renderSettings();
  } catch {
    alert('올바른 백업 파일이 아니에요.');
  }
};

// 오프라인 실행 & 홈 화면 앱 지원
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

renderToday();
