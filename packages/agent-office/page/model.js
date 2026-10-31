// What the page shows, worked out from live.js (globalThis.AgentOfficeLive,
// written by the plugin's host part) without the DOM, so a test can check
// it. A classic script: it sets globalThis.AgentOfficeModel.
//
// A session from an agent's own files says its phase outright (thinking,
// tool, approval, ask, done, aborted, error); the page only adds that a
// session whose file has not moved for a long while, mid-turn, has made no
// progress. A session only the gateway saw (an agent whose files aren't
// read) is worked out from its requests, as before.
(() => {
  // ---- words -----------------------------------------------------------
  // Every language carries exactly the same keys. `zh` is kept as an alias
  // of zh-CN for older callers and for the tests that came before.
  const TEXT = {
    en: {
      title: "What are my agents doing", needYou: "Need you", working: "Working", doneN: "Done", finished: "Finished",
      office: "Office", list: "List", pip: "Picture in picture", settings: "Settings",
      thinking: "Thinking", executing: "Running tools", replying: "Replying", waiting: "Waiting for you",
      done: "Done", error: "Error", stopped: "Stopped", idle: "Idle",
      approval: "Waiting for your approval", ask: "Asked you something",
      stuck: "No progress · {n}", noProgress: "No progress",
      copyResume: "Copy resume command", copySession: "Copy session id", copied: "Copied",
      justNow: "just now", sAgo: "{n}s ago", mAgo: "{n} min ago", hAgo: "{n} h ago", dAgo: "{n} d ago",
      empty: "No agent has been at work in the last two days. Start Claude Code, Codex, DeepSeek Harness, Gemini CLI… and it walks in here.",
      noFile: "Starting… the plugin reads your agents' sessions in magpie's plugin host.",
      demo: "Sample agents", showDone: "Show finished agents", showText: "Show prompts and replies",
      showSub: "Show subagents", showIdle: "Show idle agents", agents: "Agents", allAgents: "All agents",
      language: "Language", auto: "Auto", scene: "Scene",
      hideAfter: "Leave the office after", h1: "1 hour", h6: "6 hours", h24: "24 hours", never: "Never",
      demoOn: "Showing sample agents", turns: "{n} turns", noPrompt: "(no prompt)",
      project: "Folder", model: "Model", status: "Status", task: "Task", last: "Last active", agent: "Agent",
      quiet: "Text off: only statuses are kept",
      floating: "The office has its own window here: move it, reshape it, or ✕ it to put it back",
      pipOn: "Put it back", ran: "running {n}", via: "seen through magpie's gateway", fromFiles: "from its own session file",
      live: "live", stale: "Last update {n}",
      today: "Today", turnsL: "turns", tokensL: "tokens", agentsL: "agents",
      topProjects: "Top folders", noUsage: "No usage recorded yet.",
      summaryNote: "Totals come from the usage records in each agent's own session files.",
      context: "Context", recent: "Recent conversation", noMessages: "No messages yet.",
      privateNote: "Text is off, so the conversation is hidden.", loadingMsgs: "Loading…",
      subAgent: "subagent", panel: "Panel", dismiss: "Dismiss", clear: "Clear", clearTip: "Remove from the office until its session moves",
      unitS: "s", unitM: "m", unitH: "h",
    },
    "zh-CN": {
      title: "我的 Agent 在干嘛", needYou: "需要你", working: "工作中", doneN: "已完成", finished: "已结束",
      office: "办公室", list: "列表", pip: "画中画", settings: "设置",
      thinking: "思考中", executing: "执行中", replying: "回复中", waiting: "等你回应",
      done: "已完成", error: "错误", stopped: "已中断", idle: "摸鱼中",
      approval: "等你批准", ask: "在问你问题",
      stuck: "已 {n} 没有进展", noProgress: "没有进展",
      copyResume: "复制续接命令", copySession: "复制会话 ID", copied: "已复制",
      justNow: "刚刚", sAgo: "{n}秒前", mAgo: "{n}分钟前", hAgo: "{n}小时前", dAgo: "{n}天前",
      empty: "最近两天没有 Agent 在干活。打开 Claude Code、Codex、DeepSeek Harness、Gemini CLI……它就会走进这间办公室。",
      noFile: "正在启动……插件在 magpie 的插件宿主里读取各个 Agent 的会话。",
      demo: "示例 Agent", showDone: "显示已完成的 Agent", showText: "显示提问和回复",
      showSub: "显示子 Agent", showIdle: "显示摸鱼 Agent", agents: "Agent", allAgents: "全部 Agent",
      language: "语言", auto: "自动", scene: "场景",
      hideAfter: "多久后离开办公室", h1: "1 小时", h6: "6 小时", h24: "24 小时", never: "从不",
      demoOn: "正在显示示例 Agent", turns: "{n} 轮", noPrompt: "（没有提问）",
      project: "目录", model: "模型", status: "状态", task: "任务", last: "最近活动", agent: "Agent",
      quiet: "已关闭文本：只记录状态",
      floating: "办公室在这里的小窗中：可拖动、可缩放，点 ✕ 放回去",
      pipOn: "放回去", ran: "已运行 {n}", via: "经 magpie 网关看到", fromFiles: "来自它自己的会话文件",
      live: "实时", stale: "最近更新 {n}",
      today: "今日", turnsL: "轮", tokensL: "tokens", agentsL: "个 Agent",
      topProjects: "热门目录", noUsage: "还没有用量记录。",
      summaryNote: "统计来自各个 Agent 自己会话文件里的用量记录。",
      context: "上下文", recent: "最近对话", noMessages: "还没有消息。",
      privateNote: "已关闭文本，对话已隐藏。", loadingMsgs: "加载中……",
      subAgent: "子 Agent", panel: "侧栏", dismiss: "关闭", clear: "清除", clearTip: "从办公室移除，直到会话有新动静",
      unitS: "秒", unitM: "分", unitH: "小时",
    },
    "zh-TW": {
      title: "我的 Agent 在幹嘛", needYou: "需要你", working: "工作中", doneN: "已完成", finished: "已結束",
      office: "辦公室", list: "列表", pip: "子母畫面", settings: "設定",
      thinking: "思考中", executing: "執行中", replying: "回覆中", waiting: "等你回應",
      done: "已完成", error: "錯誤", stopped: "已中斷", idle: "摸魚中",
      approval: "等你批准", ask: "在問你問題",
      stuck: "已 {n} 沒有進展", noProgress: "沒有進展",
      copyResume: "複製續接指令", copySession: "複製工作階段 ID", copied: "已複製",
      justNow: "剛剛", sAgo: "{n}秒前", mAgo: "{n}分鐘前", hAgo: "{n}小時前", dAgo: "{n}天前",
      empty: "最近兩天沒有 Agent 在幹活。打開 Claude Code、Codex、DeepSeek Harness、Gemini CLI……它就會走進這間辦公室。",
      noFile: "正在啟動……外掛在 magpie 的外掛宿主裡讀取各個 Agent 的工作階段。",
      demo: "範例 Agent", showDone: "顯示已完成的 Agent", showText: "顯示提問和回覆",
      showSub: "顯示子 Agent", showIdle: "顯示摸魚 Agent", agents: "Agent", allAgents: "全部 Agent",
      language: "語言", auto: "自動", scene: "場景",
      hideAfter: "多久後離開辦公室", h1: "1 小時", h6: "6 小時", h24: "24 小時", never: "從不",
      demoOn: "正在顯示範例 Agent", turns: "{n} 輪", noPrompt: "（沒有提問）",
      project: "目錄", model: "模型", status: "狀態", task: "任務", last: "最近活動", agent: "Agent",
      quiet: "已關閉文字：只記錄狀態",
      floating: "辦公室在這裡的小視窗中：可拖動、可縮放，點 ✕ 放回去",
      pipOn: "放回去", ran: "已執行 {n}", via: "經 magpie 閘道看到", fromFiles: "來自它自己的工作階段檔案",
      live: "即時", stale: "最近更新 {n}",
      today: "今日", turnsL: "輪", tokensL: "tokens", agentsL: "個 Agent",
      topProjects: "熱門目錄", noUsage: "還沒有用量記錄。",
      summaryNote: "統計來自各個 Agent 自己工作階段檔案裡的用量記錄。",
      context: "上下文", recent: "最近對話", noMessages: "還沒有訊息。",
      privateNote: "已關閉文字，對話已隱藏。", loadingMsgs: "載入中……",
      subAgent: "子 Agent", panel: "側欄", dismiss: "關閉", clear: "清除", clearTip: "從辦公室移除，直到工作階段有新動靜",
      unitS: "秒", unitM: "分", unitH: "小時",
    },
    ja: {
      title: "エージェントは何してる？", needYou: "要対応", working: "作業中", doneN: "完了", finished: "終了",
      office: "オフィス", list: "リスト", pip: "ピクチャーインピクチャー", settings: "設定",
      thinking: "考え中", executing: "ツール実行中", replying: "返信中", waiting: "あなた待ち",
      done: "完了", error: "エラー", stopped: "中断", idle: "待機中",
      approval: "承認待ち", ask: "質問があります",
      stuck: "{n} 進展なし", noProgress: "進展なし",
      copyResume: "再開コマンドをコピー", copySession: "セッション ID をコピー", copied: "コピーしました",
      justNow: "たった今", sAgo: "{n}秒前", mAgo: "{n}分前", hAgo: "{n}時間前", dAgo: "{n}日前",
      empty: "この2日間、エージェントは動いていません。Claude Code、Codex、DeepSeek Harness、Gemini CLI… を起動すると、ここに現れます。",
      noFile: "起動中… プラグインが magpie のプラグインホストで各エージェントのセッションを読んでいます。",
      demo: "サンプルエージェント", showDone: "終了したエージェントを表示", showText: "プロンプトと返信を表示",
      showSub: "サブエージェントを表示", showIdle: "待機中のエージェントを表示", agents: "エージェント", allAgents: "すべてのエージェント",
      language: "言語", auto: "自動", scene: "シーン",
      hideAfter: "オフィスを離れるまで", h1: "1 時間", h6: "6 時間", h24: "24 時間", never: "なし",
      demoOn: "サンプルエージェントを表示中", turns: "{n} ターン", noPrompt: "（プロンプトなし）",
      project: "フォルダ", model: "モデル", status: "状態", task: "タスク", last: "最終活動", agent: "エージェント",
      quiet: "テキストオフ：状態のみ保持",
      floating: "オフィスはこの小窓にあります。移動・リサイズでき、✕ で戻せます",
      pipOn: "戻す", ran: "実行中 {n}", via: "magpie のゲートウェイ経由", fromFiles: "自身のセッションファイルから",
      live: "ライブ", stale: "最終更新 {n}",
      today: "今日", turnsL: "ターン", tokensL: "トークン", agentsL: "エージェント",
      topProjects: "上位フォルダ", noUsage: "まだ使用量の記録がありません。",
      summaryNote: "合計は各エージェントのセッションファイルの使用量記録から算出します。",
      context: "コンテキスト", recent: "最近の会話", noMessages: "まだメッセージはありません。",
      privateNote: "テキストオフのため、会話は非表示です。", loadingMsgs: "読み込み中…",
      subAgent: "サブエージェント", panel: "パネル", dismiss: "閉じる", clear: "消去", clearTip: "セッションが動くまでオフィスから消す",
      unitS: "秒", unitM: "分", unitH: "時間",
    },
    ko: {
      title: "내 에이전트는 뭐 하는 중?", needYou: "확인 필요", working: "작업 중", doneN: "완료", finished: "종료",
      office: "사무실", list: "목록", pip: "화면 속 화면", settings: "설정",
      thinking: "생각 중", executing: "도구 실행 중", replying: "답변 작성 중", waiting: "응답 대기",
      done: "완료", error: "오류", stopped: "중단됨", idle: "대기",
      approval: "승인 대기 중", ask: "질문이 있습니다",
      stuck: "{n} 동안 진행 없음", noProgress: "진행 없음",
      copyResume: "이어하기 명령 복사", copySession: "세션 ID 복사", copied: "복사됨",
      justNow: "방금", sAgo: "{n}초 전", mAgo: "{n}분 전", hAgo: "{n}시간 전", dAgo: "{n}일 전",
      empty: "지난 이틀 동안 에이전트가 작업하지 않았습니다. Claude Code, Codex, DeepSeek Harness, Gemini CLI…를 실행하면 여기로 들어옵니다.",
      noFile: "시작 중… 플러그인이 magpie의 플러그인 호스트에서 에이전트 세션을 읽고 있습니다.",
      demo: "샘플 에이전트", showDone: "완료된 에이전트 표시", showText: "프롬프트와 답변 표시",
      showSub: "하위 에이전트 표시", showIdle: "대기 중인 에이전트 표시", agents: "에이전트", allAgents: "모든 에이전트",
      language: "언어", auto: "자동", scene: "장면",
      hideAfter: "사무실을 떠나기까지", h1: "1시간", h6: "6시간", h24: "24시간", never: "안 함",
      demoOn: "샘플 에이전트 표시 중", turns: "{n} 턴", noPrompt: "(프롬프트 없음)",
      project: "폴더", model: "모델", status: "상태", task: "작업", last: "최근 활동", agent: "에이전트",
      quiet: "텍스트 꺼짐: 상태만 유지",
      floating: "사무실이 이 작은 창에 있습니다. 이동·크기 조절하거나 ✕로 되돌리세요",
      pipOn: "되돌리기", ran: "실행 중 {n}", via: "magpie 게이트웨이로 확인", fromFiles: "자체 세션 파일에서",
      live: "실시간", stale: "마지막 업데이트 {n}",
      today: "오늘", turnsL: "턴", tokensL: "토큰", agentsL: "에이전트",
      topProjects: "상위 폴더", noUsage: "아직 사용량 기록이 없습니다.",
      summaryNote: "합계는 각 에이전트 세션 파일의 사용량 기록에서 계산합니다.",
      context: "컨텍스트", recent: "최근 대화", noMessages: "아직 메시지가 없습니다.",
      privateNote: "텍스트가 꺼져 있어 대화가 숨겨집니다.", loadingMsgs: "불러오는 중…",
      subAgent: "하위 에이전트", panel: "패널", dismiss: "닫기", clear: "지우기", clearTip: "세션이 움직일 때까지 사무실에서 숨기기",
      unitS: "초", unitM: "분", unitH: "시간",
    },
    es: {
      title: "¿Qué hacen mis agentes?", needYou: "Te necesitan", working: "Trabajando", doneN: "Hecho", finished: "Terminados",
      office: "Oficina", list: "Lista", pip: "Imagen en imagen", settings: "Ajustes",
      thinking: "Pensando", executing: "Ejecutando herramientas", replying: "Respondiendo", waiting: "Esperándote",
      done: "Hecho", error: "Error", stopped: "Detenido", idle: "Inactivo",
      approval: "Esperando tu aprobación", ask: "Te ha preguntado algo",
      stuck: "Sin progreso desde hace {n}", noProgress: "Sin progreso",
      copyResume: "Copiar comando de reanudación", copySession: "Copiar id de sesión", copied: "Copiado",
      justNow: "ahora mismo", sAgo: "hace {n} s", mAgo: "hace {n} min", hAgo: "hace {n} h", dAgo: "hace {n} d",
      empty: "Ningún agente ha trabajado en los últimos dos días. Abre Claude Code, Codex, DeepSeek Harness, Gemini CLI… y entrará aquí.",
      noFile: "Iniciando… el plugin lee las sesiones de tus agentes en el host de plugins de magpie.",
      demo: "Agentes de ejemplo", showDone: "Mostrar agentes terminados", showText: "Mostrar preguntas y respuestas",
      showSub: "Mostrar subagentes", showIdle: "Mostrar agentes inactivos", agents: "Agentes", allAgents: "Todos los agentes",
      language: "Idioma", auto: "Auto", scene: "Escena",
      hideAfter: "Salir de la oficina tras", h1: "1 hora", h6: "6 horas", h24: "24 horas", never: "Nunca",
      demoOn: "Mostrando agentes de ejemplo", turns: "{n} turnos", noPrompt: "(sin pregunta)",
      project: "Carpeta", model: "Modelo", status: "Estado", task: "Tarea", last: "Última actividad", agent: "Agente",
      quiet: "Texto desactivado: solo se guardan los estados",
      floating: "La oficina tiene su propia ventana: muévela, redimensiónala o pulsa ✕ para devolverla",
      pipOn: "Devolver", ran: "en marcha {n}", via: "visto por la pasarela de magpie", fromFiles: "desde su propio archivo de sesión",
      live: "en vivo", stale: "Última actualización {n}",
      today: "Hoy", turnsL: "turnos", tokensL: "tokens", agentsL: "agentes",
      topProjects: "Carpetas principales", noUsage: "Aún no hay uso registrado.",
      summaryNote: "Los totales vienen de los registros de uso de las sesiones de cada agente.",
      context: "Contexto", recent: "Conversación reciente", noMessages: "Aún no hay mensajes.",
      privateNote: "El texto está desactivado, así que la conversación está oculta.", loadingMsgs: "Cargando…",
      subAgent: "subagente", panel: "Panel", dismiss: "Cerrar", clear: "Quitar", clearTip: "Quitarlo de la oficina hasta que la sesión se mueva",
      unitS: "s", unitM: "min", unitH: "h",
    },
    fr: {
      title: "Que font mes agents ?", needYou: "Besoin de vous", working: "Au travail", doneN: "Terminé", finished: "Terminés",
      office: "Bureau", list: "Liste", pip: "Image dans l'image", settings: "Réglages",
      thinking: "Réfléchit", executing: "Exécute des outils", replying: "Rédige", waiting: "Vous attend",
      done: "Terminé", error: "Erreur", stopped: "Arrêté", idle: "Inactif",
      approval: "En attente de votre accord", ask: "Vous a posé une question",
      stuck: "Aucun progrès depuis {n}", noProgress: "Aucun progrès",
      copyResume: "Copier la commande de reprise", copySession: "Copier l'id de session", copied: "Copié",
      justNow: "à l'instant", sAgo: "il y a {n} s", mAgo: "il y a {n} min", hAgo: "il y a {n} h", dAgo: "il y a {n} j",
      empty: "Aucun agent n'a travaillé ces deux derniers jours. Lancez Claude Code, Codex, DeepSeek Harness, Gemini CLI… et il entrera ici.",
      noFile: "Démarrage… le plugin lit les sessions de vos agents dans l'hôte de plugins de magpie.",
      demo: "Agents d'exemple", showDone: "Afficher les agents terminés", showText: "Afficher les questions et réponses",
      showSub: "Afficher les sous-agents", showIdle: "Afficher les agents inactifs", agents: "Agents", allAgents: "Tous les agents",
      language: "Langue", auto: "Auto", scene: "Scène",
      hideAfter: "Quitter le bureau après", h1: "1 heure", h6: "6 heures", h24: "24 heures", never: "Jamais",
      demoOn: "Affichage des agents d'exemple", turns: "{n} tours", noPrompt: "(aucune question)",
      project: "Dossier", model: "Modèle", status: "Statut", task: "Tâche", last: "Dernière activité", agent: "Agent",
      quiet: "Texte désactivé : seuls les statuts sont gardés",
      floating: "Le bureau a sa propre fenêtre : déplacez-la, redimensionnez-la ou cliquez sur ✕ pour la remettre",
      pipOn: "Remettre", ran: "en cours {n}", via: "vu via la passerelle magpie", fromFiles: "depuis son propre fichier de session",
      live: "en direct", stale: "Dernière mise à jour {n}",
      today: "Aujourd'hui", turnsL: "tours", tokensL: "jetons", agentsL: "agents",
      topProjects: "Dossiers principaux", noUsage: "Aucune utilisation enregistrée pour l'instant.",
      summaryNote: "Les totaux viennent des relevés d'usage des fichiers de session de chaque agent.",
      context: "Contexte", recent: "Conversation récente", noMessages: "Pas encore de messages.",
      privateNote: "Le texte est désactivé, la conversation est masquée.", loadingMsgs: "Chargement…",
      subAgent: "sous-agent", panel: "Panneau", dismiss: "Fermer", clear: "Retirer", clearTip: "Retirer du bureau jusqu'au prochain mouvement de la session",
      unitS: "s", unitM: "min", unitH: "h",
    },
    de: {
      title: "Was machen meine Agents?", needYou: "Braucht dich", working: "Arbeitet", doneN: "Fertig", finished: "Beendet",
      office: "Büro", list: "Liste", pip: "Bild im Bild", settings: "Einstellungen",
      thinking: "Denkt nach", executing: "Führt Tools aus", replying: "Schreibt Antwort", waiting: "Wartet auf dich",
      done: "Fertig", error: "Fehler", stopped: "Angehalten", idle: "Inaktiv",
      approval: "Wartet auf deine Freigabe", ask: "Hat dich etwas gefragt",
      stuck: "Seit {n} kein Fortschritt", noProgress: "Kein Fortschritt",
      copyResume: "Fortsetzen-Befehl kopieren", copySession: "Sitzungs-ID kopieren", copied: "Kopiert",
      justNow: "gerade eben", sAgo: "vor {n} s", mAgo: "vor {n} min", hAgo: "vor {n} h", dAgo: "vor {n} T",
      empty: "In den letzten zwei Tagen war kein Agent tätig. Starte Claude Code, Codex, DeepSeek Harness, Gemini CLI… und er kommt herein.",
      noFile: "Startet… das Plugin liest die Sitzungen deiner Agenten im magpie-Plugin-Host.",
      demo: "Beispiel-Agenten", showDone: "Beendete Agenten zeigen", showText: "Fragen und Antworten zeigen",
      showSub: "Subagenten zeigen", showIdle: "Inaktive Agenten zeigen", agents: "Agents", allAgents: "Alle Agents",
      language: "Sprache", auto: "Auto", scene: "Szene",
      hideAfter: "Büro verlassen nach", h1: "1 Stunde", h6: "6 Stunden", h24: "24 Stunden", never: "Nie",
      demoOn: "Beispiel-Agenten werden gezeigt", turns: "{n} Runden", noPrompt: "(keine Frage)",
      project: "Ordner", model: "Modell", status: "Status", task: "Aufgabe", last: "Zuletzt aktiv", agent: "Agent",
      quiet: "Text aus: nur Status werden behalten",
      floating: "Das Büro hat hier sein eigenes Fenster: verschieben, skalieren oder mit ✕ zurückholen",
      pipOn: "Zurückholen", ran: "läuft {n}", via: "über magpies Gateway gesehen", fromFiles: "aus seiner eigenen Sitzungsdatei",
      live: "live", stale: "Letzte Aktualisierung {n}",
      today: "Heute", turnsL: "Runden", tokensL: "Tokens", agentsL: "Agents",
      topProjects: "Top-Ordner", noUsage: "Noch keine Nutzung erfasst.",
      summaryNote: "Die Summen stammen aus den Nutzungsdaten der Sitzungsdateien der Agenten.",
      context: "Kontext", recent: "Letzte Unterhaltung", noMessages: "Noch keine Nachrichten.",
      privateNote: "Text ist aus, daher ist die Unterhaltung verborgen.", loadingMsgs: "Lädt…",
      subAgent: "Subagent", panel: "Seitenleiste", dismiss: "Schließen", clear: "Entfernen", clearTip: "Aus dem Büro entfernen, bis sich die Sitzung bewegt",
      unitS: "s", unitM: "min", unitH: "Std",
    },
    pt: {
      title: "O que meus agentes estão fazendo?", needYou: "Precisam de você", working: "Trabalhando", doneN: "Concluído", finished: "Concluídos",
      office: "Escritório", list: "Lista", pip: "Imagem em imagem", settings: "Configurações",
      thinking: "Pensando", executing: "Executando ferramentas", replying: "Escrevendo", waiting: "Esperando você",
      done: "Concluído", error: "Erro", stopped: "Parado", idle: "Ocioso",
      approval: "Aguardando sua aprovação", ask: "Perguntou algo a você",
      stuck: "Sem progresso há {n}", noProgress: "Sem progresso",
      copyResume: "Copiar comando de retomar", copySession: "Copiar id da sessão", copied: "Copiado",
      justNow: "agora mesmo", sAgo: "há {n} s", mAgo: "há {n} min", hAgo: "há {n} h", dAgo: "há {n} d",
      empty: "Nenhum agente trabalhou nos últimos dois dias. Abra Claude Code, Codex, DeepSeek Harness, Gemini CLI… e ele entra aqui.",
      noFile: "Iniciando… o plugin lê as sessões dos seus agentes no host de plugins do magpie.",
      demo: "Agentes de exemplo", showDone: "Mostrar agentes finalizados", showText: "Mostrar perguntas e respostas",
      showSub: "Mostrar subagentes", showIdle: "Mostrar agentes ociosos", agents: "Agentes", allAgents: "Todos os agentes",
      language: "Idioma", auto: "Auto", scene: "Cenário",
      hideAfter: "Sair do escritório após", h1: "1 hora", h6: "6 horas", h24: "24 horas", never: "Nunca",
      demoOn: "Mostrando agentes de exemplo", turns: "{n} turnos", noPrompt: "(sem pergunta)",
      project: "Pasta", model: "Modelo", status: "Status", task: "Tarefa", last: "Última atividade", agent: "Agente",
      quiet: "Texto desativado: só os status são mantidos",
      floating: "O escritório tem a própria janela aqui: mova, redimensione ou ✕ para devolver",
      pipOn: "Devolver", ran: "rodando {n}", via: "visto pelo gateway do magpie", fromFiles: "do próprio arquivo de sessão",
      live: "ao vivo", stale: "Última atualização {n}",
      today: "Hoje", turnsL: "turnos", tokensL: "tokens", agentsL: "agentes",
      topProjects: "Pastas principais", noUsage: "Ainda sem uso registrado.",
      summaryNote: "Os totais vêm dos registros de uso das sessões de cada agente.",
      context: "Contexto", recent: "Conversa recente", noMessages: "Ainda não há mensagens.",
      privateNote: "O texto está desativado, então a conversa fica oculta.", loadingMsgs: "Carregando…",
      subAgent: "subagente", panel: "Painel", dismiss: "Fechar", clear: "Remover", clearTip: "Remover do escritório até a sessão se mover",
      unitS: "s", unitM: "min", unitH: "h",
    },
  }
  const LANGS = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "pt"]
  const LANG_NAMES = {
    en: "English", "zh-CN": "简体中文", "zh-TW": "繁體中文", ja: "日本語", ko: "한국어",
    es: "Español", fr: "Français", de: "Deutsch", pt: "Português",
  }
  Object.defineProperty(TEXT, "zh", { value: TEXT["zh-CN"], enumerable: false })
  // the six the page draws, in the legend's order
  const STATUSES = ["thinking", "executing", "replying", "waiting", "done", "error"]
  const COLORS = { thinking: "#8b6cf6", executing: "#3b82f6", replying: "#10b981", waiting: "#f59e0b", done: "#22a35a", error: "#ef4444", idle: "#9ca3af" }
  const HIDE = { "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3, never: Infinity }
  const DEFAULTS = {
    mode: "office", dim: "3d", scene: "office", quality: "medium", demo: false, showDone: true,
    hideAfter: "6h", approvalAfterSec: 90, agents: [], showSub: true, showIdle: true, side: true,
    lang: "auto", progress: true, text: true, cleared: {},
  }
  // a turn whose file hasn't moved this long has made no progress
  const NOPROGRESS_MS = 8 * 60e3
  const STUCK_MS = 10 * 60e3
  // a finished session nobody has touched for this long is idling about
  const IDLE_MS = 20 * 60e3

  // Map a locale like "zh-HK", "pt-BR" or "en-US" to one we have.
  function normalizeLang(code) {
    const s = String(code || "").toLowerCase()
    if (!s) return ""
    if (s === "zh" || s.startsWith("zh-hans") || /^zh-(cn|sg|my)/.test(s)) return "zh-CN"
    if (s.startsWith("zh")) return "zh-TW"
    const base = s.split("-")[0]
    return LANGS.includes(base) ? base : ""
  }
  function text(lang) {
    return TEXT[normalizeLang(lang)] || TEXT.en
  }
  function fill(s, n) { return String(s).replace("{n}", n) }

  // The language of a prompt, for CJK scripts only: Latin prompts say
  // nothing about which UI language to use.
  const TRADITIONAL = /[這個們說時間對麼為與動檔設開關點錯誤務資讀寫頁於後裡嗎沒還進來]/
  function scriptLang(sample) {
    const s = String(sample || "")
    let han = 0, kana = 0, hangul = 0
    for (const ch of s) {
      const c = ch.codePointAt(0)
      if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff)) kana++
      else if (c >= 0x4e00 && c <= 0x9fff) han++
      else if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) hangul++
    }
    if (kana) return "ja"
    if (hangul) return "ko"
    if (han) return TRADITIONAL.test(s) ? "zh-TW" : "zh-CN"
    return ""
  }
  // Manual pick, then the prompt's script, then magpie's UI theme, then the
  // browser, then English.
  function detectLang(o = {}) {
    const manual = normalizeLang(o.manual)
    if (manual) return manual
    const script = scriptLang(o.sample)
    if (script) return script
    const theme = normalizeLang(o.theme)
    if (theme) return theme
    for (const n of (Array.isArray(o.nav) ? o.nav : [o.nav])) {
      const c = normalizeLang(n)
      if (c) return c
    }
    return "en"
  }
  // the newest prompt/title in a snapshot, the sample the script check reads
  function sample(snap) {
    let best = null
    for (const s of Array.isArray(snap?.sessions) ? snap.sessions : []) {
      const t = [s?.query, s?.title].filter(Boolean).join(" ")
      if (!t) continue
      const at = Math.max(s.updated || 0, s.touched || 0, s.last?.at || 0, s.started || 0)
      if (!best || at > best.at) best = { at, text: t }
    }
    return best ? best.text : ""
  }

  function hash(s) {
    let h = 2166136261
    for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619)
    return h >>> 0
  }

  // an agent as magpie names it, with its own icon (page/agents.js)
  function brand(agent) {
    const all = globalThis.AgentOfficeAgents || {}
    const id = String(agent || "agent")
    const a = all[id] || all[id.replace(/-cli$/, "")] || null
    const color = a?.color || `hsl(${hash(id) % 360} 55% 45%)`
    return { id, name: a?.name || id, icon: a?.icon || "", color }
  }

  // { status, sub }: status one of STATUSES; sub says more (approval, ask,
  // stopped, noprog, stuck) for the card and the list. `progress: true` is
  // the workbench's reading: a stalled turn still works, it merely says it
  // has made no progress. Without it the older reading is kept.
  function state(s, now, opts = {}) {
    if (s.source === "files" || s.phase) {
      const quiet = now - (s.touched || s.updated || now)
      switch (s.phase) {
        case "approval": return { status: "waiting", sub: "approval" }
        case "ask": return { status: "waiting", sub: "ask" }
        case "error": return { status: "error", sub: "" }
        case "aborted": return { status: "done", sub: "stopped" }
        case "done": return { status: "done", sub: "" }
        case "tool":
          if (quiet > STUCK_MS) return opts.progress ? { status: "executing", sub: "stuck" } : { status: "error", sub: "stuck" }
          return { status: "executing", sub: "" }
        case "thinking": default:
          if (s.reply && quiet < 4000) return { status: "replying", sub: "" }
          if (quiet > (opts.progress ? NOPROGRESS_MS : STUCK_MS)) {
            return opts.progress ? { status: "thinking", sub: "noprog" } : { status: "error", sub: "stuck" }
          }
          return { status: "thinking", sub: "" }
      }
    }
    // only the gateway saw it: from its requests
    const approval = (Number(opts.approvalAfterSec) || DEFAULTS.approvalAfterSec) * 1000
    if (s.inflight > 0) return { status: now - (s.inflightSince || now) > 8000 ? "replying" : "thinking", sub: "" }
    const l = s.last
    if (!l) return { status: "thinking", sub: "" }
    if (l.outcome === "error") return { status: "error", sub: "" }
    if (l.outcome === "ask") return { status: "waiting", sub: "ask" }
    if (l.outcome === "tools") return now - l.at > approval ? { status: "waiting", sub: "approval" } : { status: "executing", sub: "" }
    return { status: "done", sub: "" }
  }
  function status(s, now, opts) { return state(s, now, opts).status }

  // what the user may clear: an agent not at work. A stuck one (error), a
  // stopped or finished one, and one waiting on a process that may be gone.
  function clearable(st) { return st === "done" || st === "error" || st === "waiting" }

  function ago(ms, lang) {
    const t = text(lang)
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 10) return t.justNow
    if (s < 60) return fill(t.sAgo, s)
    if (s < 3600) return fill(t.mAgo, Math.floor(s / 60))
    if (s < 86400) return fill(t.hAgo, Math.floor(s / 3600))
    return fill(t.dAgo, Math.floor(s / 86400))
  }

  // 45 000 → "45s"; 130 000 → "2m 10s"; 3 900 000 → "1h 5m"
  function duration(ms, lang) {
    const w = text(lang)
    const code = normalizeLang(lang)
    const cjk = code === "zh-CN" || code === "zh-TW" || code === "ja" || code === "ko"
    const gap = cjk ? "" : " "
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return s + w.unitS
    const m = Math.floor(s / 60), r = s % 60
    if (m < 60) return m + w.unitM + (r ? gap + r + w.unitS : "")
    const h = Math.floor(m / 60), mm = m % 60
    return h + w.unitH + (mm ? gap + mm + w.unitM : "")
  }

  function shellQuote(s) {
    return /^[A-Za-z0-9._:@%+=/-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`
  }

  // the command that picks the session up again, where the agent has one
  function resume(s) {
    // a reader that already knows the agent's own resume syntax wins
    if (typeof s.resumeCommand === "string" && s.resumeCommand) return s.resumeCommand
    const id0 = String(s.session || "")
    if (!id0 || id0.startsWith("cwd:") || id0.startsWith("model:")) return ""
    const id = shellQuote(id0)
    const cd = s.cwd ? `cd ${shellQuote(s.cwd)} && ` : ""
    switch (s.agent) {
      case "claude": return `${cd}claude --resume ${id}`
      case "codex": return `${cd}codex resume ${id}`
      case "opencode": return `${cd}opencode --session ${id}`
      case "gemini": return `${cd}gemini --resume ${id}`
      case "qwen": return `${cd}qwen --resume ${id}`
      case "pi": return `${cd}pi --session ${id}`
      case "copilot": return `${cd}copilot --resume ${id}`
      case "kimi": return `${cd}kimi --session ${id}`
      case "grok": return `${cd}grok --resume ${id}`
      case "omp": return `${cd}omp --resume ${id}`
      case "dsh": return `${cd}dsh --resume ${shellQuote(id0.replace(/^session-/, ""))}`
      default: return ""
    }
  }

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0 }

  // How full the model's context window is. `context` may be a number of
  // used tokens or {used, window}; contextWindow overrides the window.
  function context(a) {
    if (!a) return null
    let used = null, window = 0
    const c = a.context
    if (typeof c === "number") used = c
    else if (c && typeof c === "object") {
      if (c.used != null) used = num(c.used)
      if (c.window != null) window = num(c.window)
    }
    if (a.contextWindow != null) window = num(a.contextWindow)
    if (used == null || !(window > 0)) return null
    const pct = Math.max(0, Math.min(100, Math.round((used / window) * 100)))
    return { used: Math.round(used), window: Math.round(window), pct, level: pct >= 85 ? "full" : pct >= 60 ? "warn" : "ok" }
  }

  function fmtTokens(n) {
    n = num(n)
    if (n < 1000) return String(Math.round(n))
    if (n < 1e6) return n < 1e4 ? (n / 1e3).toFixed(1) + "k" : Math.round(n / 1e3) + "k"
    return n < 1e7 ? (n / 1e6).toFixed(2) + "M" : (n / 1e6).toFixed(1) + "M"
  }

  // the agents to draw: [{ key, agent, brand, title, status, sub, at, … }]
  function agents(snap, now, opts = {}) {
    const o = { ...DEFAULTS, ...opts }
    const hide = HIDE[o.hideAfter] ?? HIDE["6h"]
    const picked = Array.isArray(o.agents) ? o.agents.filter((x) => typeof x === "string") : []
    const cleared = o.cleared && typeof o.cleared === "object" ? o.cleared : {}
    const out = []
    for (const s of Array.isArray(snap?.sessions) ? snap.sessions : []) {
      if (!s || typeof s.key !== "string") continue
      if (picked.length && !picked.includes(s.agent)) continue
      const subagent = !!(s.subagent || s.isSubagent || (s.parent && s.parent !== s.key))
      if (subagent && o.showSub === false) continue
      const { status: st, sub } = state(s, now, o)
      const at = Math.max(s.updated || 0, s.touched || 0, s.last?.at || 0)
      const quiet = now - at
      if ((st === "done" || st === "error") && quiet > hide) continue
      if (st === "done" && !o.showDone) continue
      const c = Number(cleared[s.key])
      if (c && at <= c && clearable(st)) continue
      const idle = st === "done" && quiet > IDLE_MS
      if (idle && o.showIdle === false) continue
      const b = brand(s.agent)
      // how long the current step has gone on
      const since = s.pendingSince ? now - s.pendingSince : quiet
      out.push({
        key: s.key, agent: s.agent, brand: b, session: s.session || "", status: st, sub, source: s.source || "gateway",
        idle,
        subagent,
        parent: s.parent || "",
        profile: s.profile || "",
        title: s.title || s.project || b.name, project: s.project || "", cwd: s.cwd || "",
        query: s.query || "", step: s.step || s.last?.step || "", reply: s.reply || s.last?.text || "", error: s.error || "",
        model: s.model || "", at, since, started: s.started || at, turns: s.turns || 0,
        turnsToday: s.turnsToday,
        tokensToday: s.tokensToday,
        context: s.context,
        contextWindow: s.contextWindow,
        ctx: context(s),
        messages: Array.isArray(s.messages) ? s.messages : [],
        private: s.private === true,
        noProgress: sub === "noprog" || sub === "stuck",
        resume: resume(s), seed: hash(s.key),
      })
    }
    return out
  }

  function counts(list) {
    const c = { needYou: 0, working: 0, done: 0 }
    for (const a of list) {
      // an agent that failed or stalled needs you as much as one that asked
      if (a.status === "waiting" || a.status === "error") c.needYou++
      else if (a.status === "thinking" || a.status === "executing" || a.status === "replying") c.working++
      else if (a.status === "done") c.done++
    }
    return c
  }

  // the list's order: what needs you, what works, then the rest, latest first
  const RANK = { waiting: 0, error: 1, thinking: 2, executing: 2, replying: 2, done: 3 }
  function sorted(list) {
    return list.slice().sort((a, b) => (RANK[a.status] - RANK[b.status]) || (b.at - a.at))
  }

  // the workbench's three groups, in the order they matter
  const GROUPS = [
    { key: "needYou", match: (a) => a.status === "waiting" || a.status === "error" },
    { key: "working", match: (a) => a.status === "thinking" || a.status === "executing" || a.status === "replying" },
    { key: "finished", match: (a) => a.status === "done" },
  ]
  function groups(list) {
    return GROUPS.map((g) => ({
      key: g.key,
      list: list.filter((a) => g.match(a)).sort((a, b) => b.at - a.at),
    }))
  }

  // Today's turns and tokens, per agent and per folder, plus each session's
  // context fullness. Sessions without the fields simply don't contribute.
  function today(list) {
    const byAgent = {}
    const projects = {}
    const contexts = []
    let turns = 0, tokens = 0, hasUsage = false
    for (const a of list) {
      // readers write 0 when the file says nothing, so only positive counts
      // are usage; all-zero sessions must not look like a busy day
      const hasTurns = a.turnsToday != null && Number.isFinite(Number(a.turnsToday)) && Number(a.turnsToday) > 0
      const hasTokens = a.tokensToday != null && Number.isFinite(Number(a.tokensToday)) && Number(a.tokensToday) > 0
      const at = hasTurns ? num(a.turnsToday) : 0
      const ak = hasTokens ? num(a.tokensToday) : 0
      if (hasTurns || hasTokens) {
        hasUsage = true
        turns += at
        tokens += ak
        const id = a.agent || a.brand?.id || "agent"
        const row = byAgent[id] || (byAgent[id] = { agent: id, name: a.brand?.name || id, turns: 0, tokens: 0 })
        row.turns += at
        row.tokens += ak
        const project = a.project || a.brand?.name || id
        const p = projects[project] || (projects[project] = { project, turns: 0, tokens: 0 })
        p.turns += at
        p.tokens += ak
      }
      const c = a.ctx || context(a)
      if (c) contexts.push({ key: a.key, agent: a.agent, name: a.brand?.name || a.agent, project: a.project || "", ...c })
    }
    const projectList = Object.values(projects)
      .filter((p) => p.turns > 0 || p.tokens > 0)
      .sort((a, b) => b.turns - a.turns || b.tokens - a.tokens)
      .slice(0, 5)
    return {
      hasUsage, turns, tokens,
      agentCount: Object.keys(byAgent).length,
      byAgent,
      projects: projectList,
      contexts: contexts.sort((a, b) => b.pct - a.pct),
    }
  }

  // the page's own side of text off: whatever live.js holds, no prompt,
  // reply, error, tool argument or conversation is shown. A tool step keeps
  // its name only.
  function redact(list) {
    return list.map((a) => {
      const step = String(a.step || "")
      const name = step.includes(" · ") ? step.split(" · ")[0]
        : /^[A-Za-z0-9_.-]{1,40}$/.test(step) ? step : ""
      return {
        ...a, title: a.project || a.brand?.name || a.agent || "", query: "", reply: "", error: "", step: name,
        messages: [], private: true,
      }
    })
  }

  // what the page draws: what the host wrote, and, with sample agents on,
  // theirs beside it — never instead of it
  function merge(real, demo) {
    const sessions = [...(Array.isArray(real?.sessions) ? real.sessions : []), ...(Array.isArray(demo?.sessions) ? demo.sessions : [])]
    return { ...(real || {}), sessions, demo: true }
  }

  // sample agents, for a first look (Settings › Sample agents)
  function demo(now) {
    const m = 60e3
    const msg = (role, text, name, at) => ({ role, text, name, at })
    const S = (agent, session, cwd, title, query, model, phase, extra) => ({
      key: `demo|${agent}|${session}`, source: "files", agent, session, cwd, project: cwd.split("/").pop(), title, query, model,
      started: now - 50 * m, updated: now - 1000, touched: now - 1000, phase, turns: 3,
      turnsToday: 1, tokensToday: 2400, context: 48000, contextWindow: 200000,
      messages: [
        msg("user", query, "", now - 40 * m),
        msg("assistant", "收到，我先看一下现状。", "assistant", now - 39 * m),
      ],
      ...extra,
    })
    return { v: 2, written: now, text: true, demo: true, sessions: [
      S("codex", "demo-1", "/Users/me/blog", "封面图", "用 punk skill 生成文章封面", "gpt-6-astra", "done",
        { touched: now - 28 * m, updated: now - 28 * m, step: "image_gen · cover.png", reply: "已用内置生图完成「方块世界」封面，PNG · 1600×900，放进 assets/cover.png。",
          turnsToday: 3, tokensToday: 18200, context: 96000,
          messages: [
            msg("user", "用 punk skill 生成文章封面", "", now - 46 * m),
            msg("assistant", "我先读一下文章结构，再定封面方向。", "assistant", now - 45 * m),
            msg("tool", "image_gen · cover.png", "", now - 30 * m),
            msg("assistant", "已用内置生图完成「方块世界」封面，PNG · 1600×900，放进 assets/cover.png。", "assistant", now - 28 * m),
          ] }),
      S("claude", "demo-2", "/Users/me/oh-my-x", "oh-my-x", "给 CLI 加一个 --json 输出", "claude-opus-5", "tool",
        { touched: now - 3000, pendingSince: now - 42000, step: "Bash · bun test", context: 172000,
          messages: [
            msg("user", "给 CLI 加一个 --json 输出", "", now - 12 * m),
            msg("tool", "Bash · bun test", "", now - 42e3),
          ] }),
      S("claude", "demo-3", "/Users/me/x", "X 选题", "下周发什么？给我 5 个选题", "claude-sonnet-5", "ask",
        { touched: now - 2 * m, step: "AskUserQuestion · 工具测评还是工作流？", reply: "我列了 5 个方向。你更想写工具测评，还是写自己的工作流？",
          turnsToday: 1, tokensToday: 3600, context: 118000,
          messages: [
            msg("user", "下周发什么？给我 5 个选题", "", now - 8 * m),
            msg("assistant", "我列了 5 个方向。你更想写工具测评，还是写自己的工作流？", "assistant", now - 2 * m),
          ] }),
      S("dsh", "demo-4", "/Users/me/site", "站点部署", "部署到 Cloudflare Pages", "deepseek-flash", "approval",
        { touched: now - 40000, step: "bash · wrangler pages deploy ./dist", turnsToday: 0, tokensToday: 5800, context: 76000 }),
      S("gemini", "demo-5", "/Users/me/music", "自动修歌", "把副歌的节拍对齐到 120 BPM", "gemini-3-pro", "thinking",
        { touched: now - 1500, reply: "", turnsToday: 1, tokensToday: 2100, context: 45000 }),
      S("qwen", "demo-6", "/Users/me/notes", "工具整理", "整理这周收藏的工具和思路", "qwen3-coder", "done",
        { touched: now - 40 * m, updated: now - 40 * m, reply: "整理好了：12 个工具、5 条思路，按「写作 / 编程 / 效率」分组写进 weekly.md。",
          turnsToday: 3, tokensToday: 9800, context: 64000 }),
      S("codex", "demo-7", "/Users/me/app", "支付接入", "接入 Stripe 订阅", "gpt-6.1-terra", "error",
        { touched: now - 6 * m, error: "429: usage limit reached", step: "exec · npm run test:e2e", turnsToday: 1, tokensToday: 1200, context: 88000 }),
    ] }
  }

  globalThis.AgentOfficeModel = {
    TEXT, LANGS, LANG_NAMES, STATUSES, COLORS, DEFAULTS, HIDE, GROUPS, clearable,
    NOPROGRESS_MS, STUCK_MS, IDLE_MS,
    text, normalizeLang, scriptLang, detectLang, sample, fill, hash, brand,
    state, status, ago, duration, resume,
    context, fmtTokens, today, agents, counts, sorted, groups,
    demo, merge, redact,
  }
})()
