import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {stateRoot} from "./grant-store.mjs";
import {readTail} from "./receipts.mjs";

export async function getReceiptReport({day = new Date().toISOString().slice(0,10), root = stateRoot(), task, appLog} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("invalid_date");
  if (task && !/^(?:[a-f0-9-]{36}|id-[a-f0-9]{24})$/i.test(task)) throw new Error("invalid_task");
  const parse = s => { try { return JSON.parse(s); } catch { return null; } };
  const records = (await readTail(path.join(root,"receipts",day+".jsonl"))).split("\n").map(parse).filter(Boolean);
  const grouped = new Map();
  for (const row of records) {
    if (task && row.task !== task && row.thread !== task) continue;
    const g = grouped.get(row.id) || {};
    g[row.phase] = row; grouped.set(row.id,g);
  }
  const marker = "NERO_COMPANY_GUARD_RECEIPT ";
  const log = await readTail(appLog || path.join(os.homedir(),"Library","Logs","magpie","app.log"),4*1024*1024);
  const middleware = " middleware " + path.resolve(fileURLToPath(new URL("..", import.meta.url))) + " [error]: ";
  const errors = [];
  for (const line of log.split("\n")) {
    const errorAt = line.indexOf(middleware);
    if (errorAt >= 0) {
      const match = /^(onRequest|onAccount|onProvider|onEvent|onResponse): (.*)$/.exec(line.slice(errorAt + middleware.length));
      const at = new Date(line.slice(0,19).replaceAll("/","-").replace(" ","T"));
      if (match && Number.isFinite(at.getTime()) && at.toISOString().slice(0,10) === day) errors.push({at:at.toISOString(), hook:match[1], code:match[2] === "took too long" ? "callback_timeout" : "callback_error", requestId:null});
    }
    const i = line.indexOf(marker); if (i < 0) continue;
    const row = parse(line.slice(i + marker.length));
    if (row && grouped.has(row.id) && ["request_checked","reply_processed"].includes(row.phase)) grouped.get(row.id)[row.phase] = row;
  }
  const rows = [...grouped.entries()].map(([id,g]) => {
    const p = g.prepared, reply = g.response_observed;
    let status = "未确认";
    if (p?.status === "failed" || (g.reply_processed?.ok === false && g.reply_processed.reason !== "upstream_incomplete") || reply?.remainingCurrentPlaceholders > 0) status = "处理失败";
    else if (["replaced","authorized","no_match"].includes(p?.status) && g.request_checked?.ok && g.reply_processed?.ok && reply?.hostCompletionObserved && reply?.replyCaptured) status = p?.status === "replaced" ? "已替换，回复处理完成" : p?.status === "authorized" ? "授权放行" : "未命中";
    let statusCode, statusLabel, statusReason;
    if (status === "处理失败") {
      statusCode = p?.status === "failed" ? "preparation_failed" : reply?.remainingCurrentPlaceholders > 0 ? "restoration_residue" : "reply_processing_failed";
      statusLabel = status; statusReason = statusCode === "preparation_failed" ? "输入保护准备失败。" : statusCode === "restoration_residue" ? "已采集的回复仍有本次名称代号。" : "插件记录了回复处理未成功；需核对调用终止原因。";
    } else if (status !== "未确认") {
      statusCode = "completed"; statusLabel = status; statusReason = "准备、同步检查、回复处理和宿主完成记录均已核对。";
    } else if (reply?.hostCompletionObserved === false || g.reply_processed?.reason === "upstream_incomplete") {
      statusCode = "call_incomplete"; statusLabel = "调用未完成"; statusReason = "宿主未取得完整回复；可能为调用取消、上游失败、回复不完整或采集超限，不能直接判为还原故障。";
    } else if (!p) {
      statusCode = "preparation_missing"; statusLabel = "准备回执缺失"; statusReason = "未取得输入保护的准备记录。";
    } else if (!g.request_checked?.ok) {
      statusCode = "request_confirmation_missing"; statusLabel = "同步确认缺失"; statusReason = "缺少同步检查确认，不能认定输入保护已完成。";
    } else if (reply?.hostCompletionObserved && !reply.replyCaptured) {
      statusCode = "reply_capture_missing"; statusLabel = "回复采集缺失"; statusReason = "宿主报告完成，但未取得可核对的回复副本。";
    } else if (reply?.hostCompletionObserved && !g.reply_processed) {
      statusCode = "reply_confirmation_missing"; statusLabel = "回复确认缺失"; statusReason = "宿主已完成且已采集回复，但缺少插件处理确认；不能仅凭代号残留为零认定还原成功。";
    } else {
      statusCode = "awaiting_completion"; statusLabel = "等待完成通知"; statusReason = g.reply_processed?.ok ? "插件已确认回复处理，尚未取得宿主完整完成通知。" : "输入已检查，尚未取得完整的回复处理及宿主完成通知；这不证明请求仍在运行。";
    }
    return {id, task:p?.task || reply?.task, thread:p?.thread || reply?.thread, at:p?.startedAt || reply?.startedAt, version:p?.version || reply?.version, status, statusCode, statusLabel, statusReason, preparedStatus:p?.status || "not_observed", authorization:p?.authorization || "unknown", authorizationCoverage:p?.authorizationCoverage || "none", authorizationReason:p?.authorizationReason || "unknown", allowedOccurrences:p?.allowedOccurrences ?? null, matchedNames:p?.matchedNames ?? null, replacedNames:p?.replacedNames ?? null, replacements:p?.replacements ?? null, scopes:p?.scopes || {}, processingMs:p?.processingMs ?? null, requestChecked:!!g.request_checked?.ok, replyProcessingObserved:!!g.reply_processed, replyProcessingOK:g.reply_processed?.ok ?? null, replyProcessingReason:["processed","upstream_incomplete","restoration_incomplete"].includes(g.reply_processed?.reason) ? g.reply_processed.reason : null, replyEventType:["response.completed","response.failed","response.incomplete","message_stop","error"].includes(g.reply_processed?.eventType) ? g.reply_processed.eventType : null, restoredNames:g.reply_processed?.restoredNames ?? null, hostCompletionObserved:reply?.hostCompletionObserved ?? null, replyCaptured:reply?.replyCaptured ?? null, remainingCurrentPlaceholders:reply?.remainingCurrentPlaceholders ?? null};
  }).sort((a,b)=>(b.at||"").localeCompare(a.at||""));
  return {date:day,rows,diagnostics:{events:errors.slice(-25), observed:errors.length, omitted:Math.max(0,errors.length-25), requestAttribution:"unavailable"},limits:["未命中不代表没有敏感名称", "无回执或宿主回调、日志缺失均不能视为已保护", "本地检查和还原记录不证明所有名称均被识别", "status保留兼容分组；statusCode、statusLabel和statusReason说明当前分类及证据缺口", "回调错误日志没有请求编号，不能据此归因到某一条回执", "本工具读取每日回执末尾8MiB及应用日志末尾4MiB；日志轮转或宿主限流可能造成确认缺失"]};
}
