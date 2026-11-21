// The time left on a pairing code, counted on the page itself. These two
// functions are plain, so they can be tested without a browser.
export const pairingLeft = (state, now = Date.now()) => {
  const until = Date.parse(state?.pairingExpiresAt || '');
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, Math.round((until - now) / 1000));
};

// Under a minute the seconds are shown, so a code that is about to die does
// not look like a dead one.
export const remainingText = (seconds) => {
  const left = Math.max(0, Math.round(seconds || 0));
  if (!left) return '已经作废';
  if (left < 60) return `还剩 ${left} 秒`;
  return `还剩 ${Math.floor(left / 60)} 分 ${left % 60} 秒`;
};
