import fs from "node:fs";
import { createHash } from "node:crypto";
import { configFile } from "./store.mjs";
import { ask } from "./gateway.mjs";
import { loadDetector, generateChallenges } from "./lmfpd/index.js";

// 数值指纹：lm-detector（MIT，https://github.com/Ikaleio/lm-detector）那套做法——
// 让它「随机数 300 个 1..355 的整数」，真人模型生成的数字串有自己的统计纹理，
// 参考库里几百个型号各采过一遍，就能算出「这条回答更像谁」。
// 和自述的区别：它不看模型怎么自称，也改不了，只能靠真的换了模型才变。

const DATA_FILE = "lmfpd-data.bin";
// 采样方式：参考库那套 SDK 一次只吃 1–3 个样本（count 上限 3，strict 又要求 3/3 都成功），
// 所以「多采几个样本」只能拆回合：每回合 3 个「数数」挑战，跑两回合再按型号把概率平均。
// 3 个样本只够「有排名」，前两名经常咬在一起（实测 80.5% vs 19.0% 就是 3 个样本的样子）；
// 两回合平均后方差收窄，同样的钱换来更硬的结论。
export const ROUND = 3;
export const ROUNDS = 2;
export const SAMPLES = ROUND * ROUNDS;

// 参考库钉在一个具体版本上：下载路径带版本号（不是 @latest），落地再按 sha256 对一遍。
// 理由：参考库换了内容，「这条线像谁」的概率就不该还能跟旧结论摆在一起看；
// 而 @latest 意味着今天跑出来的分数和昨天的不是同一把尺子。哈希对不上就当失败，宁可不测。
export const DATA_VERSION = "0.0.1794360871947";
export const DATA_SHA256 = "8c7d48ea242026d123baa7cfbbe377701ac8d6899e6796f319ce555d3ae06b6c";
export const DATA_BYTES = 4028744;
export const DATA_BUILT_AT = "2026-11-11T01:24:58Z";
// 默认从上游自己那台取（lm-detector 作者的服务器，内容是同一份：bundle.json 里声明的
// detector sha256 就是下面的 DATA_SHA256，chunk 名本身也是内容寻址的 .zst）。
export const DATA_SOURCE_UPSTREAM = "https://lm.ikale.io/data/";
// 备选：钉死版本的 npm 镜像。默认不连它，只在 ROUTE_INSIGHT_DATA_SOURCE 指过去时用。
export const DATA_SOURCE = "https://cdn.jsdmirror.com/npm/lmfpd-data@" + DATA_VERSION + "/";

// 数据源可以被换掉，默认行为不变（只连上面那一个钉版路径）。两个环境变量：
//   ROUTE_INSIGHT_DATA_SOURCE=<url>  换成自己的镜像 / 自建源（末尾斜杠可有可无，版本号仍由本文件决定）
//   ROUTE_INSIGHT_DATA_DIR=<dir>     直接读一个本地目录（SDK 的 readDir 分支，完全不联网）
// 换源不改校验：版本号、sha256、字节数还是写死在下面的常量里，对不上就判失败。
const ENV_SOURCE = String(process.env.ROUTE_INSIGHT_DATA_SOURCE || "").trim();
const ENV_DIR = String(process.env.ROUTE_INSIGHT_DATA_DIR || "").trim();

export function dataSources() {
  if (ENV_DIR) return [ENV_DIR.replace(/[\\/]+$/, "")];
  if (ENV_SOURCE) return [ENV_SOURCE.replace(/\/?$/, "/")];
  return [DATA_SOURCE_UPSTREAM];
}

export function activeSource() {
  const list = dataSources();
  return ENV_DIR ? "file://" + list[0].replace(/\\/g, "/") : list[0];
}
export const DATA_CREDIT =
  "参考库来自 lm-detector（MIT）· 固定版本 " +
  DATA_VERSION +
  "（" +
  DATA_BUILT_AT.slice(0, 10) +
  "）· 约 " +
  (DATA_BYTES / 1048576).toFixed(1) +
  " MB · 第一次用到时才下载";

let detectorPromise = null;

// 缓存永不过期：SDK 默认 ttl 86400，一天后下次 loadData 会在后台悄悄重下一次——
// 那就是「用户没点任何按钮，插件自己联网」。插件只认固定版本 + 固定哈希，
// 版本变了这里会直接判失败并要求用户点按钮重取，所以没有理由自动刷新。
const NO_AUTO_REFRESH = 315360000;

// 只读本地缓存，不触发下载：界面要显示的「下没下、哪个版本、多大」都从这里来。
function cacheInfo() {
  const file = configFile(DATA_FILE);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (error) {
    return { present: false, file: file };
  }
  try {
    const length = buf.readUInt32LE(0);
    const bundle = JSON.parse(buf.subarray(4, 4 + length).toString("utf8"));
    const detector = buf.subarray(4 + length);
    const sha = createHash("sha256").update(detector).digest("hex");
    const entry = (bundle.files && bundle.files["shared_detector.bin"]) || {};
    const declared = String(entry.sha256 || "");
    const ok = sha === DATA_SHA256 && declared === DATA_SHA256;
    return {
      present: true,
      file: file,
      sha256: sha,
      builtAt: String(bundle.built_at || ""),
      bytes: detector.length,
      ok: ok,
      error: ok
        ? ""
        : "本地参考库不是插件固定的版本（" +
          sha.slice(0, 12) +
          " ≠ " +
          DATA_SHA256.slice(0, 12) +
          "）。参考库换了内容，读数不可比；删掉 " +
          file +
          " 再在界面上点「下载参考库」重新取一份。"
    };
  } catch (error) {
    return { present: true, file: file, ok: false, error: "本地参考库读不了：" + String((error && error.message) || error) };
  }
}

// 真正加载参考库（必要时才下载）。下完再校验一次哈希，不通过就不返回检测器。
export function loadFingerprinter() {
  if (!detectorPromise) {
    detectorPromise = loadDetector({ cache: configFile(DATA_FILE), source: dataSources(), ttl: NO_AUTO_REFRESH })
      .then(function (detector) {
        const info = cacheInfo();
        if (!info.ok) throw new Error(info.error || "参考库校验失败");
        return detector;
      })
      .catch(function (error) {
        detectorPromise = null;
        throw error;
      });
  }
  return detectorPromise;
}

// 「下载参考库」按钮走这里：本地已有的副本对不上固定版本时，先把它删掉再重新取，
// 否则 SDK 直接把内存里那份旧的还回来，按了按钮也不会真的换数据。
export async function downloadReferenceData() {
  const info = cacheInfo();
  if (info.present && info.ok && detectorPromise) return detectorPromise;
  if (info.present && !info.ok) {
    try {
      fs.unlinkSync(info.file);
    } catch (error) {
      /* 删不掉就让它照常失败，错误会原样报到界面上 */
    }
  }
  detectorPromise = null;
  return loadFingerprinter();
}

// 状态查询：只报告，不下载。界面据此决定是显示版本，还是显示一个「下载参考库」按钮。
export async function fingerprinterStatus() {
  const base = {
    version: DATA_VERSION,
    sha256: DATA_SHA256,
    downloadBytes: DATA_BYTES,
    builtAt: DATA_BUILT_AT,
    source: activeSource(),
    credit: DATA_CREDIT
  };
  const info = cacheInfo();
  if (!info.present) return Object.assign({ ready: false, downloaded: false }, base);
  if (!info.ok) {
    return Object.assign({ ready: false, downloaded: true }, base, {
      dataBytes: info.bytes || 0,
      error: info.error
    });
  }
  return Object.assign({ ready: true, downloaded: true }, base, {
    builtAt: info.builtAt || DATA_BUILT_AT,
    dataBytes: info.bytes || 0
  });
}

// 第一名与第二名的概率差：差得越开，这个结论越经得起看；咬在一起（<5%）就该提醒「别当定论」。
export function topMargin(rows) {
  const list = (rows || []).filter(function (row) {
    return typeof row.probability === "number";
  });
  if (list.length < 2) return null;
  return Math.max(0, list[0].probability - list[1].probability);
}

function label(decision) {
  if (decision === "scored") return "有排名";
  if (decision === "not_model") return "不像模型回答";
  if (decision === "unscorable") return "样本不够";
  return decision || "未知";
}

// 一个样本 = 一次「数数」挑战。空答要重试一次：网关那头常是「思考把预算吃光」。
// 单次输出必须有上限（以前传 0 = 不设上限，一次点击能烧掉没有边界的钱）：
// 16000 够数完 300 个数再留出思考余量，两趟都空就记一次失败，不再加码。
const NUM_MAX_TOKENS = 16000;
async function sample(model, challenge, opts) {
  const started = Date.now();
  let call = await ask(model, challenge.prompt, { effort: opts.effort, maxTokens: NUM_MAX_TOKENS, timeoutMs: 240000 });
  let retried = false;
  if (!call.ok || !call.text.trim()) {
    retried = true;
    call = await ask(model, challenge.prompt, { effort: opts.effort, maxTokens: NUM_MAX_TOKENS, timeoutMs: 240000 });
  }
  return {
    expected: challenge.expected_count,
    text: call.text,
    chars: String(call.text || "").length,
    ms: Date.now() - started,
    status: call.status,
    served: call.served,
    retried: retried,
    error: call.error
  };
}

// 两回合的概率按型号平均，再归一化：回合之间参考库是同一套，平均不会引入偏差，
// 但「哪一回合运气好」这种偶然因素会被摊平。
function mergeAnalyses(analyses) {
  const table = new Map();
  let scored = 0;
  analyses.forEach(function (analysis) {
    if (!analysis || analysis.decision !== "scored" || !Array.isArray(analysis.results)) return;
    scored += 1;
    analysis.results.forEach(function (row) {
      const key = row.model || row.display_name;
      if (!key) return;
      const cur = table.get(key) || {
        model: row.model,
        name: row.display_name || row.model,
        family: row.family || "",
        familyName: row.family_name || "",
        sum: 0,
        n: 0
      };
      cur.sum += typeof row.probability === "number" ? row.probability : 0;
      cur.n += 1;
      table.set(key, cur);
    });
  });
  if (!scored) return null;
  const rows = Array.from(table.values()).map(function (row) {
    return {
      model: row.model,
      name: row.name,
      family: row.family,
      familyName: row.familyName,
      probability: row.sum / row.n
    };
  });
  const total = rows.reduce(function (sum, row) { return sum + row.probability; }, 0);
  rows.forEach(function (row) {
    row.probability = total > 0 ? row.probability / total : 0;
  });
  rows.sort(function (a, b) { return b.probability - a.probability; });
  return { rounds: scored, rows };
}

export async function runNumeric(model, opts) {
  const o = opts || {};
  const started = Date.now();
  let detector;
  try {
    detector = await loadFingerprinter();
  } catch (error) {
    return {
      id: "numfp",
      ok: false,
      model,
      ms: Date.now() - started,
      error: "参考库没下下来：" + String((error && error.message) || error),
      samples: []
    };
  }

  const batches = [];
  for (let round = 0; round < ROUNDS; round += 1) batches.push(generateChallenges(ROUND));
  const jobs = [];
  batches.forEach(function (challenges, round) {
    challenges.forEach(function (challenge, index) {
      jobs.push({ round, index, challenge });
    });
  });
  const results = await Promise.all(
    jobs.map(function (job) {
      return sample(model, job.challenge, o);
    })
  );
  jobs.forEach(function (job, i) {
    job.sample = results[i];
  });

  const analyses = [];
  const roundOutputs = batches.map(function () { return []; });
  const roundJobIds = batches.map(function () { return []; });
  jobs.forEach(function (job, i) {
    const text = String(job.sample.text || "");
    if (text.trim()) {
      roundOutputs[job.round].push({ text, expected_count: job.challenge.expected_count });
      roundJobIds[job.round].push(i);
    }
  });
  roundOutputs.forEach(function (outputs, round) {
    if (!outputs.length) {
      analyses.push({ decision: "empty" });
      return;
    }
    let analysis;
    try {
      // strict：这一回合凑不满 3 个就别给「部分排名」，免得把噪声当结论。
      analysis = detector.analyze(outputs, { strict: outputs.length < ROUND });
    } catch (error) {
      analysis = { decision: "error", error: String((error && error.message) || error) };
    }
    analyses.push(analysis);
    // 诊断按「这一回合收下的样本顺序」给回来的，据此回填每个样本解出多少个数、有没有被采纳。
    const diagnostics = analysis.diagnostics || [];
    roundJobIds[round].forEach(function (jobId, k) {
      const diag = diagnostics[k] || {};
      jobs[jobId].parsed = diag.parsed_numbers || 0;
      jobs[jobId].accepted = !!diag.accepted;
    });
  });

  const used = roundOutputs.reduce(function (sum, outputs) { return sum + outputs.length; }, 0);
  const samplesOut = jobs
    .map(function (job) {
      return {
        round: job.round + 1,
        index: job.index + 1,
        expected: job.challenge.expected_count,
        chars: job.sample.chars,
        parsed: job.parsed || 0,
        accepted: !!job.accepted,
        ms: job.sample.ms,
        retried: job.sample.retried,
        status: job.sample.status,
        error: job.sample.error,
        verdict: ""
      };
    });

  if (!used) {
    return {
      id: "numfp",
      ok: false,
      model,
      ms: Date.now() - started,
      error: "样本全是空的，这次没得分",
      samples: samplesOut
    };
  }

  const merged = mergeAnalyses(analyses);
  const first = analyses.find(function (analysis) {
    return analysis && analysis.decision;
  }) || {};

  // 回合里的判定回填到样本行：界面用来看「这几次答得像样吗」。
  const verdictsByRound = analyses.map(function (analysis) {
    return (analysis && analysis.decision) || "";
  });
  samplesOut.forEach(function (row) {
    row.verdict = verdictsByRound[row.round - 1] || "";
  });

  if (!merged) {
    const why = first.error || (first.decision === "not_model" ? "回答不像模型在数数" : "样本不够判不了");
    return {
      id: "numfp",
      ok: false,
      model,
      ms: Date.now() - started,
      decision: first.decision || "unscorable",
      decisionLabel: label(first.decision),
      error: why,
      used,
      builtAt: detector.builtAt,
      method: first.method || "",
      samples: samplesOut
    };
  }

  const rows = merged.rows;
  const top = rows[0] || {};
  const usedRounds = merged.rounds;
  return {
    id: "numfp",
    ok: true,
    model,
    ms: Date.now() - started,
    decision: "scored",
    decisionLabel: label("scored") + (usedRounds > 1 ? "（" + usedRounds + " 回合合并）" : ""),
    prediction: top.model || "",
    predictionName: top.name || top.model || "",
    probability: typeof top.probability === "number" ? top.probability : null,
    probabilityStatus: usedRounds > 1 ? "merged" : "single",
    family: top.family || "",
    familyName: top.familyName || "",
    rankingScore: null,
    used,
    builtAt: detector.builtAt,
    method: first.method || "",
    evidence: first.evidence || null,
    margin: topMargin(rows),
    results: rows.slice(0, 8),
    samples: samplesOut,
    error: ""
  };
}
