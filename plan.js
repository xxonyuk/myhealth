// 목표 칼로리·영양소 계산과 추천 식단 생성 (스포츠 영양 전문가 프롬프트 기준)

const PHASES = {
  cut: {
    name: '다이어트', goal: '체지방 감량', color: 'var(--cut)', kcalMul: 0.80, proteinPerKg: 2.2,
    desc: '체지방 감량. 근손실을 막기 위해 단백질을 높게 유지합니다.',
    reason: '유지 칼로리보다 20% 적게 먹어 주 0.5~0.8kg 정도의 완만한 감량을 노립니다. 이보다 크게 줄이면 근손실·요요·폭식 위험이 커져 오래 유지하기 어렵습니다.',
  },
  lean: {
    name: '린매스업', goal: '근육 증가 (지방 최소)', color: 'var(--lean)', kcalMul: 1.07, proteinPerKg: 2.0,
    desc: '지방은 최소로, 근육은 천천히. 소폭 잉여 칼로리.',
    reason: '유지 칼로리보다 5~10%만 더 먹어 체지방 증가는 최소화하면서 근육을 천천히 늘립니다. 체중은 월 0.5~1kg 정도 증가가 적당합니다.',
  },
  bulk: {
    name: '벌크업', goal: '근육 증가', color: 'var(--bulk)', kcalMul: 1.15, proteinPerKg: 1.8,
    desc: '근육량 증가에 집중. 충분한 잉여 칼로리.',
    reason: '유지 칼로리보다 15% 더 먹어 근성장에 충분한 에너지를 공급합니다. 체지방도 어느 정도 함께 늘 수 있으니 월 1~2kg 증가를 넘지 않게 조절하세요.',
  },
};

// 운동 횟수 → 활동계수
const FREQS = [
  { v: '0', label: '주 0회 (거의 운동 안 함)', factor: 1.2, note: '좌식 생활' },
  { v: '1-2', label: '주 1~2회', factor: 1.375, note: '가벼운 활동' },
  { v: '3-4', label: '주 3~4회', factor: 1.55, note: '보통 활동' },
  { v: '5-6', label: '주 5~6회', factor: 1.725, note: '많은 활동' },
  { v: '7+', label: '주 7회 이상', factor: 1.9, note: '매우 많은 활동' },
];

// 식단에 쓰는 음식 (100g 기준, 대략적인 값 · s 당류 g, na 나트륨 mg)
// cat: carb 탄수화물 / protein 단백질 / fat 지방 / veg 채소
const PLAN_FOODS = [
  { key: 'brownrice', name: '현미밥',   cat: 'carb', kcal: 143, c: 30.5, p: 3,    f: 1, s: 0, na: 2 },
  { key: 'whiterice', name: '흰쌀밥',   cat: 'carb', kcal: 150, c: 33,   p: 2.7,  f: 0.3, s: 0, na: 2 },
  { key: 'sweetpot',  name: '고구마',   cat: 'carb', kcal: 128, c: 31,   p: 1.4,  f: 0.2, s: 6, na: 20 },
  { key: 'potato',    name: '감자',     cat: 'carb', kcal: 70,  c: 16,   p: 2,    f: 0.1, s: 0.8, na: 5 },
  { key: 'oatmeal',   name: '오트밀',   cat: 'carb', kcal: 380, c: 67,   p: 13,   f: 7, s: 1, na: 5, max: 100 },
  { key: 'chicken',   name: '닭가슴살', cat: 'protein', kcal: 109, c: 0,   p: 23,   f: 1.2, s: 0, na: 60 },
  { key: 'thigh',     name: '닭다리살(껍질 제거)', cat: 'protein', kcal: 120, c: 0, p: 19, f: 4.5, s: 0, na: 80 },
  { key: 'egg',       name: '계란',     cat: 'protein', kcal: 143, c: 0.7, p: 12.6, f: 9.6, s: 0.4, na: 140, unit: 50, unitName: '개' },
  { key: 'tofu',      name: '두부',     cat: 'protein', kcal: 84,  c: 1.7, p: 8.6,  f: 5, s: 0.7, na: 7, max: 200 },
  { key: 'tuna',      name: '참치(기름 뺀)', cat: 'protein', kcal: 120, c: 0, p: 25, f: 2, s: 0, na: 400 },
  { key: 'beef',      name: '소고기 우둔살', cat: 'protein', kcal: 140, c: 0, p: 21, f: 5.5, s: 0, na: 55 },
  { key: 'pork',      name: '돼지 안심', cat: 'protein', kcal: 120, c: 0,  p: 22,   f: 3.5, s: 0, na: 55 },
  { key: 'greek',     name: '그릭요거트', cat: 'protein', kcal: 100, c: 5,  p: 9,    f: 4.5, s: 4, na: 40, max: 200 },
  { key: 'almond',    name: '아몬드',   cat: 'fat', kcal: 580, c: 20,  p: 21,   f: 50, s: 4.4, na: 1, max: 30 },
  { key: 'walnut',    name: '호두',     cat: 'fat', kcal: 650, c: 14,  p: 15,   f: 65, s: 2.6, na: 2, max: 30 },
  { key: 'olive',     name: '올리브오일', cat: 'fat', kcal: 884, c: 0, p: 0,    f: 100, s: 0, na: 0, max: 15 },
  { key: 'avocado',   name: '아보카도', cat: 'fat', kcal: 160, c: 8.5, p: 2,    f: 15, s: 0.7, na: 7, max: 100 },
  { key: 'broccoli',  name: '브로콜리', cat: 'veg', kcal: 34,  c: 7,   p: 2.8,  f: 0.4, s: 1.7, na: 30 },
  { key: 'cabbage',   name: '양배추',   cat: 'veg', kcal: 25,  c: 6,   p: 1.3,  f: 0.1, s: 3.2, na: 15 },
  { key: 'lettuce',   name: '상추',     cat: 'veg', kcal: 15,  c: 3,   p: 1.4,  f: 0.2, s: 0.8, na: 10 },
  { key: 'cucumber',  name: '오이',     cat: 'veg', kcal: 15,  c: 3.6, p: 0.7,  f: 0.1, s: 1.7, na: 2 },
  { key: 'tomato',    name: '토마토',   cat: 'veg', kcal: 18,  c: 3.9, p: 0.9,  f: 0.2, s: 2.6, na: 5 },
  { key: 'kimchi',    name: '김치',     cat: 'veg', kcal: 30,  c: 4.8, p: 2,    f: 0.6, s: 2, na: 650, max: 50 },
];
const CAT_NAME = { carb: '탄수화물', protein: '단백질', fat: '지방', veg: '채소', snack: '간식' };

// 해리스-베네딕트 (1984 개정판)
function hbBmr({ sex, weight, height, age }) {
  return sex === 'F'
    ? { value: 447.593 + 9.247 * weight + 3.098 * height - 4.330 * age,
        formula: `447.593 + (9.247 × ${weight}) + (3.098 × ${height}) − (4.330 × ${age})` }
    : { value: 88.362 + 13.397 * weight + 4.799 * height - 5.677 * age,
        formula: `88.362 + (13.397 × ${weight}) + (4.799 × ${height}) − (5.677 × ${age})` };
}

// 걸음 수가 많으면 운동 외 활동량이 커서 계수를 조금 올림 (최대 1.9)
function activityFactor(freq, steps) {
  const base = (FREQS.find((f) => f.v === freq) || FREQS[2]).factor;
  const bonus = steps >= 12000 ? 0.1 : steps >= 8000 ? 0.05 : 0;
  return { base, bonus, factor: Math.min(1.9, base + bonus) };
}

function recommendPhase(sex, bodyFat) {
  const [high, low] = sex === 'F' ? [28, 20] : [20, 12];
  if (bodyFat > high) return 'cut';
  if (bodyFat < low) return 'bulk';
  return 'lean';
}

// 프로필 + 최신 인바디 → BMR, TDEE, 목표 칼로리, 탄단지
function calcPlan(profile, ib) {
  if (!ib || !num(profile.age) || !num(profile.height)) return null;
  const weight = ib.weight;
  const bmr = hbBmr({ sex: profile.sex, weight, height: num(profile.height), age: num(profile.age) });
  const act = activityFactor(profile.freq, num(profile.steps));
  const tdee = bmr.value * act.factor;
  const recommended = recommendPhase(profile.sex, ib.bodyFat);
  const phase = profile.phase || recommended;
  const p = PHASES[phase];

  let kcal = tdee * p.kcalMul;
  const notes = [];
  // 극단적인 저칼로리 방지: 기초대사량 아래로는 내리지 않음
  if (kcal < bmr.value) { kcal = bmr.value; notes.push('계산값이 기초대사량보다 낮아 기초대사량으로 맞췄어요 (극단적 저칼로리 방지).'); }
  const manual = num(profile.targetKcal);
  if (manual) { kcal = manual; notes.push('목표 열량을 직접 설정했어요.'); }

  let protein = weight * p.proteinPerKg;
  let fat = Math.max((kcal * 0.25) / 9, weight * 0.8);   // 호르몬 유지를 위해 체중 1kg당 0.8g 이상
  let carb = (kcal - protein * 4 - fat * 9) / 4;
  // 극단적인 저탄수화물 방지: 탄수화물이 30% 미만이면 단백질을 체중 1kg당 1.6g까지 낮춤
  if (carb * 4 < kcal * 0.3) {
    protein = Math.max(weight * 1.6, (kcal * 0.7 - fat * 9) / 4);
    carb = (kcal - protein * 4 - fat * 9) / 4;
  }
  carb = Math.max(0, carb);

  return {
    ib, weight, bmr, act, tdee, recommended, phase, kcal, protein, fat, carb, notes,
    pct: { carb: (carb * 4) / kcal * 100, protein: (protein * 4) / kcal * 100, fat: (fat * 9) / kcal * 100 },
    inbodyBmr: ib.bmr || null,
  };
}

// ---------- 추천 식단 ----------
const MEAL_SPLITS = {
  2: [['아침·점심', 0.5], ['저녁', 0.5]],
  3: [['아침', 0.3], ['점심', 0.35], ['저녁', 0.35]],
  4: [['아침', 0.25], ['점심', 0.3], ['간식', 0.15], ['저녁', 0.3]],
};

function nutrientsOf(food, g) {
  const m = g / 100;
  return { kcal: food.kcal * m, carb: food.c * m, protein: food.p * m, fat: food.f * m, sugar: food.s * m, sodium: food.na * m };
}

function buildMealPlan(plan, profile) {
  const prefs = profile.foodPrefs || {};   // { key: 'like' | 'no' }
  const pool = (cat) => {
    const list = PLAN_FOODS.filter((f) => f.cat === cat && prefs[f.key] !== 'no');
    return [...list.filter((f) => prefs[f.key] === 'like'), ...list.filter((f) => prefs[f.key] !== 'like')];
  };
  const carbs = pool('carb');
  const mains = pool('protein').filter((f) => f.key !== 'egg' && f.key !== 'greek');
  const vegs = pool('veg').filter((f) => f.key !== 'kimchi');
  const fats = pool('fat');
  const egg = pool('protein').find((f) => f.key === 'egg');
  const greek = pool('protein').find((f) => f.key === 'greek');
  const kimchi = pool('veg').find((f) => f.key === 'kimchi');

  const split = MEAL_SPLITS[profile.meals] || MEAL_SPLITS[3];
  const round = (g, step = 10) => Math.max(step, Math.round(g / step) * step);
  const meals = [];

  split.forEach(([name, share], i) => {
    const target = { carb: plan.carb * share, protein: plan.protein * share, fat: plan.fat * share };
    const items = [];
    const add = (food, g) => { if (food && g > 0) items.push({ food, g, n: nutrientsOf(food, g) }); };
    const sum = (k) => items.reduce((s, it) => s + it.n[k], 0);
    const isSnack = name === '간식';

    // 1) 채소: 간식 제외 매 끼니 100g (+ 점심·저녁은 김치 50g)
    if (!isSnack) {
      add(vegs[i % Math.max(1, vegs.length)], 100);
      if (kimchi && i > 0) add(kimchi, 50);
    }
    // 2) 첫 끼에는 계란 2개
    if (i === 0 && egg) add(egg, 100);
    // 3) 탄수화물: 오트밀은 아침에만
    const carbChoices = i === 0 ? carbs : carbs.filter((f) => f.key !== 'oatmeal');
    const carbFood = carbChoices[(isSnack ? 2 : i) % Math.max(1, carbChoices.length)];
    if (carbFood) {
      const g = (target.carb - sum('carb')) / (carbFood.c / 100);
      add(carbFood, Math.min(carbFood.max || 400, round(g)));
    }
    // 4) 단백질: 간식은 그릭요거트, 나머지는 주 단백질 식품을 돌아가며
    const protFood = isSnack && greek ? greek : mains[i % Math.max(1, mains.length)];
    if (protFood) {
      const g = (target.protein - sum('protein')) / (protFood.p / 100);
      if (g >= 30) add(protFood, Math.min(protFood.max || 300, round(g)));
      // 최대량(두부·그릭요거트 등)에 막혀 단백질이 모자라면 다음 단백질 식품으로 보충
      const extra = mains.find((f) => f !== protFood && !items.some((it) => it.food === f));
      const left = target.protein - sum('protein');
      if (extra && left >= 8) add(extra, Math.min(extra.max || 300, round(left / (extra.p / 100))));
    }
    // 5) 지방: 부족한 만큼 견과류·올리브오일·아보카도로
    const fatFood = fats[i % Math.max(1, fats.length)];
    if (fatFood) {
      const g = (target.fat - sum('fat')) / (fatFood.f / 100);
      if (g >= 5) add(fatFood, Math.min(fatFood.max || 30, round(g, 5)));
    }
    meals.push({ name, items, total: { kcal: sum('kcal'), carb: sum('carb'), protein: sum('protein'), fat: sum('fat'), sugar: sum('sugar'), sodium: sum('sodium') } });
  });

  const total = ['kcal', 'carb', 'protein', 'fat', 'sugar', 'sodium'].reduce((t, k) => ({ ...t, [k]: meals.reduce((s, m) => s + m.total[k], 0) }), {});
  return { meals, total };
}

// 장보기 리스트: 식단의 음식을 1주일 분량으로
function shoppingList(mealPlan) {
  const byFood = new Map();
  mealPlan.meals.forEach((m) => m.items.forEach((it) => byFood.set(it.food, (byFood.get(it.food) || 0) + it.g)));
  const groups = {};
  byFood.forEach((g, food) => {
    const cat = food.key === 'greek' ? 'snack' : food.cat;
    (groups[cat] ||= []).push({ food, week: g * 7 });
  });
  return groups;
}

// 편의점 대체 (1개 기준, 대략적인 값)
const CONVENIENCE = [
  { name: '편의점 닭가슴살', size: '1팩 100g', kcal: 120, c: 2, p: 23, f: 2, swap: '닭가슴살·돼지 안심' },
  { name: '구운계란', size: '2개', kcal: 150, c: 1, p: 13, f: 10, swap: '계란' },
  { name: '햇반 (작은 공기)', size: '130g', kcal: 200, c: 44, p: 3.5, f: 0.5, swap: '밥 130g' },
  { name: '햇반', size: '210g', kcal: 315, c: 69, p: 5.5, f: 0.5, swap: '밥 210g' },
  { name: '삼각김밥', size: '1개', kcal: 200, c: 38, p: 5, f: 3, swap: '밥 130g (나트륨 주의)' },
  { name: '그릭요거트', size: '1컵 100g', kcal: 100, c: 5, p: 9, f: 4.5, swap: '그릭요거트' },
  { name: '바나나', size: '1개', kcal: 93, c: 24, p: 1, f: 0.3, swap: '고구마 70g' },
  { name: '프로틴 음료', size: '1병', kcal: 130, c: 6, p: 20, f: 3, swap: '단백질 식품 90g' },
  { name: '견과류 1봉', size: '20g', kcal: 120, c: 4, p: 4, f: 10, swap: '아몬드·호두' },
];

const WORKOUT_MEALS = {
  pre: [
    '운동 1~2시간 전: 고구마 150g + 닭가슴살 100g (또는 바나나 1개 + 그릭요거트 100g)',
    '운동 30분 전 급할 때: 바나나 1개 또는 프로틴 음료 1병',
    '기름진 음식·과식은 피하기 (운동 중 속이 불편해짐)',
  ],
  post: [
    '운동 후 1~2시간 안에: 흰쌀밥 150~210g + 닭가슴살·우둔살 150g + 채소',
    '바로 식사가 어려우면: 프로틴 음료 1병 + 바나나 1개 → 이후 정상 식사',
    '흰쌀밥은 소화·흡수가 빨라 운동 직후 탄수화물로 좋음',
  ],
};

// 식단 평가 (계산 결과로 판단)
function evaluatePlan(plan, profile) {
  const diff = plan.kcal - plan.tdee;            // 하루 칼로리 차이
  const weekly = (diff * 7) / 7700;              // 지방 1kg ≈ 7,700kcal
  const months = num(profile.period) || 3;
  const deficitPct = (-diff / plan.tdee) * 100;
  const proteinPerKg = plan.protein / plan.weight;
  const meals = num(profile.meals) || 3;

  const speed = Math.abs(weekly) < 0.05
    ? '체중 유지 수준'
    : `주 ${weekly > 0 ? '+' : ''}${weekly.toFixed(2)}kg · ${months}개월 후 약 ${weekly > 0 ? '+' : ''}${(weekly * months * 4.3).toFixed(1)}kg`;

  const muscleRisk = plan.phase !== 'cut'
    ? '낮음 — 잉여 칼로리 + 충분한 단백질'
    : deficitPct <= 20 && proteinPerKg >= 2 ? '낮음 — 적당한 감량 폭 + 고단백 (근력운동 병행 필수)'
    : deficitPct <= 25 ? '보통 — 근력운동과 단백질 섭취를 꼭 지키세요' : '높음 — 감량 폭이 큽니다. 목표 열량을 올리는 걸 권장';

  const hunger = plan.phase === 'cut'
    ? (deficitPct > 18 ? '보통~높음 — 채소·단백질을 먼저 먹고, 물을 충분히' : '보통 — 채소와 단백질로 포만감 유지')
    : plan.phase === 'bulk' ? '낮음 — 오히려 다 먹기 힘들 수 있어요. 밥·견과류로 칼로리 채우기' : '낮음~보통';

  const feasible = meals >= 3
    ? '높음 — 마트에서 구하기 쉬운 재료, 간단한 조리. 점심은 편의점 대체 가능'
    : '보통 — 2끼로 나누면 한 끼 양이 많아요. 가능하면 간식 1회 추가 추천';

  const tips = {
    cut: ['주 1회 체중·인바디를 재고 2주 연속 변화가 없으면 목표 열량을 100~200kcal 낮추기',
          '근력운동 주 3회 이상 유지 (근손실 방지의 핵심)', '저녁 탄수화물은 운동한 날 위주로'],
    lean: ['월 체중 증가가 1kg를 넘으면 목표 열량을 100kcal 낮추기',
           '점진적 과부하(무게·횟수 늘리기)를 기록하며 운동', '수면 7시간 이상'],
    bulk: ['월 체중 증가가 2kg를 넘으면 지방이 많이 붙는 중 → 열량 조금 낮추기',
           '식사량이 부담되면 밥 대신 오트밀·견과류처럼 칼로리 밀도 높은 음식 활용', '수면 7~8시간, 큰 근육 위주 복합 운동'],
  }[plan.phase];

  return { speed, muscleRisk, hunger, feasible, tips };
}
