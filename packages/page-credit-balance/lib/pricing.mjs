const CODEARTS = 'https://support.huaweicloud.com/price-codeartsagent/codeartsagent_billing_0028.html';
const TRAE = 'https://docs.trae.cn/ide_limited-time-discount-for-builtin-models';
const codearts = offpeak => ({ peak: 0.18, offpeak, start: 8, end: 21,
  hours: '每天 21:00–次日 08:00', url: CODEARTS });
const rules = new Map([
  ['codearts/deepseek-v4.1-flash', codearts(0.09)],
  ['codearts/deepseek-v4.1-flash-1017', codearts(0.12)],
  ['trae-cn/deepseek-v4.1-flash', { peak: 0.12, offpeak: 0.06, weekday: true,
    peakSamplesFrom: Date.parse('2026-11-17T00:00:00+08:00'),
    hours: '工作日 00:00–09:00、12:00–14:00、18:00–24:00；周末全天', url: TRAE }],
  ['trae-cn/deepseek-v4-pro', { peak: 0.72, offpeak: 0.36, start: 8, end: 22,
    hours: '每天 22:00–次日 08:00', url: TRAE }],
]);

export const PERIODS = ['recent', 'peak', 'offpeak'];
export const pricingRule = (provider, model) => rules.get(`${provider}/${model}`);

export function sampleMultiplier(rule, time) {
  if (!rule) return null;
  const beijing = new Date(time + 8 * 3_600_000);
  const hour = beijing.getUTCHours();
  const day = beijing.getUTCDay();
  const peak = rule.weekday ? day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
    : hour >= rule.start && hour < rule.end;
  if (peak && time < rule.peakSamplesFrom) return null;
  return peak ? rule.peak : rule.offpeak;
}
