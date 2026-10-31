// Input area (§8.6 Composer): auto-grow, IME, queue/steer, waiting for permission, attachments,
// Agent·model popover, thinking level, permission mode, ↑ to recall.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isImeComposing } from "../composer/ime";
import { useUi } from "../stores/ui";
import { useData } from "../stores/data";
import { useTimeline } from "../stores/timeline";
import { ws } from "../main";
import { getToken } from "../api/token";
import { Icon } from "./Icons";
import { attachmentUrl } from "./Timeline";
import type { Mode, ModelInfo } from "../types/models";
import type { SlashCommand } from "../composer/slashMenu";
import { toast } from "./Toast";
import { useLiveSettings } from "./Settings";
import { composerModeOptions, effortLabel } from "../i18n/modes.js";
import { Logo } from "./Logo";
import { SelectMenu } from "./SelectMenu";
import { errMsg, t as tr, tf } from "../i18n/index.js";
import {
  applySlashPick,
  slashEnterSends,
  clampSlashIndex,
  filterSlashCommands,
  selectableSlashRows,
  slashMenuRows,
  slashMenuState,
} from "../composer/slashMenu";

type Attachment = { path: string; name: string; mime: string; uploading?: boolean };

/** Maximum rows drawn in the model list at once (hundreds of buttons make the popover noticeably sluggish) */
const MODEL_LIST_CAP = 150;

export function Composer() {
  const ui = useUi();
  const { threads, providers } = useData();
  const tl = useTimeline();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [agentPop, setAgentPop] = useState(false);
  const [pickerProviderId, setPickerProviderId] = useState<string | null>(null);
  const [modelQ, setModelQ] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [lastSent, setLastSent] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [slashSel, setSlashSel] = useState(0);
  const slashSuppress = useRef(false);
  const slashLoadThreads = useRef(new Set<string>());
  const [slashLoading, setSlashLoading] = useState(false);
  const prefs = useLiveSettings();

  const thread = threads.find((t) => t.id === ui.currentThreadId);
  const provider = providers.find((p) => p.id === thread?.provider);
  const running = tl.status === "running" || tl.status === "initializing";
  const waiting = tl.pending.length > 0;
  const steerOk = provider?.capabilities.steer ?? false;
  // Known not to take images (an ACP Agent whose initialize doesn't advertise them): images still go, as file paths
  const imagesByPath = !!provider && !provider.capabilities.images && provider.capabilities.imagesKnown !== false;
  const mode = thread?.mode ?? "default";
  const modes = composerModeOptions(thread?.provider, provider?.capabilities.modes ?? [], provider?.capabilities.modeLabels);
  const modeMeta = modes.find((m) => m.id === mode);
  const started = tl.items.some((it) => it.kind === "user");

  const slashMenu = useMemo(() => slashMenuState(text, slashSuppress.current), [text]);
  const slashFiltered = useMemo(
    () => filterSlashCommands(tl.slashCommands, slashMenu.query),
    [tl.slashCommands, slashMenu.query],
  );
  const slashRows = useMemo(() => slashMenuRows(slashFiltered), [slashFiltered]);
  const slashPickable = useMemo(() => selectableSlashRows(slashRows), [slashRows]);
  const slashOpen = slashMenu.open && !waiting;

  useEffect(() => {
    setSlashSel(0);
  }, [slashMenu.query, slashOpen]);

  // Only the first "/" typed fetches commands with load:true (opening a conversation doesn't start the Agent)
  useEffect(() => {
    const id = thread?.id;
    if (!slashOpen || !id) return;
    if (slashLoadThreads.current.has(id)) return;
    slashLoadThreads.current.add(id);
    // The first time we start the Agent and wait for its commands (seconds): meanwhile the menu shows "loading commands…" rather than "no commands"
    setSlashLoading(true);
    void ws.call("thread.commands", { id, load: true }, 30000).then((r) => {
      const commands = (r as { commands?: SlashCommand[] }).commands ?? [];
      // A background push (commands event) may already have arrived: don't overwrite it with an empty result
      if (commands.length || !useTimeline.getState().slashCommands.length) {
        useTimeline.setState({ slashCommands: commands });
      }
    }).catch(() => {}).finally(() => setSlashLoading(false));
  }, [slashOpen, thread?.id]);

  const visibleProviders = useMemo(
    () => providers.filter((p) => p.enabled !== false || p.id === thread?.provider),
    [providers, thread?.provider],
  );

  const pickerProvider = visibleProviders.find((p) => p.id === (pickerProviderId ?? thread?.provider));

  const providerOk = (p: (typeof visibleProviders)[0]) =>
    p.enabled !== false && p.available && p.status !== "planned";

  const openPicker = (open: boolean) => {
    setAgentPop(open);
    if (open) {
      setPickerProviderId(null);
      setModelQ("");
    }
  };

  // Close on outside click / Esc (it used to close as soon as the pointer left, so a height change would "throw" the user out)
  useEffect(() => {
    if (!agentPop) return;
    const onDown = (e: PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) openPicker(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); openPicker(false); }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [agentPop]);

  const pickModelForProvider = async (providerId: string, model: string | null) => {
    if (!thread) return;
    // Close the popover first; the switch happens in the background (no longer waits for detection/model fetching to respond)
    openPicker(false);
    try {
      if (!started && providerId !== thread.provider) {
        await ws.call("thread.setProvider", { id: thread.id, provider: providerId });
      }
      await ws.call("thread.setModel", { id: thread.id, model });
    } catch (e) {
      toast(tr("composer.failSwitchAgent") + errMsg(e), true);
    }
  };

  const modelSearchHits = useMemo(() => {
    const q = modelQ.trim().toLowerCase();
    if (!q) return [] as { providerId: string; providerName: string; model: ModelInfo }[];
    const hits: { providerId: string; providerName: string; model: ModelInfo }[] = [];
    for (const p of visibleProviders) {
      if (!providerOk(p)) continue;
      for (const m of p.models ?? []) {
        if (m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) {
          hits.push({ providerId: p.id, providerName: p.name, model: m });
        }
      }
    }
    return hits.slice(0, 100);
  }, [modelQ, visibleProviders]);

  const inModelList = Boolean(pickerProviderId && !modelQ.trim());

  // Timer
  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Auto-grow 1–12 lines
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 12 * 22) + "px";
  }, [text]);

  const send = useCallback(async (behavior: "queue" | "steer" = "queue") => {
    const id = ui.currentThreadId;
    const msg = text.trim();
    if (!id || (!msg && attachments.length === 0)) return;
    if (running && behavior === "queue") setLastSent((s) => [...s, msg]);
    setText("");
    try {
      const r = (await ws.call("thread.send", {
        id, text: msg,
        attachments: attachments.map((a) => ({ path: a.path, mime: a.mime, name: a.name })),
        behavior: running && behavior === "steer" && steerOk ? "steer" : "queue",
      })) as { delivered?: "started" | "steered" | "queued" } | undefined;
      setAttachments([]);
      // Say what really happened to a message sent mid-turn (B7: agents without steer queue it)
      if (r?.delivered === "queued" && running) toast(tr("composer.queuedToast"));
      else if (r?.delivered === "steered") toast(tr("composer.steeredToast"));
      if (!running) setLastSent((s) => [...s.slice(-9), msg]);
    } catch (e) {
      setText(msg);
      toast(tr("composer.failSend") + errMsg(e), true);
    }
  }, [text, attachments, ui.currentThreadId, running, steerOk]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e.nativeEvent)) return;

    if (slashOpen && slashPickable.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSel((i) => clampSlashIndex(i + 1, slashPickable.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSel((i) => clampSlashIndex(i - 1, slashPickable.length));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        slashSuppress.current = true;
        setSlashSel(0);
        return;
      }
      const pick = slashPickable[slashSel] ?? slashPickable[0];
      const enterSends = e.key === "Enter" && slashEnterSends(text, pick?.name);
      if (((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") && !enterSends) {
        e.preventDefault();
        if (pick) {
          slashSuppress.current = false;
          setText(applySlashPick(pick.name));
        }
        return;
      }
    }

    const ctrl = e.ctrlKey || e.metaKey;
    const sendCombo = prefs.sendKey === "ctrlEnter"
      ? e.key === "Enter" && ctrl
      : e.key === "Enter" && !e.shiftKey && !ctrl;
    if (sendCombo) {
      e.preventDefault();
      if (running && prefs.runningSend === "steer" && steerOk) void send("steer");
      else void send("queue");
      return;
    }
    // With Enter to send: Ctrl+Enter while running still steers (with the "steer" setting the branch above already steers)
    if (prefs.sendKey === "enter" && e.key === "Enter" && ctrl && running) {
      e.preventDefault();
      if (steerOk) void send("steer");
      else void send("queue");
      return;
    }
    if (e.key === "ArrowUp" && text === "" && lastSent.length > 0) {
      e.preventDefault();
      setText(lastSent[lastSent.length - 1]);
    }
  };

  // Paste: image → upload; text >32KB → .txt attachment (§8.6)
  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        e.preventDefault();
        const f = it.getAsFile();
        if (f) await upload(f);
        return;
      }
    }
    const t = e.clipboardData.getData("text/plain");
    if (t && t.length > 32 * 1024) {
      e.preventDefault();
      const f = new File([t], "paste.txt", { type: "text/plain" });
      await upload(f);
    }
  };

  const upload = async (f: File) => {
    const token = getToken();
    const tmp: Attachment = { path: "", name: f.name, mime: f.type || "application/octet-stream", uploading: true };
    setAttachments((a) => [...a, tmp]);
    try {
      const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, {
        method: "POST", headers: { "x-agent-console": token }, body: f,
      });
      const r = await res.json();
      if (!r.ok) throw new Error(r.e?.message ?? tr("composer.uploadFailed"));
      setAttachments((a) => a.map((x) => (x === tmp ? { ...x, path: r.id, name: r.name ?? f.name, uploading: false } : x)));
    } catch (e) {
      setAttachments((a) => a.filter((x) => x !== tmp));
      toast(tr("composer.failUpload") + errMsg(e), true);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) {
      if (f.type.startsWith("image/") || f.type.startsWith("text/")) await upload(f);
    }
  };

  const setMode = (m: Mode) => {
    if (thread) void ws.call("thread.setMode", { id: thread.id, mode: m });
  };
  const setEffort = (effort: string | null) => {
    if (thread) void ws.call("thread.setEffort", { id: thread.id, effort });
  };
  const setCursorOpts = (patch: { cursorFast?: boolean; cursorAutoReview?: boolean }) => {
    if (thread) void ws.call("thread.setCursorOpts", { id: thread.id, ...patch }).catch((e) => toast(errMsg(e), true));
  };

  // With the default model: some Providers don't mark isDefault → fall back to the first one so the level dropdown appears
  const modelRow = thread?.model
    ? provider?.models?.find((m) => m.id === thread.model)
    : provider?.models?.find((m) => m.isDefault) ?? provider?.models?.[0];
  // Defensive: an old daemon may pass Codex's { reasoningEffort, description } objects straight through, and rendering an object would blank the whole page
  const thinkingOpts = (modelRow?.thinkingOptions ?? [])
    .map((o) => {
      const raw = o as unknown as { id?: unknown; label?: unknown; reasoningEffort?: unknown };
      const id = typeof raw.id === "string" ? raw.id : typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : null;
      const idObj = raw.id as { reasoningEffort?: unknown } | null;
      const fixedId = id ?? (idObj && typeof idObj.reasoningEffort === "string" ? idObj.reasoningEffort : null);
      return fixedId ? { id: fixedId, label: typeof raw.label === "string" ? raw.label : fixedId } : null;
    })
    .filter((o): o is { id: string; label: string } => o !== null);
  const defaultThinking = typeof modelRow?.defaultThinking === "string" ? modelRow.defaultThinking : null;
  const showThinking = thinkingOpts.length > 0;

  const modelLabel = (() => {
    if (!thread?.model) {
      const d = provider?.models?.find((x) => x.isDefault);
      return d ? d.name : tr("composer.defaultModel");
    }
    const m = provider?.models?.find((x) => x.id === thread.model);
    let name = m?.name ?? thread.model;
    if (thread.cursorFast) name += " · Fast";
    return name;
  })();

  if (!ui.currentThreadId) return null;

  return (
    <div className={`composer${waiting ? " waiting" : ""}`} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      {/* queue list */}
      {tl.queue.length > 0 && (
        <div className="q-list">
          {tl.queue.map((q) => (
            <div key={q.id} className="q-item">
              <span className="q-text">{q.text}</span>
              <button className="ibtn" title={tr("common.remove")} onClick={() => void ws.call("thread.queueRemove", { id: thread?.id, queueId: q.id }).catch(() => {})}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {mode === "bypassPermissions" && (
        <div className="cp-danger">{tr("composer.bypassWarn")}</div>
      )}
      <div className={`cp-card${waiting ? " waiting" : ""}${mode === "bypassPermissions" ? " danger" : ""}`}>
        {imagesByPath && attachments.some((a) => a.mime.startsWith("image/")) && (
          <div className="att-note">{tf("composer.imagesByPath", { agent: provider?.name ?? "" })}</div>
        )}
        {attachments.length > 0 && (
          <div className="att-bar">
            {attachments.map((a, i) => (
              <span key={i} className={`att${a.uploading ? " up" : ""}`}>
                {a.mime.startsWith("image/") && a.path
                  ? <img src={attachmentUrl(a.path)} alt={a.name} />
                  : <Icon name="attach" size={12} />}
                <span className="att-name">{a.name}</span>
                {a.uploading && <span className="att-prog">…</span>}
                <button className="att-x" onClick={() => setAttachments((s) => s.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="cp-ta-wrap">
          {slashOpen && (
            <div className="pop agent-picker slash-pop" role="listbox">
              <div className="ap-scroll">
                {slashRows.length === 0 ? (
                  <div className="ap-empty">{tr(slashLoading ? "composer.slashLoading" : "composer.slashNoCommands")}</div>
                ) : (
                  slashRows.map((row) => {
                    if (row.type === "heading") {
                      return (
                        <div key={row.id} className="slash-h">
                          {row.labelKey === "slashGroupCommand"
                            ? tr("composer.slashGroupCommand")
                            : tr("composer.slashGroupSkill")}
                        </div>
                      );
                    }
                    const idx = slashPickable.indexOf(row.command);
                    const sel = idx === slashSel;
                    return (
                      <button
                        key={row.id}
                        type="button"
                        role="option"
                        aria-selected={sel}
                        className={`mi slash-item${sel ? " sel" : ""}`}
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={() => {
                          slashSuppress.current = false;
                          setText(applySlashPick(row.command.name));
                        }}
                      >
                        <span className="slash-name">/{row.command.name}</span>
                        <span className="slash-desc">{row.command.description}</span>
                        {row.command.argumentHint ? (
                          <span className="slash-hint">{row.command.argumentHint}</span>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
          <textarea
            ref={taRef}
            className="cp-ta"
            rows={1}
            placeholder={waiting ? tr("composer.waitPerm") : running ? tr(steerOk ? "composer.queuePlaceholder" : "composer.queuePlaceholderNoSteer") : tr("composer.inputPlaceholder")}
            value={text}
            disabled={waiting}
            onChange={(e) => {
              slashSuppress.current = false;
              setText(e.target.value);
            }}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
        </div>
        <div className="cp-bar">
          {/* Agent·model pill */}
          <div className="pill-wrap" ref={pickerRef}>
            <button className="pill chip" onClick={() => openPicker(!agentPop)} title={tr("composer.agentModel")}>
              <Logo size={18} className="chip-logo" />
              <span className="p-a">{provider?.name ?? thread?.provider ?? tr("composer.agent")}</span>
              <span className="p-t">{modelLabel}</span>
              <svg className="chip-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {agentPop && (
              <div className="pop agent-pop agent-picker">
                <div className="ap-search">
                  <Icon name="search" size={14} />
                  <input
                    className="ap-search-in"
                    autoFocus
                    placeholder={tr("composer.searchAllModels")}
                    value={modelQ}
                    onChange={(e) => setModelQ(e.target.value)}
                  />
                </div>

                {modelQ.trim() ? (
                  <div className="ap-scroll">
                    {modelSearchHits.length === 0 && (
                      <div className="ap-empty">{tr("composer.noModelMatch")}</div>
                    )}
                    {modelSearchHits.map(({ providerId, providerName, model }) => {
                      const locked = started && providerId !== thread?.provider;
                      return (
                        <button
                          key={`${providerId}:${model.id}`}
                          className="mi mi-row"
                          disabled={locked}
                          onClick={() => void pickModelForProvider(providerId, model.id)}
                        >
                          <span className="mi-sub">{providerName}</span>
                          <span className="mi-name">{model.name}</span>
                          {thread?.provider === providerId && thread?.model === model.id && (
                            <span className="mi-check">✓</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : inModelList && pickerProvider ? (
                  <div className="ap-scroll">
                    <button
                      type="button"
                      className="ap-back mi"
                      onClick={() => setPickerProviderId(null)}
                    >
                      <span className="ap-back-icon"><Icon name="caret" size={14} /></span>
                      {pickerProvider.name}
                    </button>
                    <button
                      className="mi model-pick-row"
                      title={pickerProvider.models?.find((m) => m.isDefault)?.name ?? tr("composer.defaultModel")}
                      onClick={() => void pickModelForProvider(pickerProvider.id, null)}
                    >
                      <span className="model-pick-name">{tr("composer.defaultModel")}</span>
                      {/* which model the default really is (behind magpie = the model magpie applies to this Agent) */}
                      {(() => {
                        const d = pickerProvider.models?.find((m) => m.isDefault);
                        return d ? <span className="mi-sub model-pick-default"> ({d.name})</span> : null;
                      })()}
                      {thread?.provider === pickerProvider.id && !thread?.model ? <span className="mi-check">✓</span> : ""}
                    </button>
                    {/* Devin/Cursor have hundreds of models: draw only the first MODEL_LIST_CAP, search for the rest */}
                    {/* the default model already appears in the "Default (…)" row above, so it isn't listed again (Copilot used to show "Default (Auto)" + "Auto") */}
                    {(pickerProvider.models ?? []).filter((m) => !m.isDefault).slice(0, MODEL_LIST_CAP).map((m) => (
                      <button
                        key={m.id}
                        className="mi model-pick-row"
                        title={m.name}
                        onClick={() => void pickModelForProvider(pickerProvider.id, m.id)}
                      >
                        <span className="model-pick-name">{m.name}</span>
                        {thread?.provider === pickerProvider.id && thread?.model === m.id
                          ? <span className="mi-check">✓</span>
                          : ""}
                      </button>
                    ))}
                    {(pickerProvider.models?.length ?? 0) > MODEL_LIST_CAP && (
                      <div className="ap-empty">
                        {tf("composer.moreModels", { n: String((pickerProvider.models?.length ?? 0) - MODEL_LIST_CAP) })}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="ap-scroll">
                    <div className="mlabel">
                      {started ? tr("composer.agentLocked") : tr("composer.providers")}
                    </div>
                    {started && <div className="ap-empty">{tr("composer.agentLockedHint")}</div>}
                    {visibleProviders.length === 0 && <div className="ap-empty">{tr("composer.providersLoading")}</div>}
                    {visibleProviders.map((p) => {
                      const ok = providerOk(p);
                      const canOpen = ok && (!started || p.id === thread?.provider);
                      const n = p.models?.length ?? 0;
                      const label = p.name?.trim() || p.id;
                      return (
                        <button
                          key={p.id}
                          className="mi mi-row provider-pick-row"
                          disabled={!canOpen}
                          onClick={() => {
                            if (!canOpen) return;
                            setPickerProviderId(p.id);
                          }}
                        >
                          <span className="provider-pick-name">{label}</span>
                          <span className="provider-pick-meta">
                            {p.id === thread?.provider && <span className="mi-tag">Current</span>}
                            {/* option labels in the picker are English throughout */}
                            <span className="mi-meta">{n === 1 ? "1 model" : `${n} models`}</span>
                            {canOpen && <span className="mi-caret"><Icon name="caret" size={14} /></span>}
                            {p.enabled === false && <span className="dlg-hint">Disabled</span>}
                            {p.enabled !== false && p.status === "planned" && <span className="dlg-hint">Not available</span>}
                            {p.enabled !== false && p.status !== "planned" && !p.available && (
                              <span className="dlg-hint">Not detected</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* thinking level: icon + short label; the menu is the page's own (SelectMenu), opening upwards */}
          {showThinking && (
            <SelectMenu
              className="pill ipill"
              title={tr("composer.effortTitle")}
              ariaLabel={tr("composer.effortTitle")}
              prefer="up"
              upAnchor=".cp-card"
              value={thread?.effort ?? ""}
              onChange={(v) => setEffort(v || null)}
              options={[
                {
                  value: "",
                  label: defaultThinking
                    ? tf("composer.defaultEffortNamed", { level: effortLabel(defaultThinking) })
                    : tr("composer.defaultEffort"),
                },
                // an Agent's own "default" level is the same thing as the first entry
                ...thinkingOpts.filter((e) => e.id !== "default").map((e) => ({ value: e.id, label: effortLabel(e.id, e.label) })),
              ]}
            >
              <Icon name="gauge" size={14} />
              <span className="ip-l">{(() => {
                const cur = thread?.effort ?? defaultThinking;
                if (!cur) return tr("composer.defaultEffort");
                return effortLabel(cur, thinkingOpts.find((o) => o.id === cur)?.label);
              })()}</span>
            </SelectMenu>
          )}
          {/* permission mode: list only the modes this Agent really has; hidden when there is only one (e.g. Pi has no modes) */}
          {modes.length > 1 && (() => {
            // The mode stored on the conversation doesn't exist for this Agent → show the one it will actually use
            const shown = modes.find((m) => m.id === mode) ?? modes[0]!;
            return (
              <SelectMenu
                className={`pill ipill${shown.danger ? " danger" : ""}`}
                title={shown.desc}
                ariaLabel={tr("composer.modeTitle")}
                prefer="up"
              upAnchor=".cp-card"
                menuClassName="mode-menu"
                value={shown.id}
                onChange={(v) => setMode(v as Mode)}
                options={modes.map((m) => ({ value: m.id, label: m.label, hint: m.desc, danger: m.danger }))}
              >
                <Icon name="shield" size={14} />
                <span className="ip-l">{shown.label}</span>
              </SelectMenu>
            );
          })()}
          {/* Cursor speed (like Paseo's Fast toggle) */}
          {thread?.provider === "cursor" && (
            <SelectMenu
              className="pill ipill cursor-fast"
              title="Fast"
              ariaLabel="Fast"
              prefer="up"
              upAnchor=".cp-card"
              value={thread.cursorFast ? "fast" : "off"}
              onChange={(v) => setCursorOpts({ cursorFast: v === "fast" })}
              options={[{ value: "off", label: "Fast: Off" }, { value: "fast", label: "Fast: On" }]}
            >
              <span className="ip-l">{thread.cursorFast ? "Fast: On" : "Fast: Off"}</span>
            </SelectMenu>
          )}
          <span className="cp-div" aria-hidden="true" />
          {/* attachments */}
          <button className="ibtn cp-attach" title={tr("composer.attachTitle")} onClick={() => fileRef.current?.click()}>
            <Icon name="attach" />
          </button>
          <input ref={fileRef} type="file" hidden multiple accept="image/*,.txt,.md,.log,.json,.csv"
            onChange={(e) => { for (const f of e.target.files ?? []) void upload(f); e.target.value = ""; }} />
          <div className="cp-right">
            {running ? (
              <>
                <span className="cp-clock">{elapsed}s</span>
                {(text.trim() || attachments.length > 0) && (
                  <button className="cp-send" title={tr(steerOk && prefs.runningSend === "steer" ? "settings.steer" : "settings.queue")}
                    disabled={waiting || attachments.some((a) => a.uploading)}
                    onClick={() => void send(prefs.runningSend === "steer" && steerOk ? "steer" : "queue")}>
                    <Icon name="arrowUp" />
                  </button>
                )}
                <button className="cp-stop" title={tr("common.stop")} onClick={() => void ws.call("thread.interrupt", { id: thread?.id })}>
                  <Icon name="stopFill" />
                </button>
              </>
            ) : (
              <button className="cp-send" title={tr("common.send")} disabled={waiting || (!text.trim() && attachments.length === 0) || attachments.some((a) => a.uploading)}
                onClick={() => void send("queue")}>
                <Icon name="arrowUp" />
              </button>
            )}
          </div>
        </div>
      </div>
      {running && !steerOk && prefs.runningSend === "steer" && (
        <div className="cp-hint">{tf("composer.steerUnsupported", { agent: provider?.name ?? thread?.provider ?? "" })}</div>
      )}
    </div>
  );
}
