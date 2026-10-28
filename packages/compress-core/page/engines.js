// 由 scripts/gen-page-catalog.mjs 生成，不要手改。真相源是 catalog.js 与各引擎的 configSchema。
globalThis.CompressCatalog = {
  "engines": [
    {
      "id": "session-dedup",
      "label": "Session Dedup",
      "description": "Lossless — elides only text already sent earlier in the same session; nothing is summarized or dropped. Negligible latency overhead.",
      "why": "同一会话里已经发过的文本，后面再出现就换成引用；不总结也不丢内容。",
      "stackPriority": 3,
      "lossy": false,
      "cacheImpact": "low",
      "isSingleMode": false,
      "levels": null,
      "sampling": false,
      "inputScope": "messages",
      "available": true,
      "requires": null,
      "fields": [
        {
          "key": "minBlockChars",
          "type": "number",
          "label": "最小块字符",
          "description": "小于这个长度的文本块不参与去重",
          "defaultValue": 80,
          "min": 20,
          "max": 4000
        },
        {
          "key": "minJaccard",
          "type": "number",
          "label": "相似度阈值",
          "description": "越高越保守，1 表示只合并完全相同的块",
          "defaultValue": 0.85,
          "min": 0.5,
          "max": 1
        },
        {
          "key": "shingleSize",
          "type": "number",
          "label": "分片大小",
          "description": "相似度计算的分片长度",
          "defaultValue": 3,
          "min": 2,
          "max": 8
        }
      ]
    },
    {
      "id": "lite",
      "label": "Lite Cleanup",
      "description": "Safest mode (~15% savings, <1ms latency): whitespace/dedup/formatting cleanup only, zero semantic change. Always safe to leave on.",
      "why": "只清空白、重复行和格式，零语义改动，永远可以开着（约 15%）。",
      "stackPriority": 5,
      "lossy": false,
      "cacheImpact": "none",
      "isSingleMode": true,
      "levels": null,
      "sampling": false,
      "inputScope": "mixed",
      "available": true,
      "requires": null,
      "fields": [
        {
          "key": "compressToolResults",
          "type": "boolean",
          "label": "压缩工具输出",
          "description": "对 tool_result 做空白与格式清理",
          "defaultValue": true
        },
        {
          "key": "preserveSystemPrompt",
          "type": "boolean",
          "label": "保护系统提示词",
          "description": "完全不碰 system 消息",
          "defaultValue": false
        },
        {
          "key": "maxToolLength",
          "type": "number",
          "label": "工具输出上限",
          "description": "超过这个字符数的工具输出会被截断",
          "defaultValue": 2000,
          "min": 200,
          "max": 20000
        }
      ]
    },
    {
      "id": "headroom",
      "label": "Headroom (GCF)",
      "description": "Column-wise compaction of tabular JSON into [N rows] form while keeping the structure readable.",
      "why": "把表格化的 JSON 按列压紧成 [N rows]，结构仍然可读。",
      "stackPriority": 15,
      "lossy": false,
      "cacheImpact": "low",
      "isSingleMode": false,
      "levels": null,
      "sampling": false,
      "inputScope": "tool-results",
      "available": true,
      "requires": null,
      "fields": [
        {
          "key": "minRows",
          "type": "number",
          "label": "最小行数",
          "description": "表格行数少于这个值就不压",
          "defaultValue": 8,
          "min": 2,
          "max": 200
        }
      ]
    }
  ],
  "order": [
    "session-dedup",
    "lite",
    "headroom"
  ],
  "presets": [
    "off",
    "safe",
    "custom",
    "all"
  ]
};
