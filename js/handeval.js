// 7 張牌取最佳 5 張的牌型評分。
// card 格式：'AS','TH','9D'... rank 字元 2-9,T,J,Q,K,A；suit 字元 S,H,D,C
const RANK_ORDER = '23456789TJQKA';
const rankVal = c => RANK_ORDER.indexOf(c[0]) + 2;
const suitOf = c => c[1];

const CATEGORY = {
  HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
  FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8,
};

export const CATEGORY_NAME = {
  0: '高牌', 1: '一對', 2: '兩對', 3: '三條', 4: '順子',
  5: '同花', 6: '葫蘆', 7: '四條', 8: '同花順',
};

function combinations(arr, k) {
  const res = [];
  const combo = [];
  function go(start) {
    if (combo.length === k) { res.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      go(i + 1);
      combo.pop();
    }
  }
  go(0);
  return res;
}

// 評一組剛好 5 張牌，回傳 [category, tiebreak...] 用於字典序比較
function evaluate5(cards) {
  const ranks = cards.map(rankVal).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every(s => s === suits[0]);

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, n]) => [Number(r), n])
    .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));

  // 判斷順子（含 A-2-3-4-5 wheel）
  const uniqRanks = [...new Set(ranks)];
  let straightHigh = null;
  if (uniqRanks.length === 5) {
    if (uniqRanks[0] - uniqRanks[4] === 4) straightHigh = uniqRanks[0];
    else if (uniqRanks.join(',') === '14,5,4,3,2') straightHigh = 5; // wheel
  }

  if (isFlush && straightHigh) return [CATEGORY.STRAIGHT_FLUSH, straightHigh];
  if (groups[0][1] === 4) {
    const kicker = groups.find(g => g[1] === 1)[0];
    return [CATEGORY.QUADS, groups[0][0], kicker];
  }
  if (groups[0][1] === 3 && groups[1]?.[1] >= 2) {
    return [CATEGORY.FULL_HOUSE, groups[0][0], groups[1][0]];
  }
  if (isFlush) return [CATEGORY.FLUSH, ...ranks];
  if (straightHigh) return [CATEGORY.STRAIGHT, straightHigh];
  if (groups[0][1] === 3) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]);
    return [CATEGORY.TRIPS, groups[0][0], ...kickers];
  }
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const pairs = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    const kicker = groups.find(g => g[1] === 1)[0];
    return [CATEGORY.TWO_PAIR, ...pairs, kicker];
  }
  if (groups[0][1] === 2) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]);
    return [CATEGORY.PAIR, groups[0][0], ...kickers];
  }
  return [CATEGORY.HIGH, ...ranks];
}

function cmpScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? -1, bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// 傳入 5~7 張牌，回傳最佳 5 張組合的評分 { score, cards }
export function evaluateBest(cards) {
  const combos = cards.length <= 5 ? [cards] : combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const score = evaluate5(combo);
    if (!best || cmpScore(score, best.score) > 0) best = { score, cards: combo };
  }
  return best;
}

// 回傳 1 (a贏) / -1 (b贏) / 0 (平手)
export function compareBest(a, b) {
  return Math.sign(cmpScore(a.score, b.score));
}

export function describe(score) {
  return CATEGORY_NAME[score[0]];
}
