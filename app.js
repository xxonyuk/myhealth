// ---------- 상수 ----------
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

let profile = { sex: 'M', age: '', height: '', freq: '3-4', exercise: '', steps: '', meals: '3', period: '3', phase: null, targetKcal: null, foodPrefs: {},
  ...store.get('profile', {}) };
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
const optNum = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
const opt = (v, digits = 1) => (v == null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const show = (v, unit, digits = 1) => (v == null ? '–' : `${opt(v, digits)}${unit}`);
const NUTRIENTS = ['kcal', 'carb', 'protein', 'fat', 'sugar', 'sodium'];
// 하루 권장 상한: 당류 50g (총열량 10%, WHO), 나트륨 2,000mg (WHO)
const LIMITS = { sugar: 50, sodium: 2000 };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
const toKey = (d) => {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};
const foodKey = (f) => `${f.src}|${f.barcode || ''}|${f.name}|${f.servingLabel}`;
let currentDate = new Date();
let currentMeal = '아침';   // 식단 탭에서 선택된 끼니

// ---------- 계산 ----------
function latestInbody() {
  return [...inbody].sort((a, b) => a.date.localeCompare(b.date)).at(-1) || null;
}

function calcTargets() {
  return calcPlan(profile, latestInbody());
}

function dayTotals(key) {
  return (foods[key] || []).reduce((t, f) => ({
    kcal: t.kcal + f.kcal, carb: t.carb + f.carb, protein: t.protein + f.protein, fat: t.fat + f.fat,
    sugar: t.sugar + (f.sugar ?? 0), sodium: t.sodium + (f.sodium ?? 0),
  }), { kcal: 0, carb: 0, protein: 0, fat: 0, sugar: 0, sodium: 0 });
}

// ---------- 음식 검색 ----------
function searchLocal(q) {
  const k = norm(q);
  return [...myFoods, ...FOOD_DB].filter((f) => norm(f.name + (f.brand || '')).includes(k));
}

// 식약처 식품영양성분DB (공공데이터포털)
async function searchMfds(q) {
  if (!mfdsKey) return [];
  const url = 'https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo03/getFoodNtrCpntDbInq03'
    + `?serviceKey=${encodeURIComponent(mfdsKey)}&pageNo=1&numOfRows=100&type=json&FOOD_NM_KR=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`식약처 API 오류 (${res.status})`);
  const data = await res.json();
  let items = data?.body?.items ?? [];
  if (!Array.isArray(items)) items = items.item ? [].concat(items.item) : [];
  return items.map((it) => {
    // 영양값은 SERVING_SIZE(보통 100g/100mL) 기준, Z10500은 제품 1개(총) 중량
    const base = parseFloat(it.SERVING_SIZE) || 100;
    const unit = /ml/i.test(it.SERVING_SIZE || '') ? 'mL' : 'g';
    const whole = parseFloat(String(it.Z10500 || '').replace(/,/g, ''));
    // 1개 중량이 한 번에 먹을 만한 양이면 1개 기준으로 보여줌 (대용량 묶음은 100g 기준 유지)
    const perPack = whole >= 10 && whole <= 700 && whole !== base;
    const g = perPack ? whole : base;
    const k = g / base;
    const v = (x) => num(x) * k;
    const ov = (x) => { const o = optNum(x); return o == null ? null : o * k; };
    return {
      src: 'mfds',
      name: it.FOOD_NM_KR,
      brand: it.MAKER_NM && it.MAKER_NM !== '해당없음' ? it.MAKER_NM : '',
      servingLabel: perPack ? `${it.DB_GRP_CM === 'D' ? '1인분' : '1개'} (${round(g)}${unit})` : `${round(g)}${unit}`,
      servingG: g,
      n: { kcal: v(it.AMT_NUM1), protein: v(it.AMT_NUM3), fat: v(it.AMT_NUM4), carb: v(it.AMT_NUM6),
           sugar: ov(it.AMT_NUM7), sodium: ov(it.AMT_NUM13) },
    };
  }).filter((f) => f.name)
    // 이름이 검색어와 똑같거나 검색어로 시작하는 것을 위로, 그다음 짧은 이름 순
    .map((f) => ({ f, r: (f.name === q ? 0 : f.name.startsWith(q) ? 1 : 2) * 1000 + f.name.length }))
    .sort((a, b) => a.r - b.r).map((x) => x.f);
}

// Open Food Facts → 공통 음식 객체
function fromOff(p, code) {
  const nm = p.nutriments || {};
  const kcal100 = nm['energy-kcal_100g'] ?? (nm.energy_100g != null ? nm.energy_100g / 4.184 : null);
  if (kcal100 == null) return null;
  // 나트륨은 g 단위로 오므로 mg로 변환 (나트륨이 없고 소금만 있으면 소금 ÷ 2.5)
  const sodium100 = nm.sodium_100g ?? (nm.salt_100g != null ? nm.salt_100g / 2.5 : null);
  const per100 = {
    kcal: num(kcal100), carb: num(nm.carbohydrates_100g), protein: num(nm.proteins_100g), fat: num(nm.fat_100g),
    sugar: optNum(nm.sugars_100g), sodium: sodium100 == null ? null : sodium100 * 1000,
  };
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

// 당류·나트륨은 정보가 없는 음식이 있어서 null(모름)을 유지
function scale(n, m) {
  return Object.fromEntries(NUTRIENTS.map((k) => [k, n[k] == null ? null : n[k] * m]));
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
  $('sMeal').value = currentMeal;
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
    <div><b>${r1(n.fat)}</b><small>지방 g</small></div>
    <div><b>${show(n.sugar, '')}</b><small>당류 g</small></div>
    <div><b>${show(n.sodium, '', 0)}</b><small>나트륨 mg</small></div>`;
}

function guessMeal() {
  const h = new Date().getHours();
  return h < 10 ? '아침' : h < 15 ? '점심' : h < 21 ? '저녁' : '간식';
}

// ---------- 기록 ----------
function logFood(food, multiplier, meal, amountText) {
  currentMeal = meal;
  const n = scale(food.n, multiplier);
  const key = toKey(currentDate);
  (foods[key] ||= []).push({
    id: Date.now() + Math.random(), meal, name: food.name, amount: amountText,
    kcal: r1(n.kcal), carb: r1(n.carb), protein: r1(n.protein), fat: r1(n.fat), sugar: opt(n.sugar), sodium: opt(n.sodium, 0),
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
      ${bar('당류 (상한)', t.sugar, LIMITS.sugar, 'var(--sugar)', 'g')}
      ${bar('나트륨 (상한)', t.sodium, LIMITS.sodium, 'var(--sodium)', 'mg')}
    </div>` : `
    <div class="muted">섭취 칼로리</div>
    <div class="big">${round(t.kcal)} kcal</div>
    <div style="margin-top:14px">
      ${bar('당류 (상한)', t.sugar, LIMITS.sugar, 'var(--sugar)', 'g')}
      ${bar('나트륨 (상한)', t.sodium, LIMITS.sodium, 'var(--sodium)', 'mg')}
    </div>
    <p class="muted">목표 탭에서 인바디와 내 정보를 입력하면 목표 칼로리와 탄단지가 계산됩니다.</p>`;

  $('recentChips').innerHTML = recent.length
    ? `<span class="muted" style="width:100%">최근 먹은 음식</span>`
      + recent.map((f, i) => `<button data-recent="${i}">${esc(f.name)}</button>`).join('')
    : '';

  const list = foods[key] || [];
  const mealKcal = (meal) => list.filter((f) => f.meal === meal).reduce((s, f) => s + f.kcal, 0);
  $('mealTabs').innerHTML = MEALS.map((meal) => `
    <button data-meal="${meal}" class="${meal === currentMeal ? 'on' : ''}">${meal}<small>${round(mealKcal(meal))} kcal</small></button>`).join('');

  const items = list.filter((f) => f.meal === currentMeal);
  $('mealList').innerHTML = `<h2>${currentMeal} · ${round(mealKcal(currentMeal))} kcal</h2>` + (items.length ? items.map((f) => `
    <div class="food">
      <div>${esc(f.name)}${f.amount ? ` <small>${esc(f.amount)}</small>` : ''}<br>
        <small>탄 ${r1(f.carb)}g · 단 ${r1(f.protein)}g · 지 ${r1(f.fat)}g · 당 ${show(f.sugar, 'g')} · 나트륨 ${show(f.sodium, 'mg', 0)}</small></div>
      <div style="white-space:nowrap">${round(f.kcal)} kcal <button data-del="${f.id}" title="삭제">×</button></div>
    </div>`).join('') : `<p class="muted">${currentMeal}에 먹은 음식이 없어요.</p>`);
  $('addTitle').textContent = `${currentMeal}에 음식 추가`;
}

function goToDate(d) {
  currentDate = d;
  currentMeal = toKey(d) === toKey(new Date()) ? guessMeal() : '아침';
  renderToday();
}

// ---------- 렌더: 인바디 ----------
function renderInbody() {
  $('pFreq').innerHTML = FREQS.map((f) => `<option value="${f.v}">${f.label}</option>`).join('');
  $('pSex').value = profile.sex;
  $('pAge').value = profile.age;
  $('pHeight').value = profile.height;
  $('pFreq').value = profile.freq;
  $('pExercise').value = profile.exercise;
  $('pSteps').value = profile.steps;
  $('pMeals').value = profile.meals;
  $('pPeriod').value = profile.period;
  renderFoodPrefs();

  const ib = latestInbody();
  $('iDate').value = ib ? ib.date : toKey(new Date());   // 최근 기록을 보여주고, 새 측정이면 날짜를 바꿔서 저장
  if (ib) {
    $('iWeight').value = ib.weight;
    $('iSmm').value = ib.smm || '';
    $('iFat').value = ib.bodyFat;
    $('iBmr').value = ib.bmr || '';
  }
  renderAnalysis();
}

function renderFoodPrefs() {
  const prefs = profile.foodPrefs || {};
  $('foodPrefs').innerHTML = ['carb', 'protein', 'fat', 'veg'].map((cat) =>
    `<span class="muted" style="width:100%;margin-top:4px">${CAT_NAME[cat]}</span>`
    + PLAN_FOODS.filter((f) => f.cat === cat).map((f) => {
      const st = prefs[f.key];
      return `<button data-pref="${f.key}" class="pref-${st || 'none'}">${st === 'like' ? '❤️ ' : st === 'no' ? '🚫 ' : ''}${f.name}</button>`;
    }).join('')).join('');
}

const fmt = (v, d = 0) => Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });

function renderAnalysis() {
  const g = calcTargets();
  ['mealPlan', 'planExtras'].forEach((id) => $(id).classList.toggle('hidden', !g));
  if (!g) {
    $('analysis').innerHTML = `<h2>분석 결과</h2><p class="muted">인바디(체중·체지방률)와 나이·키를 입력하고 저장하세요.</p>`;
    return;
  }
  const p = PHASES[g.phase];
  const freq = FREQS.find((f) => f.v === profile.freq) || FREQS[2];
  const maintain = g.tdee, cutK = Math.max(g.bmr.value, g.tdee * PHASES.cut.kcalMul), gainK = g.tdee * PHASES.bulk.kcalMul;

  $('analysis').innerHTML = `
    <h2>목표 포지션</h2>
    <p class="muted" style="margin-top:0">체지방률 ${g.ib.bodyFat}% 기준 추천: <b style="color:${PHASES[g.recommended].color}">${PHASES[g.recommended].name}</b></p>
    <div class="phase-pick">
      ${Object.entries(PHASES).map(([k, v]) =>
        `<button data-p="${k}" class="${g.phase === k ? 'on' : ''}">${v.name}${g.recommended === k ? ' ⭐' : ''}</button>`).join('')}
    </div>
    ${profile.phase ? `<button class="btn ghost" id="resetPhase">추천 포지션으로 되돌리기</button>` : ''}

    <h3 class="step">1. 기초대사량 (BMR) — 해리스-베네딕트</h3>
    <div class="formula">${profile.sex === 'F' ? '여성' : '남성'}: ${g.bmr.formula}<br>= <b>${fmt(g.bmr.value)} kcal</b></div>
    ${g.inbodyBmr ? `<p class="muted">참고: 인바디 측정 기초대사량 ${fmt(g.inbodyBmr)} kcal (근육량이 반영된 값)</p>` : ''}

    <h3 class="step">2. 유지 칼로리 (TDEE)</h3>
    <div class="formula">활동계수: ${freq.label} → ${g.act.base} (${freq.note})${g.act.bonus ? `<br>+ 걸음 수 ${fmt(num(profile.steps))}보 보정 +${g.act.bonus}` : ''}<br>
      ${fmt(g.bmr.value)} × ${g.act.factor.toFixed(3).replace(/0+$/, '')} = <b>${fmt(g.tdee)} kcal</b></div>
    <p class="muted">활동계수: 1.2 거의 안 움직임 · 1.375 주 1~2회 · 1.55 주 3~4회 · 1.725 주 5~6회 · 1.9 매일 고강도. 하루 8천보 이상이면 +0.05, 1만2천보 이상이면 +0.1</p>

    <h3 class="step">3. 하루 권장 칼로리</h3>
    <div class="stat-row"><span>유지 칼로리</span><b>${fmt(maintain)} kcal</b></div>
    <div class="stat-row"><span>감량 칼로리 (−20%)</span><b>${fmt(cutK)} kcal</b></div>
    <div class="stat-row"><span>린매스업 칼로리 (+7%)</span><b>${fmt(g.tdee * PHASES.lean.kcalMul)} kcal</b></div>
    <div class="stat-row"><span>증량 칼로리 (+15%)</span><b>${fmt(gainK)} kcal</b></div>
    <div class="target-box" style="border-color:${p.color}">
      <div class="muted">${p.name} 목표 칼로리</div>
      <div class="big" style="color:${p.color}">${fmt(g.kcal)} kcal</div>
      <p class="muted" style="margin:6px 0 0">${p.reason}</p>
      ${g.notes.map((n) => `<p class="muted" style="margin:4px 0 0">※ ${n}</p>`).join('')}
    </div>
    <div class="row" style="margin-top:10px">
      <input id="manualKcal" type="number" inputmode="numeric" placeholder="목표 열량 직접 입력 (kcal)" value="${profile.targetKcal || ''}">
      <button class="btn small" id="applyKcal">적용</button>
      ${profile.targetKcal ? `<button class="btn small ghost" id="clearKcal">자동</button>` : ''}
    </div>

    <h3 class="step">4. 하루 권장 영양소</h3>
    <table>
      <tr><th>영양소</th><th>양</th><th>칼로리</th><th>비율</th></tr>
      <tr><td>단백질</td><td>${fmt(g.protein)} g</td><td>${fmt(g.protein * 4)}</td><td>${fmt(g.pct.protein)}%</td></tr>
      <tr><td>탄수화물</td><td>${fmt(g.carb)} g</td><td>${fmt(g.carb * 4)}</td><td>${fmt(g.pct.carb)}%</td></tr>
      <tr><td>지방</td><td>${fmt(g.fat)} g</td><td>${fmt(g.fat * 9)}</td><td>${fmt(g.pct.fat)}%</td></tr>
    </table>
    <p class="muted">단백질 체중 1kg당 ${fmt(g.protein / g.weight, 1)}g · 지방 총 칼로리의 25% 이상 · 나머지를 탄수화물로</p>`;

  renderMealPlan(g);
}

function renderMealPlan(g) {
  const plan = buildMealPlan(g, profile);
  const row = (name, g_, n, unit) => `<tr><td>${name}</td><td>${g_}</td><td>${fmt(n.kcal)}</td><td>${fmt(n.carb, 1)}</td><td>${fmt(n.protein, 1)}</td><td>${fmt(n.fat, 1)}</td></tr>`;
  const amount = (it) => it.food.unit ? `${it.g}g (${it.g / it.food.unit}${it.food.unitName})` : `${it.g}g`;

  $('mealPlan').innerHTML = `
    <h2>5~7. 추천 하루 식단</h2>
    <p class="muted" style="margin-top:0">${profile.meals}끼 기준 · 밥은 지은 밥 중량, 나머지는 손질한 생 중량 · 값은 대략적인 계산</p>
    <div class="table-wrap"><table class="plan">
      <tr><th>음식</th><th>중량</th><th>kcal</th><th>탄</th><th>단</th><th>지</th></tr>
      ${plan.meals.map((m) => `
        <tr class="meal-head"><td colspan="6">${m.name} · ${fmt(m.total.kcal)} kcal</td></tr>
        ${m.items.map((it) => row(it.food.name, amount(it), it.n)).join('')}`).join('')}
      <tr class="total">${['합계', '', plan.total.kcal, plan.total.carb, plan.total.protein, plan.total.fat]
        .map((v, i) => `<td>${i < 2 ? v : fmt(v, i === 2 ? 0 : 1)}</td>`).join('')}</tr>
      <tr class="muted-row"><td>목표</td><td></td><td>${fmt(g.kcal)}</td><td>${fmt(g.carb)}</td><td>${fmt(g.protein)}</td><td>${fmt(g.fat)}</td></tr>
    </table></div>
    <p class="muted">하루 당류 약 ${fmt(plan.total.sugar)}g (상한 ${LIMITS.sugar}g) · 나트륨 약 ${fmt(plan.total.sodium)}mg (상한 ${fmt(LIMITS.sodium)}mg, 양념·소스 제외)</p>
    <button class="btn ghost" id="logPlan">오늘 식단에 이대로 기록하기</button>`;
  $('logPlan').onclick = () => {
    if (!confirm('추천 식단을 오늘 날짜 끼니별로 기록할까요?')) return;
    const key = toKey(new Date());
    plan.meals.forEach((m) => {
      const meal = MEALS.includes(m.name) ? m.name : '점심';
      m.items.forEach((it) => (foods[key] ||= []).push({
        id: Date.now() + Math.random(), meal, name: it.food.name, amount: amount(it),
        kcal: r1(it.n.kcal), carb: r1(it.n.carb), protein: r1(it.n.protein), fat: r1(it.n.fat),
        sugar: opt(it.n.sugar), sodium: opt(it.n.sodium, 0),
      }));
    });
    store.set('foods', foods);
    alert('기록했어요. 식단 탭에서 확인하세요.');
  };

  renderPlanExtras(g, plan);
}

function renderPlanExtras(g, plan) {
  const shop = shoppingList(plan);
  const ev = evaluatePlan(g, profile);
  const li = (arr) => `<ul>${arr.map((t) => `<li>${t}</li>`).join('')}</ul>`;
  $('planExtras').innerHTML = `
    <h2>8. 운동 전후 식사</h2>
    <h3 class="step">운동 전</h3>${li(WORKOUT_MEALS.pre)}
    <h3 class="step">운동 후</h3>${li(WORKOUT_MEALS.post)}

    <h2 style="margin-top:20px">9. 편의점 대체 식단</h2>
    <div class="table-wrap"><table class="plan">
      <tr><th>제품</th><th>양</th><th>kcal</th><th>탄</th><th>단</th><th>지</th><th>대체</th></tr>
      ${CONVENIENCE.map((c) => `<tr><td>${c.name}</td><td>${c.size}</td><td>${c.kcal}</td><td>${c.c}</td><td>${c.p}</td><td>${c.f}</td><td>${c.swap}</td></tr>`).join('')}
    </table></div>
    <p class="muted">예: 점심 = 햇반 210g + 편의점 닭가슴살 1팩 + 구운계란 2개 + 샐러드</p>

    <h2 style="margin-top:20px">10. 장보기 리스트 (1주일)</h2>
    ${['carb', 'protein', 'fat', 'veg', 'snack'].filter((c) => shop[c]).map((c) => `
      <h3 class="step">${CAT_NAME[c]}</h3>
      ${li(shop[c].map(({ food, week }) => `${food.name} ${food.unit ? `${Math.ceil(week / food.unit)}${food.unitName}` : week >= 1000 ? `${(week / 1000).toFixed(1)}kg` : `${week}g`}`))}`).join('')}

    <h2 style="margin-top:20px">11. 식단 평가</h2>
    <div class="stat-row"><span>실천 가능성</span><span style="text-align:right">${ev.feasible}</span></div>
    <div class="stat-row"><span>예상 변화 속도</span><span style="text-align:right">${ev.speed}</span></div>
    <div class="stat-row"><span>근손실 위험</span><span style="text-align:right">${ev.muscleRisk}</span></div>
    <div class="stat-row"><span>배고픔 정도</span><span style="text-align:right">${ev.hunger}</span></div>
    <h3 class="step">더 좋아지려면</h3>${li(ev.tips)}`;
}

// ---------- 인바디 CSV (인바디 앱 → 내보내기) ----------
// 열 순서가 바뀌어도 되도록 열 이름으로 찾음. 값이 "-"면 측정 안 된 항목
const INBODY_COLS = {
  weight: '체중(kg)', smm: '골격근량(kg)', muscle: '근육량(kg)', fatMass: '체지방량(kg)', bmi: 'BMI(kg/m²)',
  bodyFat: '체지방률(%)', bmr: '기초대사량(kcal)', score: '인바디점수', visceral: '내장지방레벨(Level)', water: '체수분(L)',
};

function decodeCsv(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  // 깨진 글자가 있으면 엑셀식 한글 인코딩(EUC-KR)으로 다시 읽기
  return utf8.includes('�') ? new TextDecoder('euc-kr').decode(buf) : utf8;
}

function parseInbodyCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const split = (l) => l.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
  const head = split(lines[0] || '');
  const col = (name) => head.findIndex((h) => h.replace(/\s/g, '') === name.replace(/\s/g, ''));
  const dateIdx = col('날짜');
  if (dateIdx < 0 || col(INBODY_COLS.weight) < 0) throw new Error('인바디 앱에서 내보낸 CSV 형식이 아니에요.');

  return lines.slice(1).map((line) => {
    const v = split(line);
    const d = (v[dateIdx] || '').replace(/\D/g, '');   // 20261027083801 → 2026-10-27
    if (d.length < 8) return null;
    const entry = { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` };
    for (const [key, name] of Object.entries(INBODY_COLS)) {
      const i = col(name);
      entry[key] = i >= 0 ? optNum(v[i] === '-' ? null : v[i]) : null;
    }
    // 체지방률이 비어 있으면 체지방량 ÷ 체중으로 계산
    if (entry.bodyFat == null && entry.fatMass && entry.weight) entry.bodyFat = r1((entry.fatMass / entry.weight) * 100);
    return entry.weight && entry.bodyFat ? entry : null;
  }).filter(Boolean);
}

async function importInbodyCsv(file) {
  const status = $('ibCsvStatus');
  status.classList.remove('hidden');
  try {
    const rows = parseInbodyCsv(decodeCsv(await file.arrayBuffer()));
    if (!rows.length) throw new Error('측정 기록이 없어요.');
    const dates = new Set(rows.map((r) => r.date));
    inbody = inbody.filter((i) => !dates.has(i.date)).concat(rows);
    store.set('inbody', inbody);
    const last = latestInbody();
    status.textContent = `${rows.length}개 측정 기록을 불러왔어요. 최근 ${last.date}: 체중 ${last.weight}kg · 골격근량 ${last.smm ?? '–'}kg · 체지방률 ${last.bodyFat}%`;
    renderInbody();
  } catch (e) {
    status.textContent = `불러오기 실패: ${e.message}`;
  }
}

// ---------- 렌더: 달력 ----------
let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function renderHistory() {
  const g = calcTargets();
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayKey = toKey(new Date());
  $('monthLabel').textContent = `${y}년 ${m + 1}월`;

  const cells = ['일', '월', '화', '수', '목', '금', '토'].map((d) => `<div class="dow">${d}</div>`);
  for (let i = 0; i < calMonth.getDay(); i++) cells.push(`<div class="day empty"></div>`);
  const logged = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = toKey(new Date(y, m, d));
    const has = (foods[key] || []).length > 0;
    const kcal = has ? dayTotals(key).kcal : 0;
    if (has) logged.push(kcal);
    const state = has && g ? (kcal > g.kcal ? 'over' : 'ok') : '';
    cells.push(`<button class="day ${state} ${key === todayKey ? 'today' : ''}" data-day="${key}">
      ${d}<small>${has ? round(kcal) : ''}</small></button>`);
  }
  $('calendar').innerHTML = cells.join('');

  const avg = logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : 0;
  const okDays = g ? logged.filter((k) => k <= g.kcal).length : null;
  $('monthStats').innerHTML = `
    <h2>${m + 1}월 요약</h2>
    <div class="stat-row"><span>기록한 날</span><b>${logged.length}일</b></div>
    <div class="stat-row"><span>하루 평균 섭취</span><b>${round(avg)} kcal</b></div>
    ${g ? `<div class="stat-row"><span>목표 이내로 먹은 날</span><b>${okDays}일 / ${logged.length}일</b></div>` : ''}`;

  const ibs = [...inbody].sort((a, b) => b.date.localeCompare(a.date));
  $('inbodyTable').innerHTML = ibs.length ? `
    <div class="table-wrap"><table class="plan"><tr><th>날짜</th><th>체중</th><th>골격근</th><th>체지방</th><th>체지방률</th><th>점수</th></tr>
    ${ibs.map((i) => `<tr><td>${i.date}</td><td>${i.weight}</td><td>${i.smm ?? '–'}</td><td>${i.fatMass ?? '–'}</td><td>${i.bodyFat}%</td><td>${i.score ?? '–'}</td></tr>`).join('')}
    </table></div>` : `<p class="muted">인바디 기록이 없습니다.</p>`;
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

function loadScript(src, globalName = 'Html5Qrcode') {
  return new Promise((resolve, reject) => {
    if (window[globalName]) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('기능을 불러오지 못했어요 (인터넷 연결 확인)'));
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
      alert(`바코드 ${code} 제품 정보를 찾지 못했어요.\n"영양성분표 사진으로 채우기"로 찍거나 직접 입력하면, 다음부터는 바코드만 찍어도 바로 불러와요.`);
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

// ---------- 영양성분표 OCR (Tesseract.js, 무료 · 폰에서 직접 인식) ----------
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let ocrWorker = null;

function getOcrWorker(onProgress) {
  ocrWorker ||= loadScript(TESSERACT_URL, 'Tesseract').then(() =>
    // 한글 인식 데이터는 처음 한 번만 받고, 이후엔 폰에 저장된 것을 사용
    Tesseract.createWorker(['kor', 'eng'], 1, { logger: (m) => onProgress?.(m) }))
;
  return ocrWorker.catch((e) => { ocrWorker = null; throw e; });
}

// 사진을 키우고 흑백 + 대비 강화해서 인식률을 높임
async function prepareImage(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(2400 / Math.max(img.width, img.height), Math.max(1, 1600 / img.width));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const px = ctx.getImageData(0, 0, c.width, c.height);
  const d = px.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = ((d[i] - min) / range) * 255;
  ctx.putImageData(px, 0, 0);
  return c;
}

// OCR 글자에서 열량·탄단지·제공량 찾기
function parseNutrition(raw) {
  let t = raw
    .replace(/(\d),(\d{3})/g, '$1$2')               // 1,790 → 1790
    .replace(/\b[Oo](?=\s*(?:m?g|kcal)\b)/g, '0')    // "Og" → "0g"
    .replace(/[：:]/g, ' ');
  // 글자 사이에 공백이 끼어도 찾도록 (예: "탄 수 화 물"), 비슷하게 읽히는 글자도 허용
  const word = (w) => [...w].map((c) => ({ 량: '[량랑]', 화: '[화와]', 질: '[질절]' }[c] || c)).join('\\s*');
  // OCR이 단위 "g"를 숫자 "9"로 자주 읽음 ("79g" → "799"). 표의 숫자엔 항상 단위가 붙으므로 끝의 9를 g로 봄
  const NUM = '(\\d+(?:\\.\\d+)?)\\s*(mg|g|ml)?';
  const value = (n, unit) => {
    const decimals = n.split('.')[1] || '';
    if (!unit && n.length > 1 && n.endsWith('9') && (!decimals || decimals.length >= 2)) return Number(n.slice(0, -1));
    return unit?.toLowerCase() === 'mg' ? Number(n) / 1000 : Number(n);
  };
  const find = (label) => t.match(new RegExp(`${word(label)}\\s*${NUM}`, 'i'));
  const amount = (label) => {
    const m = find(label);
    return m ? value(m[1], m[2]) : null;
  };

  const sugar = amount('당류');
  const na = find('나트륨');   // 나트륨은 mg 그대로 (g로 적힌 경우만 ×1000)
  let sodium = na ? (na[2]?.toLowerCase() === 'g' ? Number(na[1]) * 1000 : Number(na[1])) : null;
  if (sodium != null && (sodium < 5 || sodium > 10000)) sodium = null;   // "1,790"이 "1"로 잘리는 등 잘못 읽은 값은 비워 둠
  const kcalM = t.match(/(\d+(?:\.\d+)?)\s*k\s*c\s*a\s*l/i) || t.match(new RegExp(`${word('열량')}\\s*(\\d+(?:\\.\\d+)?)`));
  const carb = amount('탄수화물');
  const protein = amount('단백질');
  // "지방" 앞에 포화/트랜스가 붙은 줄은 빼고 찾기
  t = t.replace(new RegExp(`(${word('포화')}|${word('트랜스')})\\s*${word('지방')}\\s*[\\d.]*\\s*(mg|g)?`, 'g'), '');
  const fat = amount('지방');

  const per = t.match(/(\d+(?:\.\d+)?)[ \t]*(g|ml)[ \t]*당(?!류)/i);
  const size = (label) => {
    const m = find(label);
    return m ? `${value(m[1], m[2])}${(m[2] || 'g').toLowerCase()}` : '';
  };
  const once = size('1회제공량'), total = size('총내용량');
  const serving = per ? `${per[1]}${per[2]}당` : once ? `1회 ${once}` : total ? `총 ${total}` : '';

  return { kcal: kcalM ? Number(kcalM[1]) : null, carb, protein, fat, sugar, sodium, serving };
}

// "79g"를 "799g"로 읽는 경우처럼 g가 9로 붙은 값은, 열량(탄4·단4·지9 kcal/g)과 더 잘 맞는 쪽으로 고침
function fixWithKcal(r) {
  if (r.kcal == null) return r;
  const KCAL = { carb: 4, protein: 4, fat: 9 };
  const err = (x) => Math.abs(Object.keys(KCAL).reduce((s, k) => s + (x[k] || 0) * KCAL[k], 0) - x.kcal);
  for (const k of Object.keys(KCAL)) {
    const v = r[k];
    if (v == null || !/\d9$/.test(String(v))) continue;
    const alt = { ...r, [k]: Number(String(v).slice(0, -1)) };
    if (err(alt) < err(r)) r = alt;
  }
  return r;
}

async function runOcr(file) {
  const status = $('ocrStatus');
  status.classList.remove('hidden');
  status.textContent = '사진 준비 중…';
  try {
    const worker = await getOcrWorker((m) => {
      if (m.status === 'recognizing text') status.textContent = `글자 읽는 중… ${Math.round(m.progress * 100)}%`;
      else if (/load|initializ/.test(m.status)) status.textContent = '인식 엔진 준비 중… (처음 한 번은 몇 초 더 걸려요)';
    });
    const image = await prepareImage(file);
    // 표 모양에 따라 잘 맞는 읽기 방식이 달라서, 줄 단위(4) → 한 덩어리(6) → 흩어진 글자(11) 순으로 시도하며 빈 항목만 채움
    let r = { kcal: null, carb: null, protein: null, fat: null, sugar: null, sodium: null, serving: '' };
    const texts = [];
    for (const psm of ['4', '6', '11']) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(image);
      texts.push(data.text.trim());
      const found = parseNutrition(data.text);
      for (const k of Object.keys(r)) if (r[k] == null || r[k] === '') r[k] = found[k];
      if (['kcal', 'carb', 'protein', 'fat'].every((k) => r[k] != null)) break;
      status.textContent = '조금 더 꼼꼼히 읽는 중…';
    }
    r = fixWithKcal(r);
    $('ocrRaw').textContent = texts[0] || '(읽은 글자가 없어요)';
    $('ocrRawBox').classList.remove('hidden');

    const fields = { fKcal: ['열량', r.kcal], fCarb: ['탄수화물', r.carb], fProtein: ['단백질', r.protein], fFat: ['지방', r.fat] };
    const missing = [];
    for (const [id, [label, v]] of Object.entries(fields)) {
      if (v == null) missing.push(label);
      else $(id).value = v;
    }
    if (r.sugar != null) $('fSugar').value = r.sugar;
    if (r.sodium != null) $('fSodium').value = r.sodium;
    if (r.serving) $('fServing').value = r.serving;
    status.textContent = missing.length === 4
      ? '영양성분을 찾지 못했어요. 표만 크게, 밝은 곳에서 반사 없이 다시 찍어보세요.'
      : `채웠어요! 숫자가 맞는지 확인해 주세요.${missing.length ? ` 못 읽은 항목: ${missing.join(', ')}` : ''}`;
    if (!$('fName').value) $('fName').focus();
  } catch (e) {
    status.textContent = `인식 실패: ${e.message || e}`;
  }
}

// ---------- 이벤트 ----------
const renderers = { today: renderToday, inbody: renderInbody, history: renderHistory, settings: renderSettings };
function showTab(tab) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + tab));
  renderers[tab]();
  window.scrollTo(0, 0);
}
document.querySelectorAll('nav button').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

const shiftDay = (n) => goToDate(new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + n));
$('prevDay').onclick = () => shiftDay(-1);
$('nextDay').onclick = () => shiftDay(1);
$('datePicker').onchange = (e) => {
  if (!e.target.value) return;
  const [y, m, d] = e.target.value.split('-').map(Number);
  goToDate(new Date(y, m - 1, d));
};
$('mealTabs').onclick = (e) => {
  const b = e.target.closest('[data-meal]');
  if (b) { currentMeal = b.dataset.meal; renderToday(); }
};

$('prevMonth').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderHistory(); };
$('nextMonth').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderHistory(); };
$('calendar').onclick = (e) => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  const [y, m, d] = b.dataset.day.split('-').map(Number);
  goToDate(new Date(y, m - 1, d));
  showTab('today');
};

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

// 바코드DB 값이 포장지와 다를 때: 값을 직접 입력 칸으로 옮겨 고친 뒤 '내 음식'으로 저장 → 다음 스캔부터 고친 값 사용
$('sEdit').onclick = () => {
  const f = sheetFood;
  $('foodSheet').classList.add('hidden');
  $('fName').value = f.name;
  $('fServing').value = f.servingLabel;
  $('fKcal').value = r1(f.n.kcal);
  $('fCarb').value = r1(f.n.carb);
  $('fProtein').value = r1(f.n.protein);
  $('fFat').value = r1(f.n.fat);
  $('fSugar').value = opt(f.n.sugar) ?? '';
  $('fSodium').value = opt(f.n.sodium, 0) ?? '';
  $('fBarcode').value = f.barcode || '';
  $('fBarcodeNote').textContent = f.barcode ? `바코드 ${f.barcode} 와 함께 저장돼서, 다음 스캔부터 고친 값이 나와요.` : '';
  $('fBarcodeNote').classList.toggle('hidden', !f.barcode);
  $('fSave').checked = true;
  $('manualBox').open = true;
  $('manualBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

$('addManual').onclick = () => {
  const name = $('fName').value.trim();
  const kcal = num($('fKcal').value);
  if (!name || !$('fKcal').value) return alert('음식 이름과 칼로리를 입력하세요.');
  let food = {
    src: 'my', name, barcode: $('fBarcode').value || undefined,
    servingLabel: $('fServing').value.trim() || '1회', servingG: null,
    n: { kcal, carb: num($('fCarb').value), protein: num($('fProtein').value), fat: num($('fFat').value),
         sugar: optNum($('fSugar').value), sodium: optNum($('fSodium').value) },
  };
  if ($('fSave').checked) food = saveMyFood(food);
  logFood(food, 1, currentMeal, food.servingLabel);
  ['fName', 'fServing', 'fKcal', 'fCarb', 'fProtein', 'fFat', 'fSugar', 'fSodium', 'fBarcode'].forEach((id) => ($(id).value = ''));
  ['fBarcodeNote', 'ocrStatus', 'ocrRawBox'].forEach((id) => $(id).classList.add('hidden'));
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
$('ocrFile').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) runOcr(file);
};
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
  profile = {
    ...profile, sex: $('pSex').value, age: $('pAge').value, height: $('pHeight').value, freq: $('pFreq').value,
    exercise: $('pExercise').value.trim(), steps: $('pSteps').value, meals: $('pMeals').value, period: $('pPeriod').value,
  };
  store.set('profile', profile);

  const entry = { date: $('iDate').value, weight: num($('iWeight').value), smm: num($('iSmm').value), bodyFat: num($('iFat').value), bmr: num($('iBmr').value) || null };
  if (!entry.date || !entry.weight || !entry.bodyFat) return alert('측정일, 체중, 체지방률은 필수입니다.');
  if (!num(profile.age) || !num(profile.height)) return alert('기초대사량 계산을 위해 나이와 키를 입력하세요.');
  const prev = inbody.find((i) => i.date === entry.date);   // CSV로 들어온 체지방량·점수 등은 유지
  inbody = inbody.filter((i) => i !== prev).concat({ ...prev, ...entry });
  store.set('inbody', inbody);
  renderAnalysis();
  $('analysis').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

$('analysis').onclick = (e) => {
  const t = e.target;
  if (t.dataset.p) profile.phase = t.dataset.p;
  else if (t.id === 'resetPhase') profile.phase = null;
  else if (t.id === 'applyKcal') {
    const v = num($('manualKcal').value);
    if (v && (v < 1000 || v > 6000)) return alert('1,000~6,000 kcal 사이로 입력하세요.');
    profile.targetKcal = v || null;
  } else if (t.id === 'clearKcal') profile.targetKcal = null;
  else return;
  store.set('profile', profile);
  renderAnalysis();
};

$('foodPrefs').onclick = (e) => {
  const key = e.target.dataset.pref;
  if (!key) return;
  const prefs = (profile.foodPrefs ||= {});
  prefs[key] = { undefined: 'like', like: 'no', no: undefined }[prefs[key]];
  if (!prefs[key]) delete prefs[key];
  store.set('profile', profile);
  renderFoodPrefs();
  if (calcTargets()) renderMealPlan(calcTargets());
};

$('ibCsvFile').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importInbodyCsv(file);
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

goToDate(new Date());
