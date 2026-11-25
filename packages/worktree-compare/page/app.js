"use strict";

const el = (id) => document.getElementById(id);
const access = new URLSearchParams(location.hash.slice(1)).get("access");
const labels = {
  queued:"等待中", pending:"等待中", running:"运行中", completed:"已完成", succeeded:"已完成",
  finished:"已完成", failed:"失败", cancelled:"已停止", canceled:"已停止", interrupted:"已中断",
  discarded:"已归档", archived:"已归档"
};
const active = (s) => ["pending", "queued", "running"].includes(s);
const complete = (s) => ["completed", "succeeded", "finished"].includes(s);
const archived = (s) => ["discarded", "archived"].includes(s);
const state = { view:"editor", run:null, lock:false, models:[], serial:0 };
const modelA = el("model-a");
const modelB = el("model-b");

function item(tag, text, className) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function message(text, error = false) {
  const n = el("notice");
  n.hidden = !text;
  n.textContent = text || "";
  n.classList.toggle("error", error);
}
function show(view) {
  state.view = view;
  for (const id of ["editor", "history", "detail"]) el(id).hidden = id !== view;
  for (const [id, key] of [["new-tab", "editor"], ["history-tab", "history"]]) {
    if (key === view) el(id).setAttribute("aria-current", "page");
    else el(id).removeAttribute("aria-current");
  }
  message("");
}
async function api(path, payload) {
  if (!access) throw new Error("此页面缺少访问凭据。请从 Magpie 的插件侧栏重新打开双模型对比。");
  const headers = { "X-Arena-Key": access };
  const options = { headers, credentials:"omit", cache:"no-store" };
  if (payload !== undefined) {
    options.method = "POST";
    headers["Content-Type"] = "application/json";
    headers["X-Arena-Request"] = "1";
    options.body = JSON.stringify(payload);
  }
  const response = await fetch("./api/" + path, options);
  let result;
  try { result = await response.json(); }
  catch { throw new Error("本地服务未返回有效结果（HTTP " + response.status + "）。请从 Magpie 重新打开插件。"); }
  if (!response.ok) {
    const detail = typeof result.error === "string" ? result.error : result.error?.message || result.message;
    throw new Error(detail || "本地服务请求失败（HTTP " + response.status + "）。");
  }
  return result;
}
const runPath = (id) => "runs/" + encodeURIComponent(id);
const candidatePath = (id, side) => runPath(id) + "/" + encodeURIComponent(side);
function button(title, click, style) {
  const control = item("button", title, style);
  control.type = "button";
  control.addEventListener("click", click);
  return control;
}
function syncForm() {
  modelB.setCustomValidity(modelA.value && modelB.value === modelA.value ? "请选择两个不同的模型。" : "");
  el("start").disabled = state.lock || !access || state.models.length < 2;
}
async function loadModels() {
  const helper = el("model-help");
  const old = [modelA.value, modelB.value];
  el("reload-models").disabled = true;
  let error = "";
  try {
    const data = await api("models");
    state.models = [...new Set((data.models || []).filter((m) => typeof m === "string" && m.length))];
  } catch (e) { state.models = []; error = e.message; }
  [modelA, modelB].forEach((select, index) => {
    select.replaceChildren();
    for (const model of state.models) select.add(new Option(model, model));
    if (state.models.length) {
      select.value = state.models.includes(old[index]) ? old[index] : state.models[Math.min(index, state.models.length - 1)];
    } else select.add(new Option("没有可用模型", ""));
    select.disabled = !state.models.length;
  });
  helper.hidden = !error && state.models.length >= 2;
  helper.firstElementChild.textContent = error || "请先在 Magpie 中配好两个可供 Codex 使用的模型，再读取列表。";
  el("reload-models").hidden = !access;
  el("reload-models").disabled = false;
  syncForm();
}
function chip(status) {
  const style = complete(status) ? "ok" : ["failed", "interrupted"].includes(status) ? "fail" : "";
  return item("span", labels[status] || status || "未知", "chip " + style);
}
function drawDiff(pre, diff) {
  if (!diff) { pre.textContent = "这个版本没有代码改动。"; return; }
  const output = document.createDocumentFragment();
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") || line.startsWith("-")) output.append(item("span", line, line[0] === "+" ? "added" : "deleted"));
    else output.append(document.createTextNode(line));
    output.append(document.createTextNode("\n"));
  }
  pre.replaceChildren(output);
}
function renderCandidate(run, c) {
  const side = String(c.side).toUpperCase();
  const panel = item("article", null, "candidate");
  const head = item("header", null, "candidate-header");
  head.append(item("span", side, "side-label"), item("h3", c.model || "模型 " + side));
  const status = item("div", null, "status-line");
  status.append(chip(c.status));
  const chosen = run.chosen === c.side;
  if (chosen) status.append(item("strong", "已选用 " + side));
  panel.append(head, status);
  if (chosen && run.chosenBranch) {
    const branch = item("p", "本地分支 ", "selected-branch");
    branch.append(item("code", run.chosenBranch));
    panel.append(branch);
  }
  if (c.cwd) panel.append(item("p", c.cwd, "candidate-path"));
  if (c.error) panel.append(item("p", c.error, "failure"));
  if (c.summary) {
    const summary = item("details");
    summary.append(item("summary", "执行摘要"), item("pre", c.summary));
    panel.append(summary);
  }
  if (c.cwd && !["queued","pending"].includes(c.status)) {
    const details = item("details");
    const contents = item("pre", "", "diff");
    details.append(item("summary", "查看代码改动"), contents);
    details.addEventListener("toggle", async () => {
      if (!details.open) return;
      contents.textContent = "正在读取改动…";
      try { drawDiff(contents, (await api(candidatePath(run.id, c.side) + "/diff")).diff); }
      catch (e) { contents.textContent = e.message; }
    });
    panel.append(details);
  }
  const controls = item("div", null, "candidate-controls");
  if (c.cwd) controls.append(button("打开工作目录", () => action(run, c.side + "/open", "已请求打开 " + side + " 的工作目录。")));
  if (complete(c.status) && !active(run.status) && !archived(run.status) && run.chosen !== c.side) {
    controls.append(button((run.chosen ? "改选 " : "选用 ") + side, () => action(run, c.side + "/choose", "已选用版本 " + side + "。"), run.chosen ? "" : "primary"));
  }
  panel.append(controls);
  return panel;
}
function drawRun(run) {
  if (state.run && state.run.id === run.id && JSON.stringify(state.run) === JSON.stringify(run)) return;
  state.run = run;
  const base = (run.base || "").slice(0, 12);
  const pathLine = item("p", (run.repo || "") + (base ? "  ·  " + base : ""), "meta mono");
  const row = item("div", null, "status-line");
  row.append(chip(run.status));
  if (run.chosen) row.append(item("span", "选用版本 " + run.chosen.toUpperCase()));
  el("run-meta").replaceChildren(item("p", run.prompt, "task-prompt"), pathLine, row);
  el("candidates").replaceChildren(...(run.candidates || []).map((c) => renderCandidate(run, c)));
  const actions = el("run-actions");
  actions.replaceChildren();
  if (active(run.status)) {
    actions.append(item("p", "完成后可以在这里选择要继续的版本。", "hint"), button("停止运行", () => action(run, "cancel", "已请求停止本次运行。")));
  } else if (archived(run.status)) {
    actions.append(item("p", "本次对比已归档，工作目录仍保留。", "hint"));
  } else {
    const guidance = run.chosen
      ? "在选中的工作目录继续开发。改动仍在该目录，尚未合并回原项目。"
      : "选用后会为该工作目录创建本地分支。由你决定何时提交和合并。";
    actions.append(item("p", guidance, "hint"));
    actions.append(button(run.chosen ? "归档本次对比" : "都不选，归档", () => action(run, "discard", "已归档，两个工作目录仍保留。")));
  }
}
async function action(run, suffix, done) {
  if (state.lock) return;
  state.lock = true;
  ++state.serial;
  const controls = [...el("detail").querySelectorAll("button")];
  for (const n of controls) n.disabled = true;
  try {
    const result = await api(runPath(run.id) + "/" + suffix, {});
    if (state.view !== "detail" || state.run?.id !== run.id) return;
    if (result.run) drawRun(result.run);
    message(done);
  } catch (e) { if (state.view === "detail" && state.run?.id === run.id) message(e.message, true); }
  finally { state.lock = false; controls.forEach((n) => n.disabled = false); syncForm(); }
}
async function openRun(id) {
  const seq = ++state.serial;
  try {
    const result = await api(runPath(id));
    if (seq !== state.serial) return;
    show("detail");
    drawRun(result.run);
    el("detail-title").focus({preventScroll:true});
  } catch (e) { if (seq === state.serial) message(e.message, true); }
}
async function history() {
  const seq = ++state.serial;
  show("history");
  const list = el("history-list");
  list.replaceChildren(item("p", "正在读取记录…", "empty"));
  try {
    const {runs} = await api("runs");
    if (seq !== state.serial || state.view !== "history") return;
    list.replaceChildren();
    if (!runs.length) { list.append(item("p", "还没有对比记录。新建一次对比后，结果会保存在这里。", "empty")); return; }
    for (const run of runs) {
      const open = button("", () => openRun(run.id), "hist-row");
      const left = item("span", null, "hist-main");
      left.append(item("span", run.prompt || "未命名任务", "hist-title"), item("span", run.repo, "hist-sub mono"));
      const status = run.chosen ? "选用 " + run.chosen.toUpperCase() : labels[run.status] || run.status;
      open.append(left, item("span", status + "  ›", "hist-state"));
      list.append(open);
    }
  } catch (e) {
    if (seq !== state.serial) return;
    list.replaceChildren(button("重新读取", history));
    message(e.message, true);
  }
}
async function startRun() {
  if (state.lock || el("start").disabled || !el("run-form").reportValidity()) return;
  const repo = el("repo").value.trim();
  const prompt = el("prompt").value.trim();
  if (!repo || !prompt) { message("请输入项目路径和任务。", true); return; }
  if (modelA.value === modelB.value) { modelB.reportValidity(); return; }
  state.lock = true;
  syncForm();
  el("start").textContent = "正在创建…";
  el("history-tab").disabled = true;
  el("new-tab").disabled = true;
  message("");
  try {
    const {run} = await api("runs", { repo, prompt, models:[modelA.value, modelB.value] });
    ++state.serial;
    show("detail"); drawRun(run);
    el("detail-title").focus({preventScroll:true});
  } catch (e) { message(e.message, true); }
  finally {
    state.lock = false;
    el("start").textContent = "开始对比 ↗";
    el("history-tab").disabled = false;
    el("new-tab").disabled = false;
    syncForm();
  }
}
async function refresh() {
  if (document.hidden || state.view !== "detail" || !state.run || !active(state.run.status) || state.lock) return;
  const seq = ++state.serial;
  const runID = state.run.id;
  try {
    const result = await api(runPath(runID));
    if (state.serial === seq && state.view === "detail" && state.run?.id === runID) {
      drawRun(result.run);
      if (el("notice").dataset.refreshError === "true") { message(""); delete el("notice").dataset.refreshError; }
    }
  } catch (e) {
    if (state.serial === seq && state.view === "detail") { message(e.message, true); el("notice").dataset.refreshError = "true"; }
  }
}
for (const n of [modelA, modelB]) n.addEventListener("change", syncForm);
// The plugin iframe permits scripts but blocks native form submissions.
el("start").addEventListener("click", startRun);
el("run-form").addEventListener("submit", event => event.preventDefault());
el("run-form").addEventListener("keydown", event => {
  if (event.isComposing || event.key !== "Enter") return;
  if (event.target === el("repo") || (event.target === el("prompt") && (event.metaKey || event.ctrlKey))) {
    event.preventDefault();
    el("start").click();
  }
});
el("reload-models").addEventListener("click", loadModels);
el("new-tab").addEventListener("click", () => { ++state.serial; show("editor"); });
el("history-tab").addEventListener("click", history);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
loadModels();
(async function poll() {
  await refresh();
  window.setTimeout(poll, 2200);
})();
