globalThis.FoveaReport = {
  "version": 1,
  "source": "synthetic",
  "options": {
    "threshold": 0,
    "keep_recent": 4,
    "keep_recent_tokens": 0,
    "cut_step": 4,
    "tool_head": 80,
    "tool_tail": 40,
    "text_head": 120,
    "text_tail": 60,
    "saccade": "off"
  },
  "request": {
    "before": 47777,
    "after": 14148,
    "saved": 33629,
    "changed": 13,
    "messages": 34
  },
  "consecutive": {
    "first_messages": 32,
    "second_messages": 34,
    "baseline_prefix_chars": 44694,
    "fovea_prefix_chars": 11065,
    "baseline_prefix_share": 0.9986370237962239,
    "fovea_prefix_share": 0.9945173467553479,
    "stable_cut_messages": 27,
    "stable_cut_prefix": true
  },
  "limits": "字符数与共同前缀占比是确定性的代理指标，不是计费 token、缓存命中、延迟或实际美元；system/developer 与最近窗口里的摘要仍会发送。"
};
