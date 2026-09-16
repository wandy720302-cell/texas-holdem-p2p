// Host 權威式德州撲克引擎。只有 host 執行這個檔案裡的邏輯；
// guest 只送 action/sit 請求給 host，畫面完全依賴 host 廣播回來的 state。
import { freshDeck } from './deck.js';
import { evaluateBest, compareBest, describe } from './handeval.js';

const SEAT_COUNT = 8;
const START_CHIPS = 10000;
const SB = 50;
const BB = 100;
const ZIMUCHE_THRESHOLD = 10001;
const ZIMUCHE_GRANT = 5;
export const ZIMUCHE_VALUE = 168;   // 持有時的紀念價值
export const ZIMUCHE_BET_VALUE = 100; // 拿來下注時只值這個價（花掉會虧，這是故意的）

export function createGame({ onState, onPrivateCards, onLog }) {
  const players = new Map(); // id -> player
  let seats = Array(SEAT_COUNT).fill(null); // seat index -> playerId
  let deck = [];
  let community = [];
  let pot = 0;
  let phase = 'lobby'; // lobby | preflop | flop | turn | river | showdown
  let dealerSeat = -1;
  let turnSeat = -1;
  let currentBet = 0;
  let minRaise = BB;
  let handNumber = 0;
  let log = [];

  function pushLog(msg) {
    log.push(msg);
    if (log.length > 40) log.shift();
    onLog?.(msg);
  }

  function newPlayer(id, name) {
    return {
      id, name, seat: null, chips: START_CHIPS, zimuche: 0, zimucheGranted: false,
      spectating: true, holeCards: [], folded: false, allIn: false,
      committed: 0, totalCommitted: 0, hasActed: false, inHand: false, connected: true,
    };
  }

  function ensurePlayer(id, name) {
    if (!players.has(id)) players.set(id, newPlayer(id, name || id));
    else if (name) players.get(id).name = name;
    return players.get(id);
  }

  function activeSeats() {
    return seats
      .map((pid, i) => (pid ? i : null))
      .filter(i => i !== null);
  }

  function seatedPlayers() {
    return activeSeats().map(i => players.get(seats[i]));
  }

  function nextSeatFrom(start, predicate) {
    for (let step = 1; step <= SEAT_COUNT; step++) {
      const s = (start + step) % SEAT_COUNT;
      const pid = seats[s];
      if (pid && predicate(players.get(pid))) return s;
    }
    return -1;
  }

  function sit(id, name, seat) {
    const p = ensurePlayer(id, name);
    if (seats[seat] || p.seat !== null) return;
    if (p.chips <= 0) p.chips = START_CHIPS;
    seats[seat] = id;
    p.seat = seat;
    p.spectating = false;
    pushLog(`${p.name} 坐上了 ${seat + 1} 號位`);
    broadcast();
  }

  function standUp(id) {
    const p = players.get(id);
    if (!p || p.seat === null) return;
    if (phase !== 'lobby' && p.inHand && !p.folded) {
      p.folded = true; // 中途離桌視為棄牌
      checkFoldWin();
    }
    seats[p.seat] = null;
    p.seat = null;
    p.spectating = true;
    pushLog(`${p.name} 離開座位`);
    broadcast();
  }

  function disconnect(id) {
    const p = players.get(id);
    if (!p) return;
    p.connected = false;
    if (p.seat !== null && phase !== 'lobby' && p.inHand && !p.folded) {
      p.folded = true;
      pushLog(`${p.name} 斷線，自動棄牌`);
      checkFoldWin();
    }
    broadcast();
  }

  function canStart() {
    return phase === 'lobby' && seatedPlayers().filter(p => p.chips > 0).length >= 2;
  }

  function startHand() {
    if (!canStart()) return;
    handNumber++;
    deck = freshDeck();
    community = [];
    pot = 0;
    currentBet = 0;
    minRaise = BB;
    log = [];

    const players_ = seatedPlayers().filter(p => p.chips > 0);
    for (const p of players_) {
      p.folded = false; p.allIn = false; p.committed = 0; p.totalCommitted = 0;
      p.hasActed = false; p.holeCards = []; p.inHand = true;
    }
    for (const p of seatedPlayers()) {
      if (p.chips <= 0) { p.inHand = false; p.spectating = true; seats[p.seat] = null; p.seat = null; }
    }

    const active = activeSeats();
    dealerSeat = nextSeatFrom(dealerSeat, () => true);
    if (dealerSeat === -1) dealerSeat = active[0];

    // 發手牌
    for (const s of active) {
      const p = players.get(seats[s]);
      p.holeCards = [deck.pop(), deck.pop()];
      onPrivateCards?.(p.id, p.holeCards);
    }

    let sbSeat, bbSeat;
    if (active.length === 2) {
      sbSeat = dealerSeat;
      bbSeat = nextSeatFrom(dealerSeat, () => true);
    } else {
      sbSeat = nextSeatFrom(dealerSeat, () => true);
      bbSeat = nextSeatFrom(sbSeat, () => true);
    }
    postBlind(sbSeat, SB);
    postBlind(bbSeat, BB);
    currentBet = BB;

    phase = 'preflop';
    turnSeat = active.length === 2
      ? sbSeat // heads-up：preflop 由小盲(莊家)先動
      : nextSeatFrom(bbSeat, canAct);
    if (turnSeat === -1) turnSeat = nextSeatFrom(bbSeat, p => !p.folded);

    pushLog(`— 第 ${handNumber} 手開始 —`);
    broadcast();
  }

  function postBlind(seat, amount) {
    const p = players.get(seats[seat]);
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.committed += pay;
    p.totalCommitted += pay;
    pot += pay;
    if (p.chips === 0) p.allIn = true;
    pushLog(`${p.name} 下盲注 ${pay}`);
  }

  function canAct(p) {
    return p && !p.folded && !p.allIn && p.inHand;
  }

  function inHandPlayers() {
    return activeSeats().map(s => players.get(seats[s])).filter(p => p.inHand);
  }

  function notFolded() {
    return inHandPlayers().filter(p => !p.folded);
  }

  // 花錢：優先用子母車折抵（1個=100），不足的差額才動用籌碼。
  // 子母車用量會自動夾在「不超過 need、不超過玩家庫存」的範圍內，不會找零、不會超付。
  function spend(p, need, zimucheRequested) {
    const maxTokensByNeed = Math.floor(need / ZIMUCHE_BET_VALUE);
    const tokensUsed = Math.max(0, Math.min(Math.floor(zimucheRequested || 0), p.zimuche, maxTokensByNeed));
    const tokenValue = tokensUsed * ZIMUCHE_BET_VALUE;
    const chipsPaid = Math.min(need - tokenValue, p.chips);
    p.zimuche -= tokensUsed;
    p.chips -= chipsPaid;
    return { paid: tokenValue + chipsPaid, tokensUsed, chipsPaid };
  }

  function handleAction(id, action, amount, zimucheUsed = 0) {
    const p = players.get(id);
    if (!p || p.seat === null || p.seat !== turnSeat) return;
    if (!['preflop', 'flop', 'turn', 'river'].includes(phase)) return;

    const toCall = currentBet - p.committed;

    if (action === 'fold') {
      p.folded = true;
      pushLog(`${p.name} 棄牌`);
    } else if (action === 'check') {
      if (toCall > 0) return;
      pushLog(`${p.name} 過牌`);
    } else if (action === 'call') {
      const { paid, tokensUsed } = spend(p, toCall, zimucheUsed);
      p.committed += paid; p.totalCommitted += paid; pot += paid;
      if (p.chips === 0 && p.zimuche === 0) p.allIn = true;
      const tokenNote = tokensUsed > 0 ? `（含 ${tokensUsed} 個子母車）` : '';
      pushLog(`${p.name} 跟注 ${paid}${tokenNote}${p.allIn ? '（全下）' : ''}`);
    } else if (action === 'bet' || action === 'raise') {
      const target = Math.max(0, Math.floor(amount));
      const need = target - p.committed;
      const maxNeed = p.chips + p.zimuche * ZIMUCHE_BET_VALUE; // 籌碼+子母車換算後最多能付到多少
      if (need <= 0 || need > maxNeed) return;
      const isAllIn = need === maxNeed;
      const raiseSize = target - currentBet;
      if (!isAllIn && raiseSize < minRaise) return; // 不足最小加注量且不是全下
      const { paid, tokensUsed } = spend(p, need, zimucheUsed);
      p.committed += paid; p.totalCommitted += paid; pot += paid;
      if (raiseSize > 0) minRaise = raiseSize;
      currentBet = Math.max(currentBet, p.committed);
      if (p.chips === 0 && p.zimuche === 0) p.allIn = true;
      // 加注重新開放行動權：其他未蓋牌未全下玩家的 hasActed 重置
      for (const other of notFolded()) {
        if (other.id !== p.id && !other.allIn) other.hasActed = false;
      }
      const tokenNote = tokensUsed > 0 ? `（含 ${tokensUsed} 個子母車）` : '';
      pushLog(`${p.name} ${action === 'bet' ? '下注' : '加注到'} ${p.committed}${tokenNote}${p.allIn ? '（全下）' : ''}`);
    } else {
      return;
    }

    p.hasActed = true;
    advanceTurn();
  }

  function advanceTurn() {
    if (notFolded().length <= 1) { awardUncontested(); return; }

    const stillToAct = notFolded().filter(pl => canAct(pl) && (!pl.hasActed || pl.committed !== currentBet));
    if (stillToAct.length === 0) {
      advanceStreet();
      return;
    }
    const pending = new Set(stillToAct.map(pl => pl.id));
    const next = nextSeatFrom(turnSeat, pl => pending.has(pl.id));
    turnSeat = next !== -1 ? next : stillToAct[0].seat;
    broadcast();
  }

  function awardUncontested() {
    const winner = notFolded()[0];
    if (winner) {
      winner.chips += pot;
      pushLog(`${winner.name} 獲得底池 ${pot}（其他玩家皆棄牌）`);
      grantZimucheIfNeeded(winner);
    }
    pot = 0;
    endHand();
  }

  function advanceStreet() {
    for (const p of inHandPlayers()) { p.committed = 0; p.hasActed = false; }
    currentBet = 0;
    minRaise = BB;

    if (phase === 'preflop') { community.push(deck.pop(), deck.pop(), deck.pop()); phase = 'flop'; }
    else if (phase === 'flop') { community.push(deck.pop()); phase = 'turn'; }
    else if (phase === 'turn') { community.push(deck.pop()); phase = 'river'; }
    else if (phase === 'river') { showdown(); return; }

    pushLog(`— ${{ flop: '翻牌', turn: '轉牌', river: '河牌' }[phase]} —`);

    const canActCount = notFolded().filter(canAct).length;
    if (canActCount <= 1) {
      // 剩下的人都全下了，直接補完公共牌到攤牌
      advanceStreet();
      return;
    }
    turnSeat = nextSeatFrom(dealerSeat, canAct);
    broadcast();
  }

  function buildSidePots() {
    const contenders = inHandPlayers().filter(p => p.totalCommitted > 0);
    const levels = [...new Set(contenders.map(p => p.totalCommitted))].sort((a, b) => a - b);
    let prev = 0;
    const pots = [];
    for (const level of levels) {
      const payers = contenders.filter(p => p.totalCommitted >= level);
      const amount = (level - prev) * payers.length;
      const eligible = payers.filter(p => !p.folded);
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    return pots;
  }

  function grantZimucheIfNeeded(p) {
    if (!p.zimucheGranted && p.chips > ZIMUCHE_THRESHOLD) {
      p.zimucheGranted = true;
      p.zimuche += ZIMUCHE_GRANT;
      pushLog(`🎉 ${p.name} 籌碼突破 ${ZIMUCHE_THRESHOLD}，獲得 5 個希銘的子母車！`);
    }
  }

  function showdown() {
    phase = 'showdown';
    const pots = buildSidePots();
    const revealed = notFolded().map(p => ({
      id: p.id, seat: p.seat, name: p.name, cards: p.holeCards,
      best: evaluateBest([...p.holeCards, ...community]),
    }));
    const results = [];

    for (const potTier of pots) {
      const eligible = revealed.filter(r => potTier.eligible.some(e => e.id === r.id));
      if (eligible.length === 0) continue;
      let winners = [eligible[0]];
      for (const r of eligible.slice(1)) {
        const cmp = compareBest(r.best, winners[0].best);
        if (cmp > 0) winners = [r];
        else if (cmp === 0) winners.push(r);
      }
      const share = Math.floor(potTier.amount / winners.length);
      const remainder = potTier.amount - share * winners.length;
      winners.forEach((w, idx) => {
        const p = players.get(w.id);
        p.chips += share + (idx === 0 ? remainder : 0);
      });
      results.push({
        amount: potTier.amount,
        winners: winners.map(w => w.name),
        handName: describe(winners[0].best.score),
      });
    }

    for (const r of revealed) {
      pushLog(`${r.name} 攤牌：${r.cards.join(' ')}（${describe(r.best.score)}）`);
    }
    for (const r of results) {
      pushLog(`💰 ${r.winners.join('、')} 贏得 ${r.amount}（${r.handName}）`);
    }
    for (const p of notFolded()) grantZimucheIfNeeded(p);

    pot = 0;
    broadcast({ showdownReveal: revealed.map(r => ({ seat: r.seat, cards: r.cards, hand: describe(r.best.score) })) });
    endHand();
  }

  function endHand() {
    for (const p of players.values()) {
      if (p.seat !== null && p.chips <= 0) {
        pushLog(`${p.name} 籌碼歸零，退回觀戰`);
        seats[p.seat] = null; p.seat = null; p.spectating = true;
      }
    }
    phase = 'lobby';
    turnSeat = -1;
    broadcast();
  }

  function checkFoldWin() {
    if (['preflop', 'flop', 'turn', 'river'].includes(phase) && notFolded().length <= 1) {
      awardUncontested();
    }
  }

  function publicState(extra = {}) {
    return {
      type: 'state',
      phase, community, pot, currentBet, minRaise, dealerSeat, turnSeat, handNumber, log: log.slice(-15),
      seats: seats.map((pid, i) => {
        if (!pid) return null;
        const p = players.get(pid);
        return {
          seat: i, id: p.id, name: p.name, chips: p.chips, zimuche: p.zimuche,
          folded: p.folded, allIn: p.allIn, committed: p.committed, inHand: p.inHand,
          connected: p.connected, hasCards: p.inHand && p.holeCards.length > 0 && !p.folded,
        };
      }),
      spectators: [...players.values()].filter(p => p.spectating).map(p => ({ id: p.id, name: p.name })),
      canStart: canStart(),
      ...extra,
    };
  }

  let broadcastFn = () => {};
  function broadcast(extra) { broadcastFn(publicState(extra)); }

  return {
    setBroadcast(fn) { broadcastFn = fn; },
    ensurePlayer, sit, standUp, disconnect, startHand, handleAction,
    getPublicState: publicState,
    getPlayer: id => players.get(id),
    refresh: broadcast,
  };
}
