// shared/challenge-browser.js
function randomIndex(length) {
  const limit = Math.floor(4294967296 / length) * length;
  const buffer = new Uint32Array(1);
  do
    crypto.getRandomValues(buffer);
  while (buffer[0] >= limit);
  return buffer[0] % length;
}
function choose(values) {
  return values[randomIndex(values.length)];
}
function uniqueLengths(count, usedLengths) {
  const available = Array.from({ length: 41 }, (_, index) => 292 + index).filter((length) => !usedLengths.includes(length));
  const output = [];
  while (output.length < count)
    output.push(available.splice(randomIndex(available.length), 1)[0]);
  return output;
}
var LANGUAGES = {
  zh: {
    space: "",
    openings: [
      "这是一次独立的数值选择记录。",
      "请完成下面的无语义整数选择任务。",
      "执行一次第一反应取值记录。",
      "生成一组不承载语义的整数选择。",
      "进行一轮快速逐项取值。"
    ],
    actions: [
      "为各个位置分别凭第一反应选择",
      "逐项选择",
      "每次只决定当前一项，共给出",
      "分别凭第一反应给出",
      "逐个直接选择"
    ],
    request: (action, count) => `${action} ${count} 个 1 到 355（含端点）的整数。`,
    rules: "每个位置都要单独选择；不要从 1 开始计数，不要连续递增或递减，也不要采用等差、循环、重复区块或其他规则化模式。" + "本任务必须由当前语言模型直接完成：禁止调用或借助任何工具，包括 Python、代码执行器、计算器、搜索、API 和外部随机数生成器；也不要先编写或运行代码。",
    endings: [
      "允许某个数字再次出现；每项写出后不要回头排序、去重或替换。",
      "偶然重复是有效的；不要重新排列或修正已经写出的项目。",
      "相同值可以再次出现；输出过程中不要整理或改写前面的项目。",
      "重复值无需删除；不要筛选、重排或补成某种规律。",
      "不必赋予数字任何含义；已经给出的值保持不变。"
    ],
    separators: [
      "数字之间用逗号或空格分隔均可。",
      "使用一种一致的常见分隔符即可。",
      "可以用逗号、空格或换行分隔。",
      "只要每个整数边界清楚，格式可自行选择。"
    ],
    start: "直接从第一个取值开始输出，不要在序列前重复数量、范围或任务说明。"
  },
  en: {
    space: " ",
    openings: [
      "This is an independent record of numerical choices.",
      "Complete the following integer-choice task, which carries no semantic meaning.",
      "Record a round of first-instinct choices.",
      "Generate a set of integer choices that carry no meaning.",
      "Make a quick round of item-by-item choices."
    ],
    actions: [
      "For each position, choose separately by first instinct",
      "Choose, item by item,",
      "Decide only the current item each time, giving a total of",
      "Give, each by first instinct,",
      "Choose directly, one by one,"
    ],
    request: (action, count) => `${action} ${count} integers from 1 to 355, inclusive.`,
    rules: "Choose separately for every position; do not count up from 1, do not increase or decrease consecutively, and do not use arithmetic progressions, cycles, repeated blocks, or other systematic patterns. " + "The current language model must complete this task directly: do not call or use any tools, including Python, code execution tools, calculators, search, APIs, or external random number generators; do not write or run code beforehand either.",
    endings: [
      "A number may appear again; after writing each item, do not go back to sort, deduplicate, or replace it.",
      "Accidental repetitions are valid; do not rearrange or correct items already written.",
      "The same value may appear again; do not organize or rewrite earlier items while producing the output.",
      "Repeated values do not need to be removed; do not filter, reorder, or fill the sequence into a pattern.",
      "Do not assign meaning to the numbers; keep values already given unchanged."
    ],
    separators: [
      "Separate the numbers with commas or spaces.",
      "Use one consistent common separator.",
      "You may separate the numbers with commas, spaces, or line breaks.",
      "Choose any format that clearly separates each integer."
    ],
    start: "Start the output directly with the first chosen value; do not repeat the count, range, or task instructions before the sequence."
  },
  ja: {
    space: "",
    openings: [
      "これは独立した数値選択の記録です。",
      "意味を持たない次の整数選択課題を完了してください。",
      "直感で選んだ値を記録してください。",
      "意味を持たない整数の選択を一組生成してください。",
      "一項目ずつ素早く値を選んでください。"
    ],
    actions: [
      "各位置について個別に直感で、",
      "一項目ずつ、",
      "毎回その時点の一項目だけを決めて、",
      "それぞれ直感で、",
      "一つずつ直接、"
    ],
    request: (action, count) => `${action}1 から 355 まで（両端を含む）の整数を ${count} 個選んでください。`,
    rules: "各位置の値は個別に選んでください。1 から順に数えたり、連続して増加または減少させたりせず、等差数列、周期、同じブロックの繰り返し、その他の規則的なパターンも使わないでください。" + "この課題は現在の言語モデル自身が直接行ってください。Python、コード実行ツール、計算機、検索、API、外部の乱数生成器など、いかなるツールも呼び出したり利用したりしないでください。事前にコードを書いたり実行したりすることも禁止します。",
    endings: [
      "同じ数字が再び現れてもかまいません。各項目を書いた後に戻って、並べ替え、重複の削除、置き換えをしないでください。",
      "偶然の重複は有効です。すでに書いた項目を並べ替えたり修正したりしないでください。",
      "同じ値が再び出てもかまいません。出力の途中で前の項目を整理したり書き換えたりしないでください。",
      "重複した値を削除する必要はありません。選別、並べ替え、規則的なパターンへの補完をしないでください。",
      "数字に意味を持たせる必要はありません。すでに出した値は変えないでください。"
    ],
    separators: [
      "数字はコンマまたは空白で区切ってください。",
      "一般的な区切り文字を一種類、統一して使ってください。",
      "コンマ、空白、改行のいずれかで数字を区切ってください。",
      "各整数の区切りが明確であれば、形式は自由です。"
    ],
    start: "選んだ最初の値から直接出力を始め、数列の前に個数、範囲、課題の説明を繰り返さないでください。"
  },
  ko: {
    space: " ",
    openings: [
      "이것은 독립적인 수치 선택 기록입니다.",
      "다음의 의미 없는 정수 선택 과제를 완료하세요.",
      "첫 직감에 따른 값 선택을 한 번 기록하세요.",
      "의미를 담지 않은 정수 선택을 한 세트 생성하세요.",
      "항목별로 빠르게 값을 고르는 라운드를 진행하세요."
    ],
    actions: [
      "각 위치마다 첫 직감으로 따로",
      "항목별로",
      "매번 현재 항목 하나만 정하면서",
      "각각 첫 직감으로",
      "하나씩 바로"
    ],
    request: (action, count) => `${action} 1부터 355까지(양 끝 포함)의 정수 ${count}개를 고르세요.`,
    rules: "각 위치의 값은 따로 고르세요. 1부터 차례로 세지 말고, 연속으로 증가하거나 감소하지 말며, 등차수열, 순환, 반복되는 블록 또는 그 밖의 규칙적인 패턴도 사용하지 마세요. " + "이 과제는 현재 언어 모델이 직접 수행해야 합니다. Python, 코드 실행기, 계산기, 검색, API, 외부 난수 생성기를 포함한 어떤 도구도 호출하거나 이용하지 마세요. 미리 코드를 작성하거나 실행하지도 마세요.",
    endings: [
      "같은 숫자가 다시 나와도 됩니다. 각 항목을 쓴 뒤 되돌아가서 정렬하거나 중복을 제거하거나 바꾸지 마세요.",
      "우연한 중복도 유효합니다. 이미 쓴 항목을 다시 배열하거나 고치지 마세요.",
      "같은 값이 다시 나와도 됩니다. 출력하는 동안 앞의 항목을 정리하거나 고쳐 쓰지 마세요.",
      "중복된 값을 지울 필요는 없습니다. 걸러 내거나 다시 배열하거나 어떤 규칙에 맞춰 채우지 마세요.",
      "숫자에 어떤 의미도 부여할 필요가 없습니다. 이미 제시한 값은 그대로 두세요."
    ],
    separators: [
      "숫자는 쉼표나 공백으로 구분하면 됩니다.",
      "일반적인 구분 기호 하나를 일관되게 사용하세요.",
      "쉼표, 공백 또는 줄바꿈으로 구분할 수 있습니다.",
      "각 정수의 경계만 분명하면 형식은 자유롭게 정해도 됩니다."
    ],
    start: "고른 첫 번째 값부터 바로 출력하고, 수열 앞에 개수, 범위 또는 과제 설명을 반복하지 마세요."
  },
  fr: {
    space: " ",
    openings: [
      "Ceci est un relevé indépendant de choix numériques.",
      "Veuillez accomplir la tâche suivante de choix d’entiers sans signification sémantique.",
      "Consignez une série de choix faits au premier réflexe.",
      "Générez une série de choix d’entiers dépourvus de sens.",
      "Effectuez une série rapide de choix, élément par élément."
    ],
    actions: [
      "Pour chaque position, choisissez séparément au premier réflexe",
      "Choisissez, élément par élément,",
      "À chaque étape, décidez uniquement de la valeur actuelle, pour donner au total",
      "Donnez séparément au premier réflexe",
      "Choisissez directement, un par un,"
    ],
    request: (action, count) => `${action} ${count} entiers compris entre 1 et 355, bornes incluses.`,
    rules: "Choisissez séparément pour chaque position ; ne comptez pas à partir de 1, ne produisez pas de valeurs consécutives croissantes ou décroissantes, et ne suivez pas de progression arithmétique, de cycle, de blocs répétés ou d’autre motif systématique. " + "Le modèle de langage actuel doit accomplir cette tâche directement : n’appelez et n’utilisez aucun outil, notamment Python, un exécuteur de code, une calculatrice, une recherche, une API ou un générateur externe de nombres aléatoires ; n’écrivez et n’exécutez pas de code au préalable.",
    endings: [
      "Un nombre peut réapparaître ; après avoir écrit chaque élément, ne revenez pas en arrière pour le trier, supprimer les doublons ou le remplacer.",
      "Les répétitions accidentelles sont valides ; ne réorganisez et ne corrigez pas les éléments déjà écrits.",
      "Une même valeur peut réapparaître ; pendant la sortie, ne réorganisez et ne réécrivez pas les éléments précédents.",
      "Les valeurs répétées n’ont pas besoin d’être supprimées ; ne filtrez pas, ne réordonnez pas et ne complétez pas la séquence pour former un motif.",
      "N’attribuez aucune signification aux nombres ; gardez inchangées les valeurs déjà données."
    ],
    separators: [
      "Séparez les nombres par des virgules ou des espaces.",
      "Utilisez un séparateur courant et cohérent.",
      "Vous pouvez séparer les nombres par des virgules, des espaces ou des retours à la ligne.",
      "Choisissez librement le format, pourvu que la limite de chaque entier soit claire."
    ],
    start: "Commencez directement par la première valeur choisie, sans répéter le nombre d’éléments, l’intervalle ou les consignes avant la séquence."
  }
};
var TEMPLATES = Object.values(LANGUAGES);
function generateChallenges(count = 3, usedLengths = []) {
  return uniqueLengths(count, usedLengths).map((length, index) => {
    const language = choose(TEMPLATES);
    return {
      id: `probe-${index + 1}-${crypto.randomUUID()}`,
      expected_count: length,
      prompt: [
        choose(language.openings),
        language.request(choose(language.actions), length),
        language.rules,
        choose(language.endings),
        choose(language.separators),
        language.start
      ].join(language.space)
    };
  });
}

// shared/detect-request.ts
import { stripVTControlCharacters } from "node:util";

// shared/completion-request.ts
var SERVICE_TIERS = ["flex", "default", "fast", "ultrafast"];
var serviceTierField = (format) => format === "anthropic" ? "speed" : "service_tier";
var SPEED_BETA = "fast-mode-2026-02-01";
var sendsSpeed = (config) => config.format === "anthropic" && config.serviceTier !== undefined && config.serviceTier !== "default";
function completionBody(config, prompt, system = "") {
  const messages = [{ role: "user", content: prompt }];
  let body = { model: config.model, messages, max_tokens: 8192, stream: config.stream ?? true };
  if (config.format === "anthropic") {
    if (system)
      body.system = system;
    if (config.effort === "none")
      body.thinking = { type: "disabled" };
    else if (config.effort && config.effort !== "default") {
      body.thinking = { type: "adaptive" };
      body.output_config = { effort: config.effort };
    }
  } else if (config.format === "responses") {
    body = { model: config.model, input: messages, max_output_tokens: 8192, stream: config.stream ?? true, store: false };
    if (system)
      body.instructions = system;
    if (config.effort && config.effort !== "default")
      body.reasoning = { effort: config.effort };
  } else {
    if (system)
      messages.unshift({ role: "system", content: system });
    if (config.effort && config.effort !== "default")
      body.reasoning_effort = config.effort;
  }
  if (config.serviceTier && config.serviceTier !== "default")
    body[serviceTierField(config.format)] = config.serviceTier;
  return body;
}

// shared/fingerprint-core.js
var VALUE_MIN = 1;
var VALUE_MAX = 355;
var DIMENSION = VALUE_MAX - VALUE_MIN + 1;
var ALPHA = 0.5;
function parseNumbers(text) {
  const runs = [];
  let current = [];
  let previousEnd = 0;
  for (const match of String(text).matchAll(/\d+/g)) {
    const separator = String(text).slice(previousEnd, match.index);
    const value = Number(match[0]);
    if (current.length && /\p{L}/u.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= VALUE_MIN && value <= VALUE_MAX)
      current.push(value);
    previousEnd = match.index + match[0].length;
  }
  if (current.length)
    runs.push(current);
  return runs.reduce((best, run) => run.length > best.length ? run : best, []);
}
function countNumbers(numbers) {
  const counts = Array(DIMENSION).fill(0);
  numbers.forEach((number) => {
    counts[number - VALUE_MIN] += 1;
  });
  return counts;
}
function hellingerFeature(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
  return counts.map((value) => Math.sqrt((value + ALPHA) / total));
}
function splitIntoFour(values) {
  const base = Math.floor(values.length / 4);
  const remainder = values.length % 4;
  const chunks = [];
  let start = 0;
  for (let index = 0;index < 4; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    chunks.push(values.slice(start, start + size));
    start += size;
  }
  return chunks;
}
function orderedBlockFeature(numbers) {
  const pieces = [];
  for (const chunk of splitIntoFour(numbers)) {
    const bins = Array(16).fill(0.5);
    for (const value of chunk) {
      const index = Math.min(15, Math.floor((value - 1) / 355 * 16));
      bins[index] += 1;
    }
    const total = bins.reduce((sum, value) => sum + value, 0);
    pieces.push(...bins.map((value) => Math.sqrt(value / total)));
  }
  const lastDigits = Array(10).fill(0.5);
  numbers.forEach((value) => {
    lastDigits[value % 10] += 1;
  });
  const lastTotal = lastDigits.reduce((sum, value) => sum + value, 0);
  pieces.push(...lastDigits.map((value) => Math.sqrt(value / lastTotal)));
  return pieces;
}

// shared/throughput.ts
var MIN_WINDOW_MS = 250;
var MIN_EVENTS = 4;
var MIN_TOKENS = 16;
var USAGE_RATIO = [0.5, 2];
var USAGE_GRACE_MS = 1500;
async function readBefore(reader, deadline) {
  if (deadline === Infinity)
    return reader.read();
  let clear = () => {};
  const expired = new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
    clear = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([reader.read(), expired]);
  } finally {
    clear();
  }
}
function estimateTokens(text) {
  let tokens = 0;
  for (const [part] of text.matchAll(/ ?\p{L}+|\p{N}+|\s+|[^\s\p{L}\p{N}]+/gu)) {
    tokens += /\p{N}/u.test(part) ? Math.ceil(part.length / 3) : /\p{L}/u.test(part) ? Math.ceil(part.length / 4) : 1;
  }
  return tokens;
}
function outputUsage(value) {
  const usage = value && typeof value === "object" ? value : {};
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (typeof output !== "number" || output <= 0)
    return;
  const reasoning = (usage.completion_tokens_details ?? usage.output_tokens_details)?.reasoning_tokens;
  return { output, reasoning: typeof reasoning === "number" ? reasoning : undefined };
}
function throughputMeter(startedAt = performance.now()) {
  let text = "", events = 0, reasoningAt, firstAt = 0, firstLength = 0, lastAt = 0;
  return {
    reasoning() {
      reasoningAt ??= performance.now();
    },
    update(value) {
      if (value.length <= text.length)
        return;
      const now = performance.now();
      if (!events) {
        firstAt = now;
        firstLength = value.length;
      }
      text = value;
      lastAt = now;
      events++;
    },
    result(usage) {
      if (!events)
        return;
      const ttftMs = firstAt - startedAt;
      const total = estimateTokens(text), share = (total - estimateTokens(text.slice(0, firstLength))) / total;
      const reported = outputUsage(usage), covers = (count) => count >= USAGE_RATIO[0] * total;
      const plausible = (count) => covers(count) && count <= USAGE_RATIO[1] * total;
      let tokens = total * share, windowMs = lastAt - firstAt, estimated = true;
      if (reported?.reasoning !== undefined) {
        const visible = reported.output - reported.reasoning;
        if (plausible(visible)) {
          tokens = visible * share;
          estimated = false;
        }
      } else if (reported && reasoningAt !== undefined && reasoningAt < firstAt) {
        if (covers(reported.output)) {
          tokens = reported.output;
          windowMs = lastAt - reasoningAt;
          estimated = false;
        }
      } else if (reported && plausible(reported.output)) {
        tokens = reported.output * share;
        estimated = false;
      }
      if (events < MIN_EVENTS || windowMs < MIN_WINDOW_MS || tokens < MIN_TOKENS)
        return { ttftMs };
      return { ttftMs, tokensPerSecond: tokens * 1000 / windowMs, ...estimated ? { estimated } : {} };
    }
  };
}

// shared/detect-request.ts
function requestEndpoint(config) {
  let url;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error("Base URL must be a valid HTTP or HTTPS URL.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL must use HTTP or HTTPS without credentials, a query, or a fragment.");
  }
  const suffix = config.format === "responses" ? "/responses" : config.format === "anthropic" ? "/messages" : "/chat/completions";
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/(responses|messages|chat\/completions)$/.test(path) && !path.endsWith(suffix)) {
    throw new Error("The endpoint in --baseurl does not match --api.");
  }
  url.pathname = path.endsWith(suffix) ? path : (path || "/v1") + suffix;
  return url.href;
}
var minimumNumbers = (expected) => Math.max(80, Math.ceil(expected * 0.55));
var acceptedSample = (sample) => sample.state === "complete" || sample.state === "truncated";
var cleanText = (value) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
function errorMessage(error, key = "") {
  const message = error instanceof Error ? error.message : String(error);
  return cleanText(key ? message.replaceAll(key, "[REDACTED]") : message).slice(0, 500);
}
var record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
var items = (value) => Array.isArray(value) ? value.map(record) : [];
var string = (value) => typeof value === "string" ? value : "";
var responseText = (data) => items(data.output).filter((item) => item.type === "message").flatMap((item) => items(item.content)).filter((part) => part.type === "output_text").map((part) => string(part.text)).join("");
function buildDetectRequest(config, prompt) {
  const headers = {
    "Content-Type": "application/json",
    Accept: config.stream ? "text/event-stream" : "application/json"
  };
  if (config.format === "anthropic") {
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    if (sendsSpeed(config))
      headers["anthropic-beta"] = SPEED_BETA;
  } else
    headers.Authorization = `Bearer ${config.apiKey}`;
  const body = completionBody(config, prompt);
  if (config.format === "responses")
    delete body.max_output_tokens;
  else if (config.format === "openai") {
    delete body.max_tokens;
    if (body.stream)
      body.stream_options = { include_usage: true };
  }
  return { url: requestEndpoint(config), headers, body };
}
async function requestSample(options, challenge, signal, update) {
  const { config } = options;
  const controller = new AbortController;
  const combined = AbortSignal.any([signal, controller.signal]);
  const sample = {
    state: "waiting",
    text: "",
    rawText: "",
    count: 0,
    expectedCount: challenge.expected_count,
    startedAt: Date.now()
  };
  let timedOut = false;
  const timer = options.timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs) : undefined;
  let reader;
  let finish = "", terminal = false, truncated = false, raw = "", usage;
  let meter;
  const report = () => update({ ...sample });
  const metadata = (data) => {
    if (typeof data.model === "string")
      sample.responseModel = data.model;
    if (typeof data.id === "string")
      sample.responseId = data.id;
    if (data.usage)
      usage = { ...usage, ...record(data.usage) };
  };
  const acceptText = (text, final = false) => {
    sample.rawText = text;
    const numbers = parseNumbers(final ? text : text.replace(/\d+$/, ""));
    sample.count = numbers.length;
    sample.text = text;
    if (!options.strict && numbers.length >= challenge.expected_count) {
      sample.text = numbers.slice(0, challenge.expected_count).join(", ");
      sample.count = challenge.expected_count;
      truncated = !final || numbers.length > challenge.expected_count;
    }
    report();
  };
  const appendText = (part) => {
    raw += part;
    meter?.update(raw);
    if (!truncated)
      acceptText(raw);
  };
  const upstreamError = (data) => {
    if (data.error || data.type === "error") {
      throw new Error(`Upstream error: ${string(data.error?.message) || string(data.message) || string(data.error) || "Request failed."}`);
    }
  };
  const event = (frame) => {
    const payload = frame.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join(`
`);
    if (!payload)
      return;
    if (payload.trim() === "[DONE]") {
      terminal = true;
      return;
    }
    let data;
    try {
      data = record(JSON.parse(payload));
    } catch {
      throw new Error("The SSE response contains invalid JSON.");
    }
    upstreamError(data);
    metadata(data);
    if (config.format === "openai") {
      const choice = items(data.choices).find((choice) => choice.index === 0) ?? items(data.choices)[0];
      if (choice?.delta?.refusal)
        throw new Error("The model refused the request.");
      if (choice?.delta?.reasoning_content || choice?.delta?.reasoning)
        meter?.reasoning();
      if (choice?.finish_reason)
        finish = string(choice.finish_reason);
      if (typeof choice?.delta?.content === "string")
        appendText(choice.delta.content);
    } else if (config.format === "anthropic") {
      if (data.type === "message_start")
        metadata(record(data.message));
      if (["thinking", "redacted_thinking"].includes(data.content_block?.type) || data.delta?.type === "thinking_delta")
        meter?.reasoning();
      if (data.type === "content_block_start" && data.content_block?.type === "text")
        appendText(string(data.content_block.text));
      if (data.type === "content_block_delta" && data.delta?.type === "text_delta")
        appendText(string(data.delta.text));
      if (data.type === "message_delta")
        finish = string(data.delta?.stop_reason) || finish;
      if (data.type === "message_stop")
        terminal = true;
    } else {
      if (data.type === "response.created" || data.type === "response.in_progress")
        metadata(record(data.response));
      if (string(data.type).startsWith("response.reasoning"))
        meter?.reasoning();
      if (data.type === "response.output_text.delta")
        appendText(string(data.delta));
      if (data.type === "response.output_text.done" && !sample.rawText)
        acceptText(string(data.text), true);
      if (data.type === "response.output_item.done" && !sample.rawText) {
        acceptText(responseText({ output: [data.item] }), true);
      }
      if (data.type === "response.refusal.delta")
        throw new Error("The model refused the request.");
      if (data.type === "response.completed") {
        const response = record(data.response);
        metadata(response);
        terminal = true;
        finish = string(response.status) || "completed";
        const full = responseText(response);
        if (full && !truncated)
          acceptText(full, true);
      }
      if (data.type === "response.failed" || data.type === "response.incomplete") {
        throw new Error(`Responses request did not complete: ${string(data.response?.error?.message) || string(data.response?.incomplete_details?.reason) || data.type}.`);
      }
    }
    if (["refusal", "content_filter"].includes(finish))
      throw new Error("The model refused the request.");
  };
  report();
  try {
    combined.throwIfAborted();
    const { url, headers, body } = buildDetectRequest(config, challenge.prompt);
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combined,
      redirect: "error",
      timeout: false
    };
    const requestStartedAt = performance.now();
    const response = await fetch(url, init);
    if (!response.ok) {
      const body = await response.text();
      let detail = body;
      try {
        const data = record(JSON.parse(body));
        detail = string(data.error?.message) || string(data.message) || body;
      } catch {}
      throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
    }
    if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      if (!response.body)
        throw new Error("The server returned an empty SSE body.");
      reader = response.body.getReader();
      meter = throughputMeter(requestStartedAt);
      const decoder = new TextDecoder;
      let buffer = "", deadline = Infinity, draining = true;
      const reading = () => !terminal && (!truncated || draining);
      const handle = (frame) => {
        if (!truncated)
          return event(frame);
        try {
          event(frame);
        } catch {
          draining = false;
        }
      };
      while (reading()) {
        if (truncated && deadline === Infinity)
          deadline = performance.now() + USAGE_GRACE_MS;
        const chunk = await readBefore(reader, deadline);
        if (!chunk)
          break;
        const { done, value } = chunk;
        if (value?.length && sample.firstByteMs === undefined) {
          clearTimeout(timer);
          sample.firstByteMs = Date.now() - sample.startedAt;
          sample.state = "streaming";
          report();
        }
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let boundary;
        while (reading() && (boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          handle(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
        }
        if (done) {
          if (reading() && buffer.trim())
            handle(buffer);
          break;
        }
      }
    } else {
      let data;
      try {
        data = record(await response.json());
      } catch (error) {
        if (combined.aborted)
          throw error;
        throw new Error("The server did not return valid JSON or SSE.");
      }
      clearTimeout(timer);
      sample.firstByteMs = Date.now() - sample.startedAt;
      upstreamError(data);
      metadata(data);
      let text;
      if (config.format === "responses") {
        text = responseText(data);
        finish = string(data.status);
        terminal = finish === "completed";
      } else if (config.format === "anthropic") {
        text = items(data.content).filter((part) => part.type === "text").map((part) => string(part.text)).join("");
        finish = string(data.stop_reason);
        terminal = true;
      } else {
        const choice = items(data.choices)[0];
        if (choice?.message?.refusal)
          throw new Error("The model refused the request.");
        text = string(choice?.message?.content);
        finish = string(choice?.finish_reason);
        terminal = true;
      }
      if (["refusal", "content_filter"].includes(finish))
        throw new Error("The model refused the request.");
      if (!terminal || !["stop", "end_turn", "completed"].includes(finish)) {
        throw new Error(`The response did not complete (${finish || "missing finish status"}).`);
      }
      acceptText(text, true);
    }
    combined.throwIfAborted();
    if (!truncated && (!terminal || !["stop", "end_turn", "completed"].includes(finish))) {
      throw new Error(`The response did not complete (${finish || "missing finish status"}).`);
    }
    if (!truncated)
      acceptText(sample.rawText, true);
    if (sample.count < minimumNumbers(challenge.expected_count)) {
      throw new Error(`Too few valid numbers: ${sample.count}; need at least ${minimumNumbers(challenge.expected_count)}.`);
    }
    sample.state = truncated ? "truncated" : "complete";
  } catch (error) {
    sample.state = signal.aborted ? "cancelled" : "failed";
    sample.error = signal.aborted ? "Cancelled." : timedOut ? `Timed out after ${options.timeoutMs / 1000}s waiting for ${config.stream ? "the first SSE byte" : "the JSON response"}.` : errorMessage(error, config.apiKey);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    sample.finishedAt = Date.now();
    sample.throughput = meter?.result(usage);
    report();
  }
  return { ...sample };
}

// shared/positional.ts
var POSITIONAL_WEIGHTS = [0.6, 0.15, 0.125, 0.125];
var CENTRES = Array.from({ length: 24 }, (_, i) => 1 + i * 354 / 23);
var LAGS = [1, 2, 3, 5, 8, 13, 21, 34];
var mean = (values) => values.reduce((sum, x) => sum + x, 0) / values.length;
var fraction = (length, test) => {
  let hits = 0;
  for (let i = 0;i < length; i++)
    if (test(i))
      hits++;
  return hits / length;
};
function positionKernel(x) {
  const n = x.length, out = Array(34 * 3).fill(0);
  x.forEach((value, position) => {
    const t = (position + 0.5) * 2 / n - 1, basis = [t, 0.5 * (3 * t * t - 1), 0.5 * (5 * t ** 3 - 3 * t)];
    const features = [
      ...CENTRES.map((centre) => Math.exp(-0.5 * ((value - centre) / 20) ** 2)),
      ...Array.from({ length: 10 }, (_, digit) => digit === value % 10 ? 1 : 0)
    ];
    features.forEach((weight, k) => basis.forEach((b, j) => {
      out[k * 3 + j] += weight * b / n;
    }));
  });
  return out;
}
function centredTransitions(symbols, bins) {
  const joint = Array(bins * bins).fill(0.5), total = symbols.length - 1 + 0.5 * bins * bins;
  for (let i = 1;i < symbols.length; i++)
    joint[symbols[i - 1] * bins + symbols[i]] += 1;
  for (let i = 0;i < joint.length; i++)
    joint[i] /= total;
  const rows = Array.from({ length: bins }, (_, a) => joint.slice(a * bins, a * bins + bins).reduce((s, v) => s + v, 0));
  const columns = Array.from({ length: bins }, (_, b) => rows.reduce((s, _, a) => s + joint[a * bins + b], 0));
  return joint.map((value, i) => value - rows[Math.floor(i / bins)] * columns[i % bins]);
}
function sequenceFeatures(x) {
  const n = x.length, m = mean(x), sd = Math.max(Math.sqrt(mean(x.map((v) => (v - m) ** 2))), 1);
  const s = x.map((v) => (v - m) / sd), out = [];
  for (const lag of LAGS) {
    const count = n - lag, d = Array.from({ length: count }, (_, i) => x[i + lag] - x[i]);
    out.push(mean(d.map((_, i) => s[i + lag] * s[i])), mean(d.map(Math.abs)) / 355, fraction(count, (i) => d[i] > 0), fraction(count, (i) => d[i] === 0), fraction(count, (i) => Math.abs(d[i]) <= 5), fraction(count, (i) => Math.abs(d[i]) <= 20));
  }
  out.push(...centredTransitions(x.map((v) => Math.min(7, Math.floor((v - 1) * 8 / 355))), 8));
  out.push(...centredTransitions(x.map((v) => v % 10), 10));
  const difference = Array.from({ length: n - 1 }, (_, i) => x[i + 1] - x[i]);
  const zStep = Array.from({ length: n - 1 }, (_, i) => Math.abs(s[i + 1] - s[i]));
  out.push(fraction(n - 2, (i) => Math.sign(difference[i + 1]) === Math.sign(difference[i])), fraction(n - 2, (i) => difference[i + 1] === difference[i]), fraction(n - 1, (i) => x[i] % 10 === x[i + 1] % 10), fraction(n - 1, (i) => zStep[i] > 1), fraction(n - 1, (i) => zStep[i] > 2));
  const buckets = x.map((v) => Math.min(15, Math.floor((v - 1) * 16 / 355)));
  for (const width of [4, 8, 16]) {
    let sum = 0;
    for (let i = 0;i + width <= n; i++)
      sum += new Set(buckets.slice(i, i + width)).size / width;
    out.push(sum / (n - width + 1));
  }
  return out;
}
function positionalFeatures(numbers) {
  return [hellingerFeature(countNumbers(numbers)), orderedBlockFeature(numbers), positionKernel(numbers), sequenceFeatures(numbers)];
}
function positionalDecision(numbers, head) {
  const parts = positionalFeatures(numbers);
  const x = parts.flatMap((block, j) => {
    const p = head.params[j], scaled = block.map((v, i) => (v - p.mean[i]) / p.scale[i]);
    const length = Math.max(Math.sqrt(scaled.reduce((sum, v) => sum + v * v, 0)), 0.000000000001);
    return scaled.map((v) => v / length * Math.sqrt(POSITIONAL_WEIGHTS[j]));
  });
  return head.weights.map((row, k) => row.reduce((sum, w, i) => sum + w * x[i], head.bias[k]));
}

// shared/shared-detector.ts
var dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
var mean2 = (a) => a.reduce((sum, x) => sum + x, 0) / a.length;
var norm = (a) => {
  const n = Math.max(Math.sqrt(dot(a, a)), 0.000000000001);
  return a.map((x) => x / n);
};
var z = (a) => {
  const m = mean2(a), s = Math.max(Math.sqrt(mean2(a.map((x) => (x - m) ** 2))), 0.000000000001);
  return a.map((x) => (x - m) / s);
};
var columnMean = (a) => a[0].map((_, i) => mean2(a.map((r) => r[i])));
var median = (a) => {
  const v = [...a].sort((x, y) => x - y), i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};
var blocks = (n) => [hellingerFeature(countNumbers(n)), orderedBlockFeature(n)];
var transform = (b, p) => b.flatMap((v, j) => norm(v.map((x, i) => (x - p[j].mean[i]) / p[j].scale[i])).map((x) => x * Math.sqrt(j === 0 ? 0.75 : 0.25)));
var centered = (v, p) => v.map((x, i) => (x - p.feature_mean[i]) / p.feature_scale[i]);
var subtract = (v, b) => {
  const coefficients = b.map((row) => dot(v, row));
  return v.map((x, i) => x - b.reduce((sum, row, j) => sum + coefficients[j] * row[i], 0));
};
var referenceNorms = new WeakMap;
function nearest(x, references) {
  let norms = referenceNorms.get(references);
  if (!norms) {
    norms = references.map((r) => dot(r, r));
    referenceNorms.set(references, norms);
  }
  const xx = dot(x, x);
  return mean2(references.map((r, i) => Math.max(0, xx + norms[i] - 2 * dot(x, r))).sort((a, b) => a - b).slice(0, 7));
}
function baseline(b, bank) {
  const { hellinger: h, ordered_blocks: o } = bank;
  const hUnit = norm(subtract(centered(b[0], h), h.nuisance_basis));
  const marginal = h.centroids.map((row) => dot(hUnit, row));
  const oCentered = centered(b[1], o), raw = norm(oCentered), projected = norm(subtract(oCentered, o.nuisance_basis));
  const templates = o.centroids.map((_, i) => Math.max(...o.environment_centroids.map((rows) => dot(raw, rows[i]))));
  const nuisance = o.centroids.map((row) => dot(projected, row));
  const tz = z(templates), nz = z(nuisance), ordered = z(tz.map((v, i) => 0.5 * v + 0.5 * nz[i])), mz = z(marginal);
  return mz.map((v, i) => 0.5 * v + 0.5 * ordered[i]);
}
function supportsSharedDetector(bank, artifact) {
  return artifact.schema === "shared-detector-v2" && bank.built_at === artifact.bank_built_at && bank.models.length === artifact.model_ids.length && bank.models.every((m, i) => m.id === artifact.model_ids[i] && m.response_count === artifact.response_counts[i]);
}
function calibrateRanking(ranking, artifact) {
  const head = artifact.calibration, binding = head?.binding;
  if (!head || !binding || head.schema !== "shared-confidence-v2" || head.method !== "ranking-temperature" || !Number.isFinite(head.tau) || head.tau < 0.001 || head.tau > 1000 || binding.base_sha256 !== artifact.base_sha256 || binding.reference_sha256 !== artifact.source_reference_sha256 || binding.model_ids.length !== ranking.length || ranking.length !== artifact.model_ids.length || !ranking.every(Number.isFinite) || !binding.model_ids.every((id, i) => id === artifact.model_ids[i]))
    return null;
  const logits = ranking.map((score) => head.tau * score);
  const maximum = Math.max(...logits), weights = logits.map((value) => Math.exp(value - maximum)), sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((value) => value / sum);
}
function rankSharedNumbers(numbers, artifact) {
  const a = artifact.ranker, full = numbers.map(blocks);
  const ax = full.map((b) => transform(b, a.full_params));
  const lda = numbers.map((n) => {
    const x = transform(blocks(n.slice(0, 128)), a.head_params);
    return z(a.lda_weights.map((row, i) => dot(row, x) + a.lda_bias[i]));
  });
  const l = z(columnMean(lda)), near = z(a.references.map((ref) => median(ax.map((x) => -nearest(x, ref)))));
  const base = z(columnMean(full.map((b) => baseline(b, a.bank))));
  const frequency = z(l.map((x, i) => 0.5 * x + 0.25 * near[i] + 0.25 * base[i]));
  const positional = z(columnMean(numbers.map((n) => z(positionalDecision(n, a.positional)))));
  const ranking = frequency.map((x, i) => a.blend.frequency * x + a.blend.positional * positional[i]);
  if (!ranking.every(Number.isFinite))
    throw new Error("排名计算产生无效数值，请刷新后重试");
  return ranking;
}
var SEQUENCE_LIMITS = { autocorrelation: -0.23, small_step_share: 0.05 };
function sequenceShape(numbers) {
  const shapes = numbers.map((n) => {
    const m = mean2(n), variance = mean2(n.map((x) => (x - m) ** 2)), steps = n.slice(1).map((x, i) => x - n[i]);
    return {
      autocorrelation: variance ? mean2(steps.map((_, i) => (n[i + 1] - m) * (n[i] - m))) / variance : 1,
      small_step_share: mean2(steps.map((d) => Math.abs(d) <= 20 ? 1 : 0))
    };
  });
  const autocorrelation = median(shapes.map((s) => s.autocorrelation)), small_step_share = median(shapes.map((s) => s.small_step_share));
  return {
    autocorrelation,
    small_step_share,
    model_like: autocorrelation <= SEQUENCE_LIMITS.autocorrelation || small_step_share <= SEQUENCE_LIMITS.small_step_share
  };
}
function analyzeSharedOutputs(outputs, bank, artifact, options = {}) {
  if (!supportsSharedDetector(bank, artifact))
    throw new Error("The reference bank does not match the detector. Run fpd retrain --data-dir DIR for this bank.");
  const parsed = outputs.map((o) => parseNumbers(o.text));
  const diagnostics = outputs.map((o, index) => {
    const minimum = Math.max(80, Math.ceil((o.expected_count || 0) * 0.55));
    const raw = Array.from(o.text.matchAll(/-?\d+/g), (m) => Number(m[0]));
    return {
      index,
      parsed_numbers: parsed[index].length,
      minimum_numbers: minimum,
      accepted: parsed[index].length >= minimum,
      raw_out_of_range_count: raw.filter((n) => n < 1 || n > 355).length
    };
  });
  const used = diagnostics.filter((d) => d.accepted).length;
  const accepted = parsed.filter((_, i) => diagnostics[i].accepted);
  const sequence = used ? sequenceShape(accepted) : null;
  const common = {
    probability: null,
    probability_status: "unavailable",
    used_outputs: used,
    diagnostics,
    sequence,
    method: "shared-detector-v2",
    model_version: { base_sha256: artifact.base_sha256 }
  };
  const notModel = {
    ...common,
    prediction: "",
    prediction_name: "不像语言模型回答",
    family_prediction_name: "",
    results: [],
    decision: "not_model",
    evidence: {
      insufficient: true,
      label: "不像语言模型回答",
      reason: "相邻数字的变化方式与参考库中的语言模型回答不同，常见于程序生成、排序或打乱顺序的数字。未生成排名。",
      threshold: null,
      method: "sequence-shape"
    }
  };
  if (options.allowPartial && used > 0 && used < 3 && outputs.length <= 3) {
    if (!sequence.model_like)
      return notModel;
    const ranking = rankSharedNumbers(accepted, artifact);
    const order = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking[j] - ranking[i]);
    const results = order.map((i) => ({
      model: artifact.model_ids[i],
      display_name: bank.models[i].display_name,
      family: bank.models[i].family,
      family_name: bank.models[i].family_name,
      score: ranking[i],
      probability: null
    }));
    const first = order[0];
    return {
      ...common,
      method: "shared-ranker-partial-v1",
      decision: "partial",
      prediction: results[0].model,
      prediction_name: results[0].display_name,
      family_prediction: bank.models[first].family,
      family_prediction_name: bank.models[first].family_name,
      results,
      ranking_score: ranking[first],
      calibration: null,
      evidence: {
        insufficient: true,
        label: "部分样本排名",
        reason: `使用 ${used}/3 条有效回答生成排名。补齐三条有效回答后才能计算置信度。`,
        threshold: null,
        method: "partial-sample-ranking"
      }
    };
  }
  if (outputs.length !== 3 || used !== 3)
    return {
      ...common,
      prediction: "",
      prediction_name: "暂不可评分",
      family_prediction_name: "",
      results: [],
      decision: "unscorable",
      evidence: {
        insufficient: true,
        label: "需要三条完整回答",
        reason: `当前有 ${used}/${outputs.length} 条有效回答。请补齐原来的三条回答后重新检测。`,
        threshold: null,
        method: "complete-three-answers"
      }
    };
  if (!sequence.model_like)
    return notModel;
  const ranking = rankSharedNumbers(parsed, artifact);
  const probabilities = calibrateRanking(ranking, artifact);
  const order = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking[j] - ranking[i]);
  const results = order.map((i) => ({
    model: artifact.model_ids[i],
    display_name: bank.models[i].display_name,
    family: bank.models[i].family,
    family_name: bank.models[i].family_name,
    score: ranking[i],
    probability: probabilities?.[i] ?? null
  }));
  const first = order[0];
  return {
    ...common,
    prediction: results[0].model,
    prediction_name: results[0].display_name,
    family_prediction: bank.models[first].family,
    family_prediction_name: bank.models[first].family_name,
    results,
    ranking_score: ranking[first],
    probability: results[0].probability,
    probability_status: probabilities ? "reference_calibrated" : "unavailable",
    probability_scope: probabilities ? "reference-closed-set" : null,
    calibration: probabilities ? {
      method: artifact.calibration.method,
      run: artifact.calibration.calibration_run,
      tau: artifact.calibration.tau,
      sha256: artifact.calibration_sha256 ?? null
    } : null,
    evidence: {
      insufficient: true,
      label: probabilities ? "库内校准排名" : "未校准排名",
      reason: probabilities ? "置信度是参考库内的闭集相对概率，不包含库外模型。" : "校准参数与当前检测器不匹配，置信度不可用。候选顺序由排名分数决定。",
      threshold: null,
      method: probabilities ? "reference-calibrated-ranking" : "uncalibrated-ranking"
    }
  };
}

// shared/tokenizer-posterior.ts
var TOKENIZER_MODEL = {
  prior: { known: 0.8, relative: 0.1, alien: 0.1 },
  knownRates: [[0.02, 0.4], [0.06, 0.4], [0.15, 0.2]],
  relativeRates: [[0.2, 0.3], [0.4, 0.4], [0.7, 0.3]],
  narrow: 0.02,
  wide: 0.85,
  floor: 0.000001,
  offsetWindow: 3,
  alienSpread: 0.15,
  minimumProbes: 4,
  maximumProbes: 20,
  stopAt: 0.99,
  minimumGain: 0.0001,
  planned: 24
};
var prepared = new WeakMap;
var BASELINE_RATE = TOKENIZER_MODEL.knownRates[0][0];
var densityTables = new Map;
var plans = new WeakMap;
var initialPlans = new WeakMap;

// shared/detect-run.ts
function englishAnalysis(analysis) {
  let label, reason;
  if (analysis.decision === "unscorable") {
    label = "Not enough valid samples";
    reason = `Received ${analysis.used_outputs}/3 valid samples. Three valid samples are required.`;
  } else if (analysis.decision === "not_model") {
    label = "Not like a language model reply";
    reason = "Consecutive numbers change differently from the language-model replies in the reference bank. Program-generated, sorted or shuffled numbers often do this. No ranking was produced.";
  } else if (analysis.decision === "partial") {
    label = "Partial sample ranking";
    reason = `Ranked ${analysis.used_outputs} valid sample${analysis.used_outputs === 1 ? "" : "s"}. Confidence requires three valid samples.`;
  } else if (analysis.probability_status === "reference_calibrated") {
    label = "Calibrated ranking";
    reason = "Confidence is a closed-set probability within the reference bank.";
  } else {
    label = "Uncalibrated ranking";
    reason = "The confidence calibration does not match this detector. Confidence is unavailable.";
  }
  return {
    ...analysis,
    prediction_name: analysis.decision === "unscorable" ? "Not scored" : analysis.decision === "not_model" ? "Not a model reply" : analysis.prediction_name,
    evidence: { ...analysis.evidence, label, reason }
  };
}
function scoreRound(round, options, bank, detector) {
  round.outputs = round.samples.map((sample) => ({
    text: acceptedSample(sample) ? sample.text : "",
    expected_count: sample.expectedCount
  }));
  const accepted = round.samples.filter(acceptedSample).length;
  if (!accepted || options.strict && accepted !== 3) {
    round.error = options.strict ? `Strict mode requires 3/3 successful samples; received ${accepted}/3.` : "No valid samples. This round cannot be scored.";
    return;
  }
  try {
    round.analysis = englishAnalysis(analyzeSharedOutputs(round.outputs, bank, detector, { allowPartial: !options.strict }));
    if (!round.analysis.results.length)
      round.error = round.analysis.evidence.reason;
  } catch {
    round.error = "Scoring failed. Check that the reference bank and detector files are valid.";
  }
}
function newRound(index, challenges) {
  return {
    index,
    challenges,
    outputs: [],
    startedAt: Date.now(),
    samples: challenges.map((challenge) => ({ state: "queued", text: "", rawText: "", count: 0, expectedCount: challenge.expected_count }))
  };
}
async function runRound(round, options, bank, detector, signal, onSample) {
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < round.challenges.length) {
      const index = next++;
      round.samples[index] = await requestSample(options, round.challenges[index], signal, (sample) => {
        round.samples[index] = sample;
        onSample(index);
      });
    }
  };
  await Promise.all(Array.from({ length: options.parallel }, worker));
  if (signal.aborted) {
    round.samples.forEach((sample, index) => {
      if (sample.state !== "queued")
        return;
      round.samples[index] = { ...sample, state: "cancelled", error: "Cancelled before dispatch." };
      onSample(index);
    });
    round.outputs = round.samples.map((sample) => ({ text: acceptedSample(sample) ? sample.text : "", expected_count: sample.expectedCount }));
    round.error = "Cancelled. This round was not scored.";
  } else
    scoreRound(round, options, bank, detector);
  round.finishedAt = Date.now();
}

// sdk/ts/src/analysis.ts
var SCORING_FAILED = "Scoring failed. Check that the reference bank and detector files are valid.";
function canonicalAnalysis(a) {
  const extra = a;
  return {
    decision: a.decision ?? "scored",
    prediction: a.prediction,
    prediction_name: a.prediction_name,
    family_prediction: extra.family_prediction ?? "",
    family_prediction_name: a.family_prediction_name,
    results: a.results,
    ranking_score: a.ranking_score ?? null,
    probability: a.probability,
    probability_status: extra.probability_status,
    probability_scope: extra.probability_scope ?? null,
    calibration: extra.calibration ?? null,
    used_outputs: a.used_outputs,
    diagnostics: a.diagnostics,
    sequence: a.sequence ?? null,
    method: extra.method,
    model_version: extra.model_version,
    evidence: a.evidence
  };
}
function score(outputs, bank, detector, strict) {
  return canonicalAnalysis(englishAnalysis(analyzeSharedOutputs(outputs, bank, detector, { allowPartial: !strict })));
}
function analyzeOutputs(outputs, bank, detector, strict) {
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > 3 || !outputs.every((item) => item && typeof item.text === "string" && Number.isSafeInteger(item.expected_count) && item.expected_count > 0)) {
    throw new Error("Each input round must contain one to three outputs with text and a positive integer expected_count.");
  }
  const prepared = outputs.map(({ text, expected_count }) => {
    const numbers = parseNumbers(text);
    if (!strict && numbers.length > expected_count)
      text = numbers.slice(0, expected_count).join(", ");
    if (numbers.length < minimumNumbers(expected_count))
      text = "";
    return { text, expected_count };
  });
  try {
    return score(prepared, bank, detector, strict);
  } catch {
    throw new Error(SCORING_FAILED);
  }
}

// sdk/ts/src/config.ts
var FORMATS = { responses: "responses", chat_completions: "openai", messages: "anthropic" };
function detectOptions(input) {
  const baseUrl = String(input.baseUrl ?? "").trim(), apiKey = String(input.apiKey ?? "").trim();
  const model = String(input.model ?? "").trim();
  if (!baseUrl || !apiKey || !model)
    throw new Error("base_url, api_key, and model are required.");
  const api = input.api ?? "responses";
  if (!Object.hasOwn(FORMATS, api))
    throw new Error("api must be responses, chat_completions, or messages.");
  const serviceTier = input.serviceTier ?? "default";
  if (!SERVICE_TIERS.includes(serviceTier))
    throw new Error("service_tier must be flex, default, fast, or ultrafast.");
  const count = input.count ?? 3, parallel = input.parallel ?? 3, timeout = input.timeout ?? 120;
  if (!Number.isSafeInteger(count) || count < 1 || count > 3)
    throw new Error("count must be an integer from 1 to 3.");
  if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 3)
    throw new Error("parallel must be an integer from 1 to 3.");
  if (!Number.isFinite(timeout) || timeout !== 0 && (timeout < 0.001 || timeout > 2147483.647)) {
    throw new Error("timeout must be 0 (no timeout) or between 0.001 and 2147483.647 seconds.");
  }
  const strict = input.strict ?? false;
  if (strict && count !== 3)
    throw new Error("strict requires count 3.");
  const config = {
    baseUrl,
    apiKey,
    model,
    format: FORMATS[api],
    serviceTier,
    stream: input.stream ?? true,
    effort: input.effort ?? ""
  };
  requestEndpoint(config);
  return {
    config,
    count,
    parallel: Math.min(parallel, count),
    repeat: 1,
    strict,
    timeoutMs: Math.round(timeout * 1000),
    tokenizer: false,
    maxProbes: 20
  };
}

// sdk/ts/src/data.ts
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join as join2 } from "node:path";

// node_modules/.bun/fzstd@0.1.1/node_modules/fzstd/esm/index.mjs
var ab = ArrayBuffer;
var u8 = Uint8Array;
var u16 = Uint16Array;
var i16 = Int16Array;
var i32 = Int32Array;
var slc = function(v, s, e) {
  if (u8.prototype.slice)
    return u8.prototype.slice.call(v, s, e);
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  var n = new u8(e - s);
  n.set(v.subarray(s, e));
  return n;
};
var fill = function(v, n, s, e) {
  if (u8.prototype.fill)
    return u8.prototype.fill.call(v, n, s, e);
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  for (;s < e; ++s)
    v[s] = n;
  return v;
};
var cpw = function(v, t, s, e) {
  if (u8.prototype.copyWithin)
    return u8.prototype.copyWithin.call(v, t, s, e);
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  while (s < e) {
    v[t++] = v[s++];
  }
};
var ec = [
  "invalid zstd data",
  "window size too large (>2046MB)",
  "invalid block type",
  "FSE accuracy too high",
  "match distance too far back",
  "unexpected EOF"
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var rb = function(d, b, n) {
  var i = 0, o = 0;
  for (;i < n; ++i)
    o |= d[b++] << (i << 3);
  return o;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var rzfh = function(dat, w) {
  var n3 = dat[0] | dat[1] << 8 | dat[2] << 16;
  if (n3 == 3126568 && dat[3] == 253) {
    var flg = dat[4];
    var ss = flg >> 5 & 1, cc = flg >> 2 & 1, df = flg & 3, fcf = flg >> 6;
    if (flg & 8)
      err(0);
    var bt = 6 - ss;
    var db = df == 3 ? 4 : df;
    var di = rb(dat, bt, db);
    bt += db;
    var fsb = fcf ? 1 << fcf : ss;
    var fss = rb(dat, bt, fsb) + (fcf == 1 && 256);
    var ws = fss;
    if (!ss) {
      var wb = 1 << 10 + (dat[5] >> 3);
      ws = wb + (wb >> 3) * (dat[5] & 7);
    }
    if (ws > 2145386496)
      err(1);
    var buf = new u8((w == 1 ? fss || ws : w ? 0 : ws) + 12);
    buf[0] = 1, buf[4] = 4, buf[8] = 8;
    return {
      b: bt + fsb,
      y: 0,
      l: 0,
      d: di,
      w: w && w != 1 ? w : buf.subarray(12),
      e: ws,
      o: new i32(buf.buffer, 0, 3),
      u: fss,
      c: cc,
      m: Math.min(131072, ws)
    };
  } else if ((n3 >> 4 | dat[3] << 20) == 25481893) {
    return b4(dat, 4) + 8;
  }
  err(0);
};
var msb = function(val) {
  var bits = 0;
  for (;1 << bits <= val; ++bits)
    ;
  return bits - 1;
};
var rfse = function(dat, bt, mal) {
  var tpos = (bt << 3) + 4;
  var al = (dat[bt] & 15) + 5;
  if (al > mal)
    err(3);
  var sz = 1 << al;
  var probs = sz, sym = -1, re = -1, i = -1, ht = sz;
  var buf = new ab(512 + (sz << 2));
  var freq = new i16(buf, 0, 256);
  var dstate = new u16(buf, 0, 256);
  var nstate = new u16(buf, 512, sz);
  var bb1 = 512 + (sz << 1);
  var syms = new u8(buf, bb1, sz);
  var nbits = new u8(buf, bb1 + sz);
  while (sym < 255 && probs > 0) {
    var bits = msb(probs + 1);
    var cbt = tpos >> 3;
    var msk = (1 << bits + 1) - 1;
    var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (tpos & 7) & msk;
    var msk1fb = (1 << bits) - 1;
    var msv = msk - probs - 1;
    var sval = val & msk1fb;
    if (sval < msv)
      tpos += bits, val = sval;
    else {
      tpos += bits + 1;
      if (val > msk1fb)
        val -= msv;
    }
    freq[++sym] = --val;
    if (val == -1) {
      probs += val;
      syms[--ht] = sym;
    } else
      probs -= val;
    if (!val) {
      do {
        var rbt = tpos >> 3;
        re = (dat[rbt] | dat[rbt + 1] << 8) >> (tpos & 7) & 3;
        tpos += 2;
        sym += re;
      } while (re == 3);
    }
  }
  if (sym > 255 || probs)
    err(0);
  var sympos = 0;
  var sstep = (sz >> 1) + (sz >> 3) + 3;
  var smask = sz - 1;
  for (var s = 0;s <= sym; ++s) {
    var sf = freq[s];
    if (sf < 1) {
      dstate[s] = -sf;
      continue;
    }
    for (i = 0;i < sf; ++i) {
      syms[sympos] = s;
      do {
        sympos = sympos + sstep & smask;
      } while (sympos >= ht);
    }
  }
  if (sympos)
    err(0);
  for (i = 0;i < sz; ++i) {
    var ns = dstate[syms[i]]++;
    var nb = nbits[i] = al - msb(ns);
    nstate[i] = (ns << nb) - sz;
  }
  return [tpos + 7 >> 3, {
    b: al,
    s: syms,
    n: nbits,
    t: nstate
  }];
};
var rhu = function(dat, bt) {
  var i = 0, wc = -1;
  var buf = new u8(292), hb = dat[bt];
  var hw = buf.subarray(0, 256);
  var rc = buf.subarray(256, 268);
  var ri = new u16(buf.buffer, 268);
  if (hb < 128) {
    var _a = rfse(dat, bt + 1, 6), ebt = _a[0], fdt = _a[1];
    bt += hb;
    var epos = ebt << 3;
    var lb = dat[bt];
    if (!lb)
      err(0);
    var st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1;
    var fpos = (++bt << 3) - 8 + msb(lb);
    for (;; ) {
      fpos -= btr1;
      if (fpos < epos)
        break;
      var cbt = fpos >> 3;
      st1 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr1) - 1;
      hw[++wc] = fdt.s[st1];
      fpos -= btr2;
      if (fpos < epos)
        break;
      cbt = fpos >> 3;
      st2 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr2) - 1;
      hw[++wc] = fdt.s[st2];
      btr1 = fdt.n[st1];
      st1 = fdt.t[st1];
      btr2 = fdt.n[st2];
      st2 = fdt.t[st2];
    }
    if (++wc > 255)
      err(0);
  } else {
    wc = hb - 127;
    for (;i < wc; i += 2) {
      var byte = dat[++bt];
      hw[i] = byte >> 4;
      hw[i + 1] = byte & 15;
    }
    ++bt;
  }
  var wes = 0;
  for (i = 0;i < wc; ++i) {
    var wt = hw[i];
    if (wt > 11)
      err(0);
    wes += wt && 1 << wt - 1;
  }
  var mb = msb(wes) + 1;
  var ts = 1 << mb;
  var rem = ts - wes;
  if (rem & rem - 1)
    err(0);
  hw[wc++] = msb(rem) + 1;
  for (i = 0;i < wc; ++i) {
    var wt = hw[i];
    ++rc[hw[i] = wt && mb + 1 - wt];
  }
  var hbuf = new u8(ts << 1);
  var syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
  ri[mb] = 0;
  for (i = mb;i > 0; --i) {
    var pv = ri[i];
    fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << mb - i));
  }
  if (ri[0] != ts)
    err(0);
  for (i = 0;i < wc; ++i) {
    var bits = hw[i];
    if (bits) {
      var code = ri[bits];
      fill(syms, i, code, ri[bits] = code + (1 << mb - bits));
    }
  }
  return [bt, {
    n: nb,
    b: mb,
    s: syms
  }];
};
var dllt = rfse(/* @__PURE__ */ new u8([
  81,
  16,
  99,
  140,
  49,
  198,
  24,
  99,
  12,
  33,
  196,
  24,
  99,
  102,
  102,
  134,
  70,
  146,
  4
]), 0, 6)[1];
var dmlt = rfse(/* @__PURE__ */ new u8([
  33,
  20,
  196,
  24,
  99,
  140,
  33,
  132,
  16,
  66,
  8,
  33,
  132,
  16,
  66,
  8,
  33,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  36,
  9
]), 0, 6)[1];
var doct = rfse(/* @__PURE__ */ new u8([
  32,
  132,
  16,
  66,
  102,
  70,
  68,
  68,
  68,
  68,
  36,
  73,
  2
]), 0, 5)[1];
var b2bl = function(b, s) {
  var len = b.length, bl = new i32(len);
  for (var i = 0;i < len; ++i) {
    bl[i] = s;
    s += 1 << b[i];
  }
  return bl;
};
var llb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  134678020,
  202050057,
  269422093
])).buffer, 0, 36);
var llbl = /* @__PURE__ */ b2bl(llb, 0);
var mlb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  117769220,
  185207048,
  252579084,
  16
])).buffer, 0, 53);
var mlbl = /* @__PURE__ */ b2bl(mlb, 3);
var dhu = function(dat, out, hu) {
  var len = dat.length, ss = out.length, lb = dat[len - 1], msk = (1 << hu.b) - 1, eb = -hu.b;
  if (!lb)
    err(0);
  var st = 0, btr = hu.b, pos = (len << 3) - 8 + msb(lb) - btr, i = -1;
  for (;pos > eb && i < ss; ) {
    var cbt = pos >> 3;
    var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (pos & 7);
    st = (st << btr | val) & msk;
    out[++i] = hu.s[st];
    pos -= btr = hu.n[st];
  }
  if (pos != eb || i + 1 != ss)
    err(0);
};
var dhu4 = function(dat, out, hu) {
  var bt = 6;
  var ss = out.length, sz1 = ss + 3 >> 2, sz2 = sz1 << 1, sz3 = sz1 + sz2;
  dhu(dat.subarray(bt, bt += dat[0] | dat[1] << 8), out.subarray(0, sz1), hu);
  dhu(dat.subarray(bt, bt += dat[2] | dat[3] << 8), out.subarray(sz1, sz2), hu);
  dhu(dat.subarray(bt, bt += dat[4] | dat[5] << 8), out.subarray(sz2, sz3), hu);
  dhu(dat.subarray(bt), out.subarray(sz3), hu);
};
var rzb = function(dat, st, out) {
  var _a;
  var bt = st.b;
  var b0 = dat[bt], btype = b0 >> 1 & 3;
  st.l = b0 & 1;
  var sz = b0 >> 3 | dat[bt + 1] << 5 | dat[bt + 2] << 13;
  var ebt = (bt += 3) + sz;
  if (btype == 1) {
    if (bt >= dat.length)
      return;
    st.b = bt + 1;
    if (out) {
      fill(out, dat[bt], st.y, st.y += sz);
      return out;
    }
    return fill(new u8(sz), dat[bt]);
  }
  if (ebt > dat.length)
    return;
  if (btype == 0) {
    st.b = ebt;
    if (out) {
      out.set(dat.subarray(bt, ebt), st.y);
      st.y += sz;
      return out;
    }
    return slc(dat, bt, ebt);
  }
  if (btype == 2) {
    var b3 = dat[bt], lbt = b3 & 3, sf = b3 >> 2 & 3;
    var lss = b3 >> 4, lcs = 0, s4 = 0;
    if (lbt < 2) {
      if (sf & 1)
        lss |= dat[++bt] << 4 | (sf & 2 && dat[++bt] << 12);
      else
        lss = b3 >> 3;
    } else {
      s4 = sf;
      if (sf < 2)
        lss |= (dat[++bt] & 63) << 4, lcs = dat[bt] >> 6 | dat[++bt] << 2;
      else if (sf == 2)
        lss |= dat[++bt] << 4 | (dat[++bt] & 3) << 12, lcs = dat[bt] >> 2 | dat[++bt] << 6;
      else
        lss |= dat[++bt] << 4 | (dat[++bt] & 63) << 12, lcs = dat[bt] >> 6 | dat[++bt] << 2 | dat[++bt] << 10;
    }
    ++bt;
    var buf = out ? out.subarray(st.y, st.y + st.m) : new u8(st.m);
    var spl = buf.length - lss;
    if (lbt == 0)
      buf.set(dat.subarray(bt, bt += lss), spl);
    else if (lbt == 1)
      fill(buf, dat[bt++], spl);
    else {
      var hu = st.h;
      if (lbt == 2) {
        var hud = rhu(dat, bt);
        lcs += bt - (bt = hud[0]);
        st.h = hu = hud[1];
      } else if (!hu)
        err(0);
      (s4 ? dhu4 : dhu)(dat.subarray(bt, bt += lcs), buf.subarray(spl), hu);
    }
    var ns = dat[bt++];
    if (ns) {
      if (ns == 255)
        ns = (dat[bt++] | dat[bt++] << 8) + 32512;
      else if (ns > 127)
        ns = ns - 128 << 8 | dat[bt++];
      var scm = dat[bt++];
      if (scm & 3)
        err(0);
      var dts = [dmlt, doct, dllt];
      for (var i = 2;i > -1; --i) {
        var md = scm >> (i << 1) + 2 & 3;
        if (md == 1) {
          var rbuf = new u8([0, 0, dat[bt++]]);
          dts[i] = {
            s: rbuf.subarray(2, 3),
            n: rbuf.subarray(0, 1),
            t: new u16(rbuf.buffer, 0, 1),
            b: 0
          };
        } else if (md == 2) {
          _a = rfse(dat, bt, 9 - (i & 1)), bt = _a[0], dts[i] = _a[1];
        } else if (md == 3) {
          if (!st.t)
            err(0);
          dts[i] = st.t[i];
        }
      }
      var _b = st.t = dts, mlt = _b[0], oct = _b[1], llt = _b[2];
      var lb = dat[ebt - 1];
      if (!lb)
        err(0);
      var spos = (ebt << 3) - 8 + msb(lb) - llt.b, cbt = spos >> 3, oubt = 0;
      var lst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << llt.b) - 1;
      cbt = (spos -= oct.b) >> 3;
      var ost = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << oct.b) - 1;
      cbt = (spos -= mlt.b) >> 3;
      var mst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mlt.b) - 1;
      for (++ns;--ns; ) {
        var llc = llt.s[lst];
        var lbtr = llt.n[lst];
        var mlc = mlt.s[mst];
        var mbtr = mlt.n[mst];
        var ofc = oct.s[ost];
        var obtr = oct.n[ost];
        cbt = (spos -= ofc) >> 3;
        var ofp = 1 << ofc;
        var off = ofp + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16 | dat[cbt + 3] << 24) >>> (spos & 7) & ofp - 1);
        cbt = (spos -= mlb[mlc]) >> 3;
        var ml = mlbl[mlc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << mlb[mlc]) - 1);
        cbt = (spos -= llb[llc]) >> 3;
        var ll = llbl[llc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << llb[llc]) - 1);
        cbt = (spos -= lbtr) >> 3;
        lst = llt.t[lst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << lbtr) - 1);
        cbt = (spos -= mbtr) >> 3;
        mst = mlt.t[mst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mbtr) - 1);
        cbt = (spos -= obtr) >> 3;
        ost = oct.t[ost] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << obtr) - 1);
        if (off > 3) {
          st.o[2] = st.o[1];
          st.o[1] = st.o[0];
          st.o[0] = off -= 3;
        } else {
          var idx = off - (ll != 0);
          if (idx) {
            off = idx == 3 ? st.o[0] - 1 : st.o[idx];
            if (idx > 1)
              st.o[2] = st.o[1];
            st.o[1] = st.o[0];
            st.o[0] = off;
          } else
            off = st.o[0];
        }
        for (var i = 0;i < ll; ++i) {
          buf[oubt + i] = buf[spl + i];
        }
        oubt += ll, spl += ll;
        var stin = oubt - off;
        if (stin < 0) {
          var len = -stin;
          var bs = st.e + stin;
          if (len > ml)
            len = ml;
          for (var i = 0;i < len; ++i) {
            buf[oubt + i] = st.w[bs + i];
          }
          oubt += len, ml -= len, stin = 0;
        }
        for (var i = 0;i < ml; ++i) {
          buf[oubt + i] = buf[stin + i];
        }
        oubt += ml;
      }
      if (oubt != spl) {
        while (spl < buf.length) {
          buf[oubt++] = buf[spl++];
        }
      } else
        oubt = buf.length;
      if (out)
        st.y += oubt;
      else
        buf = slc(buf, 0, oubt);
    } else if (out) {
      st.y += lss;
      if (spl) {
        for (var i = 0;i < lss; ++i) {
          buf[i] = buf[spl + i];
        }
      }
    } else if (spl)
      buf = slc(buf, spl);
    st.b = ebt;
    return buf;
  }
  err(2);
};
var cct = function(bufs, ol) {
  if (bufs.length == 1)
    return bufs[0];
  var buf = new u8(ol);
  for (var i = 0, b = 0;i < bufs.length; ++i) {
    var chk = bufs[i];
    buf.set(chk, b);
    b += chk.length;
  }
  return buf;
};
function decompress(dat, buf) {
  var bufs = [], nb = +!buf;
  var bt = 0, ol = 0;
  for (;dat.length; ) {
    var st = rzfh(dat, nb || buf);
    if (typeof st == "object") {
      if (nb) {
        buf = null;
        if (st.w.length == st.u) {
          bufs.push(buf = st.w);
          ol += st.u;
        }
      } else {
        bufs.push(buf);
        st.e = 0;
      }
      for (;!st.l; ) {
        var blk = rzb(dat, st, buf);
        if (!blk)
          err(5);
        if (buf)
          st.e = st.y;
        else {
          bufs.push(blk);
          ol += blk.length;
          cpw(st.w, 0, blk.length);
          st.w.set(blk, st.w.length - blk.length);
        }
      }
      bt = st.b + st.c * 4;
    } else
      bt = st;
    dat = dat.subarray(bt);
  }
  return cct(bufs, ol);
}

// shared/cache-dir.ts
import { homedir } from "node:os";
import { join } from "node:path";
function cacheRoot() {
  const home = homedir();
  const root = process.env.XDG_CACHE_HOME || (process.platform === "darwin" ? join(home, "Library/Caches") : process.platform === "win32" ? process.env.LOCALAPPDATA || join(home, "AppData/Local") : join(home, ".cache"));
  return join(root, "lmfpd");
}

// shared/detector-codec.ts
function decodeDetector(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = view.getUint32(0, true), start = Math.ceil((4 + headerLength) / 4) * 4;
  const count = (data.length - start) / 4;
  const raw = new Uint8Array(count * 4);
  for (let i = 0;i < count; i++)
    for (let b = 0;b < 4; b++)
      raw[i * 4 + b] = data[start + b * count + i];
  const little = new DataView(raw.buffer), floats = new Float32Array(count);
  for (let i = 0;i < count; i++)
    floats[i] = little.getFloat32(i * 4, true);
  return JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + headerLength)), (_, value) => value && typeof value === "object" && ("$f32" in value) ? Array.from(floats.subarray(value.$f32, value.$f32 + value.n)) : value);
}

// sdk/ts/src/types.ts
var DEFAULT_DATA_URLS = [
  "https://lm.ikale.io/data/",
  "https://cdn.jsdmirror.com/npm/lmfpd-data@latest/"
];

// sdk/ts/src/data.ts
var DATA_SCHEMA = "lmfpd-data-v1";
var DETECTOR_SCHEMA = "shared-detector-v2";
var DETECTOR = "shared_detector.bin";
var text = (bytes) => new TextDecoder().decode(bytes);
var message = (error) => error instanceof Error ? error.message : String(error);
function referenceData(bank, detector) {
  if (!Array.isArray(bank?.models) || !supportsSharedDetector(bank, detector)) {
    throw new Error("The reference bank does not match its detector.");
  }
  return { bank, detector };
}
async function readDir(dir) {
  const read = async (name, parse) => {
    const path = join2(dir, name);
    try {
      return parse(await readFile(path));
    } catch {
      throw new Error(`Cannot read ${path}.`);
    }
  };
  return referenceData(await read("unified_bank.json", (bytes) => JSON.parse(text(bytes))), await read(DETECTOR, decodeDetector));
}
async function readCache(path) {
  try {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    const length = bytes.readUInt32LE(0);
    const bundle = JSON.parse(text(bytes.subarray(4, 4 + length)));
    const data = referenceData(bundle, decodeDetector(bytes.subarray(4 + length)));
    return { data, version: bundle.files[DETECTOR].sha256, checkedAt: info.mtimeMs };
  } catch {
    return;
  }
}
async function writeCache(path, bundle, detector) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bundle.length);
  const staging = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(staging, Buffer.concat([length, bundle, detector]));
    await rename(staging, path);
  } catch {
    await rm(staging, { force: true }).catch(() => {});
  }
}
async function download(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok)
    throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
async function refresh(sources, cachePath, cachedVersion) {
  const failures = [];
  for (const source of sources) {
    try {
      const bundleBytes = await download(`${source}bundle.json`, 1e4);
      const bundle = JSON.parse(text(bundleBytes));
      if (bundle.schema !== DATA_SCHEMA || bundle.detector_schema !== DETECTOR_SCHEMA) {
        throw new Error(`data schema ${bundle.schema}/${bundle.detector_schema} is not supported by this SDK version. Upgrade lmfpd.`);
      }
      const file = bundle.files[DETECTOR];
      if (file.sha256 === cachedVersion) {
        const now = new Date;
        await utimes(cachePath, now, now).catch(() => {});
        return;
      }
      const parts = [];
      for (const part of file.parts)
        parts.push(await download(`${source}chunks/${part}`, 120000));
      const detectorBytes = decompress(Buffer.concat(parts));
      const data = referenceData(bundle, decodeDetector(detectorBytes));
      await writeCache(cachePath, bundleBytes, detectorBytes);
      return data;
    } catch (error) {
      failures.push(`${source} (${message(error)})`);
    }
  }
  throw new Error(`lmfpd: cannot download reference data from ${failures.join(", ")}`);
}
async function loadData(source = DEFAULT_DATA_URLS, cachePath = join2(cacheRoot(), "data.bin"), ttl = 86400) {
  const sources = typeof source === "string" ? [source] : source;
  if (sources.length === 1 && !/^https?:\/\//i.test(sources[0]))
    return readDir(sources[0]);
  const cached = await readCache(cachePath);
  if (!cached)
    return await refresh(sources, cachePath);
  if (Date.now() - cached.checkedAt >= ttl * 1000)
    refresh(sources, cachePath, cached.version).catch(() => {});
  return cached.data;
}

// sdk/ts/src/index.ts
var canonicalSample = (sample) => ({
  state: sample.state,
  text: sample.text,
  raw_text: sample.rawText,
  count: sample.count,
  expected_count: sample.expectedCount,
  first_byte_ms: sample.firstByteMs ?? null,
  response_model: sample.responseModel ?? null,
  response_id: sample.responseId ?? null,
  error: sample.error ?? null
});
var createDetector;

class Detector {
  static {
    createDetector = (data) => new Detector(data);
  }
  #data;
  builtAt;
  constructor(data) {
    this.#data = data;
    this.builtAt = data.bank.built_at;
  }
  analyze(outputs, options = {}) {
    return analyzeOutputs(outputs, this.#data.bank, this.#data.detector, options.strict ?? false);
  }
  async detect(config, { signal, onSample } = {}) {
    const options = detectOptions(config);
    if (signal?.aborted)
      return { challenges: [], samples: [], analysis: null, error: "Cancelled. This round was not scored." };
    const round = newRound(1, generateChallenges(options.count));
    const emit = onSample ? (index) => {
      try {
        onSample(index, canonicalSample(round.samples[index]));
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    } : () => {};
    round.samples.forEach((_, index) => emit(index));
    await runRound(round, options, this.#data.bank, this.#data.detector, signal ?? new AbortController().signal, emit);
    return {
      challenges: round.challenges,
      samples: round.samples.map(canonicalSample),
      analysis: round.analysis ? canonicalAnalysis(round.analysis) : null,
      error: round.error ?? null
    };
  }
}
async function loadDetector(options = {}) {
  return createDetector(await loadData(options.source, options.cache, options.ttl));
}
function generateChallenges2(count = 3) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 3)
    throw new Error("count must be an integer from 1 to 3.");
  return generateChallenges(count);
}
function parseNumbers2(text) {
  return parseNumbers(text);
}
function buildRequest(config, prompt) {
  try {
    return buildDetectRequest(detectOptions(config).config, prompt);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
async function requestSample2(config, challenge) {
  return canonicalSample(await requestSample(detectOptions(config), challenge, new AbortController().signal, () => {}));
}
export {
  DEFAULT_DATA_URLS,
  Detector,
  buildRequest,
  generateChallenges2 as generateChallenges,
  loadDetector,
  parseNumbers2 as parseNumbers,
  requestSample2 as requestSample
};
