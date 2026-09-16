import { createNet, makeRoomCode } from './net.js';
import { createGame, ZIMUCHE_VALUE } from './game.js';
import { cardLabel, isRed } from './deck.js';

const $ = sel => document.querySelector(sel);

const landing = $('#landing');
const tableScreen = $('#tableScreen');
const statusMsg = $('#statusMsg');

let net = null;
let game = null;
let isHost = false;
let myId = null;
let myName = '';
let currentState = null;
let myHoleCards = [];
let lastPhase = 'lobby';
let lastLogSignature = '';

// ---------- 規則彈窗 ----------
function openRules() { $('#rulesModal').classList.remove('hidden'); }
function closeRules() { $('#rulesModal').classList.add('hidden'); }
$('#rulesBtn').onclick = openRules;
$('#rulesBtn2').onclick = openRules;
$('#closeRules').onclick = closeRules;

// ---------- 建房 / 加入 ----------
$('#createBtn').onclick = async () => {
  myName = $('#nameInput').value.trim() || '玩家';
  statusMsg.textContent = '建立房間中…';
  try {
    const code = makeRoomCode();
    net = createNet({ onMessage, onStatus });
    await net.host(code, myName);
    myId = net.selfId;
    isHost = true;
    game = createGame({
      onPrivateCards(id, cards) {
        if (id === myId) { myHoleCards = cards; renderMyCards(); }
        else net.sendTo(id, { type: 'private-cards', cards });
      },
    });
    game.setBroadcast(state => { currentState = state; render(); net.send(state); });
    game.ensurePlayer(myId, myName);
    enterTable(code);
    game.refresh(); // 立刻畫出 8 個空位，不用等第一個訊息進來
  } catch (e) {
    statusMsg.textContent = '建立房間失敗：' + e.message;
  }
};

$('#joinBtn').onclick = async () => {
  myName = $('#nameInput').value.trim() || '玩家';
  const code = $('#codeInput').value.trim().toUpperCase();
  if (code.length < 4) { statusMsg.textContent = '請輸入房間代號'; return; }
  statusMsg.textContent = '連線中…';
  try {
    net = createNet({ onMessage, onStatus });
    await net.join(code, myName);
    myId = net.selfId;
    isHost = false;
    enterTable(code);
  } catch (e) {
    statusMsg.textContent = '加入失敗：' + e.message;
  }
};

function enterTable(code) {
  landing.classList.add('hidden');
  tableScreen.classList.remove('hidden');
  $('#roomCodeLabel').textContent = code;
}

$('#copyCodeBtn').onclick = () => {
  navigator.clipboard?.writeText($('#roomCodeLabel').textContent);
};

// ---------- 網路訊息 ----------
function onStatus(status) {
  if (status.kind === 'peer-error' || status.kind === 'conn-error') {
    console.warn('net error', status.error);
  }
  if (isHost && game) {
    if (status.kind === 'peer-joined') { game.ensurePlayer(status.id, status.name); game.refresh(); }
    if (status.kind === 'peer-left') { game.disconnect(status.id); }
  }
}

function onMessage(envelope) {
  if (envelope.type === 'sticker') { showStickerToast(envelope.__name || '?', envelope.file); return; }
  if (isHost) {
    if (!game) return;
    switch (envelope.type) {
      case 'sit': game.sit(envelope.__id, envelope.__name, envelope.seat); break;
      case 'stand': game.standUp(envelope.__id); break;
      case 'start': game.startHand(); break;
      case 'action': game.handleAction(envelope.__id, envelope.action, envelope.amount, envelope.zimucheUsed); break;
    }
  } else {
    if (envelope.type === 'state') { currentState = envelope; render(); }
    if (envelope.type === 'private-cards') { myHoleCards = envelope.cards; renderMyCards(); }
  }
}

// ---------- 送出動作（host 直接呼叫引擎，guest 透過網路送給 host）----------
function submitSit(seat) {
  if (isHost) game.sit(myId, myName, seat);
  else net.send({ type: 'sit', seat });
}
function submitStand() {
  if (isHost) game.standUp(myId);
  else net.send({ type: 'stand' });
}
function submitStart() {
  if (isHost) game.startHand();
  else net.send({ type: 'start' });
}
function submitAction(action, amount, zimucheUsed = 0) {
  if (isHost) game.handleAction(myId, action, amount, zimucheUsed);
  else net.send({ type: 'action', action, amount, zimucheUsed });
}

// ---------- 座位版面（8 席，環繞牌桌）----------
const SEAT_POS = [
  { left: '50%', top: '92%' }, { left: '80%', top: '80%' },
  { left: '95%', top: '50%' }, { left: '80%', top: '20%' },
  { left: '50%', top: '8%' }, { left: '20%', top: '20%' },
  { left: '5%', top: '50%' }, { left: '20%', top: '80%' },
];

function cardEl(card, faceUp = true) {
  const el = document.createElement('div');
  el.className = 'card' + (!faceUp ? ' back' : isRed(card) ? ' red' : '');
  el.textContent = faceUp ? cardLabel(card) : '';
  return el;
}

function renderMyCards() {
  const box = $('#myCards');
  box.innerHTML = '';
  const mySeat = currentState?.seats.find(s => s?.id === myId);
  if (mySeat && mySeat.inHand && !mySeat.folded && myHoleCards.length) {
    myHoleCards.forEach(c => box.appendChild(cardEl(c)));
  }
}

const PHASE_LABEL = { lobby: '等待開局', preflop: '翻牌前', flop: '翻牌圈', turn: '轉牌圈', river: '河牌圈', showdown: '攤牌' };

function render() {
  if (!currentState) return;
  const s = currentState;

  if (s.phase === 'lobby' && lastPhase !== 'lobby') myHoleCards = [];
  lastPhase = s.phase;

  let handInfoText = `第 ${s.handNumber} 手 ・ ${PHASE_LABEL[s.phase] || s.phase}`;
  if (s.phase === 'lobby' && s.lobbyCountdownEndsAt) {
    const secs = Math.max(0, Math.ceil((s.lobbyCountdownEndsAt - Date.now()) / 1000));
    handInfoText += ` ・ ${secs} 秒後自動開始`;
  }
  $('#handInfo').textContent = handInfoText;
  $('#potLabel').textContent = `底池：${s.pot}`;

  const communityEl = $('#community');
  communityEl.innerHTML = '';
  s.community.forEach(c => communityEl.appendChild(cardEl(c)));

  const seatsEl = $('#seats');
  seatsEl.innerHTML = '';
  const mySeatInfo = s.seats.find(sec => sec?.id === myId);
  const iAmSeated = !!mySeatInfo;

  for (let i = 0; i < 8; i++) {
    const p = s.seats[i];
    const div = document.createElement('div');
    div.className = 'seat';
    Object.assign(div.style, SEAT_POS[i]);

    if (!p) {
      div.classList.add('empty');
      div.textContent = `空位 ${i + 1}`;
      if (!iAmSeated && s.phase === 'lobby') {
        div.onclick = () => submitSit(i);
      }
    } else {
      if (i === s.turnSeat) div.classList.add('turn');
      if (p.folded) div.classList.add('folded');
      const zm = p.zimuche > 0 ? `<div class="zm">🚗 子母車 ×${p.zimuche}（值 ${p.zimuche * ZIMUCHE_VALUE}）</div>` : '';
      const betChip = p.committed > 0 ? `<div class="bet-chip">${p.committed}</div>` : '';
      const dealerMark = i === s.dealerSeat ? '<div class="dealer-btn">D</div>' : '';
      const status = p.allIn ? '（全下）' : p.folded ? '（棄牌）' : !p.connected ? '（斷線）' : '';
      let turnTimerHtml = '';
      if (i === s.turnSeat && s.turnDeadlineAt) {
        const secs = Math.max(0, Math.ceil((s.turnDeadlineAt - Date.now()) / 1000));
        turnTimerHtml = `<div class="turn-timer">⏱ ${secs}s</div>`;
      }
      div.innerHTML = `
        ${dealerMark}
        <div class="avatar" style="background:${avatarColor(p.name)}">${initials(p.name)}</div>
        <div class="nm">${escapeHtml(p.name)} ${status}</div>
        <div class="chips">💰 ${p.chips}</div>
        ${zm}
        ${betChip}
        ${turnTimerHtml}
      `;
    }
    seatsEl.appendChild(div);
  }

  renderMyCards();

  // 座位/開局控制
  const seatControls = $('#seatControls');
  seatControls.innerHTML = '';
  if (iAmSeated) {
    const btn = document.createElement('button');
    btn.textContent = '離開座位';
    btn.onclick = submitStand;
    seatControls.appendChild(btn);
  }
  const startBtn = $('#startHandBtn');
  const iAmStarter = s.starterAuthorityId ? s.starterAuthorityId === myId : isHost;
  if (s.phase === 'lobby' && s.canStart && iAmStarter) {
    startBtn.classList.remove('hidden');
    startBtn.textContent = s.lobbyCountdownEndsAt ? '提前開始這一手' : '開始這一手';
    startBtn.onclick = submitStart;
  } else {
    startBtn.classList.add('hidden');
  }

  // 下注控制
  const controls = $('#controls');
  const myTurn = iAmSeated && s.turnSeat === mySeatInfo?.seat &&
    ['preflop', 'flop', 'turn', 'river'].includes(s.phase);
  if (myTurn) {
    controls.classList.remove('hidden');
    const toCall = s.currentBet - mySeatInfo.committed;
    $('#checkBtn').disabled = toCall > 0;
    $('#callBtn').textContent = toCall > 0 ? `跟注 ${toCall}` : '跟注';
    $('#callBtn').disabled = toCall <= 0;
    const betAmount = $('#betAmount');
    const minTarget = s.currentBet + (s.minRaise || 100);
    betAmount.min = minTarget;
    if (document.activeElement !== betAmount && (!betAmount.value || Number(betAmount.value) < minTarget)) {
      betAmount.value = minTarget;
    }
    betAmount.max = mySeatInfo.chips + mySeatInfo.zimuche * 100 + mySeatInfo.committed;
    $('#betBtn').textContent = s.currentBet > 0 ? '加注到' : '下注';

    const zimucheRow = $('#zimucheRow');
    if (mySeatInfo.zimuche > 0) {
      zimucheRow.classList.remove('hidden');
      const zimucheInput = $('#zimucheInput');
      zimucheInput.max = mySeatInfo.zimuche;
      if (document.activeElement !== zimucheInput && Number(zimucheInput.value) > mySeatInfo.zimuche) {
        zimucheInput.value = mySeatInfo.zimuche;
      }
    } else {
      zimucheRow.classList.add('hidden');
      $('#zimucheInput').value = 0;
    }
  } else {
    controls.classList.add('hidden');
  }

  // 紀錄（內容沒變就不要一直把捲軸拉回底部，不然使用者往上看歷史紀錄會一直被拉走）
  const logEl = $('#log');
  const logSignature = s.log.join('\n');
  if (logSignature !== lastLogSignature) {
    lastLogSignature = logSignature;
    logEl.innerHTML = s.log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  updateBossHud(myTurn, mySeatInfo, s);
}

// 每半秒重繪一次，純粹是為了讓倒數計時的秒數會跳動；遊戲狀態本身沒有變，
// 上面 render() 裡的各種 guard（focus 中的輸入框、log 內容比對）確保這不會打斷使用者操作。
setInterval(() => { if (currentState) render(); }, 500);

function zimucheWanted() {
  return Math.max(0, Math.floor(Number($('#zimucheInput').value) || 0));
}

$('#foldBtn').onclick = () => submitAction('fold');
$('#checkBtn').onclick = () => submitAction('check');
$('#callBtn').onclick = () => submitAction('call', 0, zimucheWanted());
$('#betBtn').onclick = () => {
  const amount = Number($('#betAmount').value);
  if (amount > 0) submitAction(currentState.currentBet > 0 ? 'raise' : 'bet', amount, zimucheWanted());
};
$('#allinBtn').onclick = () => {
  if (!currentState) return;
  const mySeatInfo = currentState.seats.find(sec => sec?.id === myId);
  if (!mySeatInfo) return;
  const allInTarget = mySeatInfo.chips + mySeatInfo.committed + mySeatInfo.zimuche * 100;
  if (allInTarget > currentState.currentBet) {
    submitAction(currentState.currentBet > 0 ? 'raise' : 'bet', allInTarget, mySeatInfo.zimuche);
  } else {
    submitAction('call', 0, mySeatInfo.zimuche);
  }
};

// ---------- 貼圖 ----------
let stickerList = [];
fetch('assets/stickers/manifest.json').then(r => r.ok ? r.json() : []).then(list => {
  stickerList = Array.isArray(list) ? list : [];
  renderStickerPanel();
}).catch(() => { stickerList = []; renderStickerPanel(); });

function renderStickerPanel() {
  const panel = $('#stickerPanel');
  if (stickerList.length === 0) {
    panel.innerHTML = '<div class="empty-hint">還沒有貼圖，把圖片丟進 assets/stickers/ 資料夾</div>';
    return;
  }
  panel.innerHTML = '';
  for (const file of stickerList) {
    const btn = document.createElement('button');
    const img = document.createElement('img');
    img.src = `assets/stickers/${file}`;
    img.alt = file;
    btn.appendChild(img);
    btn.onclick = () => { sendSticker(file); $('#stickerPanel').classList.add('hidden'); };
    panel.appendChild(btn);
  }
}

$('#stickerToggle').onclick = () => $('#stickerPanel').classList.toggle('hidden');
document.addEventListener('click', e => {
  const bar = $('.sticker-bar');
  if (bar && !bar.contains(e.target)) $('#stickerPanel').classList.add('hidden');
});

function sendSticker(file) {
  showStickerToast(myName, file);
  net?.send({ type: 'sticker', file });
}

function showStickerToast(name, file) {
  const toasts = $('#stickerToasts');
  const el = document.createElement('div');
  el.className = 'sticker-pop';
  el.innerHTML = `<img src="assets/stickers/${file}" alt=""><span>${escapeHtml(name)}</span>`;
  toasts.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) {
  const s = String(name).trim();
  return s.slice(0, 1).toUpperCase() || '?';
}
function avatarColor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 65% 62%)`;
}

// ---------- 老闆鍵：Esc 切換成假裝在做 Excel 報表 ----------
const BOSS_ROWS = ['業績目標', '實際達成', '差異分析', '客戶滿意度', '成本控管', '專案進度', '人力配置', '下季預測'];
const bossOverlay = $('#bossOverlay');
const bossTable = $('#bossTable');
let bossOn = false;
let bossTick = null;
const originalTitle = document.title;
const originalFavicon = $('#favicon').href;

function bossRandomCell() { return (Math.random() * 900000 + 100000).toFixed(0); }

function renderBossTable() {
  const months = ['1月', '2月', '3月', '4月', '5月', '6月'];
  let html = '<tr><th>項目</th>' + months.map(m => `<th>${m}</th>`).join('') + '</tr>';
  for (const row of BOSS_ROWS) {
    html += `<tr><td>${row}</td>` + months.map(() => `<td>${bossRandomCell()}</td>`).join('') + '</tr>';
  }
  bossTable.innerHTML = html;
}

function setBoss(on) {
  bossOn = on;
  bossOverlay.classList.toggle('hidden', !on);
  if (on) {
    renderBossTable();
    document.title = 'Q3業績分析報表.xlsx - Excel';
    $('#favicon').href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='16' fill='%23106e3c'/%3E%3Ctext x='50' y='66' font-size='46' text-anchor='middle' fill='%23fff' font-family='Arial'%3EX%3C/text%3E%3C/svg%3E";
    bossTick = setInterval(renderBossTable, 4000);
  } else {
    document.title = originalTitle;
    $('#favicon').href = originalFavicon;
    clearInterval(bossTick);
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') setBoss(!bossOn);
});

// 偽裝的兩顆動作鍵（棄牌／跟注-過牌），讓你不用離開假報表也能應付基本狀況。
// 下注/加注需要輸入金額，偽裝介面塞不下、也容易穿幫，那種情況還是得按 Esc 出來操作。
function updateBossHud(myTurn, mySeatInfo, s) {
  $('#bossDot').classList.toggle('hidden', !myTurn);
  const pot = s?.pot ?? 0;
  $('#bossStatusText').textContent = `工作表 1｜儲存格總和：${pot}`;
  $('#bossFold').disabled = !myTurn;
  $('#bossCall').disabled = !myTurn;
  if (myTurn) {
    const toCall = s.currentBet - mySeatInfo.committed;
    $('#bossCall').textContent = toCall > 0 ? '✓' : '⏭';
    $('#bossCall').title = toCall > 0 ? `核取儲存格（跟注 ${toCall}）` : '核取儲存格（過牌）';
  }
}

$('#bossFold').onclick = () => submitAction('fold');
$('#bossCall').onclick = () => {
  if (!currentState) return;
  const mySeatInfo = currentState.seats.find(sec => sec?.id === myId);
  if (!mySeatInfo) return;
  const toCall = currentState.currentBet - mySeatInfo.committed;
  submitAction(toCall > 0 ? 'call' : 'check');
};
