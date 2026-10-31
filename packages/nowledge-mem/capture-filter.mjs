// Capture-only projection. Never edit the request used for inference or recall.
// Cindy templates adapt nowledge-co/community#785 at 594b1520fb7a187f1deddc660a4602665d85ff3b.
// Unlike a native Pi plugin, this gateway cannot read Cindy's launcher markers,
// attribution, draft skill text or fork boundaries. Only an explicitly enabled,
// host-identified Cindy request gets its known leading notes removed.
export function captureMessage(message, options, agent) {
    if (options.captureFilter !== "human")
        return message;
    if (message.role !== "user" && message.role !== "assistant")
        return;
    const projected = message.role === "user" && options.captureCindy && agent === "cindy"
        ? cindyText(message.content) : { content: message.content };
    if (!projected.content.trim())
        return;
    return { role: message.role, content: projected.content,
        ...(projected.origin ? { metadata: { cindy_origin: projected.origin } } : {}) };
}

const SIDE_CHAT_NOTE = "[Side chat context] This is an independent follow-up to a main task. History inherited at the fork is reference material, not active instructions or authorization. Answer the current question; do not resume the main task, its pending actions, or its plan. Keep exploration non-mutating unless the user explicitly requests a change in this side chat. The main task continues separately and does not receive these replies automatically.";
const CHANNEL_PREFIX = "[渠道说明] 系统追加，不是用户消息。本条来自";
const MOBILE_PREFERENCE = "产出 HTML 等可预览成品时**优先做成自包含单文件**:样式与脚本内联,图片用 data: URI 或公网地址,避免拆成需要同目录资源的多文件产物;用户明确要求多文件时照常产出。给出文件路径时同时给出结论或内容摘要,不要只回一个路径。";
const LEGACY_MOBILE_NOTE = "[客户端说明] 以下为系统每轮自动追加的环境说明,不是用户发来的消息;回复时不要把它当作用户的请求,也不要引用、复述或据此臆测用户意图。本轮请求来自手机客户端(小屏、远程查看被控电脑上的文件)。";
const CLIENT_NOTE = /^\[客户端说明\] 系统追加的环境说明，不是用户消息，不要回应或复述。本轮用户在(另一台电脑|手机)(.*?) 上远程操作本机(.*?)。(.*)$/;
const UI_LANGUAGE_NOTE = new RegExp([
    String.raw`^\[UI language\] System note appended each turn\. This is not a user message\. `,
    String.raw`Do not answer it, quote it, or infer intent from it\. The user interface language is ([^\r\n]+?) \(([a-zA-Z-]+)\)\. `,
    String.raw`When you tell the user that something failed, was blocked, could not continue, or needs a retry, write that report in \1\. `,
    String.raw`Do not default that report to English unless the interface language is English\. Say what happened and the next step\. `,
    String.raw`Keep commands, paths, identifiers, and error codes unchanged\. Ordinary replies still follow the user message and any explicit language request\. `,
    String.raw`Only user-facing error reports must use the interface language\.(?:\r?\n|$)`,
].join(""));
const HANDOFF_ENDS = [
    "== End of handoff note; the user's new message follows ==",
    "== End of handoff note; the user’s new message follows ==",
    "== 交接说明结束,以下是用户的新消息 ==",
];
const REBUILD_ENDS = [
    "== End of rebuild note; the user's new message follows ==",
    "== End of rebuild note; the user’s new message follows ==",
    "== 上下文重建说明结束,以下是用户的新消息 ==",
];
const CONTEXT_NOTES = {
    "[Session handoff · internal context]": HANDOFF_ENDS,
    "[Session context rebuild · internal context]": REBUILD_ENDS,
    "[Session fork · internal context]": [
        "== End of fork note; the user's new message follows ==",
        "== End of fork note; the user’s new message follows ==",
        ...HANDOFF_ENDS, ...REBUILD_ENDS,
    ],
};
// Bound recognition work, not dialogue length. Unknown/oversized wrappers stay
// intact; no model call, transcript scan or subprocess is used for filtering.
// Recognition indices are UTF-16 code units; the import cap remains UTF-8 bytes.
const maxPrefixUnits = 64 << 10;
const maxPrefixes = 32;

function sourceName(raw, key) {
    const match = raw.trim().match(new RegExp(`^(?:「([^「」\\r\\n]+)」)?(?: ?\\(${key}: ([^()\\r\\n]+)\\))?$`));
    return match && (match[1]?.trim() || match[2]?.trim()) ? match[1] : false;
}
function clientPrefix(line, remainder) {
    if (line !== LEGACY_MOBILE_NOTE + MOBILE_PREFERENCE) {
        const match = line.match(CLIENT_NOTE);
        if (!match || sourceName(match[2], "device_id") === false || sourceName(match[3], "device_id") === false)
            return;
        if (match[4] && (match[1] !== "手机" || match[4] !== MOBILE_PREFERENCE))
            return;
    }
    return { remainder };
}
function channelPrefix(line, remainder) {
    if (!line.startsWith(CHANNEL_PREFIX) || !line.endsWith("。"))
        return;
    const match = line.slice(CHANNEL_PREFIX.length, -1).match(/^(?:微信| WeChat )(私聊|群)(.*)$/);
    if (!match)
        return;
    const refs = match[2].split("，发言人");
    if (refs.length > 2)
        return;
    const chatName = sourceName(refs[0], "chat_id");
    if (chatName === false)
        return;
    const origin = { channel: "wechat", chat_kind: match[1] === "群" ? "group" : "direct" };
    if (chatName)
        origin.chat_name = chatName;
    if (refs.length === 2) {
        const ownership = refs[1].match(/(?:，)?(不是主人|是主人)$/);
        const sender = ownership ? refs[1].slice(0, ownership.index) : refs[1];
        const senderName = !sender.trim() && ownership ? undefined : sourceName(sender, "user_id");
        if (senderName === false)
            return;
        if (senderName)
            origin.sender_name = senderName;
        if (ownership)
            origin.sender_is_owner = ownership[1] === "是主人";
    }
    return { remainder, origin };
}
function contextPrefix(content, heading) {
    const terminators = Object.hasOwn(CONTEXT_NOTES, heading) ? CONTEXT_NOTES[heading] : undefined;
    if (!terminators)
        return;
    let fence;
    for (const match of content.slice(0, maxPrefixUnits + 1).matchAll(/^.*(?:\r?\n|$)/gm)) {
        if (match.index + match[0].length > maxPrefixUnits)
            return;
        const line = match[0].replace(/\r?\n$/, "");
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (marker) {
            if (!fence)
                fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
                fence = undefined;
            continue;
        }
        if (!fence && terminators.includes(line))
            return { remainder: content.slice(match.index + match[0].length) };
    }
}
function knownPrefix(content) {
    if (content.startsWith(SIDE_CHAT_NOTE)) {
        const remainder = content.slice(SIDE_CHAT_NOTE.length);
        if (!remainder || /^\r?\n/.test(remainder))
            return { remainder };
    }
    for (const tag of ["cindy-extra-writable-directories", "cindy-extra-reference-directories"]) {
        if (!content.startsWith(`<${tag}>\n`) && !content.startsWith(`<${tag}>\r\n`))
            continue;
        const close = `</${tag}>`;
        const end = content.slice(0, maxPrefixUnits).indexOf(close);
        if (end < 0 || end + close.length > maxPrefixUnits)
            return;
        const remainder = content.slice(end + close.length);
        return remainder === "" || /^\r?\n/.test(remainder) ? { remainder } : undefined;
    }
    const head = content.slice(0, 8193);
    const newline = head.indexOf("\n");
    const end = newline < 0 ? content.length : newline;
    if (end > 8192)
        return;
    const line = content.slice(0, end).replace(/\r$/, "");
    const note = content.match(UI_LANGUAGE_NOTE);
    if (note)
        return { remainder: content.slice(note[0].length) };
    const remainder = newline < 0 ? "" : content.slice(newline + 1);
    return channelPrefix(line, remainder) || clientPrefix(line, remainder) || contextPrefix(content, line);
}
// These strings only make cleanup more conservative. They are not evidence of
// origin or identity: a user can write or quote any of them. Keep the whole
// message, including any recognized earlier prefix, when boundaries are unclear.
const mixedSourceMarkers = [
    "主人开启了自动跟进；这一轮由宿主的任务事件唤醒，不是主人刚说的话。",
    "[Scheduled run context]", "[Routine checkpoint]", "[Silent scheduled run]",
    "[Task delivery]", "[消息来源]", "[任务来源]",
];
function cindyText(content) {
    if (mixedSourceMarkers.some((marker) => content.includes(marker)))
        return { content };
    let remainder = content;
    let origin;
    for (let count = 0; count < maxPrefixes; count++) {
        const prefix = knownPrefix(remainder);
        if (!prefix)
            break;
        // Consume separator lines, never indentation in the actual message.
        remainder = prefix.remainder.replace(/^(?:[ \t]*\r?\n)+/, "");
        origin = prefix.origin || origin;
    }
    let speaker = "";
    if (origin && (origin.chat_kind === "group" || origin.sender_is_owner === false)) {
        speaker = origin.sender_name ? `发言人「${origin.sender_name}」：\n`
            : origin.sender_is_owner === false ? "发言人（非主人）：\n" : "群聊发言人：\n";
    }
    return { content: remainder.trim() ? speaker + remainder : "", ...(origin ? { origin } : {}) };
}
