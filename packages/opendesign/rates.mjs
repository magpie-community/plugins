// The Design Plan's own deduction multipliers — the "额度扣除倍率" table that
// https://open-design.ai/zh/model-credits/ publishes (read 2026-11-06; Go,
// Plus, Pro and Max carry the same table). A rate is what one dollar of model
// spend takes out of the plan's allowance: 0.27× is cheaper than 1×, 4× is
// four times dearer.
//
// The catalog's cost words are a different thing, and mostly disagree:
// amr-link calls Claude Haiku 5.5 and GPT-6 Luna "low" while the plan charges
// 2× and 4× for them, calls GLM-5.3 Flash and MiMo V2.6 Flash "low" while the
// plan charges 1×, and calls DeepSeek V4 Pro "high" and GLM-5.3 Flash-X
// "medium" while the plan charges 1× and 2×. So a rate read off those words is
// wrong for most models; the table below wins, and only a model it doesn't
// name (a new one) falls back to its catalog word.
//
// DeepSeek V4.1 Flash's 0.25× "限时谷价" / "Off-peak promo" row is a
// time-limited promotional price, not a second model id; the model keeps 0.5×.
// DeepSeek V4.1 Flash Eco is the same model on the low-priority, high-quota
// schedule (the vendor's announcement: 模型效果完全无损), charged 0.27×.
export const RATES = {
  "claude-haiku-5.5": 2,
  "deepseek-v4-flash": 1,
  "deepseek-v4-flash-vision-exp": 1,
  "deepseek-v4-pro": 1,
  "deepseek-v4.1-flash": 0.5,
  "deepseek-v4.1-flash-eco": 0.27,
  "glm-5.3-flash": 1,
  "glm-5.3-flashx": 2,
  "gpt-6-luna": 4,
  "hy4-preview": 1,
  "kimi-k2.7-code": 1,
  "mimo-v2.6-flash": 1,
  "mimo-v2.6-pro": 1,
  "minimax-m3.1-flash": 1,
}
