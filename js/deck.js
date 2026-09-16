const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['S','H','D','C'];

export function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
export function cardLabel(card) {
  return card[0] + SUIT_SYMBOL[card[1]];
}
export function isRed(card) {
  return card[1] === 'H' || card[1] === 'D';
}
