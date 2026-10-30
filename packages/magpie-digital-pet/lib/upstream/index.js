// ../digital-pet-intl/assets/i18n/en.json
var en_default = {
  "language.label": "Language",
  "language.description": "Choose the language for this device.",
  "language.en": "English",
  "language.ko": "\uD55C\uAD6D\uC5B4",
  "language.es": "Espa\xF1ol",
  "language.gl": "Galego"
};

// ../digital-pet-intl/assets/i18n/es.json
var es_default = {
  "language.label": "Idioma",
  "language.description": "Elige el idioma de este dispositivo.",
  "language.en": "English",
  "language.ko": "\uD55C\uAD6D\uC5B4",
  "language.es": "Espa\xF1ol",
  "language.gl": "Galego"
};

// ../digital-pet-intl/assets/i18n/gl.json
var gl_default = {
  "language.label": "Idioma",
  "language.description": "Escolle o idioma deste dispositivo.",
  "language.en": "English",
  "language.ko": "\uD55C\uAD6D\uC5B4",
  "language.es": "Espa\xF1ol",
  "language.gl": "Galego"
};

// ../digital-pet-intl/assets/i18n/ko.json
var ko_default = {
  "language.label": "\uC5B8\uC5B4",
  "language.description": "\uC774 \uAE30\uAE30\uC5D0\uC11C \uC0AC\uC6A9\uD560 \uC5B8\uC5B4\uB97C \uC120\uD0DD\uD558\uC138\uC694.",
  "language.en": "English",
  "language.ko": "\uD55C\uAD6D\uC5B4",
  "language.es": "Espa\xF1ol",
  "language.gl": "Galego"
};

// ../digital-pet-intl/src/intl.browser.js
var SUPPORTED_LOCALES = Object.freeze(["en", "ko", "es", "gl"]);
function normalizeLocale(value) {
  if (typeof value !== "string") return void 0;
  const language = value.trim().toLowerCase().replaceAll("_", "-").split(/[.\-@]/)[0];
  return language === "en" || language === "ko" || language === "es" || language === "gl" ? language : void 0;
}
function resolveLocale(preferred, languages = []) {
  const chosen = normalizeLocale(preferred);
  if (chosen) return chosen;
  for (const language of languages) {
    const supported = normalizeLocale(language);
    if (supported) return supported;
  }
  return "en";
}
function lookup(dictionary, key) {
  if (!dictionary) return void 0;
  if (Object.hasOwn(dictionary, key) && typeof dictionary[key] === "string") return dictionary[key];
  let value = dictionary;
  for (const part of key.split(".")) {
    if (!value || typeof value === "string" || !Object.hasOwn(value, part)) return void 0;
    value = value[part];
  }
  return typeof value === "string" ? value : void 0;
}
function createIntlModule(initialLocale = "en") {
  let locale = initialLocale;
  const catalogs3 = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Set();
  const module = {
    get locale() {
      return locale;
    },
    /** @param {unknown} value */
    setLocale(value) {
      const next = resolveLocale(value);
      if (next === locale) return;
      locale = next;
      for (const listener of listeners) listener(locale);
    },
    /** @param {string} namespace @param {Catalogs} translations */
    register(namespace, translations) {
      catalogs3.set(namespace, translations);
      return module.scope(namespace);
    },
    /** @param {(locale: Locale) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** @param {string} key @param {Parameters} parameters @param {string} namespace */
    translate(key, parameters = {}, namespace = "intl") {
      const translations = catalogs3.get(namespace);
      const text = lookup(translations?.[locale], key) ?? lookup(translations?.en, key) ?? key;
      return text.replace(
        /\{([\w]+)\}/g,
        (placeholder, name) => Object.hasOwn(parameters, name) ? String(parameters[name]) : placeholder
      );
    },
    /** @param {string} namespace */
    scope(namespace) {
      return {
        get locale() {
          return locale;
        },
        setLocale: module.setLocale,
        subscribe: module.subscribe,
        /** @param {string} key @param {Parameters} parameters */
        translate: (key, parameters = {}) => module.translate(key, parameters, namespace)
      };
    }
  };
  return module;
}
function getIntlModule() {
  const key = /* @__PURE__ */ Symbol.for("digital-pet.intl");
  const registry = (
    /** @type {Record<symbol, ReturnType<typeof createIntlModule>>} */
    /** @type {unknown} */
    globalThis
  );
  const existing = registry[key];
  if (existing) return existing;
  const module = createIntlModule();
  registry[key] = module;
  return module;
}

// ../digital-pet-intl/src/index.ts
var IntlModule = getIntlModule();
var intlCatalogs = { en: en_default, es: es_default, gl: gl_default, ko: ko_default };
IntlModule.register("intl", intlCatalogs);

// ../digital-pet-core/assets/i18n/en.json
var en_default2 = {
  "sidebarViewModel.noActivePartner": "No active partner",
  "stages.egg": "DigiEgg",
  "stages.babyI": "In Training I",
  "stages.babyII": "In Training II",
  "stages.child": "Rookie",
  "stages.adult": "Champion",
  "stages.perfect": "Ultimate",
  "stages.ultimate": "Mega",
  "stages.superUltimate": "Ultra",
  "legacyStages.egg": "Digitama",
  "legacyStages.babyI": "Baby I",
  "legacyStages.babyII": "Baby II",
  "legacyStages.child": "Child",
  "legacyStages.adult": "Adult",
  "legacyStages.perfect": "Perfect",
  "legacyStages.ultimate": "Ultimate",
  "legacyStages.superUltimate": "SuperUltimate",
  "errors.invalidHygieneState": "Invalid hygiene state",
  "errors.invalidCombatSeed": "Invalid combat seed",
  "errors.invalidCombatStats": "Combat stats must be integers in [0, 100]",
  "errors.invalidCombatRandom": "Combat random must be in [0, 1)",
  "errors.invalidEvolutionThresholds": "Evolution thresholds must be a complete frozen policy of positive finite numbers",
  "errors.noPendingBattle": "Cannot resolve evolution battle without a pending battle",
  "errors.invalidEvolutionOpponent": "Invalid evolution battle opponent",
  "errors.noEvolutionOptions": "Evolution target selection failed: partner has no evolution options",
  "errors.evolutionSelectionFailed": "Evolution target selection failed",
  "errors.opponentSelectionFailed": "Same-stage opponent selection failed",
  "errors.missingTrainerState": "Trainer state row is missing",
  "errors.missingControlState": "Digital Pet control state row is missing",
  "errors.generationAllocationFailed": "Generation allocation failed"
};

// ../digital-pet-core/assets/i18n/es.json
var es_default2 = {
  "sidebarViewModel.noActivePartner": "No hay compa\xF1ero activo",
  "stages.egg": "Digihuevo",
  "stages.babyI": "Beb\xE9 I",
  "stages.babyII": "Beb\xE9 II",
  "stages.child": "Infantil",
  "stages.adult": "Adulto",
  "stages.perfect": "Perfecto",
  "stages.ultimate": "Supremo",
  "stages.superUltimate": "Supremo II",
  "legacyStages.egg": "Digitama",
  "legacyStages.babyI": "Baby I",
  "legacyStages.babyII": "Baby II",
  "legacyStages.child": "Child",
  "legacyStages.adult": "Adult",
  "legacyStages.perfect": "Perfect",
  "legacyStages.ultimate": "Perfecto",
  "legacyStages.superUltimate": "SuperUltimate",
  "errors.invalidHygieneState": "Estado de higiene no v\xE1lido",
  "errors.invalidCombatSeed": "Semilla de combate no v\xE1lida",
  "errors.invalidCombatStats": "Las estad\xEDsticas de combate deben ser enteros entre 0 y 100",
  "errors.invalidCombatRandom": "El valor aleatorio del combate debe ser mayor o igual a 0 y menor que 1",
  "errors.invalidEvolutionThresholds": "Los umbrales de evoluci\xF3n deben definir una pol\xEDtica completa e inmutable con n\xFAmeros positivos y finitos",
  "errors.noPendingBattle": "No se puede resolver una batalla de evoluci\xF3n si no hay ninguna pendiente",
  "errors.invalidEvolutionOpponent": "Rival de la batalla de evoluci\xF3n no v\xE1lido",
  "errors.noEvolutionOptions": "No se pudo elegir la evoluci\xF3n: el compa\xF1ero no tiene evoluciones disponibles",
  "errors.evolutionSelectionFailed": "No se pudo elegir la evoluci\xF3n",
  "errors.opponentSelectionFailed": "No se pudo elegir un rival de la misma etapa",
  "errors.missingTrainerState": "No se encuentra el estado del entrenador",
  "errors.missingControlState": "No se encuentra el estado de control de Digital Pet",
  "errors.generationAllocationFailed": "No se pudo asignar la generaci\xF3n"
};

// ../digital-pet-core/assets/i18n/gl.json
var gl_default2 = {
  "sidebarViewModel.noActivePartner": "Non hai compa\xF1eiro activo",
  "stages.egg": "Dixiovo",
  "stages.babyI": "Beb\xE9 I",
  "stages.babyII": "Beb\xE9 II",
  "stages.child": "Infantil",
  "stages.adult": "Adulto",
  "stages.perfect": "Perfecto",
  "stages.ultimate": "Supremo",
  "stages.superUltimate": "Supremo II",
  "legacyStages.egg": "Digitama",
  "legacyStages.babyI": "Baby I",
  "legacyStages.babyII": "Baby II",
  "legacyStages.child": "Child",
  "legacyStages.adult": "Adult",
  "legacyStages.perfect": "Perfect",
  "legacyStages.ultimate": "Perfecto",
  "legacyStages.superUltimate": "SuperUltimate",
  "errors.invalidHygieneState": "Estado de hixiene non v\xE1lido",
  "errors.invalidCombatSeed": "Semente de combate non v\xE1lida",
  "errors.invalidCombatStats": "As estat\xEDsticas de combate deben ser enteiros entre 0 e 100",
  "errors.invalidCombatRandom": "O valor aleatorio do combate debe ser maior ou igual a 0 e menor que 1",
  "errors.invalidEvolutionThresholds": "Os limiares de evoluci\xF3n deben definir unha pol\xEDtica completa e inmutable con n\xFAmeros positivos e finitos",
  "errors.noPendingBattle": "Non se pode resolver unha batalla de evoluci\xF3n se non hai ningunha pendente",
  "errors.invalidEvolutionOpponent": "Rival da batalla de evoluci\xF3n non v\xE1lido",
  "errors.noEvolutionOptions": "Non se puido escoller a evoluci\xF3n: o compa\xF1eiro non ten evoluci\xF3ns dispo\xF1ibles",
  "errors.evolutionSelectionFailed": "Non se puido escoller a evoluci\xF3n",
  "errors.opponentSelectionFailed": "Non se puido escoller un rival da mesma etapa",
  "errors.missingTrainerState": "Non se atopa o estado do adestrador",
  "errors.missingControlState": "Non se atopa o estado de control de Digital Pet",
  "errors.generationAllocationFailed": "Non se puido asignar a xeraci\xF3n"
};

// ../digital-pet-core/assets/i18n/ko.json
var ko_default2 = {
  "sidebarViewModel.noActivePartner": "\uD65C\uC131 \uD30C\uD2B8\uB108\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4",
  "stages.egg": "\uB514\uC9C0\uD0C0\uB9C8",
  "stages.babyI": "\uC720\uB144\uAE30 I",
  "stages.babyII": "\uC720\uB144\uAE30 II",
  "stages.child": "\uC131\uC7A5\uAE30",
  "stages.adult": "\uC131\uC219\uAE30",
  "stages.perfect": "\uC644\uC804\uCCB4",
  "stages.ultimate": "\uAD81\uADF9\uCCB4",
  "stages.superUltimate": "\uCD08\uAD81\uADF9\uCCB4",
  "legacyStages.egg": "Digitama",
  "legacyStages.babyI": "Baby I",
  "legacyStages.babyII": "Baby II",
  "legacyStages.child": "Child",
  "legacyStages.adult": "Adult",
  "legacyStages.perfect": "Perfect",
  "legacyStages.ultimate": "\uC644\uC804\uCCB4",
  "legacyStages.superUltimate": "SuperUltimate",
  "errors.invalidHygieneState": "\uC704\uC0DD \uC0C1\uD0DC\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4",
  "errors.invalidCombatSeed": "\uC804\uD22C \uC2DC\uB4DC\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4",
  "errors.invalidCombatStats": "\uC804\uD22C \uB2A5\uB825\uCE58\uB294 0~100 \uC0AC\uC774\uC758 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4",
  "errors.invalidCombatRandom": "\uC804\uD22C \uB09C\uC218\uB294 0 \uC774\uC0C1 1 \uBBF8\uB9CC\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4",
  "errors.invalidEvolutionThresholds": "\uC9C4\uD654 \uAE30\uC900\uC740 \uC591\uC758 \uC720\uD55C\uC218\uB85C \uAD6C\uC131\uB41C \uC644\uC804\uD558\uACE0 \uBCC0\uACBD \uBD88\uAC00\uB2A5\uD55C \uC815\uCC45\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4",
  "errors.noPendingBattle": "\uB300\uAE30 \uC911\uC778 \uC804\uD22C\uAC00 \uC5C6\uC73C\uBA74 \uC9C4\uD654 \uC804\uD22C\uB97C \uC644\uB8CC\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4",
  "errors.invalidEvolutionOpponent": "\uC9C4\uD654 \uC804\uD22C \uC0C1\uB300\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4",
  "errors.noEvolutionOptions": "\uC9C4\uD654 \uB300\uC0C1\uC744 \uC120\uD0DD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD30C\uD2B8\uB108\uC5D0\uAC8C \uAC00\uB2A5\uD55C \uC9C4\uD654\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4",
  "errors.evolutionSelectionFailed": "\uC9C4\uD654 \uB300\uC0C1\uC744 \uC120\uD0DD\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4",
  "errors.opponentSelectionFailed": "\uAC19\uC740 \uB2E8\uACC4\uC758 \uC0C1\uB300\uB97C \uC120\uD0DD\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4",
  "errors.missingTrainerState": "\uD2B8\uB808\uC774\uB108 \uC0C1\uD0DC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4",
  "errors.missingControlState": "Digital Pet \uC81C\uC5B4 \uC0C1\uD0DC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4",
  "errors.generationAllocationFailed": "\uC138\uB300\uB97C \uBC30\uC815\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4"
};

// ../digital-pet-core/src/i18n.ts
var catalogs = { en: en_default2, es: es_default2, gl: gl_default2, ko: ko_default2 };
var IntlModule2 = IntlModule.register("core", catalogs);

// ../digital-pet-core/src/domain/evolution-options.ts
var availableEvolutionTargets = (current, uncleanPoops = 0, combatVictories = 0) => {
  if (!Number.isInteger(uncleanPoops) || uncleanPoops < 0 || uncleanPoops > 3)
    throw new Error("Evolution care must be an integer from 0 to 3");
  if (!Number.isSafeInteger(combatVictories) || combatVictories < 0) throw new Error("Invalid combat victories");
  if (!current.evolutionRoutes) return current.nextEvolutions;
  return [
    ...new Set(
      current.evolutionRoutes.filter(
        (route) => route.kind === "normal" && (route.requirements ? route.requirements.some(
          (rule) => (rule.careMask & 1 << uncleanPoops) !== 0 && combatVictories >= rule.minVictories && (rule.maxVictories === null || combatVictories <= rule.maxVictories)
        ) : (route.careMask & 1 << uncleanPoops) !== 0)
      ).map((route) => route.canonicalTargetId ?? route.targetId)
    )
  ];
};

// ../digital-pet-core/src/domain/evolution-battle.ts
var isEvolutionBranch = (current, targetId) => current.nextEvolutions.includes(targetId);
var assertEvolutionBranch = (current, targetId) => {
  if (!isEvolutionBranch(current, targetId))
    throw new Error(`Evolution ${current.id} -> ${targetId} is outside its branches`);
};
var isEvolutionBattleOpponent = (current, opponent) => opponent !== void 0 && (opponent.stage === current.stage || current.id === "5-033" && current.stage === 6 && opponent.stage === 5 || opponent.id === "5-033" && opponent.stage === 6 && current.stage === 5);
var pickEvolutionTarget = (current, selector, uncleanPoops = 0, combatVictories = 0) => {
  const targets = availableEvolutionTargets(current, uncleanPoops, combatVictories);
  if (targets.length === 0) {
    throw new Error(IntlModule2.translate("errors.noEvolutionOptions"));
  }
  const selection = selector();
  if (!Number.isFinite(selection) || selection < 0 || selection >= 1) {
    throw new Error(`Evolution selector must return a finite number in [0, 1), received ${selection}`);
  }
  const targetId = targets[Math.floor(selection * targets.length)];
  if (targetId === void 0) throw new Error(IntlModule2.translate("errors.evolutionSelectionFailed"));
  return targetId;
};
var pickRandomSameStageOpponent = (current, catalogNodes, selector) => {
  const candidates = catalogNodes.filter((node) => node.stage === current.stage && node.id !== current.id);
  if (candidates.length === 0) {
    return current.id;
  }
  const selection = selector();
  if (!Number.isFinite(selection) || selection < 0 || selection >= 1) {
    throw new Error(`Evolution selector must return a finite number in [0, 1), received ${selection}`);
  }
  const opponent = candidates[Math.floor(selection * candidates.length)];
  if (opponent === void 0) throw new Error(IntlModule2.translate("errors.opponentSelectionFailed"));
  return opponent.id;
};

// ../digital-pet-core/src/domain/stage.ts
var DIGIMON_STAGES = [0, 1, 2, 3, 4, 5, 6, 7];
var isDigimonStage = (value) => {
  return DIGIMON_STAGES.some((stage) => stage === value);
};

// ../digital-pet-core/src/domain/evolution.ts
var STAGE_GAUGE_THRESHOLDS = Object.freeze({
  0: 5e6,
  1: 1e7,
  2: 2e7,
  3: 4e7,
  4: 75e6,
  5: 125e6,
  6: 2e8,
  7: 3e8
});
var isRecord = (value) => {
  return typeof value === "object" && value !== null;
};
var isStageThresholds = (thresholds) => {
  if (!isRecord(thresholds) || !Object.isFrozen(thresholds)) return false;
  return DIGIMON_STAGES.every((stage) => {
    const threshold = thresholds[stage];
    return typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0;
  });
};
var hasPendingBattle = (state) => state.battleOpponentNodeId != null;
var applyTokenProgress = (state, tokenDelta, selector, digimonById, catalogNodes, thresholds, uncleanPoops = 0) => {
  if (!isStageThresholds(thresholds)) {
    throw new Error(IntlModule2.translate("errors.invalidEvolutionThresholds"));
  }
  if (state.isTerminal) return state;
  if (hasPendingBattle(state)) return state;
  const threshold = thresholds[state.current.stage];
  const gauge = state.gauge + tokenDelta;
  if (gauge < threshold) return { ...state, gauge };
  if (state.current.stage === 0) {
    const targetId = pickEvolutionTarget(state.current, selector, uncleanPoops);
    const target = digimonById.get(targetId);
    if (!target) throw new Error(`Evolution target ${targetId} is missing from the catalog`);
    return {
      current: target,
      gauge: 0,
      isTerminal: false,
      pendingEvolutionTargetId: null,
      battleOpponentNodeId: null
    };
  }
  const battleOpponentNodeId = pickRandomSameStageOpponent(state.current, catalogNodes, selector);
  if (digimonById.get(battleOpponentNodeId) === void 0) {
    throw new Error(`Battle opponent ${battleOpponentNodeId} is missing from the catalog`);
  }
  return {
    ...state,
    gauge: threshold,
    isTerminal: false,
    pendingEvolutionTargetId: null,
    battleOpponentNodeId
  };
};
var resolveEvolutionBattle = (state, won, digimonById, uncleanPoops = 0, selector = Math.random) => {
  const targetId = state.pendingEvolutionTargetId;
  const opponentId = state.battleOpponentNodeId;
  if (opponentId === null) {
    throw new Error(IntlModule2.translate("errors.noPendingBattle"));
  }
  if (targetId !== null) assertEvolutionBranch(state.current, targetId);
  const opponent = digimonById.get(opponentId);
  if (!isEvolutionBattleOpponent(state.current, opponent))
    throw new Error(IntlModule2.translate("errors.invalidEvolutionOpponent"));
  if (!won) {
    return {
      current: state.current,
      gauge: 0,
      isTerminal: state.isTerminal,
      pendingEvolutionTargetId: null,
      battleOpponentNodeId: null,
      combatVictories: state.combatVictories ?? 0
    };
  }
  const victories = Math.min(1e6, (state.combatVictories ?? 0) + 1);
  const eligible = availableEvolutionTargets(state.current, uncleanPoops, victories);
  const selected = targetId ?? (eligible.length ? pickEvolutionTarget(state.current, selector, uncleanPoops, victories) : void 0);
  const current = selected ? digimonById.get(selected) : state.current;
  if (!current) throw new Error(`Evolution target ${selected} is missing from the catalog`);
  return {
    current,
    gauge: 0,
    isTerminal: false,
    pendingEvolutionTargetId: null,
    battleOpponentNodeId: null,
    combatVictories: current.id === state.current.id ? victories : 0
  };
};

// ../digital-pet-core/src/application/use-cases/record-usage.ts
var recordUsage = ({
  usage,
  ledger,
  digimonById,
  catalogNodes,
  selector,
  thresholds
}) => {
  let evolution;
  let evolutionBattlePending;
  const outcome = ledger.applyUsageReceipt(usage, (partner, uncleanPoops = 0) => {
    const current = digimonById.get(partner.currentNodeId);
    if (current === void 0)
      throw new Error(`Persisted partner node ${partner.currentNodeId} is missing from the catalog`);
    const hadPendingBattle = partner.battleOpponentNodeId != null;
    const next = applyTokenProgress(
      {
        current,
        gauge: partner.gauge,
        isTerminal: partner.isTerminal,
        pendingEvolutionTargetId: partner.pendingEvolutionTargetId,
        battleOpponentNodeId: partner.battleOpponentNodeId
      },
      usage.tokenDelta,
      selector,
      digimonById,
      catalogNodes,
      thresholds,
      uncleanPoops
    );
    if (!hadPendingBattle && next.battleOpponentNodeId !== null && next.current.id === current.id) {
      evolutionBattlePending = {
        opponentNodeId: next.battleOpponentNodeId,
        targetNodeId: next.pendingEvolutionTargetId
      };
    }
    if (next.current.id !== current.id) {
      evolution = { fromNodeId: current.id, toNodeId: next.current.id };
    }
    return {
      currentNodeId: next.current.id,
      gauge: next.gauge,
      isTerminal: next.isTerminal,
      pendingEvolutionTargetId: next.pendingEvolutionTargetId,
      battleOpponentNodeId: next.battleOpponentNodeId
    };
  });
  switch (outcome.kind) {
    case "applied":
      if (evolutionBattlePending !== void 0) {
        return { kind: "applied", receiptKey: usage.receiptKey, evolutionBattlePending };
      }
      return evolution === void 0 ? { kind: "applied", receiptKey: usage.receiptKey } : { kind: "applied", receiptKey: usage.receiptKey, evolution };
    case "duplicate":
      return { kind: "duplicate", receiptKey: usage.receiptKey };
    case "no_active_partner":
      return { kind: "no_active_partner", receiptKey: usage.receiptKey };
  }
};

// ../digital-pet-core/src/application/use-cases/reconcile-usage.ts
var reconcileUsage = ({
  usages,
  ledger,
  digimonById,
  catalogNodes,
  selector,
  thresholds
}) => {
  const outcomes = [];
  for (const usage of usages) {
    outcomes.push(recordUsage({ usage, ledger, digimonById, catalogNodes, selector, thresholds }));
  }
  return outcomes;
};

// ../digital-pet-core/src/domain/combat.ts
var COMBAT_POLICY = Object.freeze({ hitsToWin: 3, maxShots: 24, scale: 25, minimum: 0.05, maximum: 0.95 });
var NEUTRAL_COMBAT_STATS = Object.freeze({ strength: 50, evasion: 50 });
var validateCombatStats = (stats) => {
  for (const value of [stats.strength, stats.evasion]) {
    if (!Number.isInteger(value) || value < 0 || value > 100)
      throw new Error(IntlModule2.translate("errors.invalidCombatStats"));
  }
  return Object.freeze({ ...stats });
};

// ../digital-pet-core/src/data/catalog-corrections.json
var catalog_corrections_default = {
  records: {
    "5-033": {
      name_jp: "DoneDevimon",
      stage: 6,
      url: "https://digimon.net/reference_en/detail.php?directory_name=donedevimon"
    }
  },
  canonicalIds: { "5-146": "5-034" },
  aliases: {
    "5-023": ["Yatagaramon (2006)"],
    "5-065": ["Loader Liomon", "LoaderLiomon"],
    "7-041": ["Agumon -Yuki no Kizuna-"],
    "7-042": ["Gabumon -Yujo no Kizuna-"]
  }
};

// ../digital-pet-core/src/data/combat-stats.ts
var COMBAT_STATS = new Map(
  [
    ["0-001", 0, 0],
    // Digiegg
    // Baby I: gentle variation around (25, 35); familiar starters receive a modest edge.
    ["1-001", 26, 34],
    // Argomon: balanced
    ["1-002", 29, 37],
    // Botamon: versatile classic
    ["1-003", 27, 38],
    // Chibomon: agile starter
    ["1-004", 25, 32],
    // Choromon: measured attacker
    ["1-005", 24, 38],
    // Conomon: evasive
    ["1-006", 28, 31],
    // Cotsucomon: offense over mobility
    ["1-007", 29, 33],
    // Dodomon: assertive attacker
    ["1-008", 23, 40],
    // Fufumon: elusive
    ["1-009", 26, 36],
    // Keemon: balanced
    ["1-010", 27, 34],
    // Ketomon: offensive leaning
    ["1-011", 28, 36],
    // Kuramon: accurate, still mobile
    ["1-012", 22, 39],
    // Mokumon: evasive specialist
    ["1-013", 23, 36],
    // Nyokimon: defensive leaning
    ["1-014", 24, 37],
    // Pabumon: defensive leaning
    ["1-015", 30, 31],
    // Petitmon: strongest attack, low evasion
    ["1-016", 22, 38],
    // Pichimon: evasive specialist
    ["1-017", 24, 41],
    // Poyomon: elusive classic
    ["1-018", 30, 35],
    // Punimon: offensive classic
    ["1-019", 23, 39],
    // Pururumon: elusive
    ["1-020", 25, 39],
    // Puttimon: defensive balance
    ["1-021", 28, 32],
    // Sakumon: offensive specialist
    ["1-022", 26, 37],
    // Tsubumon: steady all-rounder
    ["1-023", 24, 40],
    // YukimiBotamon: evasive starter
    ["1-024", 25, 40],
    // Yuramon: defensive classic
    ["1-025", 27, 35],
    // Zerimon: offensive balance
    ["1-026", 25, 34],
    // Zurumon: balanced
    ["1-027", 26, 38],
    // Chibickmon: mobile all-rounder
    ["1-028", 26, 33],
    // Dokimon: offensive leaning
    ["1-029", 30, 33],
    // Jyarimon: offensive starter
    ["1-030", 23, 41],
    // Relemon: elusive specialist
    ["1-031", 28, 34],
    // Sandmon: offensive balance
    // Baby II: variation around (35, 40); distinct roles with no overwhelming starter.
    ["2-001", 37, 38],
    // Argomon: offensive balance
    ["2-002", 39, 36],
    // Bebydomon: offensive specialist
    ["2-003", 34, 41],
    // Budmon: defensive balance
    ["2-004", 35, 46],
    // Bukamon: evasive classic
    ["2-005", 40, 35],
    // DemiMeramon: offense over mobility
    ["2-006", 40, 42],
    // DemiVeemon: versatile starter
    ["2-007", 41, 37],
    // Dorimon: assertive attacker
    ["2-008", 37, 45],
    // Gummymon: agile starter
    ["2-009", 38, 39],
    // Hopmon: offensive balance
    ["2-010", 39, 35],
    // Kakkinmon: offense over mobility
    ["2-011", 36, 38],
    // Kapurimon: measured attacker
    ["2-012", 36, 45],
    // Kokomon: agile starter
    ["2-013", 40, 43],
    // Koromon: versatile classic
    ["2-014", 33, 44],
    // Kyokyomon: evasive specialist
    ["2-015", 37, 43],
    // Motimon: balanced classic
    ["2-016", 33, 47],
    // Nyaromon: agile, weaker attack
    ["2-017", 35, 42],
    // Pagumon: defensive balance
    ["2-018", 32, 46],
    // Poromon: elusive specialist
    ["2-019", 40, 36],
    // Sakuttomon: offensive specialist
    ["2-020", 34, 46],
    // Tanemon: defensive classic
    ["2-021", 42, 40],
    // Tokomon: powerful bite, moderate evasion
    ["2-022", 42, 42],
    // Tokomon X: a small evasion upgrade
    ["2-023", 41, 36],
    // Tsumemon: offensive specialist
    ["2-024", 41, 42],
    // Tsunomon: offensive classic
    ["2-025", 34, 44],
    // Upamon: defensive balance
    ["2-026", 35, 45],
    // Wanyamon: agile all-rounder
    ["2-027", 38, 38],
    // Yaamon: offensive balance
    ["2-028", 35, 44],
    // Yokomon: defensive classic
    ["2-029", 36, 44],
    // Bibimon: mobile all-rounder
    ["2-030", 42, 38],
    // Gigimon: offensive starter
    ["2-031", 38, 36],
    // Tumblemon: offensive leaning
    ["2-032", 33, 43],
    // Hiyarimon: evasive specialist
    ["2-033", 32, 40],
    // Minomon: modest defensive profile
    ["2-034", 31, 45],
    // Moonmon: evasion over offense
    ["2-035", 36, 39],
    // Pickmon: balanced
    ["2-036", 34, 47],
    // Viximon: elusive starter
    ["2-037", 39, 37],
    // Sunmon: offense over evasion
    ["3-001", 58, 44],
    // Agumon
    ["3-002", 50, 50],
    // Agumon (Black) X
    ["3-003", 50, 50],
    // Agumon Expert
    ["3-004", 50, 50],
    // Agumon X
    ["3-005", 50, 50],
    // Argomon
    ["3-006", 50, 50],
    // Armadillomon
    ["3-007", 50, 50],
    // Betamon
    ["3-008", 50, 50],
    // Biyomon
    ["3-009", 50, 50],
    // Bulucomon
    ["3-010", 50, 50],
    // BushiAgumon
    ["3-011", 50, 50],
    // Candlemon
    ["3-012", 50, 50],
    // Coronamon
    ["3-013", 50, 50],
    // Crabmon
    ["3-014", 50, 50],
    // DemiDevimon
    ["3-015", 50, 50],
    // Dorumon
    ["3-016", 50, 50],
    // Dracomon
    ["3-017", 50, 50],
    // Dracomon X
    ["3-018", 50, 50],
    // Duskmon
    ["3-019", 50, 50],
    // Elecmon
    ["3-020", 50, 50],
    // Falcomon
    ["3-021", 46, 54],
    // Floramon
    ["3-022", 50, 56],
    // Gabumon
    ["3-023", 50, 50],
    // Gabumon X
    ["3-024", 50, 50],
    // Gaomon
    ["3-025", 52, 68],
    // Gatomon
    ["3-026", 50, 50],
    // Gazimon
    ["3-027", 50, 50],
    // Ghostmon
    ["3-028", 50, 50],
    // Gizamon
    ["3-029", 50, 50],
    // Gomamon
    ["3-030", 50, 50],
    // Gomamon X
    ["3-031", 50, 50],
    // Gotsumon
    ["3-032", 50, 50],
    // Guilmon
    ["3-033", 50, 50],
    // Hagurumon
    ["3-034", 42, 62],
    // Hawkmon
    ["3-035", 50, 50],
    // Herissmon
    ["3-036", 50, 50],
    // Huckmon
    ["3-037", 50, 50],
    // Impmon
    ["3-038", 50, 50],
    // Impmon X
    ["3-039", 50, 50],
    // Jazamon
    ["3-040", 50, 50],
    // Junkmon
    ["3-041", 50, 50],
    // Keramon X
    ["3-042", 50, 50],
    // Kokuwamon
    ["3-043", 50, 50],
    // Kokuwamon X
    ["3-044", 50, 50],
    // Kunemon
    ["3-045", 50, 50],
    // Labramon
    ["3-046", 50, 50],
    // Lalamon
    ["3-047", 50, 50],
    // Lopmon
    ["3-048", 50, 50],
    // Lopmon X
    ["3-049", 50, 50],
    // Ludomon
    ["3-050", 50, 50],
    // Lunamon
    ["3-051", 50, 50],
    // Monodramon
    ["3-052", 50, 50],
    // Morphomon
    ["3-053", 50, 50],
    // Mushroomon
    ["3-054", 50, 50],
    // Otamamon
    ["3-055", 50, 50],
    // Otamamon X
    ["3-056", 46, 54],
    // Palmon
    ["3-057", 46, 54],
    // Palmon X
    ["3-058", 44, 66],
    // Patamon
    ["3-059", 50, 50],
    // Phascomon
    ["3-060", 50, 50],
    // Pomumon
    ["3-061", 50, 50],
    // Renamon X
    ["3-062", 50, 50],
    // Ryudamon
    ["3-063", 50, 50],
    // Salamon
    ["3-064", 50, 50],
    // Salamon X
    ["3-065", 50, 50],
    // Sangomon
    ["3-066", 50, 50],
    // Shoutmon
    ["3-067", 50, 50],
    // Sistermon Blanc
    ["3-068", 50, 50],
    // Sunarizamon
    ["3-069", 50, 50],
    // Swimmon
    ["3-070", 50, 50],
    // Syakomon
    ["3-071", 50, 50],
    // Syakomon X
    ["3-072", 50, 50],
    // Tapirmon
    ["3-073", 50, 50],
    // Tentomon
    ["3-074", 50, 50],
    // Terriermon
    ["3-075", 50, 50],
    // Terriermon X
    ["3-076", 50, 50],
    // Tinkermon
    ["3-077", 50, 50],
    // ToyAgumon
    ["3-078", 50, 50],
    // Veemon
    ["3-079", 50, 50],
    // Vorvomon
    ["3-080", 50, 50],
    // Wormmon
    ["3-081", 50, 50],
    // Zubamon
    ["3-082", 50, 50],
    // Agumon (Black)
    ["3-083", 50, 50],
    // Dracmon
    ["3-084", 50, 50],
    // Pulsemon
    ["3-085", 50, 50],
    // Renamon
    ["4-001", 60, 50],
    // Agunimon
    ["4-002", 60, 50],
    // Airdramon
    ["4-003", 60, 50],
    // Allomon X
    ["4-004", 68, 60],
    // Angemon
    ["4-005", 60, 50],
    // Ankylomon
    ["4-006", 60, 50],
    // Apemon
    ["4-007", 60, 50],
    // Aquilamon
    ["4-008", 60, 50],
    // Argomon
    ["4-009", 60, 50],
    // Arresterdramon
    ["4-010", 60, 50],
    // Baboongamon
    ["4-011", 60, 50],
    // Bakemon
    ["4-012", 60, 50],
    // Baluchimon
    ["4-013", 60, 50],
    // BaoHuckmon
    ["4-014", 52, 62],
    // Birdramon
    ["4-015", 60, 50],
    // Centarumon
    ["4-016", 60, 50],
    // Clockmon
    ["4-017", 60, 50],
    // Coelamon
    ["4-018", 60, 50],
    // Coredramon (Blue)
    ["4-019", 60, 50],
    // Coredramon (Green)
    ["4-020", 60, 50],
    // Cyclonemon
    ["4-021", 60, 50],
    // Damemon
    ["4-022", 60, 50],
    // Darcmon
    ["4-023", 72, 38],
    // DarkTyrannomon
    ["4-024", 72, 38],
    // DarkTyrannomon X
    ["4-025", 60, 50],
    // Deltamon
    ["4-026", 60, 50],
    // Deputymon
    ["4-027", 60, 50],
    // Devidramon
    ["4-028", 60, 50],
    // Devimon
    ["4-029", 60, 50],
    // Diatrymon
    ["4-030", 60, 50],
    // Dobermon
    ["4-031", 60, 50],
    // Dokugumon
    ["4-032", 60, 50],
    // Dolphmon
    ["4-033", 60, 50],
    // Dorugamon
    ["4-034", 60, 50],
    // Drimogemon
    ["4-035", 60, 50],
    // Duskmon
    ["4-036", 60, 50],
    // Ebidramon
    ["4-037", 60, 50],
    // Eosmon
    ["4-038", 60, 50],
    // ExVeemon
    ["4-039", 60, 50],
    // Filmon
    ["4-040", 60, 50],
    // Firamon
    ["4-041", 60, 50],
    // Flarerizamon
    ["4-042", 52, 62],
    // Flymon
    ["4-043", 60, 50],
    // Frigimon
    ["4-044", 60, 50],
    // Gaogamon
    ["4-045", 60, 50],
    // Gargomon
    ["4-046", 64, 70],
    // Garurumon
    ["4-047", 52, 68],
    // Gatomon
    ["4-048", 60, 50],
    // Gatomon X
    ["4-049", 60, 50],
    // Gekomon
    ["4-050", 72, 38],
    // GeoGreymon
    ["4-051", 60, 50],
    // Gesomon
    ["4-052", 60, 50],
    // Ginryumon
    ["4-053", 72, 38],
    // Golemon
    ["4-054", 78, 35],
    // Greymon
    ["4-055", 60, 50],
    // Growlmon
    ["4-056", 60, 50],
    // Growlmon X
    ["4-057", 68, 42],
    // Guardromon
    ["4-058", 60, 50],
    // Hookmon
    ["4-059", 60, 50],
    // Hudiemon
    ["4-060", 60, 50],
    // Ikkakumon
    ["4-061", 60, 50],
    // Jazardmon
    ["4-062", 60, 50],
    // Kabuterimon
    ["4-063", 60, 50],
    // Kiwimon
    ["4-064", 60, 50],
    // Kokatorimon
    ["4-065", 60, 50],
    // Komondomon
    ["4-066", 60, 50],
    // Kuwagamon
    ["4-067", 60, 50],
    // Kuwagamon X
    ["4-068", 60, 50],
    // Lavorvomon
    ["4-069", 60, 50],
    // Lekismon
    ["4-070", 60, 50],
    // Leomon
    ["4-071", 60, 50],
    // Leomon X
    ["4-072", 60, 50],
    // Lobomon
    ["4-073", 60, 50],
    // Machmon
    ["4-074", 60, 50],
    // MadLeomon
    ["4-075", 60, 50],
    // Manbomon
    ["4-076", 60, 50],
    // Mantaraymon X
    ["4-077", 60, 50],
    // Meicoomon
    ["4-078", 60, 50],
    // Mekanorimon
    ["4-079", 60, 50],
    // Meramon
    ["4-080", 60, 50],
    // Meramon X
    ["4-081", 60, 50],
    // Mimicmon
    ["4-082", 60, 50],
    // Minotarumon
    ["4-083", 60, 50],
    // Mojyamon
    ["4-084", 60, 50],
    // Monochromon
    ["4-085", 60, 50],
    // Nanimon
    ["4-086", 60, 50],
    // Nefertimon X
    ["4-087", 52, 62],
    // Ninjamon
    ["4-088", 35, 40],
    // Numemon
    ["4-089", 60, 50],
    // Numemon X
    ["4-090", 60, 50],
    // Octomon
    ["4-091", 72, 38],
    // Ogremon
    ["4-092", 72, 38],
    // Ogremon X
    ["4-093", 60, 50],
    // Omekamon
    ["4-094", 60, 50],
    // Paledramon
    ["4-095", 60, 50],
    // Parasaurmon
    ["4-096", 60, 50],
    // Peckmon
    ["4-097", 60, 50],
    // Pegasusmon X
    ["4-098", 60, 50],
    // Petermon
    ["4-099", 60, 50],
    // Porcupamon
    ["4-100", 60, 50],
    // Pteramon X
    ["4-101", 60, 50],
    // Raremon
    ["4-102", 56, 54],
    // RedVegiemon
    ["4-103", 60, 50],
    // Reppamon
    ["4-104", 60, 50],
    // Rhinomon X
    ["4-105", 60, 50],
    // Roachmon
    ["4-106", 60, 50],
    // Sangloupmon
    ["4-107", 60, 50],
    // Seadramon
    ["4-108", 60, 50],
    // Seadramon X
    ["4-109", 60, 50],
    // Seasarmon X
    ["4-110", 60, 50],
    // Shadramon
    ["4-111", 60, 50],
    // Shellmon
    ["4-112", 60, 50],
    // ShellNumemon
    ["4-113", 60, 50],
    // Shoutmon X3
    ["4-114", 60, 50],
    // Sistermon Ciel
    ["4-115", 60, 50],
    // Starmon
    ["4-116", 52, 62],
    // Stingmon
    ["4-117", 60, 50],
    // Strikedramon
    ["4-118", 60, 50],
    // Submarimon
    ["4-119", 60, 50],
    // Sukamon
    ["4-120", 60, 50],
    // Sunflowmon
    ["4-121", 68, 42],
    // Tankmon
    ["4-122", 60, 50],
    // Targetmon
    ["4-123", 60, 50],
    // Thundermon
    ["4-124", 60, 50],
    // TiaLudomon
    ["4-125", 60, 50],
    // Tobiumon
    ["4-126", 60, 50],
    // TobuCatmon
    ["4-127", 56, 54],
    // Togemon
    ["4-128", 56, 54],
    // Togemon X
    ["4-129", 60, 50],
    // Tortomon
    ["4-130", 60, 50],
    // Troopmon
    ["4-131", 60, 50],
    // Turuiemon
    ["4-132", 60, 50],
    // Tuskmon
    ["4-133", 60, 50],
    // Tylomon
    ["4-134", 60, 50],
    // Tylomon X
    ["4-135", 72, 38],
    // Tyrannomon
    ["4-136", 72, 38],
    // Tyrannomon X
    ["4-137", 60, 50],
    // Unimon
    ["4-138", 60, 50],
    // Veedramon
    ["4-139", 56, 54],
    // Vegiemon
    ["4-140", 60, 50],
    // Velgrmon
    ["4-141", 60, 50],
    // Whamon
    ["4-142", 63, 57],
    // Witchmon
    ["4-143", 63, 57],
    // Wizardmon
    ["4-144", 63, 57],
    // Wizardmon X
    ["4-145", 56, 54],
    // Woodmon
    ["4-146", 60, 50],
    // ZubaEagermon
    ["4-147", 60, 50],
    // Bulkmon
    ["4-148", 60, 50],
    // Fugamon
    ["4-149", 60, 50],
    // Hyogamon
    ["4-150", 60, 50],
    // Piddomon
    ["4-151", 60, 50],
    // Rhinomon
    ["4-152", 60, 50],
    // Saberdramon
    ["5-001", 70, 55],
    // AeroVeedramon
    ["5-002", 70, 55],
    // Aldamon
    ["5-003", 78, 47],
    // Andromon
    ["5-004", 70, 55],
    // Angewomon
    ["5-005", 70, 55],
    // Angewomon X
    ["5-006", 70, 55],
    // Antylamon
    ["5-007", 70, 55],
    // Argomon
    ["5-008", 70, 55],
    // Arukenimon
    ["5-009", 70, 55],
    // Astamon
    ["5-010", 70, 55],
    // Asuramon
    ["5-011", 70, 55],
    // Baalmon
    ["5-012", 70, 55],
    // Beowolfmon
    ["5-013", 70, 55],
    // BigMamemon
    ["5-014", 66, 59],
    // Blossomon
    ["5-015", 70, 55],
    // Bulbmon
    ["5-016", 82, 43],
    // BurningGreymon
    ["5-017", 70, 55],
    // CannonBeemon
    ["5-018", 70, 55],
    // Cerberusmon
    ["5-019", 70, 55],
    // Cerberusmon X
    ["5-020", 70, 55],
    // Cherrymon
    ["5-021", 70, 55],
    // Cho-Hakkaimon
    ["5-022", 70, 55],
    // Crescemon
    ["5-023", 70, 55],
    // Crowmon
    ["5-024", 70, 55],
    // CrysPaledramon
    ["5-025", 78, 47],
    // Cyberdramon
    ["5-026", 78, 47],
    // Cyberdramon X
    ["5-027", 70, 55],
    // DarkKnightmon
    ["5-028", 70, 55],
    // Datamon
    ["5-029", 70, 55],
    // Deramon
    ["5-030", 70, 55],
    // Digitamamon
    ["5-031", 82, 43],
    // Dinobeemon
    ["5-032", 70, 55],
    // Divermon
    ["5-033", 70, 55],
    // DoneDevimon
    ["5-034", 82, 43],
    // DoruGreymon
    ["5-035", 70, 55],
    // Dragomon
    ["5-036", 70, 55],
    // Duramon
    ["5-037", 70, 55],
    // Entmon
    ["5-038", 70, 55],
    // Eosmon
    ["5-039", 70, 55],
    // Etemon
    ["5-040", 82, 43],
    // ExTyrannomon
    ["5-041", 70, 55],
    // Flaremon
    ["5-042", 70, 55],
    // Garbagemon
    ["5-043", 70, 55],
    // Garudamon
    ["5-044", 70, 55],
    // Garudamon X
    ["5-045", 70, 55],
    // Giromon
    ["5-046", 70, 55],
    // Gogmamon
    ["5-047", 70, 55],
    // Grademon
    ["5-048", 70, 55],
    // Groundramon
    ["5-049", 70, 55],
    // Gusokumon
    ["5-050", 70, 55],
    // HippoGryphonmon
    ["5-051", 70, 55],
    // Hisyaryumon
    ["5-052", 70, 55],
    // Jagamon
    ["5-053", 70, 55],
    // JagerLoweemon
    ["5-054", 70, 55],
    // Jazarichmon
    ["5-055", 70, 55],
    // JewelBeemon
    ["5-056", 70, 55],
    // KendoGarurumon
    ["5-057", 70, 55],
    // Kimeramon
    ["5-058", 70, 55],
    // Knightmon
    ["5-059", 70, 55],
    // LadyDevimon
    ["5-060", 70, 55],
    // LadyDevimon X
    ["5-061", 70, 55],
    // Lavogaritamon
    ["5-062", 70, 55],
    // Lilamon
    ["5-063", 70, 55],
    // Lillymon
    ["5-064", 70, 55],
    // Lillymon X
    ["5-065", 70, 55],
    // LoaderLeomon
    ["5-066", 70, 55],
    // Locomon
    ["5-067", 70, 55],
    // Lucemon: Chaos Mode
    ["5-068", 70, 55],
    // MachGaogamon
    ["5-069", 73, 62],
    // MagnaAngemon
    ["5-070", 70, 55],
    // Mamemon
    ["5-071", 70, 55],
    // Mamemon X
    ["5-072", 70, 55],
    // Mametyramon
    ["5-073", 82, 43],
    // Mammothmon
    ["5-074", 82, 43],
    // Mammothmon X
    ["5-075", 70, 55],
    // Manticoremon
    ["5-076", 70, 55],
    // MarineChimairamon
    ["5-077", 70, 55],
    // MarineDevimon
    ["5-078", 70, 55],
    // Maycrackmon
    ["5-079", 70, 55],
    // Maycrackmon: Vicious Mode
    ["5-080", 70, 55],
    // Megadramon
    ["5-081", 70, 55],
    // MegaKabuterimon (Red)
    ["5-082", 70, 55],
    // MegaSeadramon
    ["5-083", 70, 55],
    // MegaSeadramon X
    ["5-084", 70, 55],
    // Mephistomon X
    ["5-085", 70, 55],
    // Mermaimon
    ["5-086", 78, 47],
    // MetalGreymon
    ["5-087", 78, 47],
    // MetalGreymon (Vaccine)
    ["5-088", 78, 47],
    // MetalGreymon (Virus)
    ["5-089", 78, 47],
    // MetalGreymon (Virus) X
    ["5-090", 78, 47],
    // MetalGreymon X
    ["5-091", 78, 47],
    // MetalMamemon
    ["5-092", 78, 47],
    // MetalPhantomon
    ["5-093", 78, 47],
    // MetalTyrannomon
    ["5-094", 78, 47],
    // MetalTyrannomon X
    ["5-095", 70, 55],
    // Monzaemon
    ["5-096", 70, 55],
    // Monzaemon X
    ["5-097", 70, 55],
    // Mummymon
    ["5-098", 70, 55],
    // Myotismon
    ["5-099", 70, 55],
    // Myotismon X
    ["5-100", 70, 55],
    // NeoDevimon
    ["5-101", 70, 55],
    // Okuwamon
    ["5-102", 70, 55],
    // Okuwamon X
    ["5-103", 70, 55],
    // OmniShoutmon X
    ["5-104", 70, 55],
    // Orochimon
    ["5-105", 70, 55],
    // Paildramon
    ["5-106", 70, 55],
    // Parrotmon
    ["5-107", 70, 55],
    // Phantomon
    ["5-108", 70, 55],
    // Piranimon
    ["5-109", 70, 55],
    // Piximon
    ["5-110", 70, 55],
    // Pumpkinmon
    ["5-111", 70, 55],
    // RaijiLudomon
    ["5-112", 70, 55],
    // Rapidmon
    ["5-113", 70, 55],
    // Rebellimon
    ["5-114", 70, 55],
    // Rhihimon
    ["5-115", 82, 43],
    // RizeGreymon
    ["5-116", 82, 43],
    // RizeGreymon X
    ["5-117", 70, 55],
    // SaviorHuckmon
    ["5-118", 70, 55],
    // Scorpiomon
    ["5-119", 70, 55],
    // Scorpiomon X
    ["5-120", 70, 55],
    // Shakkoumon
    ["5-121", 70, 55],
    // ShogunGekomon
    ["5-122", 70, 55],
    // Shoutmon X5
    ["5-123", 70, 55],
    // Silphymon
    ["5-124", 70, 55],
    // Sirenmon
    ["5-125", 70, 55],
    // SkullBaluchimon
    ["5-126", 82, 43],
    // SkullGreymon
    ["5-127", 70, 55],
    // SkullMeramon
    ["5-128", 70, 55],
    // Stefilmon
    ["5-129", 70, 55],
    // Tekkamon
    ["5-130", 70, 55],
    // Toropiamon
    ["5-131", 82, 43],
    // Triceramon
    ["5-132", 82, 43],
    // Triceramon X
    ["5-133", 70, 55],
    // Vademon
    ["5-134", 70, 55],
    // Velgrmon
    ["5-135", 70, 55],
    // WarGrowlmon
    ["5-136", 70, 55],
    // WarGrowlmon X
    ["5-137", 70, 55],
    // WaruMonzaemon
    ["5-138", 70, 55],
    // WaruSeadramon
    ["5-139", 70, 55],
    // WereGarurumon
    ["5-140", 70, 55],
    // WereGarurumon X
    ["5-141", 70, 55],
    // Whamon
    ["5-142", 70, 55],
    // Wingdramon
    ["5-143", 70, 55],
    // Zudomon
    ["5-144", 70, 55],
    // Boutmon
    ["5-145", 70, 55],
    // DarkSuperStarmon
    ["5-146", 70, 55],
    // Doruguremon
    ["5-147", 70, 55],
    // Pandamon
    ["5-148", 70, 55],
    // SkullScorpiomon
    ["5-149", 70, 55],
    // SuperStarmon
    ["6-001", 80, 60],
    // Aegisdramon
    ["6-002", 80, 60],
    // Alphamon
    ["6-003", 80, 60],
    // AncientBeetlemon
    ["6-004", 80, 60],
    // AncientGarurumon
    ["6-005", 92, 48],
    // AncientGreymon
    ["6-006", 80, 60],
    // AncientKazemon
    ["6-007", 80, 60],
    // AncientMegatheriummon
    ["6-008", 80, 60],
    // AncientMermaimon
    ["6-009", 80, 60],
    // AncientSphinxmon
    ["6-010", 80, 60],
    // AncientTroymon
    ["6-011", 80, 60],
    // AncientVolcanomon
    ["6-012", 80, 60],
    // AncientWisemon
    ["6-013", 80, 60],
    // Anubismon
    ["6-014", 80, 60],
    // Apocalymon
    ["6-015", 80, 60],
    // Apollomon
    ["6-016", 80, 60],
    // Argomon
    ["6-017", 80, 60],
    // Armageddemon
    ["6-018", 80, 60],
    // Azulongmon
    ["6-019", 80, 60],
    // Bagramon
    ["6-020", 80, 60],
    // Baihumon
    ["6-021", 80, 60],
    // BanchoLeomon
    ["6-022", 80, 60],
    // BanchoMamemon
    ["6-023", 80, 60],
    // Barbamon
    ["6-024", 80, 60],
    // BeelStarmon X
    ["6-025", 80, 60],
    // Beelzemon
    ["6-026", 80, 60],
    // Belphemon: Rage Mode
    ["6-027", 92, 48],
    // BlackWarGreymon X
    ["6-028", 92, 48],
    // BlitzGreymon
    ["6-029", 80, 60],
    // Boltmon
    ["6-030", 80, 60],
    // Breakdramon
    ["6-031", 80, 60],
    // BryweLudramon
    ["6-032", 80, 60],
    // Chaosdramon X
    ["6-033", 80, 60],
    // Cherubimon (Virtue)
    ["6-034", 80, 60],
    // Cherubimon (Virtue) X
    ["6-035", 80, 60],
    // Cherubimon (Vice) X
    ["6-036", 80, 60],
    // Craniamon
    ["6-037", 80, 60],
    // Creepymon
    ["6-038", 80, 60],
    // CresGarurumon
    ["6-039", 80, 60],
    // Darkdramon
    ["6-040", 80, 60],
    // DarkKnightmon X
    ["6-041", 80, 60],
    // Dianamon
    ["6-042", 92, 48],
    // Dinorexmon
    ["6-043", 92, 48],
    // Dinotigermon
    ["6-044", 80, 60],
    // Durandamon
    ["6-045", 80, 60],
    // Dynasmon
    ["6-046", 80, 60],
    // Ebemon X
    ["6-047", 80, 60],
    // Ebonwumon
    ["6-048", 92, 48],
    // EmperorGreymon
    ["6-049", 80, 60],
    // Eosmon
    ["6-050", 80, 60],
    // Fanglongmon
    ["6-051", 80, 60],
    // Gaiomon
    ["6-052", 80, 60],
    // Gallantmon
    ["6-053", 80, 60],
    // Gallantmon X
    ["6-054", 80, 60],
    // Gankoomon
    ["6-055", 80, 60],
    // Ghoulmon
    ["6-056", 92, 48],
    // GigaSeadramon
    ["6-057", 80, 60],
    // Goldramon
    ["6-058", 80, 60],
    // Goldramon X
    ["6-059", 80, 60],
    // GrandisKuwagamon
    ["6-060", 80, 60],
    // GranDracmon
    ["6-061", 80, 60],
    // GranKuwagamon
    ["6-062", 80, 60],
    // GroundLocomon
    ["6-063", 80, 60],
    // Gryphonmon
    ["6-064", 80, 60],
    // Gundramon
    ["6-065", 80, 60],
    // HeavyLeomon
    ["6-066", 80, 60],
    // HerculesKabuterimon
    ["6-067", 80, 60],
    // Hexeblaumon
    ["6-068", 88, 52],
    // HiAndromon
    ["6-069", 80, 60],
    // Jesmon
    ["6-070", 80, 60],
    // Justimon X
    ["6-071", 80, 60],
    // Justimon: Blitz Arm
    ["6-072", 80, 60],
    // Kentaurosmon
    ["6-073", 80, 60],
    // KingEtemon
    ["6-074", 80, 60],
    // Leopardmon
    ["6-075", 80, 60],
    // Leviamon
    ["6-076", 80, 60],
    // Lilithmon
    ["6-077", 80, 60],
    // LordKnightmon
    ["6-078", 80, 60],
    // Lotosmon
    ["6-079", 80, 60],
    // Lucemon: Satan Mode
    ["6-080", 88, 52],
    // Machinedramon
    ["6-081", 83, 67],
    // Magnadramon
    ["6-082", 83, 67],
    // Magnadramon X
    ["6-083", 83, 67],
    // MagnaGarurumon
    ["6-084", 83, 67],
    // Magnamon
    ["6-085", 80, 60],
    // MaloMyotismon
    ["6-086", 83, 67],
    // MarineAngemon
    ["6-087", 80, 60],
    // MegaGargomon
    ["6-088", 80, 60],
    // Megidramon
    ["6-089", 80, 60],
    // Megidramon X
    ["6-090", 88, 52],
    // MetalEtemon
    ["6-091", 88, 78],
    // MetalGarurumon
    ["6-092", 88, 52],
    // MetalGarurumon X
    ["6-093", 88, 52],
    // Metallicdramon
    ["6-094", 88, 52],
    // MetalPiranimon
    ["6-095", 88, 52],
    // MetalSeadramon
    ["6-096", 80, 60],
    // MirageGaogamon
    ["6-097", 80, 60],
    // Murmukusmon
    ["6-098", 80, 60],
    // Nidhoggmon
    ["6-099", 80, 60],
    // NoblePumpkinmon
    ["6-100", 83, 67],
    // Ophanimon
    ["6-101", 83, 67],
    // Ophanimon X
    ["6-102", 83, 67],
    // Ophanimon: Falldown Mode X
    ["6-103", 80, 60],
    // Ornismon
    ["6-104", 80, 60],
    // Ouryumon
    ["6-105", 80, 60],
    // Phoenixmon
    ["6-106", 80, 60],
    // Phoenixmon X
    ["6-107", 80, 60],
    // Piedmon
    ["6-108", 80, 60],
    // PlatinumNumemon
    ["6-109", 80, 60],
    // Plesiomon
    ["6-110", 80, 60],
    // Plesiomon X
    ["6-111", 80, 60],
    // PrinceMamemon X
    ["6-112", 80, 60],
    // Pukumon
    ["6-113", 80, 60],
    // Puppetmon
    ["6-114", 80, 60],
    // Rafflesimon
    ["6-115", 80, 60],
    // Raguelmon
    ["6-116", 80, 60],
    // Rapidmon X
    ["6-117", 80, 60],
    // Rasenmon
    ["6-118", 80, 60],
    // Rasenmon: Fury Mode
    ["6-119", 80, 60],
    // Rasielmon
    ["6-120", 80, 60],
    // Ravemon
    ["6-121", 80, 60],
    // Regalecusmon
    ["6-122", 80, 60],
    // Rhihimon
    ["6-123", 76, 64],
    // Rosemon
    ["6-124", 76, 64],
    // Rosemon X
    ["6-125", 92, 48],
    // RustTyrannomon
    ["6-126", 80, 60],
    // SaberLeomon
    ["6-127", 80, 60],
    // Sakuyamon X
    ["6-128", 83, 67],
    // Seraphimon
    ["6-129", 92, 48],
    // ShineGreymon
    ["6-130", 92, 48],
    // SkullMammothmon
    ["6-131", 92, 48],
    // SkullMammothmon X
    ["6-132", 83, 67],
    // SlashAngemon
    ["6-133", 80, 60],
    // Slayerdramon
    ["6-134", 80, 60],
    // Susanomon
    ["6-135", 80, 60],
    // TigerVespamon
    ["6-136", 80, 60],
    // Titamon
    ["6-137", 80, 60],
    // UlforceVeedramon
    ["6-138", 80, 60],
    // UltimateBrachiomon
    ["6-139", 80, 60],
    // Valkyrimon
    ["6-140", 80, 60],
    // Varodurumon
    ["6-141", 80, 60],
    // VenomMyotismon
    ["6-142", 80, 60],
    // Volcanicdramon
    ["6-143", 94, 62],
    // WarGreymon
    ["6-144", 92, 48],
    // WarGreymon X
    ["6-145", 80, 60],
    // Zhuqiaomon
    ["6-146", 80, 60],
    // Vikemon
    ["6-147", 80, 60],
    // ShinMonzaemon
    ["6-148", 80, 60],
    // Kazuchimon
    ["6-149", 80, 60],
    // BanchoLillymon
    ["6-150", 80, 60],
    // Dorugoramon
    ["7-001", 90, 65],
    // Alphamon: Ouryuken
    ["7-002", 90, 65],
    // Armageddemon
    ["7-003", 90, 65],
    // Barbamon X
    ["7-004", 90, 65],
    // Beelzemon X
    ["7-005", 90, 65],
    // Beelzemon: Blast Mode
    ["7-006", 90, 65],
    // Belphemon X
    ["7-007", 90, 65],
    // Boltboutamon
    ["7-008", 90, 65],
    // Chaosmon
    ["7-009", 90, 65],
    // Craniamon X
    ["7-010", 90, 65],
    // Creepymon X
    ["7-011", 90, 65],
    // DarknessBagramon
    ["7-012", 90, 65],
    // Diaboromon X
    ["7-013", 90, 65],
    // Dynasmon X
    ["7-014", 90, 65],
    // Examon
    ["7-015", 90, 65],
    // Examon X
    ["7-016", 90, 65],
    // Gallantmon X
    ["7-017", 90, 65],
    // Gankoomon X
    ["7-018", 90, 65],
    // GraceNovamon
    ["7-019", 90, 65],
    // Imperialdramon: Fighter Mode
    ["7-020", 90, 65],
    // Imperialdramon: Paladin Mode
    ["7-021", 90, 65],
    // Jesmon X
    ["7-022", 90, 65],
    // Kentaurosmon X
    ["7-023", 90, 65],
    // Leopardmon X
    ["7-024", 90, 65],
    // Leviamon X
    ["7-025", 90, 65],
    // Lilithmon X
    ["7-026", 90, 65],
    // LordKnightmon X
    ["7-027", 90, 65],
    // Lucemon X
    ["7-028", 93, 72],
    // Magnamon X
    ["7-029", 90, 65],
    // Mastemon
    ["7-030", 90, 65],
    // Minervamon X
    ["7-031", 90, 65],
    // Ogudomon
    ["7-032", 90, 65],
    // Omnimon
    ["7-033", 90, 65],
    // Omnimon Alter-S
    ["7-034", 90, 65],
    // Omnimon X
    ["7-035", 90, 65],
    // Ordinemon
    ["7-036", 90, 65],
    // Rafflesimon
    ["7-037", 90, 65],
    // RagnaLoardmon
    ["7-038", 90, 65],
    // Rasenmon
    ["7-039", 100, 53],
    // RustTyrannomon
    ["7-040", 90, 65],
    // UlforceVeedramon X
    ["7-041", 90, 65],
    // Agumon (Bond of Bravery)
    ["7-042", 90, 65],
    // Gabumon (Bond of Friendship)
    ["7-043", 90, 65],
    // Jesmon GX
    ["7-044", 90, 65],
    // Ogudomon X
    ["7-045", 90, 65]
    // Chaosdramon
  ].map(([id, strength, evasion]) => [id, validateCombatStats({ strength, evasion })])
);

// ../digital-pet-core/src/domain/evolution-victory-policy.ts
var VICTORY_MINIMUMS = /* @__PURE__ */ new Map([
  [0, 0],
  [12, 3],
  [24, 5],
  [50, 7],
  [200, 10]
]);
var adaptEvolutionVictoryMinimum = (minimum) => VICTORY_MINIMUMS.get(minimum) ?? minimum;

// ../digital-pet-core/src/data/evolution-reference.json
var evolution_reference_default = {
  reviewedAt: "2026-10-16",
  sources: {
    dm: "https://humulos.com/digimon/dm/",
    dm20: "https://humulos.com/digimon/dm20/",
    dmc: "https://humulos.com/digimon/dmc/",
    dmx: "https://humulos.com/digimon/dmx/",
    dmx2: "https://humulos.com/digimon/dmx/2/",
    dmx3: "https://humulos.com/digimon/dmx/3/",
    dmxw: "https://humulos.com/digimon/dmxw/",
    garuru: "https://humulos.com/digimon/vbdm/php/details_ajax.php?digimon=garuru",
    pen: "https://humulos.com/digimon/pen/",
    pen20: "https://humulos.com/digimon/pen20/",
    penc: "https://humulos.com/digimon/penc/",
    penz: "https://humulos.com/digimon/penz/",
    vbbe: "https://humulos.com/digimon/vbbe/all/",
    vbdm: "https://humulos.com/digimon/vbdm/all/"
  },
  detailSources: {
    dmc: {
      agu: "https://humulos.com/digimon/php/details.php?digimon=agu&device=15&version=",
      airdra: "https://humulos.com/digimon/php/details.php?digimon=airdra&device=15&version=",
      andro: "https://humulos.com/digimon/php/details.php?digimon=andro&device=15&version=",
      ange: "https://humulos.com/digimon/php/details.php?digimon=ange&device=15&version=",
      bake: "https://humulos.com/digimon/php/details.php?digimon=bake&device=15&version=",
      bancholeo: "https://humulos.com/digimon/php/details.php?digimon=bancholeo&device=15&version=",
      banchomame: "https://humulos.com/digimon/php/details.php?digimon=banchomame&device=15&version=",
      beta: "https://humulos.com/digimon/php/details.php?digimon=beta&device=15&version=",
      birdra: "https://humulos.com/digimon/php/details.php?digimon=birdra&device=15&version=",
      blitzgrey: "https://humulos.com/digimon/php/details.php?digimon=blitzgrey&device=15&version=",
      bota: "https://humulos.com/digimon/php/details.php?digimon=bota&device=15&version=",
      chaos: "https://humulos.com/digimon/php/details.php?digimon=chaos&device=15&version=",
      chaosdra: "https://humulos.com/digimon/php/details.php?digimon=chaosdra&device=15&version=",
      chimaira: "https://humulos.com/digimon/php/details.php?digimon=chimaira&device=15&version=",
      cockatri: "https://humulos.com/digimon/php/details.php?digimon=cockatri&device=15&version=",
      coela: "https://humulos.com/digimon/php/details.php?digimon=coela&device=15&version=",
      cresgaruru: "https://humulos.com/digimon/php/details.php?digimon=cresgaruru&device=15&version=",
      cyclo: "https://humulos.com/digimon/php/details.php?digimon=cyclo&device=15&version=",
      darkdra: "https://humulos.com/digimon/php/details.php?digimon=darkdra&device=15&version=",
      darktyrano: "https://humulos.com/digimon/php/details.php?digimon=darktyrano&device=15&version=",
      delta: "https://humulos.com/digimon/php/details.php?digimon=delta&device=15&version=",
      devi: "https://humulos.com/digimon/php/details.php?digimon=devi&device=15&version=",
      devidra: "https://humulos.com/digimon/php/details.php?digimon=devidra&device=15&version=",
      digitama: "https://humulos.com/digimon/php/details.php?digimon=digitama&device=15&version=",
      drimoge: "https://humulos.com/digimon/php/details.php?digimon=drimoge&device=15&version=",
      elec: "https://humulos.com/digimon/php/details.php?digimon=elec&device=15&version=",
      ete: "https://humulos.com/digimon/php/details.php?digimon=ete&device=15&version=",
      extyrano: "https://humulos.com/digimon/php/details.php?digimon=extyrano&device=15&version=",
      fly: "https://humulos.com/digimon/php/details.php?digimon=fly&device=15&version=",
      gabu: "https://humulos.com/digimon/php/details.php?digimon=gabu&device=15&version=",
      gaiou: "https://humulos.com/digimon/php/details.php?digimon=gaiou&device=15&version=",
      gankoo: "https://humulos.com/digimon/php/details.php?digimon=gankoo&device=15&version=",
      garuru: "https://humulos.com/digimon/php/details.php?digimon=garuru&device=15&version=",
      gazi: "https://humulos.com/digimon/php/details.php?digimon=gazi&device=15&version=",
      giro: "https://humulos.com/digimon/php/details.php?digimon=giro&device=15&version=",
      giza: "https://humulos.com/digimon/php/details.php?digimon=giza&device=15&version=",
      grey: "https://humulos.com/digimon/php/details.php?digimon=grey&device=15&version=",
      hiandro: "https://humulos.com/digimon/php/details.php?digimon=hiandro&device=15&version=",
      kabuteri: "https://humulos.com/digimon/php/details.php?digimon=kabuteri&device=15&version=",
      koro: "https://humulos.com/digimon/php/details.php?digimon=koro&device=15&version=",
      kune: "https://humulos.com/digimon/php/details.php?digimon=kune&device=15&version=",
      kuwaga: "https://humulos.com/digimon/php/details.php?digimon=kuwaga&device=15&version=",
      leo: "https://humulos.com/digimon/php/details.php?digimon=leo&device=15&version=",
      mame: "https://humulos.com/digimon/php/details.php?digimon=mame&device=15&version=",
      megadra: "https://humulos.com/digimon/php/details.php?digimon=megadra&device=15&version=",
      mera: "https://humulos.com/digimon/php/details.php?digimon=mera&device=15&version=",
      metalgrey_vi: "https://humulos.com/digimon/php/details.php?digimon=metalgrey_vi&device=15&version=",
      metalmame: "https://humulos.com/digimon/php/details.php?digimon=metalmame&device=15&version=",
      metaltyrano: "https://humulos.com/digimon/php/details.php?digimon=metaltyrano&device=15&version=",
      mojya: "https://humulos.com/digimon/php/details.php?digimon=mojya&device=15&version=",
      monochro: "https://humulos.com/digimon/php/details.php?digimon=monochro&device=15&version=",
      monzae: "https://humulos.com/digimon/php/details.php?digimon=monzae&device=15&version=",
      mugendra: "https://humulos.com/digimon/php/details.php?digimon=mugendra&device=15&version=",
      nani: "https://humulos.com/digimon/php/details.php?digimon=nani&device=15&version=",
      nano: "https://humulos.com/digimon/php/details.php?digimon=nano&device=15&version=",
      nume: "https://humulos.com/digimon/php/details.php?digimon=nume&device=15&version=",
      ogre: "https://humulos.com/digimon/php/details.php?digimon=ogre&device=15&version=",
      omega_a: "https://humulos.com/digimon/php/details.php?digimon=omega_a&device=15&version=",
      pagu: "https://humulos.com/digimon/php/details.php?digimon=pagu&device=15&version=",
      pal: "https://humulos.com/digimon/php/details.php?digimon=pal&device=15&version=",
      pata: "https://humulos.com/digimon/php/details.php?digimon=pata&device=15&version=",
      piccolo: "https://humulos.com/digimon/php/details.php?digimon=piccolo&device=15&version=",
      piyo: "https://humulos.com/digimon/php/details.php?digimon=piyo&device=15&version=",
      poyo: "https://humulos.com/digimon/php/details.php?digimon=poyo&device=15&version=",
      puni: "https://humulos.com/digimon/php/details.php?digimon=puni&device=15&version=",
      rare: "https://humulos.com/digimon/php/details.php?digimon=rare&device=15&version=",
      scu: "https://humulos.com/digimon/php/details.php?digimon=scu&device=15&version=",
      seadra: "https://humulos.com/digimon/php/details.php?digimon=seadra&device=15&version=",
      shell: "https://humulos.com/digimon/php/details.php?digimon=shell&device=15&version=",
      shinmonzae: "https://humulos.com/digimon/php/details.php?digimon=shinmonzae&device=15&version=",
      skullgrey: "https://humulos.com/digimon/php/details.php?digimon=skullgrey&device=15&version=",
      skullmam: "https://humulos.com/digimon/php/details.php?digimon=skullmam&device=15&version=",
      tane: "https://humulos.com/digimon/php/details.php?digimon=tane&device=15&version=",
      toko: "https://humulos.com/digimon/php/details.php?digimon=toko&device=15&version=",
      tuno: "https://humulos.com/digimon/php/details.php?digimon=tuno&device=15&version=",
      tusk: "https://humulos.com/digimon/php/details.php?digimon=tusk&device=15&version=",
      tyrano: "https://humulos.com/digimon/php/details.php?digimon=tyrano&device=15&version=",
      uni: "https://humulos.com/digimon/php/details.php?digimon=uni&device=15&version=",
      vade: "https://humulos.com/digimon/php/details.php?digimon=vade&device=15&version=",
      vegi: "https://humulos.com/digimon/php/details.php?digimon=vegi&device=15&version=",
      wha: "https://humulos.com/digimon/php/details.php?digimon=wha&device=15&version=",
      yukidaru: "https://humulos.com/digimon/php/details.php?digimon=yukidaru&device=15&version=",
      yura: "https://humulos.com/digimon/php/details.php?digimon=yura&device=15&version=",
      zuru: "https://humulos.com/digimon/php/details.php?digimon=zuru&device=15&version="
    },
    dmx3: {
      alpha: "https://humulos.com/digimon/php/details.php?digimon=alpha&device=11&version=dmx3",
      alpha_o: "https://humulos.com/digimon/php/details.php?digimon=alpha_o&device=11&version=dmx3",
      angewo_x: "https://humulos.com/digimon/php/details.php?digimon=angewo_x&device=11&version=dmx3",
      anomalocari_x: "https://humulos.com/digimon/php/details.php?digimon=anomalocari_x&device=11&version=dmx3",
      bluco: "https://humulos.com/digimon/php/details.php?digimon=bluco&device=11&version=dmx3",
      cannonbee: "https://humulos.com/digimon/php/details.php?digimon=cannonbee&device=11&version=dmx3",
      cherubi_virtue_x: "https://humulos.com/digimon/php/details.php?digimon=cherubi_virtue_x&device=11&version=dmx3",
      choco: "https://humulos.com/digimon/php/details.php?digimon=choco&device=11&version=dmx3",
      coco: "https://humulos.com/digimon/php/details.php?digimon=coco&device=11&version=dmx3",
      cranium_x: "https://humulos.com/digimon/php/details.php?digimon=cranium_x&device=11&version=dmx3",
      cryspaledra: "https://humulos.com/digimon/php/details.php?digimon=cryspaledra&device=11&version=dmx3",
      cyberdra_x: "https://humulos.com/digimon/php/details.php?digimon=cyberdra_x&device=11&version=dmx3",
      diablo_x: "https://humulos.com/digimon/php/details.php?digimon=diablo_x&device=11&version=dmx3",
      dinotiger: "https://humulos.com/digimon/php/details.php?digimon=dinotiger&device=11&version=dmx3",
      doru: "https://humulos.com/digimon/php/details.php?digimon=doru&device=11&version=dmx3",
      doruga: "https://humulos.com/digimon/php/details.php?digimon=doruga&device=11&version=dmx3",
      dorugure: "https://humulos.com/digimon/php/details.php?digimon=dorugure&device=11&version=dmx3",
      duft_x: "https://humulos.com/digimon/php/details.php?digimon=duft_x&device=11&version=dmx3",
      duke_x: "https://humulos.com/digimon/php/details.php?digimon=duke_x&device=11&version=dmx3",
      dynas_x: "https://humulos.com/digimon/php/details.php?digimon=dynas_x&device=11&version=dmx3",
      ebe_x: "https://humulos.com/digimon/php/details.php?digimon=ebe_x&device=11&version=dmx3",
      exa_x: "https://humulos.com/digimon/php/details.php?digimon=exa_x&device=11&version=dmx3",
      gaiou: "https://humulos.com/digimon/php/details.php?digimon=gaiou&device=11&version=dmx3",
      gankoo_x: "https://humulos.com/digimon/php/details.php?digimon=gankoo_x&device=11&version=dmx3",
      garuda_x: "https://humulos.com/digimon/php/details.php?digimon=garuda_x&device=11&version=dmx3",
      ginryu: "https://humulos.com/digimon/php/details.php?digimon=ginryu&device=11&version=dmx3",
      goddra_x: "https://humulos.com/digimon/php/details.php?digimon=goddra_x&device=11&version=dmx3",
      grade: "https://humulos.com/digimon/php/details.php?digimon=grade&device=11&version=dmx3",
      gummy: "https://humulos.com/digimon/php/details.php?digimon=gummy&device=11&version=dmx3",
      hexeblau: "https://humulos.com/digimon/php/details.php?digimon=hexeblau&device=11&version=dmx3",
      hisyaryu: "https://humulos.com/digimon/php/details.php?digimon=hisyaryu&device=11&version=dmx3",
      holydra_x: "https://humulos.com/digimon/php/details.php?digimon=holydra_x&device=11&version=dmx3",
      houou_x: "https://humulos.com/digimon/php/details.php?digimon=houou_x&device=11&version=dmx3",
      jaza: "https://humulos.com/digimon/php/details.php?digimon=jaza&device=11&version=dmx3",
      jazard: "https://humulos.com/digimon/php/details.php?digimon=jazard&device=11&version=dmx3",
      jazarich: "https://humulos.com/digimon/php/details.php?digimon=jazarich&device=11&version=dmx3",
      jes_gx: "https://humulos.com/digimon/php/details.php?digimon=jes_gx&device=11&version=dmx3",
      jes_x: "https://humulos.com/digimon/php/details.php?digimon=jes_x&device=11&version=dmx3",
      justi_x: "https://humulos.com/digimon/php/details.php?digimon=justi_x&device=11&version=dmx3",
      kera_x: "https://humulos.com/digimon/php/details.php?digimon=kera_x&device=11&version=dmx3",
      kura: "https://humulos.com/digimon/php/details.php?digimon=kura&device=11&version=dmx3",
      lop_x: "https://humulos.com/digimon/php/details.php?digimon=lop_x&device=11&version=dmx3",
      lordknight_x: "https://humulos.com/digimon/php/details.php?digimon=lordknight_x&device=11&version=dmx3",
      magna_x: "https://humulos.com/digimon/php/details.php?digimon=magna_x&device=11&version=dmx3",
      mame_x: "https://humulos.com/digimon/php/details.php?digimon=mame_x&device=11&version=dmx3",
      mera_x: "https://humulos.com/digimon/php/details.php?digimon=mera_x&device=11&version=dmx3",
      metallicdra: "https://humulos.com/digimon/php/details.php?digimon=metallicdra&device=11&version=dmx3",
      monzae_x: "https://humulos.com/digimon/php/details.php?digimon=monzae_x&device=11&version=dmx3",
      noblepump: "https://humulos.com/digimon/php/details.php?digimon=noblepump&device=11&version=dmx3",
      ofani_x: "https://humulos.com/digimon/php/details.php?digimon=ofani_x&device=11&version=dmx3",
      ogudo_x: "https://humulos.com/digimon/php/details.php?digimon=ogudo_x&device=11&version=dmx3",
      omega_x: "https://humulos.com/digimon/php/details.php?digimon=omega_x&device=11&version=dmx3",
      omegashout_x: "https://humulos.com/digimon/php/details.php?digimon=omegashout_x&device=11&version=dmx3",
      omeka: "https://humulos.com/digimon/php/details.php?digimon=omeka&device=11&version=dmx3",
      ouryu: "https://humulos.com/digimon/php/details.php?digimon=ouryu&device=11&version=dmx3",
      pal_x: "https://humulos.com/digimon/php/details.php?digimon=pal_x&device=11&version=dmx3",
      paledra: "https://humulos.com/digimon/php/details.php?digimon=paledra&device=11&version=dmx3",
      pegas_x: "https://humulos.com/digimon/php/details.php?digimon=pegas_x&device=11&version=dmx3",
      plesio_x: "https://humulos.com/digimon/php/details.php?digimon=plesio_x&device=11&version=dmx3",
      pterano_x: "https://humulos.com/digimon/php/details.php?digimon=pterano_x&device=11&version=dmx3",
      pump: "https://humulos.com/digimon/php/details.php?digimon=pump&device=11&version=dmx3",
      rapid_x: "https://humulos.com/digimon/php/details.php?digimon=rapid_x&device=11&version=dmx3",
      rizegrey_x: "https://humulos.com/digimon/php/details.php?digimon=rizegrey_x&device=11&version=dmx3",
      ryuda: "https://humulos.com/digimon/php/details.php?digimon=ryuda&device=11&version=dmx3",
      shako_x: "https://humulos.com/digimon/php/details.php?digimon=shako_x&device=11&version=dmx3",
      siesa_x: "https://humulos.com/digimon/php/details.php?digimon=siesa_x&device=11&version=dmx3",
      sleip_x: "https://humulos.com/digimon/php/details.php?digimon=sleip_x&device=11&version=dmx3",
      tail_x: "https://humulos.com/digimon/php/details.php?digimon=tail_x&device=11&version=dmx3",
      terrier_x: "https://humulos.com/digimon/php/details.php?digimon=terrier_x&device=11&version=dmx3",
      tigervespa: "https://humulos.com/digimon/php/details.php?digimon=tigervespa&device=11&version=dmx3",
      toge_x: "https://humulos.com/digimon/php/details.php?digimon=toge_x&device=11&version=dmx3",
      tsume: "https://humulos.com/digimon/php/details.php?digimon=tsume&device=11&version=dmx3",
      tylo_x: "https://humulos.com/digimon/php/details.php?digimon=tylo_x&device=11&version=dmx3",
      ulforcevdra_x: "https://humulos.com/digimon/php/details.php?digimon=ulforcevdra_x&device=11&version=dmx3",
      wizar_x: "https://humulos.com/digimon/php/details.php?digimon=wizar_x&device=11&version=dmx3",
      zeri: "https://humulos.com/digimon/php/details.php?digimon=zeri&device=11&version=dmx3"
    },
    dmxw: {
      arresterdra: "https://humulos.com/digimon/php/details.php?digimon=arresterdra&device=2002&version=",
      chibick: "https://humulos.com/digimon/php/details.php?digimon=chibick&device=2002&version=",
      grey_2010: "https://humulos.com/digimon/php/details.php?digimon=grey_2010&device=2002&version=",
      metalgrey_2010: "https://humulos.com/digimon/php/details.php?digimon=metalgrey_2010&device=2002&version=",
      pick: "https://humulos.com/digimon/php/details.php?digimon=pick&device=2002&version=",
      shout: "https://humulos.com/digimon/php/details.php?digimon=shout&device=2002&version=",
      shout_k: "https://humulos.com/digimon/php/details.php?digimon=shout_k&device=2002&version=",
      shout_x3: "https://humulos.com/digimon/php/details.php?digimon=shout_x3&device=2002&version=",
      shout_x5: "https://humulos.com/digimon/php/details.php?digimon=shout_x5&device=2002&version="
    },
    penc: {
      aegisdra: "https://humulos.com/digimon/php/details.php?digimon=aegisdra&device=16&version=165",
      aerovdra: "https://humulos.com/digimon/php/details.php?digimon=aerovdra&device=16&version=167",
      agu: "https://humulos.com/digimon/php/details.php?digimon=agu&device=16&version=169",
      andira_d: "https://humulos.com/digimon/php/details.php?digimon=andira_d&device=16&version=183",
      andro: "https://humulos.com/digimon/php/details.php?digimon=andro&device=16&version=168",
      ange: "https://humulos.com/digimon/php/details.php?digimon=ange&device=16&version=169",
      angewo: "https://humulos.com/digimon/php/details.php?digimon=angewo&device=16&version=164",
      anomalocari: "https://humulos.com/digimon/php/details.php?digimon=anomalocari&device=16&version=165",
      anubi: "https://humulos.com/digimon/php/details.php?digimon=anubi&device=16&version=166",
      apollo: "https://humulos.com/digimon/php/details.php?digimon=apollo&device=16&version=196",
      asura: "https://humulos.com/digimon/php/details.php?digimon=asura&device=16&version=169",
      atlurkabuteri: "https://humulos.com/digimon/php/details.php?digimon=atlurkabuteri&device=16&version=164",
      bake: "https://humulos.com/digimon/php/details.php?digimon=bake&device=16&version=166",
      baku: "https://humulos.com/digimon/php/details.php?digimon=baku&device=16&version=166",
      bigmame: "https://humulos.com/digimon/php/details.php?digimon=bigmame&device=16&version=168",
      birdra: "https://humulos.com/digimon/php/details.php?digimon=birdra&device=16&version=167",
      blosso: "https://humulos.com/digimon/php/details.php?digimon=blosso&device=16&version=167",
      bolt: "https://humulos.com/digimon/php/details.php?digimon=bolt&device=16&version=166",
      bubb: "https://humulos.com/digimon/php/details.php?digimon=bubb&device=16&version=164",
      cand: "https://humulos.com/digimon/php/details.php?digimon=cand&device=16&version=166",
      cerberu: "https://humulos.com/digimon/php/details.php?digimon=cerberu&device=16&version=197",
      chaosdra: "https://humulos.com/digimon/php/details.php?digimon=chaosdra&device=16&version=168",
      chohakkai: "https://humulos.com/digimon/php/details.php?digimon=chohakkai&device=16&version=183",
      choro: "https://humulos.com/digimon/php/details.php?digimon=choro&device=16&version=168",
      clock: "https://humulos.com/digimon/php/details.php?digimon=clock&device=16&version=168",
      coela: "https://humulos.com/digimon/php/details.php?digimon=coela&device=16&version=165",
      corona: "https://humulos.com/digimon/php/details.php?digimon=corona&device=16&version=196",
      cresce: "https://humulos.com/digimon/php/details.php?digimon=cresce&device=16&version=197",
      cyberdra: "https://humulos.com/digimon/php/details.php?digimon=cyberdra&device=16&version=168",
      dago: "https://humulos.com/digimon/php/details.php?digimon=dago&device=16&version=165",
      darc: "https://humulos.com/digimon/php/details.php?digimon=darc&device=16&version=197",
      de: "https://humulos.com/digimon/php/details.php?digimon=de&device=16&version=166",
      deathmera: "https://humulos.com/digimon/php/details.php?digimon=deathmera&device=16&version=166",
      delu: "https://humulos.com/digimon/php/details.php?digimon=delu&device=16&version=167",
      devi: "https://humulos.com/digimon/php/details.php?digimon=devi&device=16&version=166",
      diana: "https://humulos.com/digimon/php/details.php?digimon=diana&device=16&version=197",
      digitama: "https://humulos.com/digimon/php/details.php?digimon=digitama&device=16&version=196",
      dober: "https://humulos.com/digimon/php/details.php?digimon=dober&device=16&version=197",
      dokugu: "https://humulos.com/digimon/php/details.php?digimon=dokugu&device=16&version=166",
      ebidra: "https://humulos.com/digimon/php/details.php?digimon=ebidra&device=16&version=165",
      elec: "https://humulos.com/digimon/php/details.php?digimon=elec&device=16&version=196",
      fanto: "https://humulos.com/digimon/php/details.php?digimon=fanto&device=16&version=166",
      fira: "https://humulos.com/digimon/php/details.php?digimon=fira&device=16&version=196",
      flare: "https://humulos.com/digimon/php/details.php?digimon=flare&device=16&version=196",
      flora: "https://humulos.com/digimon/php/details.php?digimon=flora&device=16&version=167",
      fuga: "https://humulos.com/digimon/php/details.php?digimon=fuga&device=16&version=184",
      gabu: "https://humulos.com/digimon/php/details.php?digimon=gabu&device=16&version=169",
      gani: "https://humulos.com/digimon/php/details.php?digimon=gani&device=16&version=165",
      garuda: "https://humulos.com/digimon/php/details.php?digimon=garuda&device=16&version=167",
      garuru: "https://humulos.com/digimon/php/details.php?digimon=garuru&device=16&version=166",
      garuru_b: "https://humulos.com/digimon/php/details.php?digimon=garuru_b&device=16&version=196",
      geko: "https://humulos.com/digimon/php/details.php?digimon=geko&device=16&version=164",
      gerbe: "https://humulos.com/digimon/php/details.php?digimon=gerbe&device=16&version=167",
      geso: "https://humulos.com/digimon/php/details.php?digimon=geso&device=16&version=165",
      goma: "https://humulos.com/digimon/php/details.php?digimon=goma&device=16&version=165",
      gottsu: "https://humulos.com/digimon/php/details.php?digimon=gottsu&device=16&version=164",
      gracenova: "https://humulos.com/digimon/php/details.php?digimon=gracenova&device=16&version=196",
      grankuwaga: "https://humulos.com/digimon/php/details.php?digimon=grankuwaga&device=16&version=164",
      grey: "https://humulos.com/digimon/php/details.php?digimon=grey&device=16&version=168",
      griffo: "https://humulos.com/digimon/php/details.php?digimon=griffo&device=16&version=167",
      guardro: "https://humulos.com/digimon/php/details.php?digimon=guardro&device=16&version=168",
      haguru: "https://humulos.com/digimon/php/details.php?digimon=haguru&device=16&version=168",
      hangyo: "https://humulos.com/digimon/php/details.php?digimon=hangyo&device=16&version=165",
      hanu: "https://humulos.com/digimon/php/details.php?digimon=hanu&device=16&version=166",
      heraklekabuteri: "https://humulos.com/digimon/php/details.php?digimon=heraklekabuteri&device=16&version=164",
      hiandro: "https://humulos.com/digimon/php/details.php?digimon=hiandro&device=16&version=168",
      holyange: "https://humulos.com/digimon/php/details.php?digimon=holyange&device=16&version=169",
      holydra: "https://humulos.com/digimon/php/details.php?digimon=holydra&device=16&version=164",
      houou: "https://humulos.com/digimon/php/details.php?digimon=houou&device=16&version=167",
      iga: "https://humulos.com/digimon/php/details.php?digimon=iga&device=16&version=169",
      ikkaku: "https://humulos.com/digimon/php/details.php?digimon=ikkaku&device=16&version=165",
      jyaga: "https://humulos.com/digimon/php/details.php?digimon=jyaga&device=16&version=164",
      jyurei: "https://humulos.com/digimon/php/details.php?digimon=jyurei&device=16&version=167",
      kabuteri: "https://humulos.com/digimon/php/details.php?digimon=kabuteri&device=16&version=164",
      kiwi: "https://humulos.com/digimon/php/details.php?digimon=kiwi&device=16&version=167",
      knight: "https://humulos.com/digimon/php/details.php?digimon=knight&device=16&version=168",
      kokuwa: "https://humulos.com/digimon/php/details.php?digimon=kokuwa&device=16&version=168",
      kuwaga: "https://humulos.com/digimon/php/details.php?digimon=kuwaga&device=16&version=164",
      ladydevi: "https://humulos.com/digimon/php/details.php?digimon=ladydevi&device=16&version=166",
      lekis: "https://humulos.com/digimon/php/details.php?digimon=lekis&device=16&version=197",
      leo: "https://humulos.com/digimon/php/details.php?digimon=leo&device=16&version=169",
      lili: "https://humulos.com/digimon/php/details.php?digimon=lili&device=16&version=167",
      luna: "https://humulos.com/digimon/php/details.php?digimon=luna&device=16&version=197",
      mam: "https://humulos.com/digimon/php/details.php?digimon=mam&device=16&version=166",
      marinange: "https://humulos.com/digimon/php/details.php?digimon=marinange&device=16&version=165",
      marindevi: "https://humulos.com/digimon/php/details.php?digimon=marindevi&device=16&version=165",
      maste: "https://humulos.com/digimon/php/details.php?digimon=maste&device=16&version=164",
      mechanori: "https://humulos.com/digimon/php/details.php?digimon=mechanori&device=16&version=168",
      megadra: "https://humulos.com/digimon/php/details.php?digimon=megadra&device=16&version=168",
      megaseadra: "https://humulos.com/digimon/php/details.php?digimon=megaseadra&device=16&version=165",
      mera: "https://humulos.com/digimon/php/details.php?digimon=mera&device=16&version=166",
      metalete: "https://humulos.com/digimon/php/details.php?digimon=metalete&device=16&version=164",
      metalgaruru: "https://humulos.com/digimon/php/details.php?digimon=metalgaruru&device=16&version=168",
      metalgrey_va: "https://humulos.com/digimon/php/details.php?digimon=metalgrey_va&device=16&version=168",
      metalmame: "https://humulos.com/digimon/php/details.php?digimon=metalmame&device=16&version=169",
      metalseadra: "https://humulos.com/digimon/php/details.php?digimon=metalseadra&device=16&version=165",
      mochi: "https://humulos.com/digimon/php/details.php?digimon=mochi&device=16&version=164",
      moku: "https://humulos.com/digimon/php/details.php?digimon=moku&device=16&version=166",
      monochro: "https://humulos.com/digimon/php/details.php?digimon=monochro&device=16&version=164",
      moon: "https://humulos.com/digimon/php/details.php?digimon=moon&device=16&version=197",
      mugendra: "https://humulos.com/digimon/php/details.php?digimon=mugendra&device=16&version=168",
      mush: "https://humulos.com/digimon/php/details.php?digimon=mush&device=16&version=167",
      noblepump: "https://humulos.com/digimon/php/details.php?digimon=noblepump&device=16&version=166",
      nyaro: "https://humulos.com/digimon/php/details.php?digimon=nyaro&device=16&version=169",
      nyoki: "https://humulos.com/digimon/php/details.php?digimon=nyoki&device=16&version=167",
      oct: "https://humulos.com/digimon/php/details.php?digimon=oct&device=16&version=165",
      ogre: "https://humulos.com/digimon/php/details.php?digimon=ogre&device=16&version=196",
      okuwa: "https://humulos.com/digimon/php/details.php?digimon=okuwa&device=16&version=164",
      omega: "https://humulos.com/digimon/php/details.php?digimon=omega&device=16&version=168",
      otama: "https://humulos.com/digimon/php/details.php?digimon=otama&device=16&version=164",
      pal: "https://humulos.com/digimon/php/details.php?digimon=pal&device=16&version=167",
      panda: "https://humulos.com/digimon/php/details.php?digimon=panda&device=16&version=183",
      peck: "https://humulos.com/digimon/php/details.php?digimon=peck&device=16&version=184",
      petimera: "https://humulos.com/digimon/php/details.php?digimon=petimera&device=16&version=166",
      piccolo: "https://humulos.com/digimon/php/details.php?digimon=piccolo&device=16&version=164",
      picodevi: "https://humulos.com/digimon/php/details.php?digimon=picodevi&device=16&version=166",
      pie: "https://humulos.com/digimon/php/details.php?digimon=pie&device=16&version=166",
      pinochi: "https://humulos.com/digimon/php/details.php?digimon=pinochi&device=16&version=167",
      pitch: "https://humulos.com/digimon/php/details.php?digimon=pitch&device=16&version=165",
      piyo: "https://humulos.com/digimon/php/details.php?digimon=piyo&device=16&version=167",
      plesio: "https://humulos.com/digimon/php/details.php?digimon=plesio&device=16&version=165",
      plot: "https://humulos.com/digimon/php/details.php?digimon=plot&device=16&version=169",
      puka: "https://humulos.com/digimon/php/details.php?digimon=puka&device=16&version=165",
      puku: "https://humulos.com/digimon/php/details.php?digimon=puku&device=16&version=165",
      pump: "https://humulos.com/digimon/php/details.php?digimon=pump&device=16&version=166",
      pyoco: "https://humulos.com/digimon/php/details.php?digimon=pyoco&device=16&version=167",
      rafflesi: "https://humulos.com/digimon/php/details.php?digimon=rafflesi&device=16&version=167",
      rav: "https://humulos.com/digimon/php/details.php?digimon=rav&device=16&version=184",
      redvegi: "https://humulos.com/digimon/php/details.php?digimon=redvegi&device=16&version=167",
      rele: "https://humulos.com/digimon/php/details.php?digimon=rele&device=16&version=197",
      rena: "https://humulos.com/digimon/php/details.php?digimon=rena&device=16&version=184",
      revol: "https://humulos.com/digimon/php/details.php?digimon=revol&device=16&version=168",
      rose: "https://humulos.com/digimon/php/details.php?digimon=rose&device=16&version=167",
      ruka: "https://humulos.com/digimon/php/details.php?digimon=ruka&device=16&version=165",
      saberleo: "https://humulos.com/digimon/php/details.php?digimon=saberleo&device=16&version=164",
      seadra: "https://humulos.com/digimon/php/details.php?digimon=seadra&device=16&version=165",
      shako: "https://humulos.com/digimon/php/details.php?digimon=shako&device=16&version=165",
      shell: "https://humulos.com/digimon/php/details.php?digimon=shell&device=16&version=184",
      siren: "https://humulos.com/digimon/php/details.php?digimon=siren&device=16&version=197",
      skullmam: "https://humulos.com/digimon/php/details.php?digimon=skullmam&device=16&version=166",
      star: "https://humulos.com/digimon/php/details.php?digimon=star&device=16&version=164",
      sun: "https://humulos.com/digimon/php/details.php?digimon=sun&device=16&version=196",
      tail: "https://humulos.com/digimon/php/details.php?digimon=tail&device=16&version=164",
      tank: "https://humulos.com/digimon/php/details.php?digimon=tank&device=16&version=168",
      tento: "https://humulos.com/digimon/php/details.php?digimon=tento&device=16&version=164",
      thunderball: "https://humulos.com/digimon/php/details.php?digimon=thunderball&device=16&version=168",
      tita: "https://humulos.com/digimon/php/details.php?digimon=tita&device=16&version=196",
      toge: "https://humulos.com/digimon/php/details.php?digimon=toge&device=16&version=167",
      tonosamageko: "https://humulos.com/digimon/php/details.php?digimon=tonosamageko&device=16&version=164",
      torta: "https://humulos.com/digimon/php/details.php?digimon=torta&device=16&version=164",
      toyagu: "https://humulos.com/digimon/php/details.php?digimon=toyagu&device=16&version=168",
      tricera: "https://humulos.com/digimon/php/details.php?digimon=tricera&device=16&version=164",
      turuie: "https://humulos.com/digimon/php/details.php?digimon=turuie&device=16&version=183",
      tylo: "https://humulos.com/digimon/php/details.php?digimon=tylo&device=16&version=196",
      ulforcevdra: "https://humulos.com/digimon/php/details.php?digimon=ulforcevdra&device=16&version=167",
      vamde: "https://humulos.com/digimon/php/details.php?digimon=vamde&device=16&version=166",
      vdra: "https://humulos.com/digimon/php/details.php?digimon=vdra&device=16&version=167",
      venomvamde: "https://humulos.com/digimon/php/details.php?digimon=venomvamde&device=16&version=168",
      vike: "https://humulos.com/digimon/php/details.php?digimon=vike&device=16&version=165",
      voltobauta: "https://humulos.com/digimon/php/details.php?digimon=voltobauta&device=16&version=166",
      wargrey: "https://humulos.com/digimon/php/details.php?digimon=wargrey&device=16&version=168",
      warumonzae: "https://humulos.com/digimon/php/details.php?digimon=warumonzae&device=16&version=168",
      weregaruru: "https://humulos.com/digimon/php/details.php?digimon=weregaruru&device=16&version=166",
      weregaruru_b: "https://humulos.com/digimon/php/details.php?digimon=weregaruru_b&device=16&version=196",
      wha: "https://humulos.com/digimon/php/details.php?digimon=wha&device=16&version=165",
      wizar: "https://humulos.com/digimon/php/details.php?digimon=wizar&device=16&version=166",
      wood: "https://humulos.com/digimon/php/details.php?digimon=wood&device=16&version=167",
      yatagara_2006: "https://humulos.com/digimon/php/details.php?digimon=yatagara_2006&device=16&version=184",
      yukimibota: "https://humulos.com/digimon/php/details.php?digimon=yukimibota&device=16&version=169",
      zudo: "https://humulos.com/digimon/php/details.php?digimon=zudo&device=16&version=165"
    },
    vbbe: {
      agu_2006: "https://humulos.com/digimon/php/details.php?digimon=agu_2006&device=14&version=",
      agu_b: "https://humulos.com/digimon/php/details.php?digimon=agu_b&device=14&version=",
      agu_d: "https://humulos.com/digimon/php/details.php?digimon=agu_d&device=14&version=",
      airdra: "https://humulos.com/digimon/php/details.php?digimon=airdra&device=14&version=",
      airdra_d: "https://humulos.com/digimon/php/details.php?digimon=airdra_d&device=14&version=",
      alpha: "https://humulos.com/digimon/php/details.php?digimon=alpha&device=14&version=",
      alpha_o: "https://humulos.com/digimon/php/details.php?digimon=alpha_o&device=14&version=",
      andro: "https://humulos.com/digimon/php/details.php?digimon=andro&device=14&version=",
      ange: "https://humulos.com/digimon/php/details.php?digimon=ange&device=14&version=",
      angewo: "https://humulos.com/digimon/php/details.php?digimon=angewo&device=14&version=",
      ankylo: "https://humulos.com/digimon/php/details.php?digimon=ankylo&device=14&version=",
      anomalocari_x: "https://humulos.com/digimon/php/details.php?digimon=anomalocari_x&device=14&version=",
      apollo: "https://humulos.com/digimon/php/details.php?digimon=apollo&device=14&version=",
      aquila: "https://humulos.com/digimon/php/details.php?digimon=aquila&device=14&version=",
      armadi: "https://humulos.com/digimon/php/details.php?digimon=armadi&device=14&version=",
      armage: "https://humulos.com/digimon/php/details.php?digimon=armage&device=14&version=",
      arresterdra: "https://humulos.com/digimon/php/details.php?digimon=arresterdra&device=14&version=",
      asta: "https://humulos.com/digimon/php/details.php?digimon=asta&device=14&version=",
      atlurkabuteri_r: "https://humulos.com/digimon/php/details.php?digimon=atlurkabuteri_r&device=14&version=",
      babyd: "https://humulos.com/digimon/php/details.php?digimon=babyd&device=14&version=",
      bancholili: "https://humulos.com/digimon/php/details.php?digimon=bancholili&device=14&version=",
      banchomame_d: "https://humulos.com/digimon/php/details.php?digimon=banchomame_d&device=14&version=",
      belialvamde: "https://humulos.com/digimon/php/details.php?digimon=belialvamde&device=14&version=",
      belphe_r: "https://humulos.com/digimon/php/details.php?digimon=belphe_r&device=14&version=",
      beta_d: "https://humulos.com/digimon/php/details.php?digimon=beta_d&device=14&version=",
      bibi: "https://humulos.com/digimon/php/details.php?digimon=bibi&device=14&version=",
      bibi_d: "https://humulos.com/digimon/php/details.php?digimon=bibi_d&device=14&version=",
      birdra: "https://humulos.com/digimon/php/details.php?digimon=birdra&device=14&version=",
      blitzgrey_d: "https://humulos.com/digimon/php/details.php?digimon=blitzgrey_d&device=14&version=",
      bota: "https://humulos.com/digimon/php/details.php?digimon=bota&device=14&version=",
      bota_d: "https://humulos.com/digimon/php/details.php?digimon=bota_d&device=14&version=",
      bout: "https://humulos.com/digimon/php/details.php?digimon=bout&device=14&version=",
      bout_d: "https://humulos.com/digimon/php/details.php?digimon=bout_d&device=14&version=",
      breakdra: "https://humulos.com/digimon/php/details.php?digimon=breakdra&device=14&version=",
      bubb: "https://humulos.com/digimon/php/details.php?digimon=bubb&device=14&version=",
      bulk: "https://humulos.com/digimon/php/details.php?digimon=bulk&device=14&version=",
      bulk_d: "https://humulos.com/digimon/php/details.php?digimon=bulk_d&device=14&version=",
      cannonbee: "https://humulos.com/digimon/php/details.php?digimon=cannonbee&device=14&version=",
      cerberu: "https://humulos.com/digimon/php/details.php?digimon=cerberu&device=14&version=",
      chaosdra: "https://humulos.com/digimon/php/details.php?digimon=chaosdra&device=14&version=",
      chibi: "https://humulos.com/digimon/php/details.php?digimon=chibi&device=14&version=",
      chico: "https://humulos.com/digimon/php/details.php?digimon=chico&device=14&version=",
      chimaira: "https://humulos.com/digimon/php/details.php?digimon=chimaira&device=14&version=",
      coredra_b: "https://humulos.com/digimon/php/details.php?digimon=coredra_b&device=14&version=",
      coredra_g: "https://humulos.com/digimon/php/details.php?digimon=coredra_g&device=14&version=",
      corona: "https://humulos.com/digimon/php/details.php?digimon=corona&device=14&version=",
      cresce: "https://humulos.com/digimon/php/details.php?digimon=cresce&device=14&version=",
      dame: "https://humulos.com/digimon/php/details.php?digimon=dame&device=14&version=",
      darkdra: "https://humulos.com/digimon/php/details.php?digimon=darkdra&device=14&version=",
      darktyrano: "https://humulos.com/digimon/php/details.php?digimon=darktyrano&device=14&version=",
      delta: "https://humulos.com/digimon/php/details.php?digimon=delta&device=14&version=",
      devi_d: "https://humulos.com/digimon/php/details.php?digimon=devi_d&device=14&version=",
      diana: "https://humulos.com/digimon/php/details.php?digimon=diana&device=14&version=",
      digitama: "https://humulos.com/digimon/php/details.php?digimon=digitama&device=14&version=",
      dinobee: "https://humulos.com/digimon/php/details.php?digimon=dinobee&device=14&version=",
      dodo: "https://humulos.com/digimon/php/details.php?digimon=dodo&device=14&version=",
      doki: "https://humulos.com/digimon/php/details.php?digimon=doki&device=14&version=",
      doki_d: "https://humulos.com/digimon/php/details.php?digimon=doki_d&device=14&version=",
      dori: "https://humulos.com/digimon/php/details.php?digimon=dori&device=14&version=",
      doru: "https://humulos.com/digimon/php/details.php?digimon=doru&device=14&version=",
      doruga: "https://humulos.com/digimon/php/details.php?digimon=doruga&device=14&version=",
      dorugora: "https://humulos.com/digimon/php/details.php?digimon=dorugora&device=14&version=",
      dorugure: "https://humulos.com/digimon/php/details.php?digimon=dorugure&device=14&version=",
      draco: "https://humulos.com/digimon/php/details.php?digimon=draco&device=14&version=",
      dracu: "https://humulos.com/digimon/php/details.php?digimon=dracu&device=14&version=",
      eos_v: "https://humulos.com/digimon/php/details.php?digimon=eos_v&device=14&version=",
      ete: "https://humulos.com/digimon/php/details.php?digimon=ete&device=14&version=",
      exa: "https://humulos.com/digimon/php/details.php?digimon=exa&device=14&version=",
      falco_2006: "https://humulos.com/digimon/php/details.php?digimon=falco_2006&device=14&version=",
      fil: "https://humulos.com/digimon/php/details.php?digimon=fil&device=14&version=",
      fira: "https://humulos.com/digimon/php/details.php?digimon=fira&device=14&version=",
      flare: "https://humulos.com/digimon/php/details.php?digimon=flare&device=14&version=",
      fufu: "https://humulos.com/digimon/php/details.php?digimon=fufu&device=14&version=",
      gao: "https://humulos.com/digimon/php/details.php?digimon=gao&device=14&version=",
      gaoga: "https://humulos.com/digimon/php/details.php?digimon=gaoga&device=14&version=",
      garuda: "https://humulos.com/digimon/php/details.php?digimon=garuda&device=14&version=",
      geogrey: "https://humulos.com/digimon/php/details.php?digimon=geogrey&device=14&version=",
      gigaseadra: "https://humulos.com/digimon/php/details.php?digimon=gigaseadra&device=14&version=",
      ginryu: "https://humulos.com/digimon/php/details.php?digimon=ginryu&device=14&version=",
      giro: "https://humulos.com/digimon/php/details.php?digimon=giro&device=14&version=",
      gracenova: "https://humulos.com/digimon/php/details.php?digimon=gracenova&device=14&version=",
      grade: "https://humulos.com/digimon/php/details.php?digimon=grade&device=14&version=",
      granddracu: "https://humulos.com/digimon/php/details.php?digimon=granddracu&device=14&version=",
      grankuwaga: "https://humulos.com/digimon/php/details.php?digimon=grankuwaga&device=14&version=",
      grey_d: "https://humulos.com/digimon/php/details.php?digimon=grey_d&device=14&version=",
      groundra: "https://humulos.com/digimon/php/details.php?digimon=groundra&device=14&version=",
      gundra: "https://humulos.com/digimon/php/details.php?digimon=gundra&device=14&version=",
      hack: "https://humulos.com/digimon/php/details.php?digimon=hack&device=14&version=",
      hawk: "https://humulos.com/digimon/php/details.php?digimon=hawk&device=14&version=",
      heavyleo: "https://humulos.com/digimon/php/details.php?digimon=heavyleo&device=14&version=",
      heraklekabuteri: "https://humulos.com/digimon/php/details.php?digimon=heraklekabuteri&device=14&version=",
      heriss: "https://humulos.com/digimon/php/details.php?digimon=heriss&device=14&version=",
      hiandro: "https://humulos.com/digimon/php/details.php?digimon=hiandro&device=14&version=",
      hippogriffo: "https://humulos.com/digimon/php/details.php?digimon=hippogriffo&device=14&version=",
      hisyaryu: "https://humulos.com/digimon/php/details.php?digimon=hisyaryu&device=14&version=",
      holyange: "https://humulos.com/digimon/php/details.php?digimon=holyange&device=14&version=",
      holydra: "https://humulos.com/digimon/php/details.php?digimon=holydra&device=14&version=",
      houou: "https://humulos.com/digimon/php/details.php?digimon=houou&device=14&version=",
      hudie: "https://humulos.com/digimon/php/details.php?digimon=hudie&device=14&version=",
      ikkaku: "https://humulos.com/digimon/php/details.php?digimon=ikkaku&device=14&version=",
      imperialdra_f: "https://humulos.com/digimon/php/details.php?digimon=imperialdra_f&device=14&version=",
      imperialdra_p: "https://humulos.com/digimon/php/details.php?digimon=imperialdra_p&device=14&version=",
      jaza: "https://humulos.com/digimon/php/details.php?digimon=jaza&device=14&version=",
      jazarich: "https://humulos.com/digimon/php/details.php?digimon=jazarich&device=14&version=",
      jes: "https://humulos.com/digimon/php/details.php?digimon=jes&device=14&version=",
      kabuteri: "https://humulos.com/digimon/php/details.php?digimon=kabuteri&device=14&version=",
      kazuchi: "https://humulos.com/digimon/php/details.php?digimon=kazuchi&device=14&version=",
      kazuchi_d: "https://humulos.com/digimon/php/details.php?digimon=kazuchi_d&device=14&version=",
      kingete: "https://humulos.com/digimon/php/details.php?digimon=kingete&device=14&version=",
      koro_d: "https://humulos.com/digimon/php/details.php?digimon=koro_d&device=14&version=",
      kuwaga: "https://humulos.com/digimon/php/details.php?digimon=kuwaga&device=14&version=",
      kyokyo: "https://humulos.com/digimon/php/details.php?digimon=kyokyo&device=14&version=",
      lala: "https://humulos.com/digimon/php/details.php?digimon=lala&device=14&version=",
      lekis: "https://humulos.com/digimon/php/details.php?digimon=lekis&device=14&version=",
      leo: "https://humulos.com/digimon/php/details.php?digimon=leo&device=14&version=",
      lila: "https://humulos.com/digimon/php/details.php?digimon=lila&device=14&version=",
      luna: "https://humulos.com/digimon/php/details.php?digimon=luna&device=14&version=",
      machgaoga: "https://humulos.com/digimon/php/details.php?digimon=machgaoga&device=14&version=",
      madleo: "https://humulos.com/digimon/php/details.php?digimon=madleo&device=14&version=",
      magna: "https://humulos.com/digimon/php/details.php?digimon=magna&device=14&version=",
      mame_d: "https://humulos.com/digimon/php/details.php?digimon=mame_d&device=14&version=",
      marinchimaira: "https://humulos.com/digimon/php/details.php?digimon=marinchimaira&device=14&version=",
      megadra: "https://humulos.com/digimon/php/details.php?digimon=megadra&device=14&version=",
      mera_d: "https://humulos.com/digimon/php/details.php?digimon=mera_d&device=14&version=",
      metalete: "https://humulos.com/digimon/php/details.php?digimon=metalete&device=14&version=",
      metalgrey_vi_d: "https://humulos.com/digimon/php/details.php?digimon=metalgrey_vi_d&device=14&version=",
      metallicdra: "https://humulos.com/digimon/php/details.php?digimon=metallicdra&device=14&version=",
      metalseadra: "https://humulos.com/digimon/php/details.php?digimon=metalseadra&device=14&version=",
      metaltyrano: "https://humulos.com/digimon/php/details.php?digimon=metaltyrano&device=14&version=",
      mino: "https://humulos.com/digimon/php/details.php?digimon=mino&device=14&version=",
      miragegaoga: "https://humulos.com/digimon/php/details.php?digimon=miragegaoga&device=14&version=",
      mochi: "https://humulos.com/digimon/php/details.php?digimon=mochi&device=14&version=",
      monzae: "https://humulos.com/digimon/php/details.php?digimon=monzae&device=14&version=",
      monzae_d: "https://humulos.com/digimon/php/details.php?digimon=monzae_d&device=14&version=",
      morpho: "https://humulos.com/digimon/php/details.php?digimon=morpho&device=14&version=",
      mugendra: "https://humulos.com/digimon/php/details.php?digimon=mugendra&device=14&version=",
      mummy: "https://humulos.com/digimon/php/details.php?digimon=mummy&device=14&version=",
      nidhogg: "https://humulos.com/digimon/php/details.php?digimon=nidhogg&device=14&version=",
      nume: "https://humulos.com/digimon/php/details.php?digimon=nume&device=14&version=",
      nume_d: "https://humulos.com/digimon/php/details.php?digimon=nume_d&device=14&version=",
      nyoki: "https://humulos.com/digimon/php/details.php?digimon=nyoki&device=14&version=",
      okuwa: "https://humulos.com/digimon/php/details.php?digimon=okuwa&device=14&version=",
      orochi: "https://humulos.com/digimon/php/details.php?digimon=orochi&device=14&version=",
      ouryu: "https://humulos.com/digimon/php/details.php?digimon=ouryu&device=14&version=",
      paildra: "https://humulos.com/digimon/php/details.php?digimon=paildra&device=14&version=",
      pata: "https://humulos.com/digimon/php/details.php?digimon=pata&device=14&version=",
      peck: "https://humulos.com/digimon/php/details.php?digimon=peck&device=14&version=",
      petit: "https://humulos.com/digimon/php/details.php?digimon=petit&device=14&version=",
      phasco: "https://humulos.com/digimon/php/details.php?digimon=phasco&device=14&version=",
      pid: "https://humulos.com/digimon/php/details.php?digimon=pid&device=14&version=",
      pie: "https://humulos.com/digimon/php/details.php?digimon=pie&device=14&version=",
      piyo: "https://humulos.com/digimon/php/details.php?digimon=piyo&device=14&version=",
      platinumnume: "https://humulos.com/digimon/php/details.php?digimon=platinumnume&device=14&version=",
      poro: "https://humulos.com/digimon/php/details.php?digimon=poro&device=14&version=",
      pulse: "https://humulos.com/digimon/php/details.php?digimon=pulse&device=14&version=",
      pulse_d: "https://humulos.com/digimon/php/details.php?digimon=pulse_d&device=14&version=",
      pururu: "https://humulos.com/digimon/php/details.php?digimon=pururu&device=14&version=",
      pyoco: "https://humulos.com/digimon/php/details.php?digimon=pyoco&device=14&version=",
      rasen: "https://humulos.com/digimon/php/details.php?digimon=rasen&device=14&version=",
      rasen_f: "https://humulos.com/digimon/php/details.php?digimon=rasen_f&device=14&version=",
      rav: "https://humulos.com/digimon/php/details.php?digimon=rav&device=14&version=",
      reppa: "https://humulos.com/digimon/php/details.php?digimon=reppa&device=14&version=",
      rizegrey: "https://humulos.com/digimon/php/details.php?digimon=rizegrey&device=14&version=",
      rose: "https://humulos.com/digimon/php/details.php?digimon=rose&device=14&version=",
      rusttyrano: "https://humulos.com/digimon/php/details.php?digimon=rusttyrano&device=14&version=",
      ryuda: "https://humulos.com/digimon/php/details.php?digimon=ryuda&device=14&version=",
      sangloup: "https://humulos.com/digimon/php/details.php?digimon=sangloup&device=14&version=",
      saviorhack: "https://humulos.com/digimon/php/details.php?digimon=saviorhack&device=14&version=",
      seadra_d: "https://humulos.com/digimon/php/details.php?digimon=seadra_d&device=14&version=",
      seraphi: "https://humulos.com/digimon/php/details.php?digimon=seraphi&device=14&version=",
      shakkou: "https://humulos.com/digimon/php/details.php?digimon=shakkou&device=14&version=",
      shinegrey: "https://humulos.com/digimon/php/details.php?digimon=shinegrey&device=14&version=",
      shinmonzae: "https://humulos.com/digimon/php/details.php?digimon=shinmonzae&device=14&version=",
      shinmonzae_d: "https://humulos.com/digimon/php/details.php?digimon=shinmonzae_d&device=14&version=",
      shout: "https://humulos.com/digimon/php/details.php?digimon=shout&device=14&version=",
      silphy: "https://humulos.com/digimon/php/details.php?digimon=silphy&device=14&version=",
      slayerdra: "https://humulos.com/digimon/php/details.php?digimon=slayerdra&device=14&version=",
      stiffil: "https://humulos.com/digimon/php/details.php?digimon=stiffil&device=14&version=",
      sting: "https://humulos.com/digimon/php/details.php?digimon=sting&device=14&version=",
      submari: "https://humulos.com/digimon/php/details.php?digimon=submari&device=14&version=",
      sunflow: "https://humulos.com/digimon/php/details.php?digimon=sunflow&device=14&version=",
      tail: "https://humulos.com/digimon/php/details.php?digimon=tail&device=14&version=",
      tail_c: "https://humulos.com/digimon/php/details.php?digimon=tail_c&device=14&version=",
      tento: "https://humulos.com/digimon/php/details.php?digimon=tento&device=14&version=",
      thunderball: "https://humulos.com/digimon/php/details.php?digimon=thunderball&device=14&version=",
      tigervespa: "https://humulos.com/digimon/php/details.php?digimon=tigervespa&device=14&version=",
      tobiu: "https://humulos.com/digimon/php/details.php?digimon=tobiu&device=14&version=",
      toropia: "https://humulos.com/digimon/php/details.php?digimon=toropia&device=14&version=",
      tsubu: "https://humulos.com/digimon/php/details.php?digimon=tsubu&device=14&version=",
      tyrano: "https://humulos.com/digimon/php/details.php?digimon=tyrano&device=14&version=",
      tyrano_d: "https://humulos.com/digimon/php/details.php?digimon=tyrano_d&device=14&version=",
      upa: "https://humulos.com/digimon/php/details.php?digimon=upa&device=14&version=",
      v: "https://humulos.com/digimon/php/details.php?digimon=v&device=14&version=",
      valkyri: "https://humulos.com/digimon/php/details.php?digimon=valkyri&device=14&version=",
      vamde: "https://humulos.com/digimon/php/details.php?digimon=vamde&device=14&version=",
      vike: "https://humulos.com/digimon/php/details.php?digimon=vike&device=14&version=",
      wanya: "https://humulos.com/digimon/php/details.php?digimon=wanya&device=14&version=",
      waruseadra: "https://humulos.com/digimon/php/details.php?digimon=waruseadra&device=14&version=",
      wingdra: "https://humulos.com/digimon/php/details.php?digimon=wingdra&device=14&version=",
      worm: "https://humulos.com/digimon/php/details.php?digimon=worm&device=14&version=",
      xv: "https://humulos.com/digimon/php/details.php?digimon=xv&device=14&version=",
      yatagara_2006: "https://humulos.com/digimon/php/details.php?digimon=yatagara_2006&device=14&version=",
      zudo: "https://humulos.com/digimon/php/details.php?digimon=zudo&device=14&version="
    },
    vbdm: {
      aegisdra: "https://humulos.com/digimon/php/details.php?digimon=aegisdra&device=13&version=",
      aerovdra: "https://humulos.com/digimon/php/details.php?digimon=aerovdra&device=13&version=",
      agni: "https://humulos.com/digimon/php/details.php?digimon=agni&device=13&version=",
      agu: "https://humulos.com/digimon/php/details.php?digimon=agu&device=13&version=",
      agu_b: "https://humulos.com/digimon/php/details.php?digimon=agu_b&device=13&version=",
      alda: "https://humulos.com/digimon/php/details.php?digimon=alda&device=13&version=",
      algo_iv: "https://humulos.com/digimon/php/details.php?digimon=algo_iv&device=13&version=",
      ancientbeat: "https://humulos.com/digimon/php/details.php?digimon=ancientbeat&device=13&version=",
      ancientgaruru: "https://humulos.com/digimon/php/details.php?digimon=ancientgaruru&device=13&version=",
      ancientgrey: "https://humulos.com/digimon/php/details.php?digimon=ancientgrey&device=13&version=",
      ancientiris: "https://humulos.com/digimon/php/details.php?digimon=ancientiris&device=13&version=",
      ancientmegatheriu: "https://humulos.com/digimon/php/details.php?digimon=ancientmegatheriu&device=13&version=",
      ancientmermai: "https://humulos.com/digimon/php/details.php?digimon=ancientmermai&device=13&version=",
      ancientsphinx: "https://humulos.com/digimon/php/details.php?digimon=ancientsphinx&device=13&version=",
      ancienttroia: "https://humulos.com/digimon/php/details.php?digimon=ancienttroia&device=13&version=",
      ancientvolca: "https://humulos.com/digimon/php/details.php?digimon=ancientvolca&device=13&version=",
      ancientwise: "https://humulos.com/digimon/php/details.php?digimon=ancientwise&device=13&version=",
      andira: "https://humulos.com/digimon/php/details.php?digimon=andira&device=13&version=",
      andira_d: "https://humulos.com/digimon/php/details.php?digimon=andira_d&device=13&version=",
      andro: "https://humulos.com/digimon/php/details.php?digimon=andro&device=13&version=",
      anomalocari: "https://humulos.com/digimon/php/details.php?digimon=anomalocari&device=13&version=",
      anubi: "https://humulos.com/digimon/php/details.php?digimon=anubi&device=13&version=",
      asta: "https://humulos.com/digimon/php/details.php?digimon=asta&device=13&version=",
      asura: "https://humulos.com/digimon/php/details.php?digimon=asura&device=13&version=",
      baal: "https://humulos.com/digimon/php/details.php?digimon=baal&device=13&version=",
      bake: "https://humulos.com/digimon/php/details.php?digimon=bake&device=13&version=",
      beelzebu: "https://humulos.com/digimon/php/details.php?digimon=beelzebu&device=13&version=",
      beelzebu_2010: "https://humulos.com/digimon/php/details.php?digimon=beelzebu_2010&device=13&version=",
      beelzebu_b: "https://humulos.com/digimon/php/details.php?digimon=beelzebu_b&device=13&version=",
      beowolf: "https://humulos.com/digimon/php/details.php?digimon=beowolf&device=13&version=",
      bibi: "https://humulos.com/digimon/php/details.php?digimon=bibi&device=13&version=",
      bigmame: "https://humulos.com/digimon/php/details.php?digimon=bigmame&device=13&version=",
      birdra: "https://humulos.com/digimon/php/details.php?digimon=birdra&device=13&version=",
      blitzgrey: "https://humulos.com/digimon/php/details.php?digimon=blitzgrey&device=13&version=",
      blosso: "https://humulos.com/digimon/php/details.php?digimon=blosso&device=13&version=",
      bluco: "https://humulos.com/digimon/php/details.php?digimon=bluco&device=13&version=",
      bota: "https://humulos.com/digimon/php/details.php?digimon=bota&device=13&version=",
      bout: "https://humulos.com/digimon/php/details.php?digimon=bout&device=13&version=",
      bryweludra: "https://humulos.com/digimon/php/details.php?digimon=bryweludra&device=13&version=",
      bulk: "https://humulos.com/digimon/php/details.php?digimon=bulk&device=13&version=",
      cerberu: "https://humulos.com/digimon/php/details.php?digimon=cerberu&device=13&version=",
      chaosdra: "https://humulos.com/digimon/php/details.php?digimon=chaosdra&device=13&version=",
      cherubi: "https://humulos.com/digimon/php/details.php?digimon=cherubi&device=13&version=",
      chibi: "https://humulos.com/digimon/php/details.php?digimon=chibi&device=13&version=",
      chico: "https://humulos.com/digimon/php/details.php?digimon=chico&device=13&version=",
      chimaira: "https://humulos.com/digimon/php/details.php?digimon=chimaira&device=13&version=",
      choro: "https://humulos.com/digimon/php/details.php?digimon=choro&device=13&version=",
      cockatri: "https://humulos.com/digimon/php/details.php?digimon=cockatri&device=13&version=",
      coela: "https://humulos.com/digimon/php/details.php?digimon=coela&device=13&version=",
      cotsuco: "https://humulos.com/digimon/php/details.php?digimon=cotsuco&device=13&version=",
      cresce: "https://humulos.com/digimon/php/details.php?digimon=cresce&device=13&version=",
      cresgaruru: "https://humulos.com/digimon/php/details.php?digimon=cresgaruru&device=13&version=",
      cryspaledra: "https://humulos.com/digimon/php/details.php?digimon=cryspaledra&device=13&version=",
      cyberdra: "https://humulos.com/digimon/php/details.php?digimon=cyberdra&device=13&version=",
      cyberdra_2010: "https://humulos.com/digimon/php/details.php?digimon=cyberdra_2010&device=13&version=",
      dago: "https://humulos.com/digimon/php/details.php?digimon=dago&device=13&version=",
      darksuperstar: "https://humulos.com/digimon/php/details.php?digimon=darksuperstar&device=13&version=",
      darktyrano: "https://humulos.com/digimon/php/details.php?digimon=darktyrano&device=13&version=",
      death: "https://humulos.com/digimon/php/details.php?digimon=death&device=13&version=",
      death_b: "https://humulos.com/digimon/php/details.php?digimon=death_b&device=13&version=",
      deathmera: "https://humulos.com/digimon/php/details.php?digimon=deathmera&device=13&version=",
      devi: "https://humulos.com/digimon/php/details.php?digimon=devi&device=13&version=",
      devidra: "https://humulos.com/digimon/php/details.php?digimon=devidra&device=13&version=",
      digitama: "https://humulos.com/digimon/php/details.php?digimon=digitama&device=13&version=",
      dinobee: "https://humulos.com/digimon/php/details.php?digimon=dinobee&device=13&version=",
      dinorex: "https://humulos.com/digimon/php/details.php?digimon=dinorex&device=13&version=",
      dinotiger: "https://humulos.com/digimon/php/details.php?digimon=dinotiger&device=13&version=",
      dober: "https://humulos.com/digimon/php/details.php?digimon=dober&device=13&version=",
      doki: "https://humulos.com/digimon/php/details.php?digimon=doki&device=13&version=",
      dokugu: "https://humulos.com/digimon/php/details.php?digimon=dokugu&device=13&version=",
      donedevi: "https://humulos.com/digimon/php/details.php?digimon=donedevi&device=13&version=",
      drimoge: "https://humulos.com/digimon/php/details.php?digimon=drimoge&device=13&version=",
      duke: "https://humulos.com/digimon/php/details.php?digimon=duke&device=13&version=",
      duke_x: "https://humulos.com/digimon/php/details.php?digimon=duke_x&device=13&version=",
      dura: "https://humulos.com/digimon/php/details.php?digimon=dura&device=13&version=",
      duranda: "https://humulos.com/digimon/php/details.php?digimon=duranda&device=13&version=",
      dusk: "https://humulos.com/digimon/php/details.php?digimon=dusk&device=13&version=",
      dynas: "https://humulos.com/digimon/php/details.php?digimon=dynas&device=13&version=",
      ebidra: "https://humulos.com/digimon/php/details.php?digimon=ebidra&device=13&version=",
      extyrano: "https://humulos.com/digimon/php/details.php?digimon=extyrano&device=13&version=",
      fanto: "https://humulos.com/digimon/php/details.php?digimon=fanto&device=13&version=",
      flare: "https://humulos.com/digimon/php/details.php?digimon=flare&device=13&version=",
      gabu: "https://humulos.com/digimon/php/details.php?digimon=gabu&device=13&version=",
      gabu_b: "https://humulos.com/digimon/php/details.php?digimon=gabu_b&device=13&version=",
      gaiou: "https://humulos.com/digimon/php/details.php?digimon=gaiou&device=13&version=",
      galgo: "https://humulos.com/digimon/php/details.php?digimon=galgo&device=13&version=",
      garum: "https://humulos.com/digimon/php/details.php?digimon=garum&device=13&version=",
      garuru: "https://humulos.com/digimon/php/details.php?digimon=garuru&device=13&version=",
      garuru_b: "https://humulos.com/digimon/php/details.php?digimon=garuru_b&device=13&version=",
      gazi: "https://humulos.com/digimon/php/details.php?digimon=gazi&device=13&version=",
      geso: "https://humulos.com/digimon/php/details.php?digimon=geso&device=13&version=",
      ghost: "https://humulos.com/digimon/php/details.php?digimon=ghost&device=13&version=",
      gigi: "https://humulos.com/digimon/php/details.php?digimon=gigi&device=13&version=",
      ginryu: "https://humulos.com/digimon/php/details.php?digimon=ginryu&device=13&version=",
      giza: "https://humulos.com/digimon/php/details.php?digimon=giza&device=13&version=",
      gogma: "https://humulos.com/digimon/php/details.php?digimon=gogma&device=13&version=",
      goki: "https://humulos.com/digimon/php/details.php?digimon=goki&device=13&version=",
      gole: "https://humulos.com/digimon/php/details.php?digimon=gole&device=13&version=",
      goro: "https://humulos.com/digimon/php/details.php?digimon=goro&device=13&version=",
      gottsu: "https://humulos.com/digimon/php/details.php?digimon=gottsu&device=13&version=",
      grandiskuwaga: "https://humulos.com/digimon/php/details.php?digimon=grandiskuwaga&device=13&version=",
      grandloco: "https://humulos.com/digimon/php/details.php?digimon=grandloco&device=13&version=",
      grankuwaga: "https://humulos.com/digimon/php/details.php?digimon=grankuwaga&device=13&version=",
      grey: "https://humulos.com/digimon/php/details.php?digimon=grey&device=13&version=",
      grey_b: "https://humulos.com/digimon/php/details.php?digimon=grey_b&device=13&version=",
      griffo: "https://humulos.com/digimon/php/details.php?digimon=griffo&device=13&version=",
      groundra: "https://humulos.com/digimon/php/details.php?digimon=groundra&device=13&version=",
      grow: "https://humulos.com/digimon/php/details.php?digimon=grow&device=13&version=",
      grow_o: "https://humulos.com/digimon/php/details.php?digimon=grow_o&device=13&version=",
      guil: "https://humulos.com/digimon/php/details.php?digimon=guil&device=13&version=",
      gummy: "https://humulos.com/digimon/php/details.php?digimon=gummy&device=13&version=",
      gusoku: "https://humulos.com/digimon/php/details.php?digimon=gusoku&device=13&version=",
      haguru: "https://humulos.com/digimon/php/details.php?digimon=haguru&device=13&version=",
      hangyo: "https://humulos.com/digimon/php/details.php?digimon=hangyo&device=13&version=",
      heavyleo: "https://humulos.com/digimon/php/details.php?digimon=heavyleo&device=13&version=",
      hexeblau: "https://humulos.com/digimon/php/details.php?digimon=hexeblau&device=13&version=",
      hisyaryu: "https://humulos.com/digimon/php/details.php?digimon=hisyaryu&device=13&version=",
      hiyari: "https://humulos.com/digimon/php/details.php?digimon=hiyari&device=13&version=",
      hop: "https://humulos.com/digimon/php/details.php?digimon=hop&device=13&version=",
      hudie: "https://humulos.com/digimon/php/details.php?digimon=hudie&device=13&version=",
      hyouga: "https://humulos.com/digimon/php/details.php?digimon=hyouga&device=13&version=",
      imp: "https://humulos.com/digimon/php/details.php?digimon=imp&device=13&version=",
      imperialdra_f: "https://humulos.com/digimon/php/details.php?digimon=imperialdra_f&device=13&version=",
      imperialdra_p: "https://humulos.com/digimon/php/details.php?digimon=imperialdra_p&device=13&version=",
      jewelbee: "https://humulos.com/digimon/php/details.php?digimon=jewelbee&device=13&version=",
      justi: "https://humulos.com/digimon/php/details.php?digimon=justi&device=13&version=",
      jyaga: "https://humulos.com/digimon/php/details.php?digimon=jyaga&device=13&version=",
      jyari: "https://humulos.com/digimon/php/details.php?digimon=jyari&device=13&version=",
      kaisergrey: "https://humulos.com/digimon/php/details.php?digimon=kaisergrey&device=13&version=",
      kaiserleo: "https://humulos.com/digimon/php/details.php?digimon=kaiserleo&device=13&version=",
      kakkin: "https://humulos.com/digimon/php/details.php?digimon=kakkin&device=13&version=",
      kazuchi: "https://humulos.com/digimon/php/details.php?digimon=kazuchi&device=13&version=",
      keto: "https://humulos.com/digimon/php/details.php?digimon=keto&device=13&version=",
      kii: "https://humulos.com/digimon/php/details.php?digimon=kii&device=13&version=",
      kokuwa: "https://humulos.com/digimon/php/details.php?digimon=kokuwa&device=13&version=",
      komondo: "https://humulos.com/digimon/php/details.php?digimon=komondo&device=13&version=",
      koro: "https://humulos.com/digimon/php/details.php?digimon=koro&device=13&version=",
      lavogarita: "https://humulos.com/digimon/php/details.php?digimon=lavogarita&device=13&version=",
      lavorvo: "https://humulos.com/digimon/php/details.php?digimon=lavorvo&device=13&version=",
      leo: "https://humulos.com/digimon/php/details.php?digimon=leo&device=13&version=",
      lili: "https://humulos.com/digimon/php/details.php?digimon=lili&device=13&version=",
      loaderlio: "https://humulos.com/digimon/php/details.php?digimon=loaderlio&device=13&version=",
      loco: "https://humulos.com/digimon/php/details.php?digimon=loco&device=13&version=",
      lordknight: "https://humulos.com/digimon/php/details.php?digimon=lordknight&device=13&version=",
      lotus: "https://humulos.com/digimon/php/details.php?digimon=lotus&device=13&version=",
      luce_f: "https://humulos.com/digimon/php/details.php?digimon=luce_f&device=13&version=",
      ludo: "https://humulos.com/digimon/php/details.php?digimon=ludo&device=13&version=",
      mach: "https://humulos.com/digimon/php/details.php?digimon=mach&device=13&version=",
      madleo: "https://humulos.com/digimon/php/details.php?digimon=madleo&device=13&version=",
      magna: "https://humulos.com/digimon/php/details.php?digimon=magna&device=13&version=",
      magnagaruru: "https://humulos.com/digimon/php/details.php?digimon=magnagaruru&device=13&version=",
      mam: "https://humulos.com/digimon/php/details.php?digimon=mam&device=13&version=",
      mame: "https://humulos.com/digimon/php/details.php?digimon=mame&device=13&version=",
      mametyra: "https://humulos.com/digimon/php/details.php?digimon=mametyra&device=13&version=",
      manbo: "https://humulos.com/digimon/php/details.php?digimon=manbo&device=13&version=",
      manticore: "https://humulos.com/digimon/php/details.php?digimon=manticore&device=13&version=",
      marinange: "https://humulos.com/digimon/php/details.php?digimon=marinange&device=13&version=",
      marinchimaira: "https://humulos.com/digimon/php/details.php?digimon=marinchimaira&device=13&version=",
      marindevi: "https://humulos.com/digimon/php/details.php?digimon=marindevi&device=13&version=",
      megalogrow: "https://humulos.com/digimon/php/details.php?digimon=megalogrow&device=13&version=",
      megalogrow_o: "https://humulos.com/digimon/php/details.php?digimon=megalogrow_o&device=13&version=",
      megaseadra: "https://humulos.com/digimon/php/details.php?digimon=megaseadra&device=13&version=",
      megidra: "https://humulos.com/digimon/php/details.php?digimon=megidra&device=13&version=",
      mera: "https://humulos.com/digimon/php/details.php?digimon=mera&device=13&version=",
      mermai: "https://humulos.com/digimon/php/details.php?digimon=mermai&device=13&version=",
      metalgaruru: "https://humulos.com/digimon/php/details.php?digimon=metalgaruru&device=13&version=",
      metalgaruru_b: "https://humulos.com/digimon/php/details.php?digimon=metalgaruru_b&device=13&version=",
      metalgrey_2010: "https://humulos.com/digimon/php/details.php?digimon=metalgrey_2010&device=13&version=",
      metalgrey_va: "https://humulos.com/digimon/php/details.php?digimon=metalgrey_va&device=13&version=",
      metalgrey_vi: "https://humulos.com/digimon/php/details.php?digimon=metalgrey_vi&device=13&version=",
      metalmame: "https://humulos.com/digimon/php/details.php?digimon=metalmame&device=13&version=",
      metalseadra: "https://humulos.com/digimon/php/details.php?digimon=metalseadra&device=13&version=",
      metaltyrano: "https://humulos.com/digimon/php/details.php?digimon=metaltyrano&device=13&version=",
      mino: "https://humulos.com/digimon/php/details.php?digimon=mino&device=13&version=",
      mojya: "https://humulos.com/digimon/php/details.php?digimon=mojya&device=13&version=",
      moku: "https://humulos.com/digimon/php/details.php?digimon=moku&device=13&version=",
      monochro: "https://humulos.com/digimon/php/details.php?digimon=monochro&device=13&version=",
      monodra: "https://humulos.com/digimon/php/details.php?digimon=monodra&device=13&version=",
      mugendra: "https://humulos.com/digimon/php/details.php?digimon=mugendra&device=13&version=",
      mummy: "https://humulos.com/digimon/php/details.php?digimon=mummy&device=13&version=",
      murmukus: "https://humulos.com/digimon/php/details.php?digimon=murmukus&device=13&version=",
      nano: "https://humulos.com/digimon/php/details.php?digimon=nano&device=13&version=",
      neodevi: "https://humulos.com/digimon/php/details.php?digimon=neodevi&device=13&version=",
      nidhogg: "https://humulos.com/digimon/php/details.php?digimon=nidhogg&device=13&version=",
      noblepump: "https://humulos.com/digimon/php/details.php?digimon=noblepump&device=13&version=",
      oct: "https://humulos.com/digimon/php/details.php?digimon=oct&device=13&version=",
      ogre: "https://humulos.com/digimon/php/details.php?digimon=ogre&device=13&version=",
      omega: "https://humulos.com/digimon/php/details.php?digimon=omega&device=13&version=",
      orochi: "https://humulos.com/digimon/php/details.php?digimon=orochi&device=13&version=",
      ouryu: "https://humulos.com/digimon/php/details.php?digimon=ouryu&device=13&version=",
      pagu: "https://humulos.com/digimon/php/details.php?digimon=pagu&device=13&version=",
      paildra: "https://humulos.com/digimon/php/details.php?digimon=paildra&device=13&version=",
      pal: "https://humulos.com/digimon/php/details.php?digimon=pal&device=13&version=",
      paledra: "https://humulos.com/digimon/php/details.php?digimon=paledra&device=13&version=",
      panda: "https://humulos.com/digimon/php/details.php?digimon=panda&device=13&version=",
      parasaur: "https://humulos.com/digimon/php/details.php?digimon=parasaur&device=13&version=",
      parrot: "https://humulos.com/digimon/php/details.php?digimon=parrot&device=13&version=",
      petimera: "https://humulos.com/digimon/php/details.php?digimon=petimera&device=13&version=",
      piccolo: "https://humulos.com/digimon/php/details.php?digimon=piccolo&device=13&version=",
      pie: "https://humulos.com/digimon/php/details.php?digimon=pie&device=13&version=",
      pirani: "https://humulos.com/digimon/php/details.php?digimon=pirani&device=13&version=",
      pitch: "https://humulos.com/digimon/php/details.php?digimon=pitch&device=13&version=",
      plesio: "https://humulos.com/digimon/php/details.php?digimon=plesio&device=13&version=",
      poko: "https://humulos.com/digimon/php/details.php?digimon=poko&device=13&version=",
      pomu: "https://humulos.com/digimon/php/details.php?digimon=pomu&device=13&version=",
      porcupa: "https://humulos.com/digimon/php/details.php?digimon=porcupa&device=13&version=",
      puka: "https://humulos.com/digimon/php/details.php?digimon=puka&device=13&version=",
      puku: "https://humulos.com/digimon/php/details.php?digimon=puku&device=13&version=",
      pulse: "https://humulos.com/digimon/php/details.php?digimon=pulse&device=13&version=",
      pump: "https://humulos.com/digimon/php/details.php?digimon=pump&device=13&version=",
      puni: "https://humulos.com/digimon/php/details.php?digimon=puni&device=13&version=",
      rafflesi: "https://humulos.com/digimon/php/details.php?digimon=rafflesi&device=13&version=",
      ragnalord: "https://humulos.com/digimon/php/details.php?digimon=ragnalord&device=13&version=",
      raihi: "https://humulos.com/digimon/php/details.php?digimon=raihi&device=13&version=",
      raijiludo: "https://humulos.com/digimon/php/details.php?digimon=raijiludo&device=13&version=",
      rapid: "https://humulos.com/digimon/php/details.php?digimon=rapid&device=13&version=",
      rapid_a: "https://humulos.com/digimon/php/details.php?digimon=rapid_a&device=13&version=",
      rare: "https://humulos.com/digimon/php/details.php?digimon=rare&device=13&version=",
      rebelli: "https://humulos.com/digimon/php/details.php?digimon=rebelli&device=13&version=",
      regalecus: "https://humulos.com/digimon/php/details.php?digimon=regalecus&device=13&version=",
      rele: "https://humulos.com/digimon/php/details.php?digimon=rele&device=13&version=",
      rena: "https://humulos.com/digimon/php/details.php?digimon=rena&device=13&version=",
      reppa: "https://humulos.com/digimon/php/details.php?digimon=reppa&device=13&version=",
      rhino: "https://humulos.com/digimon/php/details.php?digimon=rhino&device=13&version=",
      ruka: "https://humulos.com/digimon/php/details.php?digimon=ruka&device=13&version=",
      ryuda: "https://humulos.com/digimon/php/details.php?digimon=ryuda&device=13&version=",
      saberdra: "https://humulos.com/digimon/php/details.php?digimon=saberdra&device=13&version=",
      saberleo: "https://humulos.com/digimon/php/details.php?digimon=saberleo&device=13&version=",
      saintgalgo: "https://humulos.com/digimon/php/details.php?digimon=saintgalgo&device=13&version=",
      saku: "https://humulos.com/digimon/php/details.php?digimon=saku&device=13&version=",
      sakutto: "https://humulos.com/digimon/php/details.php?digimon=sakutto&device=13&version=",
      sakuya_x: "https://humulos.com/digimon/php/details.php?digimon=sakuya_x&device=13&version=",
      sango: "https://humulos.com/digimon/php/details.php?digimon=sango&device=13&version=",
      scorpio: "https://humulos.com/digimon/php/details.php?digimon=scorpio&device=13&version=",
      seadra: "https://humulos.com/digimon/php/details.php?digimon=seadra&device=13&version=",
      shadra: "https://humulos.com/digimon/php/details.php?digimon=shadra&device=13&version=",
      shell: "https://humulos.com/digimon/php/details.php?digimon=shell&device=13&version=",
      siren: "https://humulos.com/digimon/php/details.php?digimon=siren&device=13&version=",
      skullbaluchi: "https://humulos.com/digimon/php/details.php?digimon=skullbaluchi&device=13&version=",
      skullgrey: "https://humulos.com/digimon/php/details.php?digimon=skullgrey&device=13&version=",
      skullmam: "https://humulos.com/digimon/php/details.php?digimon=skullmam&device=13&version=",
      star: "https://humulos.com/digimon/php/details.php?digimon=star&device=13&version=",
      sting: "https://humulos.com/digimon/php/details.php?digimon=sting&device=13&version=",
      strikedra: "https://humulos.com/digimon/php/details.php?digimon=strikedra&device=13&version=",
      suna: "https://humulos.com/digimon/php/details.php?digimon=suna&device=13&version=",
      sunariza: "https://humulos.com/digimon/php/details.php?digimon=sunariza&device=13&version=",
      sunflow: "https://humulos.com/digimon/php/details.php?digimon=sunflow&device=13&version=",
      superstar: "https://humulos.com/digimon/php/details.php?digimon=superstar&device=13&version=",
      susanoo: "https://humulos.com/digimon/php/details.php?digimon=susanoo&device=13&version=",
      tane: "https://humulos.com/digimon/php/details.php?digimon=tane&device=13&version=",
      terrier: "https://humulos.com/digimon/php/details.php?digimon=terrier&device=13&version=",
      thunderball: "https://humulos.com/digimon/php/details.php?digimon=thunderball&device=13&version=",
      tialudo: "https://humulos.com/digimon/php/details.php?digimon=tialudo&device=13&version=",
      tinker: "https://humulos.com/digimon/php/details.php?digimon=tinker&device=13&version=",
      tobiu: "https://humulos.com/digimon/php/details.php?digimon=tobiu&device=13&version=",
      toge: "https://humulos.com/digimon/php/details.php?digimon=toge&device=13&version=",
      toropia: "https://humulos.com/digimon/php/details.php?digimon=toropia&device=13&version=",
      torta: "https://humulos.com/digimon/php/details.php?digimon=torta&device=13&version=",
      tricera: "https://humulos.com/digimon/php/details.php?digimon=tricera&device=13&version=",
      tuno: "https://humulos.com/digimon/php/details.php?digimon=tuno&device=13&version=",
      turuie: "https://humulos.com/digimon/php/details.php?digimon=turuie&device=13&version=",
      tyrano: "https://humulos.com/digimon/php/details.php?digimon=tyrano&device=13&version=",
      ulforcevdra: "https://humulos.com/digimon/php/details.php?digimon=ulforcevdra&device=13&version=",
      ultimatebrachi: "https://humulos.com/digimon/php/details.php?digimon=ultimatebrachi&device=13&version=",
      v: "https://humulos.com/digimon/php/details.php?digimon=v&device=13&version=",
      valve: "https://humulos.com/digimon/php/details.php?digimon=valve&device=13&version=",
      vamde: "https://humulos.com/digimon/php/details.php?digimon=vamde&device=13&version=",
      vdra: "https://humulos.com/digimon/php/details.php?digimon=vdra&device=13&version=",
      vegi: "https://humulos.com/digimon/php/details.php?digimon=vegi&device=13&version=",
      velgr: "https://humulos.com/digimon/php/details.php?digimon=velgr&device=13&version=",
      volcanicdra: "https://humulos.com/digimon/php/details.php?digimon=volcanicdra&device=13&version=",
      vorvo: "https://humulos.com/digimon/php/details.php?digimon=vorvo&device=13&version=",
      vritra: "https://humulos.com/digimon/php/details.php?digimon=vritra&device=13&version=",
      wanya: "https://humulos.com/digimon/php/details.php?digimon=wanya&device=13&version=",
      wargrey: "https://humulos.com/digimon/php/details.php?digimon=wargrey&device=13&version=",
      warumonzae: "https://humulos.com/digimon/php/details.php?digimon=warumonzae&device=13&version=",
      waruseadra: "https://humulos.com/digimon/php/details.php?digimon=waruseadra&device=13&version=",
      weregaruru: "https://humulos.com/digimon/php/details.php?digimon=weregaruru&device=13&version=",
      weregaruru_b: "https://humulos.com/digimon/php/details.php?digimon=weregaruru_b&device=13&version=",
      wha: "https://humulos.com/digimon/php/details.php?digimon=wha&device=13&version=",
      wizar: "https://humulos.com/digimon/php/details.php?digimon=wizar&device=13&version=",
      wolf: "https://humulos.com/digimon/php/details.php?digimon=wolf&device=13&version=",
      worm: "https://humulos.com/digimon/php/details.php?digimon=worm&device=13&version=",
      xv: "https://humulos.com/digimon/php/details.php?digimon=xv&device=13&version=",
      yaa: "https://humulos.com/digimon/php/details.php?digimon=yaa&device=13&version=",
      yukidaru: "https://humulos.com/digimon/php/details.php?digimon=yukidaru&device=13&version=",
      yukimibota: "https://humulos.com/digimon/php/details.php?digimon=yukimibota&device=13&version=",
      yura: "https://humulos.com/digimon/php/details.php?digimon=yura&device=13&version=",
      zeri: "https://humulos.com/digimon/php/details.php?digimon=zeri&device=13&version=",
      zuba: "https://humulos.com/digimon/php/details.php?digimon=zuba&device=13&version=",
      zubaeager: "https://humulos.com/digimon/php/details.php?digimon=zubaeager&device=13&version=",
      zuru: "https://humulos.com/digimon/php/details.php?digimon=zuru&device=13&version="
    }
  },
  routes: [
    ["1-001", "2-001", "normal", 15, ["penz"]],
    ["1-002", "2-013", "normal", 15, ["dm", "dm20", "dmc", "pen20", "vbbe", "vbdm"]],
    ["1-002", "2-026", "normal", 15, ["penz", "vbbe", "vbdm"]],
    ["1-003", "2-006", "normal", 15, ["pen20", "vbbe", "vbdm"]],
    ["1-004", "2-011", "normal", 15, ["pen20"]],
    ["1-005", "2-012", "normal", 15, ["dmx3", "pen20"]],
    ["1-006", "2-010", "normal", 15, ["pen20", "vbdm"]],
    ["1-007", "2-007", "normal", 15, ["dm20", "pen20", "vbbe"]],
    ["1-008", "2-014", "normal", 15, ["pen20", "vbbe"]],
    ["1-009", "2-027", "normal", 15, ["dmx2", "vbdm"]],
    ["1-010", "2-009", "normal", 15, ["penz", "vbdm"]],
    ["1-011", "2-023", "normal", 15, ["dmx3"]],
    ["1-012", "2-005", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["1-013", "2-003", "normal", 15, ["pen20"]],
    ["1-013", "2-028", "normal", 15, ["pen", "pen20", "penc", "vbbe"]],
    ["1-014", "2-015", "normal", 15, ["dm", "pen", "pen20", "penc", "vbbe"]],
    ["1-015", "2-002", "normal", 15, ["dm20", "pen20", "vbbe"]],
    ["1-016", "2-004", "normal", 15, ["dm20", "pen", "pen20", "penc", "vbdm"]],
    ["1-017", "2-021", "normal", 15, ["dm", "dm20", "dmc", "penz"]],
    ["1-018", "2-024", "normal", 15, ["dm", "dm20", "dmc", "vbdm"]],
    ["1-019", "2-018", "normal", 15, ["penz", "vbbe"]],
    ["1-020", "2-022", "normal", 15, ["dmx"]],
    ["1-021", "2-019", "normal", 15, ["dm20", "pen20", "vbdm"]],
    ["1-022", "2-025", "normal", 15, ["penz", "vbbe"]],
    ["1-023", "2-016", "normal", 15, ["dm20", "pen", "pen20", "penc"]],
    ["1-023", "2-032", "normal", 15, ["vbdm"]],
    ["1-024", "2-020", "normal", 15, ["dm", "dm20", "dmc", "vbdm"]],
    ["1-025", "2-008", "normal", 15, ["dmx3", "pen20", "vbdm"]],
    ["1-026", "2-017", "normal", 15, ["dm", "dm20", "dmc", "vbdm"]],
    ["1-027", "2-035", "normal", 15, ["dmxw"]],
    ["1-028", "2-029", "normal", 15, ["vbbe", "vbdm"]],
    ["1-029", "2-030", "normal", 15, ["vbdm"]],
    ["1-030", "2-036", "normal", 15, ["vbdm"]],
    ["1-031", "2-031", "normal", 15, ["vbdm"]],
    ["2-001", "3-001", "special", 0, ["penz"]],
    ["2-001", "3-005", "normal", 3, ["penz"]],
    ["2-001", "3-027", "normal", 3, ["penz"]],
    ["2-001", "3-045", "normal", 12, ["penz"]],
    ["2-001", "3-080", "special", 0, ["penz"]],
    ["2-001", "4-001", "special", 0, ["penz"]],
    ["2-002", "3-003", "normal", 12, ["pen20"]],
    ["2-002", "3-016", "normal", 3, ["dm20", "pen20", "vbbe"]],
    ["2-002", "3-036", "normal", 15, ["vbbe"]],
    ["2-003", "3-046", "normal", 15, ["pen20"]],
    ["2-004", "3-012", "normal", 15, ["dm20"]],
    ["2-004", "3-013", "normal", 14, ["pen", "pen20", "penc"]],
    ["2-004", "3-029", "normal", 3, ["pen", "pen20", "penc"]],
    ["2-004", "3-050", "normal", 15, ["dm20"]],
    ["2-004", "3-065", "normal", 15, ["vbdm"]],
    ["2-004", "3-070", "normal", 8, ["pen", "pen20", "penc"]],
    ["2-005", "3-011", "normal", 14, ["pen", "pen20", "penc"]],
    ["2-005", "3-014", "normal", 8, ["pen", "pen20", "penc"]],
    ["2-005", "3-031", "normal", 15, ["vbdm"]],
    ["2-005", "3-072", "normal", 7, ["pen", "pen20", "penc"]],
    ["2-005", "3-079", "normal", 15, ["pen20", "vbdm"]],
    ["2-006", "3-078", "normal", 15, ["pen20", "vbbe", "vbdm"]],
    ["2-007", "3-015", "normal", 15, ["dm20", "pen20", "vbbe"]],
    ["2-007", "3-082", "normal", 15, ["vbbe"]],
    ["2-008", "3-009", "special", 0, ["dmx3"]],
    ["2-008", "3-015", "normal", 1, ["dmx3"]],
    ["2-008", "3-039", "special", 0, ["dmx3"]],
    ["2-008", "3-057", "normal", 12, ["dmx3"]],
    ["2-008", "3-074", "normal", 15, ["pen20", "vbdm"]],
    ["2-008", "3-075", "normal", 1, ["dmx3"]],
    ["2-009", "3-022", "special", 0, ["penz"]],
    ["2-009", "3-039", "normal", 12, ["penz"]],
    ["2-009", "3-040", "normal", 3, ["penz"]],
    ["2-009", "3-051", "normal", 3, ["penz", "vbdm"]],
    ["2-009", "3-078", "special", 0, ["penz"]],
    ["2-009", "4-072", "special", 0, ["penz"]],
    ["2-010", "3-049", "normal", 15, ["pen20", "vbdm"]],
    ["2-011", "3-033", "normal", 12, ["pen", "pen20"]],
    ["2-011", "3-037", "normal", 12, ["pen20"]],
    ["2-011", "3-042", "normal", 10, ["pen", "pen20"]],
    ["2-011", "3-059", "normal", 3, ["pen20"]],
    ["2-011", "3-077", "normal", 7, ["pen", "pen20"]],
    ["2-012", "3-009", "special", 0, ["dmx3"]],
    ["2-012", "3-039", "special", 0, ["dmx3"]],
    ["2-012", "3-047", "normal", 15, ["pen20"]],
    ["2-012", "3-048", "normal", 1, ["dmx3"]],
    ["2-012", "3-062", "normal", 1, ["dmx3"]],
    ["2-012", "3-071", "normal", 12, ["dmx3"]],
    ["2-013", "3-001", "normal", 15, ["dm", "dm20", "dmc", "vbbe", "vbdm"]],
    ["2-013", "3-007", "normal", 8, ["dm", "dm20", "dmc", "vbbe"]],
    ["2-013", "3-010", "normal", 12, ["pen20"]],
    ["2-013", "3-032", "normal", 3, ["pen20"]],
    ["2-013", "3-082", "normal", 15, ["vbdm"]],
    ["2-014", "3-062", "normal", 15, ["pen20", "vbbe"]],
    ["2-015", "3-031", "normal", 14, ["pen", "pen20", "penc"]],
    ["2-015", "3-046", "normal", 15, ["vbbe"]],
    ["2-015", "3-052", "special", 0, ["vbbe"]],
    ["2-015", "3-054", "normal", 8, ["dm", "pen", "pen20", "penc"]],
    ["2-015", "3-073", "normal", 15, ["dm", "pen", "pen20", "penc", "vbbe"]],
    ["2-016", "3-001", "normal", 7, ["pen", "pen20", "penc"]],
    ["2-016", "3-022", "normal", 10, ["pen", "pen20", "penc"]],
    ["2-016", "3-063", "normal", 12, ["dm20", "pen", "pen20", "penc"]],
    ["2-017", "3-026", "normal", 15, ["dm", "dm20", "dmc"]],
    ["2-017", "3-027", "normal", 15, ["vbdm"]],
    ["2-017", "3-028", "normal", 8, ["dm", "dm20", "dmc"]],
    ["2-018", "3-020", "normal", 12, ["penz"]],
    ["2-018", "3-022", "special", 0, ["penz"]],
    ["2-018", "3-025", "normal", 15, ["vbbe"]],
    ["2-018", "3-034", "normal", 15, ["penz", "vbbe"]],
    ["2-018", "3-060", "normal", 3, ["penz"]],
    ["2-018", "3-076", "normal", 3, ["penz"]],
    ["2-018", "3-080", "normal", 15, ["vbbe"]],
    ["2-018", "4-072", "special", 0, ["penz"]],
    ["2-019", "3-036", "normal", 12, ["dm20", "pen20"]],
    ["2-019", "3-062", "normal", 15, ["vbdm"]],
    ["2-019", "3-081", "normal", 3, ["dm20", "pen20", "vbdm"]],
    ["2-020", "3-008", "normal", 15, ["dm", "dm20", "dmc"]],
    ["2-020", "3-056", "normal", 8, ["dm", "dm20", "dmc", "vbdm"]],
    ["2-020", "3-060", "normal", 15, ["vbdm"]],
    ["2-020", "3-076", "normal", 15, ["vbdm"]],
    ["2-021", "3-022", "special", 0, ["penz"]],
    ["2-021", "3-032", "normal", 3, ["penz"]],
    ["2-021", "3-044", "normal", 8, ["dm", "dm20", "dmc"]],
    ["2-021", "3-058", "normal", 15, ["dm", "dm20", "dmc", "penz"]],
    ["2-021", "3-066", "normal", 3, ["penz"]],
    ["2-021", "4-072", "special", 0, ["penz"]],
    ["2-022", "3-004", "normal", 3, ["dmx"]],
    ["2-022", "3-017", "special", 0, ["dmx"]],
    ["2-022", "3-023", "normal", 3, ["dmx"]],
    ["2-022", "3-035", "normal", 12, ["dmx"]],
    ["2-022", "3-061", "special", 0, ["dmx"]],
    ["2-022", "3-067", "normal", 12, ["dmx"]],
    ["2-023", "3-041", "normal", 15, ["dmx3"]],
    ["2-024", "3-019", "normal", 8, ["dm", "dm20", "dmc"]],
    ["2-024", "3-022", "normal", 15, ["dm", "dm20", "dmc", "vbdm"]],
    ["2-025", "3-001", "special", 0, ["penz"]],
    ["2-025", "3-006", "normal", 15, ["penz", "vbbe"]],
    ["2-025", "3-028", "normal", 12, ["penz"]],
    ["2-025", "3-058", "normal", 15, ["vbbe"]],
    ["2-025", "3-065", "normal", 3, ["penz"]],
    ["2-025", "3-069", "normal", 3, ["penz"]],
    ["2-025", "3-078", "normal", 15, ["vbbe"]],
    ["2-025", "4-001", "special", 0, ["penz"]],
    ["2-026", "3-001", "special", 0, ["penz"]],
    ["2-026", "3-012", "normal", 15, ["vbbe"]],
    ["2-026", "3-024", "normal", 3, ["penz", "vbbe"]],
    ["2-026", "3-028", "normal", 15, ["vbdm"]],
    ["2-026", "3-050", "normal", 15, ["vbbe"]],
    ["2-026", "3-052", "normal", 12, ["penz"]],
    ["2-026", "3-059", "special", 0, ["vbbe"]],
    ["2-026", "3-063", "special", 0, ["penz"]],
    ["2-026", "3-068", "normal", 3, ["penz"]],
    ["2-026", "4-001", "special", 0, ["penz"]],
    ["2-027", "3-002", "normal", 12, ["dmx2"]],
    ["2-027", "3-018", "special", 0, ["dmx2"]],
    ["2-027", "3-030", "normal", 1, ["dmx2"]],
    ["2-027", "3-035", "special", 0, ["dmx2"]],
    ["2-027", "3-037", "normal", 15, ["vbdm"]],
    ["2-027", "3-038", "normal", 12, ["dmx2"]],
    ["2-027", "3-043", "normal", 1, ["dmx2"]],
    ["2-027", "3-055", "normal", 1, ["dmx2"]],
    ["2-027", "3-064", "normal", 1, ["dmx2"]],
    ["2-028", "3-008", "normal", 15, ["pen", "pen20", "penc", "vbbe"]],
    ["2-028", "3-021", "normal", 2, ["pen20", "penc"]],
    ["2-028", "3-039", "special", 0, ["vbbe"]],
    ["2-028", "3-053", "normal", 8, ["pen", "pen20", "penc"]],
    ["2-028", "3-056", "normal", 4, ["pen20", "penc"]],
    ["2-029", "3-066", "special", 0, ["vbbe"]],
    ["2-029", "3-084", "normal", 15, ["vbbe", "vbdm"]],
    ["2-030", "3-032", "normal", 15, ["vbdm"]],
    ["2-031", "3-068", "normal", 15, ["vbdm"]],
    ["2-032", "3-009", "normal", 15, ["vbdm"]],
    ["2-033", "3-080", "normal", 15, ["vbbe", "vbdm"]],
    ["2-035", "3-066", "normal", 15, ["dmxw"]],
    ["2-036", "3-085", "normal", 15, ["vbdm"]],
    ["3-001", "4-004", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-001", "4-008", "normal", 15, ["vbdm"]],
    ["3-001", "4-017", "normal", 15, ["vbdm"]],
    ["3-001", "4-023", "normal", 15, ["vbdm"]],
    ["3-001", "4-028", "normal", 15, ["dm", "dm20", "dmc", "vbbe"]],
    ["3-001", "4-046", "normal", 12, ["pen", "pen20"]],
    ["3-001", "4-054", "normal", 15, ["dm", "dm20", "dmc", "pen", "pen20", "penc", "penz", "vbbe", "vbdm"]],
    ["3-001", "4-070", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-001", "4-079", "normal", 8, ["dm", "dm20", "dmc", "vbbe"]],
    ["3-001", "4-084", "normal", 15, ["vbdm"]],
    ["3-001", "4-087", "normal", 15, ["penc"]],
    ["3-001", "4-088", "normal", 8, ["dm", "dm20", "dmc", "vbbe"]],
    ["3-001", "4-091", "normal", 15, ["vbdm"]],
    ["3-001", "4-135", "normal", 8, ["dm", "dm20", "dmc", "vbbe"]],
    ["3-001", "5-016", "normal", 15, ["penz"]],
    ["3-001", "7-041", "normal", 3, ["penz"]],
    ["3-002", "4-003", "normal", 8, ["dmx2"]],
    ["3-002", "4-024", "special", 0, ["dmx2"]],
    ["3-002", "4-067", "normal", 7, ["dmx2"]],
    ["3-002", "4-089", "special", 0, ["dmx2"]],
    ["3-003", "4-019", "normal", 3, ["pen20"]],
    ["3-003", "4-027", "normal", 15, ["pen20"]],
    ["3-004", "4-021", "normal", 8, ["dmx"]],
    ["3-004", "4-126", "normal", 7, ["dmx"]],
    ["3-004", "4-136", "special", 0, ["dmx"]],
    ["3-005", "4-008", "normal", 3, ["penz"]],
    ["3-005", "4-028", "normal", 15, ["penz"]],
    ["3-005", "4-083", "normal", 12, ["penz"]],
    ["3-006", "4-005", "normal", 3, ["penz", "vbbe"]],
    ["3-006", "4-111", "normal", 12, ["penz"]],
    ["3-006", "4-118", "normal", 3, ["penz", "vbbe"]],
    ["3-007", "4-002", "normal", 8, ["dm", "dm20", "dmc", "vbbe"]],
    ["3-007", "4-028", "normal", 15, ["dm", "dm20", "dmc", "vbbe"]],
    ["3-007", "4-079", "normal", 15, ["dm", "dm20", "dmc", "vbbe"]],
    ["3-007", "4-088", "normal", 8, ["dm", "dm20", "dmc", "vbbe"]],
    ["3-007", "4-107", "normal", 8, ["dm", "dm20", "dmc", "vbbe"]],
    ["3-008", "4-014", "normal", 15, ["pen", "pen20", "penc", "vbbe"]],
    ["3-008", "4-063", "normal", 15, ["penc"]],
    ["3-008", "4-064", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-008", "4-066", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-008", "4-070", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-008", "4-084", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-008", "4-085", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-008", "4-096", "normal", 15, ["vbbe"]],
    ["3-008", "4-102", "normal", 15, ["penc"]],
    ["3-008", "4-127", "normal", 12, ["pen", "pen20"]],
    ["3-008", "4-138", "normal", 15, ["pen", "pen20"]],
    ["3-008", "4-145", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-008", "4-150", "normal", 15, ["vbbe"]],
    ["3-009", "4-043", "normal", 15, ["vbdm"]],
    ["3-009", "4-052", "normal", 12, ["dmx3"]],
    ["3-009", "4-080", "normal", 12, ["dmx3"]],
    ["3-009", "4-093", "normal", 12, ["dmx3"]],
    ["3-009", "4-094", "normal", 3, ["dmx3", "vbdm"]],
    ["3-009", "4-109", "normal", 3, ["dmx3"]],
    ["3-009", "4-128", "normal", 12, ["dmx3"]],
    ["3-009", "4-144", "normal", 3, ["dmx3"]],
    ["3-009", "4-149", "normal", 15, ["vbdm"]],
    ["3-010", "4-009", "normal", 3, ["pen20"]],
    ["3-010", "4-075", "normal", 12, ["pen20"]],
    ["3-010", "4-103", "normal", 3, ["pen20"]],
    ["3-011", "4-006", "normal", 3, ["pen", "pen20"]],
    ["3-011", "4-028", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-011", "4-046", "normal", 15, ["penc"]],
    ["3-011", "4-079", "normal", 3, ["pen", "pen20", "penc"]],
    ["3-011", "4-143", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-012", "4-040", "normal", 15, ["dm20", "vbbe"]],
    ["3-012", "4-044", "normal", 15, ["vbbe"]],
    ["3-012", "4-070", "normal", 15, ["vbbe"]],
    ["3-013", "4-017", "normal", 15, ["penc"]],
    ["3-013", "4-032", "normal", 3, ["pen", "pen20", "penc"]],
    ["3-013", "4-036", "normal", 12, ["pen20", "penc"]],
    ["3-013", "4-051", "normal", 8, ["pen", "penc"]],
    ["3-013", "4-090", "normal", 12, ["pen20"]],
    ["3-013", "4-107", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-014", "4-011", "normal", 3, ["pen20", "penc"]],
    ["3-014", "4-028", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-014", "4-031", "normal", 12, ["pen20", "penc"]],
    ["3-014", "4-079", "normal", 7, ["pen", "penc"]],
    ["3-014", "4-143", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-015", "4-033", "normal", 3, ["dm20", "dmx3", "pen20", "vbbe"]],
    ["3-015", "4-080", "special", 0, ["dmx3"]],
    ["3-015", "4-093", "normal", 12, ["dmx3"]],
    ["3-015", "4-100", "special", 0, ["dmx3"]],
    ["3-015", "4-109", "special", 0, ["dmx3"]],
    ["3-016", "4-018", "normal", 3, ["dm20", "pen20", "vbbe"]],
    ["3-016", "4-019", "normal", 15, ["dm20", "pen20", "vbbe"]],
    ["3-016", "4-050", "normal", 15, ["vbbe"]],
    ["3-017", "4-021", "normal", 8, ["dmx"]],
    ["3-017", "4-056", "special", 0, ["dmx"]],
    ["3-017", "4-114", "normal", 7, ["dmx"]],
    ["3-018", "4-024", "normal", 7, ["dmx2"]],
    ["3-018", "4-089", "normal", 8, ["dmx2"]],
    ["3-018", "4-092", "normal", 7, ["dmx2"]],
    ["3-018", "4-140", "normal", 7, ["dmx2"]],
    ["3-019", "4-004", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-019", "4-014", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-019", "4-043", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-019", "4-139", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-019", "4-141", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-020", "4-029", "normal", 7, ["penz"]],
    ["3-020", "4-096", "normal", 7, ["penz"]],
    ["3-020", "4-139", "normal", 8, ["penz"]],
    ["3-021", "4-014", "normal", 7, ["penc"]],
    ["3-021", "4-063", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-021", "4-102", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-021", "4-127", "normal", 15, ["pen", "pen20"]],
    ["3-021", "4-138", "normal", 11, ["pen20", "penc"]],
    ["3-021", "4-145", "normal", 8, ["pen"]],
    ["3-022", "4-004", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-022", "4-008", "normal", 15, ["vbdm"]],
    ["3-022", "4-031", "normal", 15, ["vbdm"]],
    ["3-022", "4-034", "normal", 15, ["vbdm"]],
    ["3-022", "4-043", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-022", "4-046", "normal", 15, ["dm", "dm20", "dmc", "pen", "pen20", "penc", "penz", "vbdm"]],
    ["3-022", "4-047", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-022", "4-062", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-022", "4-070", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-022", "4-087", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-022", "4-139", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-022", "5-056", "normal", 15, ["penz"]],
    ["3-022", "7-042", "normal", 3, ["penz"]],
    ["3-023", "4-021", "normal", 8, ["dmx"]],
    ["3-023", "4-104", "special", 0, ["dmx"]],
    ["3-023", "4-126", "normal", 7, ["dmx"]],
    ["3-024", "4-010", "normal", 7, ["penz"]],
    ["3-024", "4-040", "normal", 15, ["vbbe"]],
    ["3-024", "4-044", "normal", 7, ["penz", "vbbe"]],
    ["3-024", "4-069", "normal", 15, ["vbbe"]],
    ["3-024", "4-105", "normal", 8, ["penz"]],
    ["3-025", "4-007", "normal", 15, ["vbbe"]],
    ["3-025", "4-047", "normal", 15, ["vbbe"]],
    ["3-026", "4-020", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-026", "4-023", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-026", "4-027", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-026", "4-035", "normal", 15, ["vbdm"]],
    ["3-026", "4-074", "normal", 15, ["vbdm"]],
    ["3-026", "4-101", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-026", "4-132", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-027", "4-008", "normal", 7, ["penz"]],
    ["3-027", "4-011", "normal", 15, ["vbdm"]],
    ["3-027", "4-028", "normal", 15, ["vbdm"]],
    ["3-027", "4-041", "normal", 8, ["penz"]],
    ["3-027", "4-142", "normal", 7, ["penz"]],
    ["3-027", "4-143", "normal", 15, ["vbdm"]],
    ["3-027", "4-152", "normal", 15, ["vbdm"]],
    ["3-028", "4-025", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-028", "4-027", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-028", "4-036", "normal", 15, ["vbdm"]],
    ["3-028", "4-042", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-028", "4-043", "normal", 3, ["penz"]],
    ["3-028", "4-101", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-028", "4-111", "normal", 3, ["penz"]],
    ["3-028", "4-112", "normal", 12, ["penz"]],
    ["3-028", "4-125", "normal", 12, ["penz"]],
    ["3-028", "4-132", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-029", "4-017", "normal", 12, ["pen20", "penc"]],
    ["3-029", "4-032", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-029", "4-036", "normal", 15, ["penc"]],
    ["3-029", "4-051", "normal", 12, ["pen20"]],
    ["3-029", "4-060", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-029", "4-090", "normal", 8, ["pen", "penc"]],
    ["3-030", "4-003", "normal", 8, ["dmx2"]],
    ["3-030", "4-067", "normal", 7, ["dmx2"]],
    ["3-030", "4-076", "special", 0, ["dmx2"]],
    ["3-031", "4-049", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-031", "4-084", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-031", "4-115", "normal", 12, ["pen", "pen20", "penc", "vbdm"]],
    ["3-031", "4-129", "normal", 3, ["pen20", "penc"]],
    ["3-032", "4-009", "normal", 3, ["pen20"]],
    ["3-032", "4-012", "normal", 15, ["penz"]],
    ["3-032", "4-027", "normal", 15, ["vbdm"]],
    ["3-032", "4-050", "normal", 12, ["penz"]],
    ["3-032", "4-055", "normal", 3, ["pen20", "penz", "vbdm"]],
    ["3-032", "4-075", "normal", 12, ["pen20"]],
    ["3-033", "4-054", "normal", 3, ["pen", "pen20", "penc"]],
    ["3-033", "4-057", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-033", "4-073", "normal", 15, ["vbdm"]],
    ["3-033", "4-078", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-033", "4-101", "normal", 15, ["vbdm"]],
    ["3-033", "4-121", "normal", 3, ["pen20", "penc"]],
    ["3-034", "4-007", "normal", 3, ["penz", "vbbe"]],
    ["3-034", "4-064", "normal", 12, ["penz"]],
    ["3-034", "4-096", "normal", 3, ["penz"]],
    ["3-035", "4-021", "normal", 8, ["dmx", "vbbe"]],
    ["3-035", "4-039", "normal", 7, ["dmx2", "vbbe"]],
    ["3-035", "4-067", "normal", 7, ["dmx2"]],
    ["3-035", "4-086", "normal", 7, ["dmx2"]],
    ["3-035", "4-089", "normal", 8, ["dmx2"]],
    ["3-035", "4-106", "normal", 7, ["dmx"]],
    ["3-035", "4-136", "special", 0, ["dmx"]],
    ["3-036", "4-009", "special", 0, ["vbbe"]],
    ["3-036", "4-013", "normal", 3, ["pen20"]],
    ["3-036", "4-018", "normal", 15, ["vbbe"]],
    ["3-036", "4-122", "normal", 15, ["pen20"]],
    ["3-037", "4-074", "normal", 3, ["pen20"]],
    ["3-037", "4-110", "normal", 3, ["pen20"]],
    ["3-037", "4-130", "normal", 12, ["pen20"]],
    ["3-037", "4-143", "normal", 15, ["vbdm"]],
    ["3-038", "4-003", "normal", 8, ["dmx2"]],
    ["3-038", "4-089", "special", 0, ["dmx2"]],
    ["3-038", "4-092", "special", 0, ["dmx2"]],
    ["3-038", "4-108", "normal", 7, ["dmx2"]],
    ["3-039", "4-014", "normal", 15, ["vbbe"]],
    ["3-039", "4-061", "normal", 7, ["dmx3"]],
    ["3-039", "4-065", "normal", 7, ["penz"]],
    ["3-039", "4-073", "normal", 7, ["penz"]],
    ["3-039", "4-093", "normal", 8, ["dmx3"]],
    ["3-039", "4-097", "normal", 7, ["dmx3"]],
    ["3-039", "4-100", "normal", 7, ["dmx3"]],
    ["3-039", "4-101", "normal", 8, ["penz"]],
    ["3-039", "4-134", "normal", 8, ["dmx3"]],
    ["3-040", "4-065", "normal", 3, ["penz"]],
    ["3-040", "4-082", "normal", 15, ["penz"]],
    ["3-040", "4-101", "normal", 12, ["penz"]],
    ["3-041", "7-012", "normal", 15, ["dmx3"]],
    ["3-042", "4-016", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-042", "4-026", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-042", "4-057", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-042", "4-121", "normal", 15, ["penc"]],
    ["3-042", "4-123", "normal", 3, ["pen20", "penc"]],
    ["3-043", "4-003", "special", 0, ["dmx2"]],
    ["3-043", "4-039", "special", 0, ["dmx2"]],
    ["3-043", "4-067", "normal", 3, ["dmx2"]],
    ["3-043", "4-089", "special", 0, ["dmx2"]],
    ["3-043", "4-140", "special", 0, ["dmx2"]],
    ["3-044", "4-011", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-044", "4-034", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-044", "4-091", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-044", "4-111", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-044", "4-119", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-045", "4-008", "normal", 7, ["penz"]],
    ["3-045", "4-030", "normal", 7, ["penz"]],
    ["3-045", "4-083", "normal", 8, ["penz"]],
    ["3-046", "4-059", "special", 0, ["vbbe"]],
    ["3-046", "4-120", "normal", 15, ["pen20", "vbbe"]],
    ["3-047", "4-131", "normal", 15, ["pen20"]],
    ["3-048", "4-048", "normal", 7, ["dmx3"]],
    ["3-048", "4-052", "normal", 8, ["dmx3"]],
    ["3-048", "4-097", "special", 0, ["dmx3"]],
    ["3-048", "4-144", "special", 0, ["dmx3"]],
    ["3-049", "4-103", "normal", 15, ["vbdm"]],
    ["3-049", "4-124", "normal", 15, ["pen20", "vbdm"]],
    ["3-050", "4-044", "normal", 15, ["vbbe"]],
    ["3-050", "4-069", "normal", 15, ["dm20", "vbbe"]],
    ["3-050", "4-074", "special", 0, ["vbbe"]],
    ["3-051", "4-037", "normal", 7, ["penz"]],
    ["3-051", "4-101", "normal", 8, ["penz"]],
    ["3-051", "4-117", "normal", 7, ["penz", "vbdm"]],
    ["3-052", "4-059", "normal", 7, ["penz", "vbbe"]],
    ["3-052", "4-105", "normal", 8, ["penz"]],
    ["3-052", "4-137", "normal", 7, ["penz"]],
    ["3-053", "4-014", "normal", 3, ["pen", "pen20"]],
    ["3-053", "4-102", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-053", "4-127", "normal", 8, ["penc"]],
    ["3-053", "4-138", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-053", "4-145", "normal", 15, ["pen", "pen20", "penc"]],
    ["3-054", "4-047", "normal", 3, ["pen20", "penc"]],
    ["3-054", "4-049", "normal", 12, ["dm", "pen", "pen20", "penc"]],
    ["3-054", "4-066", "normal", 12, ["dm", "pen", "pen20", "penc"]],
    ["3-054", "4-084", "normal", 15, ["dm"]],
    ["3-054", "4-112", "normal", 8, ["dm"]],
    ["3-054", "4-115", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-054", "4-129", "normal", 15, ["dm"]],
    ["3-055", "4-003", "special", 0, ["dmx2"]],
    ["3-055", "4-039", "special", 0, ["dmx2"]],
    ["3-055", "4-089", "special", 0, ["dmx2"]],
    ["3-055", "4-108", "normal", 3, ["dmx2"]],
    ["3-055", "4-140", "special", 0, ["dmx2"]],
    ["3-056", "4-014", "normal", 12, ["pen20"]],
    ["3-056", "4-017", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-056", "4-063", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-056", "4-066", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-056", "4-070", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-056", "4-083", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-056", "4-085", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-056", "4-095", "normal", 15, ["vbdm"]],
    ["3-056", "4-102", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-056", "4-120", "normal", 15, ["vbdm"]],
    ["3-056", "4-127", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-056", "4-139", "normal", 15, ["vbdm"]],
    ["3-056", "4-145", "normal", 8, ["pen", "penc"]],
    ["3-057", "4-093", "normal", 8, ["dmx3"]],
    ["3-057", "4-100", "normal", 7, ["dmx3"]],
    ["3-057", "4-128", "normal", 7, ["dmx3"]],
    ["3-058", "4-004", "normal", 3, ["penz", "vbbe"]],
    ["3-058", "4-005", "normal", 15, ["vbbe"]],
    ["3-058", "4-011", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-058", "4-015", "normal", 8, ["dm", "dm20"]],
    ["3-058", "4-081", "normal", 12, ["penz"]],
    ["3-058", "4-091", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-058", "4-113", "normal", 3, ["penz"]],
    ["3-058", "4-119", "normal", 8, ["dm", "dm20", "dmc"]],
    ["3-058", "4-137", "normal", 15, ["dm", "dm20", "dmc"]],
    ["3-059", "4-070", "normal", 15, ["vbbe"]],
    ["3-059", "4-074", "special", 0, ["vbbe"]],
    ["3-059", "4-099", "normal", 3, ["pen20"]],
    ["3-059", "4-110", "normal", 3, ["pen20"]],
    ["3-059", "4-130", "normal", 12, ["pen20"]],
    ["3-060", "4-064", "normal", 7, ["penz", "vbdm"]],
    ["3-060", "4-095", "normal", 7, ["penz"]],
    ["3-060", "4-139", "normal", 8, ["penz"]],
    ["3-061", "4-021", "normal", 8, ["dmx"]],
    ["3-061", "4-071", "special", 0, ["dmx"]],
    ["3-061", "4-106", "normal", 7, ["dmx"]],
    ["3-062", "4-025", "normal", 15, ["vbbe"]],
    ["3-062", "4-031", "normal", 15, ["vbdm"]],
    ["3-062", "4-052", "normal", 3, ["dmx3", "pen20", "vbbe", "vbdm"]],
    ["3-062", "4-088", "normal", 15, ["vbbe"]],
    ["3-062", "4-093", "normal", 12, ["dmx3"]],
    ["3-062", "4-097", "special", 0, ["dmx3"]],
    ["3-062", "4-134", "special", 0, ["dmx3"]],
    ["3-062", "4-144", "special", 0, ["dmx3"]],
    ["3-063", "4-004", "normal", 3, ["pen", "pen20", "penc"]],
    ["3-063", "4-046", "normal", 15, ["penc"]],
    ["3-063", "4-047", "normal", 15, ["pen", "pen20", "penc", "penz"]],
    ["3-063", "4-053", "normal", 12, ["penz"]],
    ["3-063", "4-054", "normal", 15, ["pen", "pen20", "penc"]],
    ["3-063", "4-077", "normal", 15, ["dm20", "pen20"]],
    ["3-063", "4-087", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-063", "4-137", "normal", 3, ["penz"]],
    ["3-064", "4-003", "normal", 8, ["dmx2"]],
    ["3-064", "4-086", "special", 0, ["dmx2"]],
    ["3-064", "4-108", "normal", 7, ["dmx2"]],
    ["3-065", "4-058", "normal", 7, ["penz"]],
    ["3-065", "4-090", "normal", 15, ["vbdm"]],
    ["3-065", "4-107", "normal", 15, ["vbdm"]],
    ["3-065", "4-111", "normal", 7, ["penz", "vbdm"]],
    ["3-065", "4-112", "normal", 8, ["penz"]],
    ["3-065", "4-125", "normal", 15, ["vbdm"]],
    ["3-066", "4-022", "normal", 8, ["penz"]],
    ["3-066", "4-081", "normal", 7, ["penz"]],
    ["3-066", "4-103", "normal", 15, ["vbbe"]],
    ["3-066", "4-113", "normal", 7, ["dmxw", "penz"]],
    ["3-066", "4-147", "normal", 15, ["vbbe"]],
    ["3-066", "5-122", "special", 0, ["dmxw"]],
    ["3-067", "4-021", "normal", 8, ["dmx"]],
    ["3-067", "4-104", "special", 0, ["dmx"]],
    ["3-067", "4-114", "normal", 7, ["dmx"]],
    ["3-068", "4-010", "normal", 3, ["penz"]],
    ["3-068", "4-053", "normal", 15, ["penz", "vbdm"]],
    ["3-068", "4-105", "normal", 12, ["penz"]],
    ["3-068", "4-127", "normal", 15, ["vbdm"]],
    ["3-068", "4-129", "normal", 15, ["vbdm"]],
    ["3-069", "4-112", "normal", 8, ["penz"]],
    ["3-069", "4-118", "normal", 7, ["penz"]],
    ["3-069", "4-125", "normal", 7, ["penz"]],
    ["3-070", "4-051", "normal", 14, ["pen", "pen20", "penc"]],
    ["3-070", "4-060", "normal", 1, ["pen", "pen20", "penc"]],
    ["3-070", "4-090", "normal", 14, ["pen", "pen20", "penc"]],
    ["3-070", "4-107", "normal", 1, ["pen", "pen20", "penc"]],
    ["3-071", "4-052", "special", 0, ["dmx3"]],
    ["3-071", "4-093", "normal", 8, ["dmx3"]],
    ["3-071", "4-134", "normal", 7, ["dmx3"]],
    ["3-071", "4-144", "special", 0, ["dmx3"]],
    ["3-072", "4-006", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-072", "4-046", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-072", "4-079", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-072", "4-143", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-073", "4-047", "normal", 3, ["pen20", "penc"]],
    ["3-073", "4-049", "normal", 12, ["dm", "pen", "pen20", "penc"]],
    ["3-073", "4-062", "normal", 15, ["dm", "pen", "pen20", "penc", "vbbe"]],
    ["3-073", "4-066", "normal", 12, ["dm", "pen", "pen20", "penc", "vbbe"]],
    ["3-073", "4-115", "normal", 8, ["dm"]],
    ["3-073", "4-120", "normal", 15, ["vbbe"]],
    ["3-073", "4-129", "normal", 15, ["dm", "penc"]],
    ["3-074", "4-045", "normal", 15, ["pen20", "vbdm"]],
    ["3-074", "4-131", "normal", 15, ["vbdm"]],
    ["3-075", "4-033", "normal", 7, ["dmx3"]],
    ["3-075", "4-080", "special", 0, ["dmx3"]],
    ["3-075", "4-109", "special", 0, ["dmx3"]],
    ["3-075", "4-128", "normal", 8, ["dmx3"]],
    ["3-076", "4-064", "normal", 3, ["penz"]],
    ["3-076", "4-095", "normal", 12, ["penz"]],
    ["3-076", "4-098", "normal", 3, ["penz"]],
    ["3-076", "4-139", "normal", 12, ["penz"]],
    ["3-077", "4-016", "normal", 12, ["pen", "pen20", "penc"]],
    ["3-077", "4-026", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-077", "4-054", "normal", 7, ["pen", "pen20", "penc"]],
    ["3-077", "4-078", "normal", 15, ["penc"]],
    ["3-077", "4-123", "normal", 12, ["pen20", "penc"]],
    ["3-078", "4-038", "normal", 3, ["pen20", "penz", "vbbe", "vbdm"]],
    ["3-078", "4-065", "normal", 3, ["penz"]],
    ["3-078", "4-082", "normal", 12, ["penz"]],
    ["3-078", "4-138", "normal", 12, ["pen20", "vbdm"]],
    ["3-079", "4-014", "normal", 15, ["vbdm"]],
    ["3-079", "4-068", "normal", 15, ["pen20", "vbdm"]],
    ["3-079", "4-079", "normal", 15, ["vbdm"]],
    ["3-079", "4-135", "normal", 15, ["vbdm"]],
    ["3-080", "4-028", "normal", 3, ["penz"]],
    ["3-080", "4-059", "normal", 15, ["vbdm"]],
    ["3-080", "4-105", "normal", 15, ["vbdm"]],
    ["3-080", "4-110", "normal", 15, ["vbdm"]],
    ["3-080", "4-116", "normal", 3, ["penz", "vbbe", "vbdm"]],
    ["3-080", "4-142", "normal", 12, ["penz"]],
    ["3-081", "4-031", "normal", 15, ["vbdm"]],
    ["3-081", "4-122", "normal", 15, ["pen20"]],
    ["3-081", "4-146", "normal", 3, ["dm20", "pen20", "vbdm"]],
    ["3-082", "4-002", "normal", 15, ["vbbe"]],
    ["3-082", "4-023", "normal", 15, ["vbbe", "vbdm"]],
    ["3-082", "4-054", "normal", 15, ["vbdm"]],
    ["3-082", "4-084", "normal", 15, ["vbdm"]],
    ["3-083", "4-106", "normal", 15, ["vbbe"]],
    ["3-084", "4-123", "normal", 15, ["vbbe"]],
    ["3-084", "4-147", "normal", 15, ["vbbe", "vbdm"]],
    ["3-085", "4-096", "normal", 15, ["penc"]],
    ["3-085", "4-148", "normal", 15, ["penc"]],
    ["4-001", "4-010", "special", 0, ["penz"]],
    ["4-001", "4-030", "special", 0, ["penz"]],
    ["4-001", "4-043", "special", 0, ["penz"]],
    ["4-001", "4-058", "special", 0, ["penz"]],
    ["4-001", "4-116", "special", 0, ["penz"]],
    ["4-001", "4-137", "special", 0, ["penz"]],
    ["4-001", "5-002", "normal", 15, ["vbdm"]],
    ["4-001", "5-016", "normal", 7, ["penz", "vbdm"]],
    ["4-001", "5-145", "jogress", 0, ["vbdm"]],
    ["4-001", "5-149", "jogress", 0, ["vbdm"]],
    ["4-002", "5-080", "normal", 15, ["vbbe"]],
    ["4-002", "5-086", "normal", 15, ["dm", "dm20"]],
    ["4-002", "5-088", "normal", 15, ["dmc", "vbbe"]],
    ["4-002", "5-093", "normal", 15, ["vbbe"]],
    ["4-003", "5-072", "normal", 12, ["dmx2"]],
    ["4-003", "5-074", "normal", 3, ["dmx2"]],
    ["4-003", "5-092", "special", 0, ["dmx2"]],
    ["4-003", "5-132", "special", 0, ["dmx2"]],
    ["4-004", "5-004", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-004", "5-010", "jogress", 0, ["penc"]],
    ["4-004", "5-036", "jogress", 0, ["penz"]],
    ["4-004", "5-069", "normal", 7, ["pen", "pen20", "penc", "penz", "vbbe"]],
    ["4-004", "5-075", "jogress", 0, ["penz"]],
    ["4-004", "5-091", "jogress", 0, ["pen", "pen20"]],
    ["4-004", "5-120", "jogress", 0, ["penz", "vbbe"]],
    ["4-004", "5-126", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-005", "5-049", "jogress", 0, ["penz"]],
    ["4-005", "5-076", "normal", 7, ["penz"]],
    ["4-005", "5-085", "jogress", 0, ["penz"]],
    ["4-005", "5-105", "normal", 15, ["vbbe"]],
    ["4-005", "5-108", "jogress", 0, ["penz"]],
    ["4-005", "5-120", "jogress", 0, ["penz", "vbbe"]],
    ["4-006", "5-073", "normal", 7, ["pen", "pen20", "penc"]],
    ["4-006", "5-110", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-006", "5-139", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-006", "5-147", "jogress", 0, ["penc"]],
    ["4-007", "5-023", "normal", 7, ["penz"]],
    ["4-007", "5-031", "normal", 15, ["vbbe"]],
    ["4-007", "5-050", "jogress", 0, ["penz"]],
    ["4-007", "5-057", "special", 0, ["vbbe"]],
    ["4-007", "5-106", "jogress", 0, ["penz"]],
    ["4-007", "5-123", "jogress", 0, ["penz", "vbbe"]],
    ["4-007", "5-130", "jogress", 0, ["penz"]],
    ["4-008", "5-003", "jogress", 0, ["vbdm"]],
    ["4-008", "5-007", "normal", 7, ["penz"]],
    ["4-008", "5-013", "normal", 15, ["vbdm"]],
    ["4-008", "5-015", "jogress", 0, ["vbdm"]],
    ["4-008", "5-057", "jogress", 0, ["penz"]],
    ["4-008", "5-070", "normal", 15, ["vbdm"]],
    ["4-008", "5-087", "normal", 15, ["vbdm"]],
    ["4-008", "5-093", "normal", 15, ["vbdm"]],
    ["4-008", "5-097", "jogress", 0, ["penz"]],
    ["4-008", "5-106", "jogress", 0, ["vbdm"]],
    ["4-008", "5-118", "jogress", 0, ["vbdm"]],
    ["4-008", "5-138", "normal", 15, ["vbdm"]],
    ["4-008", "5-139", "normal", 15, ["vbdm"]],
    ["4-009", "5-115", "normal", 7, ["pen20"]],
    ["4-009", "5-117", "normal", 15, ["vbbe"]],
    ["4-009", "5-135", "jogress", 0, ["pen20"]],
    ["4-010", "5-046", "normal", 7, ["penz"]],
    ["4-010", "5-055", "jogress", 0, ["penz"]],
    ["4-010", "5-068", "jogress", 0, ["penz"]],
    ["4-011", "5-011", "jogress", 0, ["vbdm"]],
    ["4-011", "5-045", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-011", "5-059", "normal", 3, ["pen20", "penc"]],
    ["4-011", "5-098", "normal", 3, ["pen", "vbdm"]],
    ["4-011", "5-107", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["4-011", "5-110", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["4-012", "5-036", "jogress", 0, ["penz"]],
    ["4-012", "5-075", "normal", 7, ["penz"]],
    ["4-012", "5-111", "jogress", 0, ["penz"]],
    ["4-012", "5-135", "jogress", 0, ["penz"]],
    ["4-013", "5-036", "jogress", 0, ["pen20"]],
    ["4-013", "5-039", "jogress", 0, ["pen20"]],
    ["4-013", "5-117", "normal", 7, ["dm20", "pen20"]],
    ["4-014", "5-001", "normal", 7, ["pen", "pen20", "penc"]],
    ["4-014", "5-014", "jogress", 0, ["penc"]],
    ["4-014", "5-029", "jogress", 0, ["pen", "pen20"]],
    ["4-014", "5-041", "jogress", 0, ["vbdm"]],
    ["4-014", "5-043", "normal", 7, ["pen", "pen20", "penc", "vbbe"]],
    ["4-014", "5-048", "jogress", 0, ["vbdm"]],
    ["4-014", "5-061", "normal", 15, ["vbdm"]],
    ["4-014", "5-126", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-015", "5-045", "normal", 15, ["dm", "dm20"]],
    ["4-016", "5-003", "normal", 15, ["pen20", "penc"]],
    ["4-016", "5-013", "jogress", 0, ["pen", "pen20"]],
    ["4-016", "5-058", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-016", "5-087", "jogress", 0, ["penc"]],
    ["4-016", "5-137", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-017", "5-003", "normal", 15, ["vbdm"]],
    ["4-017", "5-033", "unverified", 0, ["vbdm"]],
    ["4-017", "5-035", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-017", "5-080", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-017", "5-082", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-017", "5-087", "jogress", 0, ["vbdm"]],
    ["4-017", "5-093", "jogress", 0, ["vbdm"]],
    ["4-017", "5-100", "normal", 15, ["vbdm"]],
    ["4-017", "5-118", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["4-017", "5-141", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-018", "5-048", "jogress", 0, ["pen20"]],
    ["4-018", "5-080", "jogress", 0, ["pen20"]],
    ["4-018", "5-115", "normal", 15, ["vbbe"]],
    ["4-018", "5-142", "normal", 7, ["dm20", "pen20", "vbbe"]],
    ["4-019", "5-048", "normal", 7, ["dm20", "pen20", "vbbe"]],
    ["4-019", "5-080", "jogress", 0, ["pen20"]],
    ["4-019", "5-117", "normal", 15, ["vbbe"]],
    ["4-019", "5-142", "jogress", 0, ["pen20"]],
    ["4-020", "5-028", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-021", "5-003", "normal", 15, ["vbbe"]],
    ["4-021", "5-019", "special", 0, ["dmx"]],
    ["4-021", "5-021", "normal", 1, ["dmx"]],
    ["4-021", "5-064", "normal", 14, ["dmx"]],
    ["4-021", "5-067", "normal", 1, ["dmx"]],
    ["4-021", "5-125", "normal", 14, ["dmx"]],
    ["4-021", "5-136", "special", 0, ["dmx"]],
    ["4-022", "5-036", "normal", 7, ["penz"]],
    ["4-022", "5-115", "jogress", 0, ["penz"]],
    ["4-022", "5-122", "jogress", 0, ["penz"]],
    ["4-023", "5-040", "normal", 15, ["vbdm"]],
    ["4-023", "5-072", "normal", 15, ["vbdm"]],
    ["4-023", "5-080", "normal", 15, ["vbbe"]],
    ["4-023", "5-087", "normal", 15, ["vbdm"]],
    ["4-023", "5-088", "jogress", 0, ["vbdm"]],
    ["4-023", "5-093", "normal", 15, ["dm", "dm20", "dmc", "vbbe"]],
    ["4-023", "5-126", "normal", 15, ["vbdm"]],
    ["4-024", "5-072", "normal", 8, ["dmx2"]],
    ["4-024", "5-074", "normal", 7, ["dmx2"]],
    ["4-024", "5-089", "special", 0, ["dmx2"]],
    ["4-024", "5-132", "special", 0, ["dmx2"]],
    ["4-025", "5-028", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-025", "5-039", "normal", 15, ["vbbe"]],
    ["4-025", "5-095", "normal", 15, ["vbbe"]],
    ["4-025", "5-104", "normal", 15, ["vbbe"]],
    ["4-026", "5-003", "normal", 15, ["pen20", "penc"]],
    ["4-026", "5-013", "jogress", 0, ["pen", "pen20"]],
    ["4-026", "5-025", "jogress", 0, ["penc"]],
    ["4-026", "5-058", "jogress", 0, ["penc"]],
    ["4-026", "5-086", "normal", 3, ["pen", "pen20"]],
    ["4-027", "5-048", "jogress", 0, ["pen20"]],
    ["4-027", "5-080", "normal", 3, ["pen20"]],
    ["4-027", "5-093", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-027", "5-135", "jogress", 0, ["vbdm"]],
    ["4-027", "5-142", "jogress", 0, ["pen20"]],
    ["4-028", "5-007", "jogress", 0, ["penz"]],
    ["4-028", "5-011", "normal", 15, ["vbdm"]],
    ["4-028", "5-033", "unverified", 0, ["penz"]],
    ["4-028", "5-057", "jogress", 0, ["penz"]],
    ["4-028", "5-059", "jogress", 0, ["pen20", "penc"]],
    ["4-028", "5-086", "normal", 15, ["dm", "dm20"]],
    ["4-028", "5-088", "normal", 15, ["dmc", "vbbe"]],
    ["4-028", "5-098", "normal", 3, ["pen20", "penc", "vbdm"]],
    ["4-028", "5-100", "normal", 7, ["penz"]],
    ["4-028", "5-107", "jogress", 0, ["pen", "vbdm"]],
    ["4-028", "5-110", "jogress", 0, ["pen", "pen20", "vbdm"]],
    ["4-028", "5-127", "jogress", 0, ["penc"]],
    ["4-029", "5-023", "jogress", 0, ["penz"]],
    ["4-029", "5-050", "jogress", 0, ["penz"]],
    ["4-029", "5-130", "normal", 7, ["penz"]],
    ["4-030", "5-012", "jogress", 0, ["vbdm"]],
    ["4-030", "5-018", "normal", 7, ["penz"]],
    ["4-030", "5-040", "jogress", 0, ["penz"]],
    ["4-030", "5-056", "normal", 15, ["vbdm"]],
    ["4-030", "5-057", "jogress", 0, ["penz"]],
    ["4-030", "5-124", "jogress", 0, ["vbdm"]],
    ["4-031", "5-010", "jogress", 0, ["vbdm"]],
    ["4-031", "5-013", "normal", 15, ["vbdm"]],
    ["4-031", "5-015", "jogress", 0, ["vbdm"]],
    ["4-031", "5-036", "jogress", 0, ["vbdm"]],
    ["4-031", "5-051", "normal", 15, ["vbdm"]],
    ["4-031", "5-059", "normal", 3, ["pen", "pen20", "penc"]],
    ["4-031", "5-098", "jogress", 0, ["pen20", "penc"]],
    ["4-031", "5-104", "normal", 15, ["vbdm"]],
    ["4-031", "5-106", "normal", 15, ["vbdm"]],
    ["4-031", "5-107", "jogress", 0, ["pen"]],
    ["4-031", "5-110", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-031", "5-139", "jogress", 0, ["vbdm"]],
    ["4-032", "5-032", "jogress", 0, ["pen20", "penc"]],
    ["4-032", "5-141", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["4-032", "5-143", "normal", 7, ["pen", "pen20", "penc"]],
    ["4-033", "5-017", "normal", 7, ["dmx3"]],
    ["4-033", "5-034", "normal", 7, ["dm20", "dmx3", "pen20", "vbbe"]],
    ["4-033", "5-047", "special", 0, ["vbbe"]],
    ["4-033", "5-071", "normal", 8, ["dmx3"]],
    ["4-033", "5-146", "normal", 7, ["dm20", "dmx3", "pen20", "vbbe"]],
    ["4-034", "4-151", "special", 0, ["vbdm"]],
    ["4-034", "5-018", "normal", 15, ["vbdm"]],
    ["4-034", "5-045", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-034", "5-139", "jogress", 0, ["vbdm"]],
    ["4-034", "5-147", "normal", 15, ["vbdm"]],
    ["4-035", "5-053", "jogress", 0, ["vbdm"]],
    ["4-035", "5-065", "jogress", 0, ["vbdm"]],
    ["4-035", "5-067", "special", 0, ["vbdm"]],
    ["4-035", "5-114", "jogress", 0, ["vbdm"]],
    ["4-035", "5-134", "normal", 15, ["vbdm"]],
    ["4-036", "5-012", "jogress", 0, ["vbdm"]],
    ["4-036", "5-032", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-036", "5-035", "jogress", 0, ["pen", "pen20"]],
    ["4-036", "5-056", "jogress", 0, ["vbdm"]],
    ["4-036", "5-077", "jogress", 0, ["penc"]],
    ["4-036", "5-082", "normal", 15, ["pen", "pen20"]],
    ["4-036", "5-118", "jogress", 0, ["penc"]],
    ["4-036", "5-124", "normal", 15, ["vbdm"]],
    ["4-036", "5-141", "jogress", 0, ["pen", "pen20"]],
    ["4-036", "5-143", "jogress", 0, ["penc"]],
    ["4-037", "5-038", "normal", 7, ["penz"]],
    ["4-037", "5-065", "jogress", 0, ["penz"]],
    ["4-037", "5-066", "jogress", 0, ["penz"]],
    ["4-037", "5-113", "jogress", 0, ["penz"]],
    ["4-038", "5-001", "jogress", 0, ["pen20", "vbdm"]],
    ["4-038", "5-030", "jogress", 0, ["vbdm"]],
    ["4-038", "5-031", "normal", 15, ["penz", "vbdm"]],
    ["4-038", "5-065", "jogress", 0, ["penz"]],
    ["4-038", "5-066", "jogress", 0, ["penz"]],
    ["4-038", "5-069", "normal", 15, ["vbbe"]],
    ["4-038", "5-093", "normal", 7, ["penz"]],
    ["4-038", "5-105", "normal", 15, ["pen20", "penz", "vbbe", "vbdm"]],
    ["4-038", "5-113", "jogress", 0, ["penz"]],
    ["4-039", "5-003", "normal", 15, ["vbbe"]],
    ["4-039", "5-053", "special", 0, ["dmx2"]],
    ["4-039", "5-072", "normal", 8, ["dmx2"]],
    ["4-039", "5-083", "special", 0, ["dmx2"]],
    ["4-039", "5-089", "normal", 7, ["dmx2"]],
    ["4-039", "5-099", "normal", 7, ["dmx2"]],
    ["4-039", "5-128", "normal", 7, ["dmx2", "vbbe"]],
    ["4-039", "5-132", "normal", 8, ["dmx2"]],
    ["4-040", "5-041", "normal", 15, ["dm20", "vbbe"]],
    ["4-040", "5-068", "normal", 15, ["vbbe"]],
    ["4-041", "5-007", "normal", 3, ["penz"]],
    ["4-041", "5-040", "jogress", 0, ["penz"]],
    ["4-041", "5-057", "jogress", 0, ["penz"]],
    ["4-041", "5-097", "jogress", 0, ["penz"]],
    ["4-042", "5-093", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-043", "5-022", "normal", 15, ["vbdm"]],
    ["4-043", "5-049", "jogress", 0, ["penz"]],
    ["4-043", "5-073", "normal", 15, ["vbdm"]],
    ["4-043", "5-076", "normal", 7, ["penz"]],
    ["4-043", "5-091", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-043", "5-124", "jogress", 0, ["penz"]],
    ["4-044", "5-022", "normal", 15, ["vbbe"]],
    ["4-044", "5-046", "jogress", 0, ["penz"]],
    ["4-044", "5-068", "normal", 7, ["penz", "vbbe"]],
    ["4-044", "5-104", "jogress", 0, ["penz"]],
    ["4-045", "5-006", "normal", 15, ["vbdm"]],
    ["4-045", "5-112", "normal", 7, ["pen20", "vbdm"]],
    ["4-046", "4-151", "jogress", 0, ["garuru", "vbdm"]],
    ["4-046", "5-004", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-046", "5-010", "jogress", 0, ["pen"]],
    ["4-046", "5-012", "jogress", 0, ["penz"]],
    ["4-046", "5-015", "normal", 15, ["garuru", "vbdm"]],
    ["4-046", "5-018", "jogress", 0, ["garuru", "vbdm"]],
    ["4-046", "5-069", "jogress", 0, ["penc"]],
    ["4-046", "5-073", "normal", 7, ["pen", "pen20", "penc"]],
    ["4-046", "5-091", "normal", 15, ["dm", "dm20", "dmc", "pen", "pen20", "penc"]],
    ["4-046", "5-104", "jogress", 0, ["garuru", "vbdm"]],
    ["4-046", "5-106", "jogress", 0, ["garuru", "vbdm"]],
    ["4-046", "5-110", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-046", "5-138", "normal", 15, ["garuru", "vbdm"]],
    ["4-046", "5-139", "normal", 7, ["garuru", "pen", "pen20", "penc", "penz", "vbdm"]],
    ["4-046", "5-147", "normal", 15, ["garuru", "vbdm"]],
    ["4-047", "5-004", "normal", 7, ["pen20", "penc", "penz", "vbbe"]],
    ["4-047", "5-052", "jogress", 0, ["pen20", "penc"]],
    ["4-047", "5-055", "jogress", 0, ["penz"]],
    ["4-047", "5-068", "jogress", 0, ["penz"]],
    ["4-047", "5-069", "jogress", 0, ["pen20", "penc"]],
    ["4-047", "5-091", "jogress", 0, ["pen20"]],
    ["4-047", "5-097", "special", 0, ["vbbe"]],
    ["4-047", "5-109", "jogress", 0, ["pen20", "penc"]],
    ["4-047", "5-123", "jogress", 0, ["penz", "vbbe"]],
    ["4-047", "5-139", "jogress", 0, ["penc"]],
    ["4-048", "5-005", "special", 0, ["dmx3"]],
    ["4-048", "5-047", "normal", 3, ["dmx3"]],
    ["4-048", "5-071", "normal", 12, ["dmx3"]],
    ["4-048", "5-096", "special", 0, ["dmx3"]],
    ["4-049", "5-101", "normal", 15, ["pen", "penc"]],
    ["4-049", "5-109", "jogress", 0, ["pen", "pen20"]],
    ["4-049", "5-121", "normal", 7, ["dm", "pen", "pen20", "penc"]],
    ["4-049", "5-131", "jogress", 0, ["penc"]],
    ["4-050", "5-036", "jogress", 0, ["penz"]],
    ["4-050", "5-115", "normal", 7, ["penz", "vbbe"]],
    ["4-050", "5-122", "jogress", 0, ["penz"]],
    ["4-050", "5-142", "normal", 15, ["vbbe"]],
    ["4-051", "5-032", "normal", 15, ["pen20", "vbdm"]],
    ["4-051", "5-035", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-051", "5-077", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["4-051", "5-118", "jogress", 0, ["penc"]],
    ["4-052", "5-010", "jogress", 0, ["vbdm"]],
    ["4-052", "5-036", "jogress", 0, ["vbdm"]],
    ["4-052", "5-047", "normal", 7, ["dmx3"]],
    ["4-052", "5-051", "normal", 7, ["dmx3", "pen20", "vbbe", "vbdm"]],
    ["4-052", "5-071", "normal", 8, ["dmx3"]],
    ["4-052", "5-104", "normal", 15, ["vbbe"]],
    ["4-052", "5-119", "normal", 8, ["dmx3"]],
    ["4-053", "5-046", "normal", 3, ["penz", "vbdm"]],
    ["4-053", "5-052", "jogress", 0, ["vbdm"]],
    ["4-053", "5-068", "jogress", 0, ["penz"]],
    ["4-053", "5-097", "jogress", 0, ["vbdm"]],
    ["4-053", "5-104", "jogress", 0, ["penz"]],
    ["4-053", "5-131", "normal", 15, ["vbdm"]],
    ["4-053", "5-148", "jogress", 0, ["vbdm"]],
    ["4-054", "5-002", "jogress", 0, ["penz"]],
    ["4-054", "5-003", "jogress", 0, ["vbdm"]],
    ["4-054", "5-010", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-054", "5-013", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-054", "5-025", "jogress", 0, ["pen20", "penc"]],
    ["4-054", "5-033", "unverified", 0, ["vbdm"]],
    ["4-054", "5-040", "jogress", 0, ["vbdm"]],
    ["4-054", "5-072", "jogress", 0, ["vbdm"]],
    ["4-054", "5-086", "normal", 7, ["dm", "dm20", "pen", "pen20", "penz"]],
    ["4-054", "5-087", "normal", 15, ["penc", "vbdm"]],
    ["4-054", "5-088", "normal", 15, ["dmc", "vbbe", "vbdm"]],
    ["4-054", "5-091", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-054", "5-093", "normal", 15, ["vbdm"]],
    ["4-054", "5-100", "jogress", 0, ["vbdm"]],
    ["4-054", "5-118", "normal", 15, ["vbdm"]],
    ["4-054", "5-126", "normal", 15, ["vbdm"]],
    ["4-055", "5-012", "jogress", 0, ["pen20"]],
    ["4-055", "5-075", "jogress", 0, ["penz"]],
    ["4-055", "5-115", "jogress", 0, ["pen20"]],
    ["4-055", "5-122", "jogress", 0, ["penz"]],
    ["4-055", "5-135", "normal", 7, ["pen20", "penz", "vbdm"]],
    ["4-056", "5-021", "normal", 7, ["dmx"]],
    ["4-056", "5-023", "normal", 8, ["dmx"]],
    ["4-056", "5-094", "special", 0, ["dmx"]],
    ["4-056", "5-136", "special", 0, ["dmx"]],
    ["4-057", "5-013", "jogress", 0, ["pen", "pen20"]],
    ["4-057", "5-058", "jogress", 0, ["penc"]],
    ["4-057", "5-080", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-057", "5-137", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-058", "5-085", "jogress", 0, ["penz"]],
    ["4-058", "5-108", "jogress", 0, ["penz"]],
    ["4-058", "5-124", "normal", 3, ["penz"]],
    ["4-059", "5-008", "normal", 7, ["penz"]],
    ["4-059", "5-017", "normal", 15, ["vbbe"]],
    ["4-059", "5-031", "jogress", 0, ["vbdm"]],
    ["4-059", "5-038", "special", 0, ["vbbe"]],
    ["4-059", "5-055", "normal", 15, ["penz", "vbdm"]],
    ["4-059", "5-104", "jogress", 0, ["penz"]],
    ["4-059", "5-105", "normal", 15, ["vbdm"]],
    ["4-060", "5-076", "normal", 15, ["vbbe"]],
    ["4-060", "5-118", "jogress", 0, ["pen20", "penc"]],
    ["4-060", "5-119", "normal", 15, ["vbbe"]],
    ["4-060", "5-141", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-060", "5-143", "normal", 7, ["pen", "pen20", "penc", "vbbe"]],
    ["4-061", "5-005", "special", 0, ["dmx3"]],
    ["4-061", "5-017", "special", 0, ["dmx3"]],
    ["4-061", "5-044", "special", 0, ["dmx3"]],
    ["4-061", "5-054", "normal", 7, ["dmx3"]],
    ["4-061", "5-110", "normal", 15, ["dmx3"]],
    ["4-061", "5-119", "special", 0, ["dmx3"]],
    ["4-062", "5-004", "jogress", 0, ["penc"]],
    ["4-062", "5-052", "jogress", 0, ["pen20"]],
    ["4-062", "5-062", "normal", 15, ["vbbe"]],
    ["4-062", "5-081", "normal", 1, ["dm", "pen", "pen20", "penc", "vbbe"]],
    ["4-062", "5-109", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-062", "5-126", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-063", "5-014", "normal", 7, ["pen20", "penc"]],
    ["4-063", "5-029", "jogress", 0, ["pen", "pen20"]],
    ["4-063", "5-042", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-063", "5-043", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-063", "5-063", "jogress", 0, ["penc"]],
    ["4-064", "5-023", "normal", 7, ["penz"]],
    ["4-064", "5-037", "jogress", 0, ["penz"]],
    ["4-064", "5-050", "jogress", 0, ["penz"]],
    ["4-064", "5-106", "jogress", 0, ["penz"]],
    ["4-064", "5-109", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-065", "5-038", "jogress", 0, ["penz"]],
    ["4-065", "5-065", "jogress", 0, ["penz"]],
    ["4-065", "5-066", "normal", 7, ["penz"]],
    ["4-065", "5-113", "jogress", 0, ["penz"]],
    ["4-065", "5-137", "normal", 15, ["vbdm"]],
    ["4-066", "5-017", "normal", 15, ["vbbe"]],
    ["4-066", "5-101", "normal", 15, ["pen", "pen20", "penc", "vbbe"]],
    ["4-066", "5-109", "normal", 15, ["dm", "dm20", "dmc", "pen", "pen20", "penc"]],
    ["4-066", "5-121", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-066", "5-129", "normal", 15, ["dm"]],
    ["4-067", "5-072", "normal", 15, ["dmx2"]],
    ["4-067", "5-074", "normal", 8, ["dmx2"]],
    ["4-067", "5-102", "normal", 7, ["dmx2"]],
    ["4-068", "5-041", "normal", 15, ["vbdm"]],
    ["4-068", "5-061", "normal", 7, ["pen20", "vbdm"]],
    ["4-068", "5-127", "jogress", 0, ["vbdm"]],
    ["4-069", "5-022", "normal", 15, ["dm20", "vbbe"]],
    ["4-069", "5-068", "normal", 15, ["vbbe"]],
    ["4-070", "5-009", "special", 0, ["vbbe"]],
    ["4-070", "5-010", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-070", "5-041", "normal", 15, ["vbbe"]],
    ["4-070", "5-080", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-070", "5-086", "normal", 3, ["pen", "pen20"]],
    ["4-070", "5-087", "jogress", 0, ["penc"]],
    ["4-070", "5-091", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-071", "5-019", "special", 0, ["dmx"]],
    ["4-071", "5-023", "normal", 8, ["dmx"]],
    ["4-071", "5-090", "special", 0, ["dmx"]],
    ["4-071", "5-094", "special", 0, ["dmx"]],
    ["4-072", "4-037", "special", 0, ["penz"]],
    ["4-072", "4-038", "special", 0, ["penz"]],
    ["4-072", "4-050", "special", 0, ["penz"]],
    ["4-072", "4-095", "special", 0, ["penz"]],
    ["4-072", "4-098", "special", 0, ["penz"]],
    ["4-072", "4-113", "special", 0, ["penz"]],
    ["4-072", "5-012", "normal", 15, ["vbdm"]],
    ["4-072", "5-056", "normal", 7, ["penz", "vbdm"]],
    ["4-072", "5-124", "jogress", 0, ["vbdm"]],
    ["4-073", "5-025", "jogress", 0, ["penz"]],
    ["4-073", "5-065", "normal", 15, ["vbdm"]],
    ["4-073", "5-066", "jogress", 0, ["penz", "vbdm"]],
    ["4-073", "5-091", "normal", 15, ["vbdm"]],
    ["4-073", "5-113", "normal", 7, ["penz", "vbdm"]],
    ["4-074", "5-009", "jogress", 0, ["pen20", "vbbe"]],
    ["4-074", "5-011", "normal", 7, ["pen20"]],
    ["4-074", "5-053", "jogress", 0, ["vbdm"]],
    ["4-074", "5-065", "normal", 15, ["vbdm"]],
    ["4-074", "5-067", "special", 0, ["vbdm"]],
    ["4-074", "5-114", "jogress", 0, ["vbdm"]],
    ["4-074", "5-134", "jogress", 0, ["vbdm"]],
    ["4-075", "5-032", "normal", 15, ["vbdm"]],
    ["4-075", "5-115", "normal", 7, ["pen20"]],
    ["4-076", "5-060", "special", 0, ["dmx2"]],
    ["4-076", "5-072", "normal", 15, ["dmx2"]],
    ["4-076", "5-102", "normal", 8, ["dmx2"]],
    ["4-077", "5-078", "normal", 15, ["dm20"]],
    ["4-077", "5-079", "normal", 7, ["pen20"]],
    ["4-078", "5-013", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-078", "5-080", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-078", "5-137", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-079", "5-002", "jogress", 0, ["vbdm"]],
    ["4-079", "5-016", "normal", 15, ["vbdm"]],
    ["4-079", "5-041", "normal", 15, ["vbdm"]],
    ["4-079", "5-048", "normal", 15, ["vbdm"]],
    ["4-079", "5-061", "jogress", 0, ["vbdm"]],
    ["4-079", "5-070", "normal", 15, ["dm", "dm20", "dmc", "vbbe"]],
    ["4-079", "5-107", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-079", "5-110", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-079", "5-127", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["4-079", "5-139", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-079", "5-145", "normal", 15, ["vbdm"]],
    ["4-079", "5-149", "jogress", 0, ["vbdm"]],
    ["4-080", "5-026", "special", 0, ["dmx3"]],
    ["4-080", "5-044", "special", 0, ["dmx3"]],
    ["4-080", "5-047", "normal", 7, ["dmx3"]],
    ["4-080", "5-071", "special", 0, ["dmx3"]],
    ["4-080", "5-103", "special", 0, ["dmx3"]],
    ["4-081", "5-036", "normal", 3, ["penz"]],
    ["4-081", "5-075", "jogress", 0, ["penz"]],
    ["4-081", "5-122", "jogress", 0, ["penz"]],
    ["4-082", "5-065", "normal", 3, ["penz"]],
    ["4-082", "5-066", "jogress", 0, ["penz"]],
    ["4-082", "5-113", "jogress", 0, ["penz"]],
    ["4-083", "5-009", "jogress", 0, ["vbdm"]],
    ["4-083", "5-018", "normal", 3, ["penz"]],
    ["4-083", "5-028", "normal", 15, ["vbdm"]],
    ["4-083", "5-040", "jogress", 0, ["penz"]],
    ["4-083", "5-057", "jogress", 0, ["penz"]],
    ["4-083", "5-109", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-084", "5-004", "jogress", 0, ["pen20"]],
    ["4-084", "5-040", "normal", 15, ["vbdm"]],
    ["4-084", "5-052", "jogress", 0, ["penc"]],
    ["4-084", "5-072", "normal", 15, ["vbdm"]],
    ["4-084", "5-080", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-084", "5-081", "normal", 15, ["dm"]],
    ["4-084", "5-087", "jogress", 0, ["vbdm"]],
    ["4-084", "5-088", "normal", 15, ["vbdm"]],
    ["4-084", "5-109", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-084", "5-121", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-084", "5-126", "normal", 15, ["vbdm"]],
    ["4-084", "5-131", "normal", 7, ["pen", "pen20", "penc"]],
    ["4-085", "5-030", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-086", "5-072", "normal", 15, ["dmx2"]],
    ["4-086", "5-083", "normal", 8, ["dmx2"]],
    ["4-086", "5-084", "special", 0, ["dmx2"]],
    ["4-087", "5-004", "jogress", 0, ["pen", "penc"]],
    ["4-087", "5-010", "jogress", 0, ["pen", "pen20"]],
    ["4-087", "5-087", "jogress", 0, ["penc"]],
    ["4-087", "5-091", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-087", "5-139", "normal", 7, ["pen", "pen20", "penc"]],
    ["4-088", "5-039", "normal", 15, ["vbbe"]],
    ["4-088", "5-051", "normal", 15, ["vbbe"]],
    ["4-088", "5-095", "normal", 15, ["dm", "dm20", "dmc", "vbbe"]],
    ["4-089", "5-053", "special", 0, ["dmx2"]],
    ["4-089", "5-060", "special", 0, ["dmx2"]],
    ["4-089", "5-083", "normal", 12, ["dmx2"]],
    ["4-089", "5-084", "special", 0, ["dmx2"]],
    ["4-089", "5-089", "special", 0, ["dmx2"]],
    ["4-089", "5-092", "special", 0, ["dmx2"]],
    ["4-089", "5-099", "special", 0, ["dmx2"]],
    ["4-089", "5-102", "normal", 12, ["dmx2"]],
    ["4-089", "5-128", "special", 0, ["dmx2"]],
    ["4-089", "5-132", "special", 0, ["dmx2"]],
    ["4-090", "5-032", "jogress", 0, ["penc"]],
    ["4-090", "5-035", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["4-090", "5-049", "jogress", 0, ["vbdm"]],
    ["4-090", "5-076", "normal", 15, ["vbdm"]],
    ["4-090", "5-077", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-090", "5-082", "normal", 15, ["vbdm"]],
    ["4-090", "5-085", "jogress", 0, ["vbdm"]],
    ["4-090", "5-108", "jogress", 0, ["vbdm"]],
    ["4-090", "5-118", "jogress", 0, ["pen20"]],
    ["4-091", "5-003", "normal", 15, ["dm", "dm20", "dmc", "vbdm"]],
    ["4-091", "5-033", "unverified", 0, ["vbdm"]],
    ["4-091", "5-057", "normal", 15, ["dmc"]],
    ["4-091", "5-070", "normal", 15, ["vbdm"]],
    ["4-091", "5-087", "jogress", 0, ["vbdm"]],
    ["4-091", "5-100", "normal", 15, ["vbdm"]],
    ["4-091", "5-118", "jogress", 0, ["vbdm"]],
    ["4-092", "5-072", "normal", 8, ["dmx2"]],
    ["4-092", "5-074", "normal", 7, ["dmx2"]],
    ["4-092", "5-092", "special", 0, ["dmx2"]],
    ["4-092", "5-099", "special", 0, ["dmx2"]],
    ["4-093", "5-024", "special", 0, ["dmx3"]],
    ["4-093", "5-026", "special", 0, ["dmx3"]],
    ["4-093", "5-034", "special", 0, ["dmx3"]],
    ["4-093", "5-047", "special", 0, ["dmx3"]],
    ["4-093", "5-051", "special", 0, ["dmx3"]],
    ["4-093", "5-054", "special", 0, ["dmx3"]],
    ["4-093", "5-071", "special", 0, ["dmx3"]],
    ["4-093", "5-096", "special", 0, ["dmx3"]],
    ["4-093", "5-103", "special", 0, ["dmx3"]],
    ["4-093", "5-110", "special", 0, ["dmx3"]],
    ["4-093", "5-116", "special", 0, ["dmx3"]],
    ["4-093", "5-146", "special", 0, ["dmx3"]],
    ["4-094", "5-022", "jogress", 0, ["vbdm"]],
    ["4-094", "5-024", "normal", 7, ["dmx3", "vbdm"]],
    ["4-094", "5-026", "special", 0, ["dmx3"]],
    ["4-094", "5-034", "special", 0, ["dmx3"]],
    ["4-094", "5-051", "special", 0, ["dmx3"]],
    ["4-094", "5-073", "jogress", 0, ["vbdm"]],
    ["4-094", "5-110", "normal", 15, ["dmx3"]],
    ["4-094", "5-116", "special", 0, ["dmx3"]],
    ["4-094", "5-146", "special", 0, ["dmx3"]],
    ["4-095", "5-014", "jogress", 0, ["vbdm"]],
    ["4-095", "5-037", "jogress", 0, ["penz"]],
    ["4-095", "5-050", "jogress", 0, ["penz"]],
    ["4-095", "5-055", "jogress", 0, ["vbdm"]],
    ["4-095", "5-063", "normal", 15, ["vbdm"]],
    ["4-095", "5-130", "normal", 3, ["penz", "vbdm"]],
    ["4-096", "5-023", "normal", 7, ["penc", "penz", "vbbe"]],
    ["4-096", "5-050", "jogress", 0, ["penz"]],
    ["4-096", "5-054", "special", 0, ["vbbe"]],
    ["4-096", "5-106", "jogress", 0, ["penz"]],
    ["4-097", "5-005", "special", 0, ["dmx3"]],
    ["4-097", "5-047", "special", 0, ["dmx3"]],
    ["4-097", "5-051", "normal", 7, ["dmx3"]],
    ["4-097", "5-096", "special", 0, ["dmx3"]],
    ["4-098", "5-037", "jogress", 0, ["penz"]],
    ["4-098", "5-050", "jogress", 0, ["penz"]],
    ["4-098", "5-062", "normal", 7, ["penz"]],
    ["4-098", "5-106", "jogress", 0, ["penz"]],
    ["4-099", "5-009", "normal", 7, ["pen20"]],
    ["4-099", "5-011", "jogress", 0, ["pen20"]],
    ["4-099", "5-027", "jogress", 0, ["pen20"]],
    ["4-099", "5-125", "normal", 15, ["vbdm"]],
    ["4-100", "5-017", "normal", 3, ["dmx3"]],
    ["4-100", "5-044", "special", 0, ["dmx3"]],
    ["4-100", "5-071", "normal", 12, ["dmx3"]],
    ["4-101", "5-038", "jogress", 0, ["penz"]],
    ["4-101", "5-040", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-101", "5-065", "normal", 15, ["vbdm"]],
    ["4-101", "5-066", "jogress", 0, ["vbdm"]],
    ["4-101", "5-091", "normal", 15, ["vbdm"]],
    ["4-101", "5-093", "normal", 3, ["penz"]],
    ["4-101", "5-113", "normal", 15, ["penz", "vbdm"]],
    ["4-102", "5-020", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-102", "5-029", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-102", "5-042", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-103", "5-012", "normal", 7, ["pen20"]],
    ["4-103", "5-030", "jogress", 0, ["vbdm"]],
    ["4-103", "5-045", "normal", 15, ["vbbe"]],
    ["4-103", "5-075", "normal", 15, ["vbdm"]],
    ["4-103", "5-109", "jogress", 0, ["vbdm"]],
    ["4-103", "5-111", "normal", 15, ["vbdm"]],
    ["4-103", "5-115", "jogress", 0, ["pen20"]],
    ["4-103", "5-135", "jogress", 0, ["pen20"]],
    ["4-104", "5-023", "normal", 8, ["dmx"]],
    ["4-104", "5-136", "special", 0, ["dmx"]],
    ["4-104", "5-140", "special", 0, ["dmx"]],
    ["4-105", "5-008", "normal", 3, ["penz"]],
    ["4-105", "5-031", "normal", 15, ["vbdm"]],
    ["4-105", "5-055", "jogress", 0, ["vbdm"]],
    ["4-105", "5-104", "jogress", 0, ["penz"]],
    ["4-105", "5-105", "jogress", 0, ["vbdm"]],
    ["4-106", "5-019", "special", 0, ["dmx"]],
    ["4-106", "5-067", "normal", 3, ["dmx"]],
    ["4-106", "5-125", "normal", 12, ["dmx"]],
    ["4-107", "5-032", "jogress", 0, ["pen20", "penc"]],
    ["4-107", "5-035", "jogress", 0, ["pen", "pen20", "penc", "vbdm"]],
    ["4-107", "5-049", "jogress", 0, ["vbdm"]],
    ["4-107", "5-070", "normal", 15, ["dm", "dm20", "dmc", "vbbe"]],
    ["4-107", "5-076", "normal", 15, ["vbdm"]],
    ["4-107", "5-082", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["4-107", "5-085", "jogress", 0, ["vbdm"]],
    ["4-107", "5-108", "normal", 15, ["vbdm"]],
    ["4-107", "5-141", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-108", "5-072", "normal", 15, ["dmx2"]],
    ["4-108", "5-074", "normal", 8, ["dmx2"]],
    ["4-108", "5-083", "normal", 7, ["dmx2"]],
    ["4-109", "5-034", "normal", 7, ["dmx3"]],
    ["4-109", "5-044", "special", 0, ["dmx3"]],
    ["4-109", "5-047", "normal", 8, ["dmx3"]],
    ["4-109", "5-103", "special", 0, ["dmx3"]],
    ["4-109", "5-146", "normal", 7, ["dmx3"]],
    ["4-110", "5-009", "jogress", 0, ["pen20"]],
    ["4-110", "5-027", "normal", 3, ["pen20"]],
    ["4-110", "5-031", "normal", 15, ["vbdm"]],
    ["4-110", "5-055", "jogress", 0, ["vbdm"]],
    ["4-110", "5-105", "jogress", 0, ["vbdm"]],
    ["4-111", "5-003", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-111", "5-023", "jogress", 0, ["penc"]],
    ["4-111", "5-035", "normal", 15, ["vbdm"]],
    ["4-111", "5-049", "normal", 15, ["penz", "vbdm"]],
    ["4-111", "5-057", "normal", 15, ["dmc"]],
    ["4-111", "5-076", "jogress", 0, ["vbdm"]],
    ["4-111", "5-085", "normal", 15, ["penz", "vbdm"]],
    ["4-111", "5-108", "jogress", 0, ["penz", "vbdm"]],
    ["4-111", "5-138", "normal", 7, ["penz"]],
    ["4-112", "5-085", "jogress", 0, ["penz"]],
    ["4-112", "5-108", "jogress", 0, ["penz"]],
    ["4-112", "5-124", "normal", 3, ["penz"]],
    ["4-112", "5-129", "normal", 15, ["dm"]],
    ["4-113", "5-115", "jogress", 0, ["penz"]],
    ["4-113", "5-122", "normal", 7, ["penz"]],
    ["4-113", "5-135", "jogress", 0, ["penz"]],
    ["4-114", "5-021", "normal", 3, ["dmx"]],
    ["4-114", "5-064", "normal", 12, ["dmx"]],
    ["4-114", "5-140", "special", 0, ["dmx"]],
    ["4-115", "5-002", "jogress", 0, ["vbdm"]],
    ["4-115", "5-004", "jogress", 0, ["pen20", "penc"]],
    ["4-115", "5-016", "jogress", 0, ["vbdm"]],
    ["4-115", "5-109", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-115", "5-121", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-115", "5-129", "normal", 15, ["dm"]],
    ["4-115", "5-131", "normal", 7, ["pen", "pen20", "penc"]],
    ["4-115", "5-145", "normal", 15, ["vbdm"]],
    ["4-115", "5-149", "normal", 15, ["vbdm"]],
    ["4-116", "5-004", "normal", 15, ["vbbe"]],
    ["4-116", "5-031", "normal", 15, ["penz", "vbbe", "vbdm"]],
    ["4-116", "5-033", "unverified", 0, ["penz"]],
    ["4-116", "5-040", "jogress", 0, ["penz"]],
    ["4-116", "5-055", "normal", 15, ["vbdm"]],
    ["4-116", "5-057", "jogress", 0, ["penz"]],
    ["4-116", "5-097", "jogress", 0, ["penz"]],
    ["4-116", "5-100", "normal", 7, ["penz"]],
    ["4-116", "5-105", "normal", 15, ["pen20", "penz", "vbdm"]],
    ["4-117", "5-025", "normal", 7, ["penz", "vbdm"]],
    ["4-117", "5-065", "jogress", 0, ["penz"]],
    ["4-117", "5-066", "jogress", 0, ["penz"]],
    ["4-118", "5-049", "jogress", 0, ["penz"]],
    ["4-118", "5-085", "jogress", 0, ["penz"]],
    ["4-118", "5-105", "normal", 15, ["vbbe"]],
    ["4-118", "5-108", "jogress", 0, ["penz"]],
    ["4-118", "5-138", "normal", 7, ["penz"]],
    ["4-119", "5-039", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-119", "5-057", "normal", 15, ["dmc"]],
    ["4-120", "5-014", "jogress", 0, ["vbdm"]],
    ["4-120", "5-017", "normal", 15, ["vbbe"]],
    ["4-120", "5-038", "special", 0, ["vbbe"]],
    ["4-120", "5-055", "normal", 15, ["vbdm"]],
    ["4-120", "5-062", "normal", 7, ["pen20", "vbbe"]],
    ["4-120", "5-063", "normal", 15, ["vbdm"]],
    ["4-120", "5-130", "normal", 15, ["vbdm"]],
    ["4-121", "5-003", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-121", "5-013", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-121", "5-058", "normal", 15, ["pen", "pen20"]],
    ["4-121", "5-080", "jogress", 0, ["penc"]],
    ["4-121", "5-087", "normal", 15, ["penc"]],
    ["4-121", "5-137", "jogress", 0, ["pen", "pen20"]],
    ["4-122", "5-036", "jogress", 0, ["pen20"]],
    ["4-122", "5-039", "normal", 3, ["pen20"]],
    ["4-122", "5-117", "jogress", 0, ["pen20"]],
    ["4-123", "5-013", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-123", "5-025", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-123", "5-045", "normal", 15, ["vbbe"]],
    ["4-123", "5-058", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-123", "5-137", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-123", "5-144", "normal", 15, ["vbbe"]],
    ["4-124", "5-030", "jogress", 0, ["vbdm"]],
    ["4-124", "5-075", "normal", 15, ["vbdm"]],
    ["4-124", "5-109", "jogress", 0, ["vbdm"]],
    ["4-124", "5-111", "normal", 7, ["pen20", "vbdm"]],
    ["4-125", "5-035", "jogress", 0, ["vbdm"]],
    ["4-125", "5-049", "normal", 15, ["penz", "vbdm"]],
    ["4-125", "5-076", "normal", 7, ["penz", "vbbe", "vbdm"]],
    ["4-125", "5-082", "jogress", 0, ["vbdm"]],
    ["4-125", "5-085", "normal", 15, ["penz", "vbdm"]],
    ["4-125", "5-108", "normal", 15, ["vbdm"]],
    ["4-125", "5-119", "normal", 15, ["vbbe"]],
    ["4-125", "5-138", "normal", 15, ["vbbe"]],
    ["4-126", "5-021", "normal", 1, ["dmx"]],
    ["4-126", "5-023", "normal", 14, ["dmx"]],
    ["4-126", "5-090", "special", 0, ["dmx"]],
    ["4-126", "5-125", "normal", 1, ["dmx"]],
    ["4-126", "5-140", "special", 0, ["dmx"]],
    ["4-127", "5-001", "jogress", 0, ["penc"]],
    ["4-127", "5-014", "jogress", 0, ["penc"]],
    ["4-127", "5-020", "jogress", 0, ["penc"]],
    ["4-127", "5-029", "jogress", 0, ["pen", "pen20"]],
    ["4-127", "5-042", "jogress", 0, ["pen", "pen20"]],
    ["4-127", "5-043", "jogress", 0, ["pen", "pen20"]],
    ["4-127", "5-046", "jogress", 0, ["vbdm"]],
    ["4-127", "5-052", "normal", 15, ["vbdm"]],
    ["4-127", "5-063", "normal", 7, ["pen20", "penc"]],
    ["4-127", "5-097", "jogress", 0, ["vbdm"]],
    ["4-127", "5-131", "normal", 15, ["vbdm"]],
    ["4-127", "5-148", "jogress", 0, ["vbdm"]],
    ["4-128", "5-017", "normal", 3, ["dmx3"]],
    ["4-128", "5-026", "special", 0, ["dmx3"]],
    ["4-128", "5-034", "normal", 3, ["dmx3"]],
    ["4-128", "5-071", "special", 0, ["dmx3"]],
    ["4-128", "5-146", "normal", 3, ["dmx3"]],
    ["4-129", "5-046", "normal", 15, ["vbdm"]],
    ["4-129", "5-052", "jogress", 0, ["pen", "pen20", "penc", "vbdm"]],
    ["4-129", "5-081", "normal", 1, ["dm", "pen", "pen20", "penc"]],
    ["4-129", "5-097", "normal", 15, ["vbdm"]],
    ["4-129", "5-109", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-129", "5-131", "jogress", 0, ["vbdm"]],
    ["4-129", "5-148", "normal", 15, ["vbdm"]],
    ["4-130", "5-027", "normal", 7, ["pen20"]],
    ["4-131", "5-006", "normal", 7, ["pen20", "vbdm"]],
    ["4-131", "5-021", "jogress", 0, ["penc"]],
    ["4-131", "5-112", "normal", 15, ["vbdm"]],
    ["4-132", "5-028", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-134", "5-071", "normal", 3, ["dmx3"]],
    ["4-134", "5-116", "special", 0, ["dmx3"]],
    ["4-135", "5-048", "normal", 15, ["vbdm"]],
    ["4-135", "5-061", "jogress", 0, ["vbdm"]],
    ["4-135", "5-070", "normal", 15, ["dm", "dm20", "dmc", "vbbe"]],
    ["4-135", "5-127", "normal", 15, ["vbdm"]],
    ["4-136", "5-023", "normal", 8, ["dmx"]],
    ["4-136", "5-090", "special", 0, ["dmx"]],
    ["4-136", "5-094", "special", 0, ["dmx"]],
    ["4-137", "5-003", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-137", "5-008", "jogress", 0, ["penz"]],
    ["4-137", "5-046", "jogress", 0, ["penz"]],
    ["4-137", "5-057", "normal", 15, ["dmc"]],
    ["4-137", "5-068", "normal", 7, ["penz"]],
    ["4-138", "5-001", "normal", 7, ["pen", "pen20", "penc", "vbdm"]],
    ["4-138", "5-029", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-138", "5-030", "jogress", 0, ["vbdm"]],
    ["4-138", "5-031", "jogress", 0, ["vbdm"]],
    ["4-138", "5-043", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-139", "5-014", "normal", 15, ["vbdm"]],
    ["4-139", "5-037", "jogress", 0, ["penz"]],
    ["4-139", "5-055", "jogress", 0, ["vbdm"]],
    ["4-139", "5-062", "jogress", 0, ["penz"]],
    ["4-139", "5-063", "jogress", 0, ["vbdm"]],
    ["4-139", "5-130", "normal", 3, ["penz", "vbdm"]],
    ["4-139", "5-133", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-140", "5-053", "normal", 7, ["dmx2"]],
    ["4-140", "5-060", "normal", 7, ["dmx2"]],
    ["4-140", "5-072", "normal", 8, ["dmx2"]],
    ["4-140", "5-084", "normal", 7, ["dmx2"]],
    ["4-140", "5-092", "normal", 8, ["dmx2"]],
    ["4-140", "5-102", "normal", 8, ["dmx2"]],
    ["4-140", "5-128", "special", 0, ["dmx2"]],
    ["4-141", "5-091", "normal", 15, ["dm", "dm20", "dmc"]],
    ["4-142", "5-033", "unverified", 0, ["penz"]],
    ["4-142", "5-040", "jogress", 0, ["penz"]],
    ["4-142", "5-057", "jogress", 0, ["penz"]],
    ["4-142", "5-097", "jogress", 0, ["penz"]],
    ["4-142", "5-100", "normal", 7, ["penz"]],
    ["4-143", "5-011", "normal", 15, ["vbdm"]],
    ["4-143", "5-073", "jogress", 0, ["penc"]],
    ["4-143", "5-098", "jogress", 0, ["vbdm"]],
    ["4-143", "5-107", "jogress", 0, ["pen", "pen20", "penc", "vbdm"]],
    ["4-143", "5-110", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["4-143", "5-127", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-143", "5-139", "jogress", 0, ["pen", "pen20"]],
    ["4-144", "5-071", "special", 0, ["dmx3"]],
    ["4-144", "5-096", "special", 0, ["dmx3"]],
    ["4-144", "5-116", "special", 0, ["dmx3"]],
    ["4-144", "5-119", "normal", 7, ["dmx3"]],
    ["4-145", "5-020", "normal", 15, ["pen", "pen20", "penc"]],
    ["4-145", "5-029", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-145", "5-042", "jogress", 0, ["pen", "pen20", "penc"]],
    ["4-146", "5-010", "normal", 15, ["vbdm"]],
    ["4-146", "5-036", "normal", 7, ["dm20", "pen20", "vbdm"]],
    ["4-146", "5-039", "jogress", 0, ["pen20"]],
    ["4-146", "5-051", "jogress", 0, ["vbdm"]],
    ["4-146", "5-117", "jogress", 0, ["pen20"]],
    ["4-147", "5-144", "normal", 15, ["vbbe", "vbdm"]],
    ["4-149", "5-024", "normal", 15, ["vbdm"]],
    ["4-149", "5-073", "jogress", 0, ["vbdm"]],
    ["4-150", "5-043", "normal", 15, ["vbbe"]],
    ["4-152", "5-011", "jogress", 0, ["vbdm"]],
    ["4-152", "5-098", "normal", 15, ["vbdm"]],
    ["4-152", "5-107", "normal", 15, ["vbdm"]],
    ["4-152", "5-110", "jogress", 0, ["vbdm"]],
    ["5-001", "6-084", "jogress", 0, ["vbdm"]],
    ["5-001", "6-105", "normal", 7, ["pen", "pen20", "penc"]],
    ["5-001", "6-114", "jogress", 0, ["penc"]],
    ["5-001", "6-137", "normal", 7, ["pen20", "penc", "vbdm"]],
    ["5-001", "7-019", "jogress", 0, ["vbdm"]],
    ["5-002", "6-005", "normal", 15, ["vbdm"]],
    ["5-002", "6-011", "jogress", 0, ["vbdm"]],
    ["5-002", "6-048", "normal", 7, ["penz", "vbdm"]],
    ["5-002", "6-143", "jogress", 0, ["penz"]],
    ["5-003", "5-033", "special", 0, ["vbdm"]],
    ["5-003", "6-028", "jogress", 0, ["vbdm"]],
    ["5-003", "6-068", "normal", 7, ["dm20", "dmc", "penc", "vbbe"]],
    ["5-003", "6-080", "jogress", 0, ["pen20"]],
    ["5-003", "6-091", "jogress", 0, ["penc"]],
    ["5-003", "6-125", "normal", 15, ["vbbe"]],
    ["5-003", "6-143", "normal", 15, ["vbdm"]],
    ["5-004", "6-020", "jogress", 0, ["penz"]],
    ["5-004", "6-066", "jogress", 0, ["penc"]],
    ["5-004", "6-081", "normal", 1, ["pen20", "penc", "penz", "vbbe"]],
    ["5-004", "6-090", "jogress", 0, ["penc"]],
    ["5-004", "6-100", "normal", 3, ["pen20", "penz"]],
    ["5-004", "6-139", "normal", 15, ["vbbe"]],
    ["5-004", "7-020", "normal", 15, ["vbbe"]],
    ["5-004", "7-029", "jogress", 0, ["pen20", "penc"]],
    ["5-004", "7-032", "jogress", 0, ["pen"]],
    ["5-005", "6-043", "normal", 7, ["dmx3"]],
    ["5-005", "6-046", "normal", 8, ["dmx3"]],
    ["5-005", "6-082", "normal", 7, ["dmx3"]],
    ["5-005", "6-101", "special", 0, ["dmx3"]],
    ["5-006", "6-033", "normal", 15, ["vbdm"]],
    ["5-006", "6-087", "jogress", 0, ["vbdm"]],
    ["5-007", "5-033", "jogress", 0, ["penz"]],
    ["5-007", "6-016", "normal", 7, ["penz"]],
    ["5-007", "6-055", "jogress", 0, ["penz"]],
    ["5-008", "6-003", "normal", 3, ["penz"]],
    ["5-008", "6-020", "jogress", 0, ["penz"]],
    ["5-008", "6-098", "jogress", 0, ["penz"]],
    ["5-009", "6-007", "jogress", 0, ["vbdm"]],
    ["5-009", "6-026", "normal", 7, ["pen20", "vbbe"]],
    ["5-009", "6-045", "special", 0, ["vbdm"]],
    ["5-009", "6-065", "normal", 15, ["vbbe"]],
    ["5-010", "6-044", "normal", 15, ["vbdm"]],
    ["5-010", "6-091", "jogress", 0, ["penc"]],
    ["5-010", "6-104", "jogress", 0, ["vbdm"]],
    ["5-010", "6-143", "normal", 3, ["pen", "pen20", "penc"]],
    ["5-011", "6-025", "normal", 7, ["pen20", "vbdm"]],
    ["5-011", "6-099", "normal", 15, ["vbdm"]],
    ["5-011", "6-107", "jogress", 0, ["vbdm"]],
    ["5-011", "7-005", "normal", 15, ["vbdm"]],
    ["5-012", "6-004", "normal", 15, ["vbdm"]],
    ["5-012", "6-008", "jogress", 0, ["vbdm"]],
    ["5-012", "6-074", "normal", 7, ["pen20"]],
    ["5-012", "6-083", "normal", 7, ["penz", "vbdm"]],
    ["5-012", "6-091", "jogress", 0, ["penz"]],
    ["5-013", "6-038", "normal", 15, ["vbdm"]],
    ["5-013", "6-068", "jogress", 0, ["penc"]],
    ["5-013", "6-091", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["5-013", "6-098", "special", 0, ["vbdm"]],
    ["5-013", "6-141", "jogress", 0, ["penc"]],
    ["5-014", "6-063", "jogress", 0, ["pen", "pen20", "penc"]],
    ["5-014", "6-114", "normal", 15, ["penc", "vbdm"]],
    ["5-014", "6-137", "jogress", 0, ["penc"]],
    ["5-015", "6-038", "normal", 15, ["vbdm"]],
    ["5-015", "6-091", "normal", 15, ["vbdm"]],
    ["5-015", "6-098", "jogress", 0, ["vbdm"]],
    ["5-016", "5-002", "jogress", 0, ["penz"]],
    ["5-016", "5-086", "jogress", 0, ["penz"]],
    ["5-016", "6-005", "normal", 15, ["vbdm"]],
    ["5-016", "6-011", "jogress", 0, ["vbdm"]],
    ["5-016", "6-048", "normal", 15, ["vbdm"]],
    ["5-017", "6-043", "normal", 7, ["dmx3"]],
    ["5-017", "6-046", "normal", 8, ["dmx3"]],
    ["5-017", "6-061", "normal", 15, ["vbbe"]],
    ["5-017", "6-066", "normal", 15, ["vbbe"]],
    ["5-017", "6-082", "special", 0, ["dmx3"]],
    ["5-017", "6-116", "special", 0, ["dmx3"]],
    ["5-017", "6-135", "normal", 7, ["dmx3", "vbbe"]],
    ["5-018", "6-009", "jogress", 0, ["penz"]],
    ["5-018", "6-013", "normal", 7, ["penz"]],
    ["5-018", "6-055", "jogress", 0, ["penz"]],
    ["5-018", "6-060", "normal", 15, ["vbbe"]],
    ["5-019", "6-085", "normal", 3, ["dmx"]],
    ["5-019", "6-108", "normal", 12, ["dmx"]],
    ["5-019", "6-127", "special", 0, ["dmx"]],
    ["5-019", "7-021", "special", 0, ["dmx"]],
    ["5-019", "7-022", "special", 0, ["dmx"]],
    ["5-020", "6-113", "normal", 15, ["pen", "pen20", "penc"]],
    ["5-020", "6-123", "jogress", 0, ["penc"]],
    ["5-021", "6-024", "special", 0, ["dmx"]],
    ["5-021", "6-085", "normal", 3, ["dmx"]],
    ["5-021", "6-092", "special", 0, ["dmx"]],
    ["5-021", "6-108", "normal", 12, ["dmx"]],
    ["5-021", "7-009", "special", 0, ["dmx"]],
    ["5-022", "6-007", "jogress", 0, ["vbdm"]],
    ["5-022", "6-026", "special", 0, ["vbbe"]],
    ["5-022", "6-041", "normal", 7, ["dm20", "vbbe"]],
    ["5-022", "6-067", "normal", 15, ["vbdm"]],
    ["5-022", "6-096", "normal", 15, ["vbbe"]],
    ["5-022", "6-130", "jogress", 0, ["vbdm"]],
    ["5-023", "6-006", "jogress", 0, ["penz"]],
    ["5-023", "6-010", "jogress", 0, ["penz"]],
    ["5-023", "6-024", "special", 0, ["dmx"]],
    ["5-023", "6-085", "normal", 3, ["dmx"]],
    ["5-023", "6-093", "special", 0, ["vbbe"]],
    ["5-023", "6-108", "normal", 12, ["dmx"]],
    ["5-023", "6-120", "normal", 7, ["penc", "penz", "vbbe"]],
    ["5-023", "6-127", "special", 0, ["dmx"]],
    ["5-023", "6-140", "normal", 3, ["dmx"]],
    ["5-024", "6-002", "special", 0, ["dmx3"]],
    ["5-024", "6-007", "special", 0, ["vbdm"]],
    ["5-024", "6-058", "normal", 7, ["dmx3"]],
    ["5-024", "6-067", "normal", 7, ["dmx3", "vbdm"]],
    ["5-024", "6-070", "normal", 7, ["dmx3"]],
    ["5-024", "6-082", "normal", 11, ["dmx3"]],
    ["5-024", "6-104", "special", 0, ["dmx3"]],
    ["5-024", "6-130", "jogress", 0, ["vbdm"]],
    ["5-025", "6-049", "jogress", 0, ["penz"]],
    ["5-025", "6-065", "jogress", 0, ["penz"]],
    ["5-025", "6-068", "jogress", 0, ["penc"]],
    ["5-025", "6-071", "normal", 15, ["vbdm"]],
    ["5-025", "6-141", "jogress", 0, ["penc"]],
    ["5-025", "6-143", "jogress", 0, ["pen20"]],
    ["5-026", "6-046", "normal", 8, ["dmx3"]],
    ["5-026", "6-051", "normal", 8, ["dmx3"]],
    ["5-026", "6-070", "special", 0, ["dmx3"]],
    ["5-026", "6-082", "normal", 7, ["dmx3"]],
    ["5-026", "6-106", "special", 0, ["dmx3"]],
    ["5-026", "6-135", "special", 0, ["dmx3"]],
    ["5-027", "6-025", "normal", 14, ["pen20"]],
    ["5-027", "6-026", "normal", 1, ["pen20"]],
    ["5-028", "6-045", "special", 0, ["vbdm"]],
    ["5-029", "6-063", "normal", 15, ["pen20", "penc"]],
    ["5-029", "6-105", "normal", 3, ["pen", "pen20", "penc"]],
    ["5-029", "6-113", "jogress", 0, ["penc"]],
    ["5-029", "6-123", "jogress", 0, ["penc"]],
    ["5-030", "6-031", "jogress", 0, ["vbdm"]],
    ["5-030", "6-054", "normal", 3, ["dmc"]],
    ["5-030", "6-084", "normal", 15, ["vbdm"]],
    ["5-030", "6-107", "special", 0, ["vbbe"]],
    ["5-030", "6-136", "normal", 7, ["dm20"]],
    ["5-030", "6-137", "normal", 15, ["vbdm"]],
    ["5-030", "7-019", "jogress", 0, ["vbdm"]],
    ["5-031", "6-013", "jogress", 0, ["penz"]],
    ["5-031", "6-055", "jogress", 0, ["penz"]],
    ["5-031", "6-061", "normal", 7, ["penz", "vbdm"]],
    ["5-031", "6-062", "jogress", 0, ["penz"]],
    ["5-031", "6-064", "jogress", 0, ["penz"]],
    ["5-031", "6-065", "jogress", 0, ["penz"]],
    ["5-031", "6-081", "normal", 15, ["vbbe"]],
    ["5-031", "6-084", "jogress", 0, ["vbdm"]],
    ["5-031", "6-088", "jogress", 0, ["penz"]],
    ["5-031", "6-137", "jogress", 0, ["vbdm"]],
    ["5-031", "7-019", "normal", 15, ["vbbe", "vbdm"]],
    ["5-031", "7-020", "normal", 15, ["vbbe", "vbdm"]],
    ["5-032", "6-008", "normal", 15, ["vbdm"]],
    ["5-032", "6-086", "jogress", 0, ["penc"]],
    ["5-032", "6-109", "normal", 15, ["pen", "pen20", "penc"]],
    ["5-032", "6-112", "normal", 15, ["vbdm"]],
    ["5-033", "6-028", "unverified", 0, ["vbdm"]],
    ["5-033", "6-055", "unverified", 0, ["penz"]],
    ["5-033", "6-088", "unverified", 0, ["penz"]],
    ["5-033", "6-143", "unverified", 0, ["vbdm"]],
    ["5-034", "6-002", "normal", 7, ["dm20", "dmx3", "pen20", "vbbe"]],
    ["5-034", "6-043", "normal", 8, ["dmx3"]],
    ["5-034", "6-051", "normal", 7, ["dmx3"]],
    ["5-034", "6-082", "normal", 8, ["dmx3"]],
    ["5-034", "6-150", "normal", 14, ["pen20", "vbbe"]],
    ["5-035", "6-095", "normal", 15, ["vbdm"]],
    ["5-035", "6-109", "jogress", 0, ["penc", "vbdm"]],
    ["5-035", "6-112", "normal", 15, ["pen", "pen20", "penc"]],
    ["5-035", "6-121", "jogress", 0, ["vbdm"]],
    ["5-036", "6-004", "jogress", 0, ["penz"]],
    ["5-036", "6-044", "normal", 7, ["dm20", "pen20", "vbdm"]],
    ["5-036", "6-057", "jogress", 0, ["penz"]],
    ["5-036", "6-104", "jogress", 0, ["vbdm"]],
    ["5-036", "6-129", "normal", 7, ["penz"]],
    ["5-037", "6-010", "jogress", 0, ["penz"]],
    ["5-037", "6-047", "normal", 3, ["penz"]],
    ["5-037", "6-103", "jogress", 0, ["penz"]],
    ["5-038", "6-012", "jogress", 0, ["penz"]],
    ["5-038", "6-049", "normal", 7, ["penz"]],
    ["5-038", "6-062", "jogress", 0, ["penz"]],
    ["5-038", "6-135", "normal", 15, ["vbbe"]],
    ["5-038", "6-149", "special", 0, ["vbbe"]],
    ["5-039", "6-021", "normal", 3, ["dmc", "pen20"]],
    ["5-039", "6-073", "normal", 7, ["dm20", "vbbe"]],
    ["5-039", "6-090", "normal", 15, ["vbbe"]],
    ["5-040", "6-009", "jogress", 0, ["penz"]],
    ["5-040", "6-013", "normal", 7, ["penz"]],
    ["5-040", "6-051", "normal", 3, ["dmc"]],
    ["5-040", "6-055", "jogress", 0, ["penz"]],
    ["5-040", "6-113", "normal", 7, ["dm20"]],
    ["5-041", "6-011", "special", 0, ["vbdm"]],
    ["5-041", "6-015", "normal", 7, ["dm20", "vbbe"]],
    ["5-041", "6-065", "normal", 15, ["vbbe"]],
    ["5-041", "6-096", "normal", 15, ["vbbe"]],
    ["5-041", "6-142", "jogress", 0, ["vbdm"]],
    ["5-042", "6-113", "jogress", 0, ["pen", "pen20", "penc"]],
    ["5-042", "6-114", "jogress", 0, ["penc"]],
    ["5-043", "6-063", "jogress", 0, ["penc"]],
    ["5-043", "6-105", "normal", 7, ["pen20", "penc", "vbbe"]],
    ["5-043", "6-137", "jogress", 0, ["penc"]],
    ["5-044", "6-046", "normal", 8, ["dmx3"]],
    ["5-044", "6-051", "special", 0, ["dmx3"]],
    ["5-044", "6-082", "normal", 7, ["dmx3"]],
    ["5-044", "6-106", "special", 0, ["dmx3"]],
    ["5-044", "6-135", "normal", 7, ["dmx3"]],
    ["5-046", "6-009", "jogress", 0, ["vbdm"]],
    ["5-046", "6-011", "normal", 7, ["penz"]],
    ["5-046", "6-042", "normal", 15, ["vbdm"]],
    ["5-046", "6-081", "jogress", 0, ["penz"]],
    ["5-046", "6-096", "jogress", 0, ["penz"]],
    ["5-047", "6-002", "normal", 3, ["dmx3", "vbbe"]],
    ["5-047", "6-046", "normal", 12, ["dmx3"]],
    ["5-047", "6-051", "normal", 3, ["dmx3"]],
    ["5-047", "6-058", "special", 0, ["dmx3"]],
    ["5-047", "6-070", "special", 0, ["dmx3"]],
    ["5-047", "6-099", "special", 0, ["dmx3"]],
    ["5-047", "6-104", "normal", 3, ["dmx3"]],
    ["5-047", "6-106", "special", 0, ["dmx3"]],
    ["5-047", "6-150", "normal", 15, ["vbbe"]],
    ["5-048", "6-011", "jogress", 0, ["vbdm"]],
    ["5-048", "6-030", "normal", 7, ["dm20", "pen20", "vbbe"]],
    ["5-048", "6-069", "normal", 15, ["vbbe"]],
    ["5-048", "6-142", "jogress", 0, ["vbdm"]],
    ["5-049", "6-001", "jogress", 0, ["penz"]],
    ["5-049", "6-008", "jogress", 0, ["penz"]],
    ["5-049", "6-095", "jogress", 0, ["vbdm"]],
    ["5-049", "6-109", "jogress", 0, ["vbdm"]],
    ["5-049", "6-121", "normal", 7, ["penz", "vbdm"]],
    ["5-050", "6-010", "jogress", 0, ["penz"]],
    ["5-050", "6-047", "jogress", 0, ["penz"]],
    ["5-050", "6-103", "normal", 7, ["penz"]],
    ["5-050", "6-107", "special", 0, ["vbbe"]],
    ["5-050", "6-145", "jogress", 0, ["penz"]],
    ["5-051", "6-044", "jogress", 0, ["vbdm"]],
    ["5-051", "6-051", "normal", 7, ["dmx3"]],
    ["5-051", "6-082", "normal", 8, ["dmx3"]],
    ["5-051", "6-098", "normal", 15, ["vbbe"]],
    ["5-051", "6-104", "normal", 7, ["dmx3", "pen20", "vbbe", "vbdm"]],
    ["5-051", "6-110", "normal", 8, ["dmx3"]],
    ["5-052", "6-009", "special", 0, ["vbdm"]],
    ["5-052", "6-042", "jogress", 0, ["vbdm"]],
    ["5-052", "6-066", "jogress", 0, ["penc"]],
    ["5-052", "6-081", "jogress", 0, ["pen20"]],
    ["5-052", "6-126", "jogress", 0, ["penc"]],
    ["5-053", "6-009", "normal", 15, ["vbdm"]],
    ["5-053", "6-019", "normal", 7, ["dmx2"]],
    ["5-053", "6-024", "normal", 8, ["dmx2"]],
    ["5-053", "6-035", "normal", 7, ["dmx2"]],
    ["5-053", "6-042", "special", 0, ["dmx2"]],
    ["5-053", "6-043", "jogress", 0, ["vbdm"]],
    ["5-053", "6-055", "normal", 15, ["vbdm"]],
    ["5-053", "6-102", "normal", 7, ["dmx2"]],
    ["5-053", "6-122", "normal", 7, ["dmx2"]],
    ["5-053", "6-138", "special", 0, ["dmx2"]],
    ["5-054", "6-034", "special", 0, ["dmx3"]],
    ["5-054", "6-046", "normal", 8, ["dmx3"]],
    ["5-054", "6-093", "normal", 7, ["dmx3", "vbbe"]],
    ["5-054", "6-101", "normal", 7, ["dmx3"]],
    ["5-054", "6-105", "normal", 15, ["vbbe"]],
    ["5-054", "6-106", "special", 0, ["dmx3"]],
    ["5-054", "6-110", "normal", 7, ["dmx3"]],
    ["5-054", "6-116", "normal", 7, ["dmx3"]],
    ["5-054", "6-135", "normal", 7, ["dmx3"]],
    ["5-055", "6-003", "normal", 7, ["penz"]],
    ["5-055", "6-020", "jogress", 0, ["penz"]],
    ["5-055", "6-061", "normal", 15, ["vbdm"]],
    ["5-055", "6-081", "jogress", 0, ["penz"]],
    ["5-055", "6-114", "normal", 15, ["vbdm"]],
    ["5-055", "7-020", "jogress", 0, ["vbdm"]],
    ["5-056", "5-012", "jogress", 0, ["penz"]],
    ["5-056", "5-139", "jogress", 0, ["penz"]],
    ["5-056", "6-004", "normal", 15, ["vbdm"]],
    ["5-056", "6-008", "jogress", 0, ["vbdm"]],
    ["5-056", "6-083", "normal", 15, ["vbdm"]],
    ["5-057", "5-033", "jogress", 0, ["penz"]],
    ["5-057", "6-013", "jogress", 0, ["penz"]],
    ["5-057", "6-017", "special", 0, ["vbbe"]],
    ["5-057", "6-021", "normal", 3, ["dmc"]],
    ["5-057", "6-055", "jogress", 0, ["penz"]],
    ["5-057", "6-088", "normal", 7, ["penz"]],
    ["5-057", "6-138", "normal", 15, ["vbdm"]],
    ["5-057", "6-139", "normal", 15, ["vbbe"]],
    ["5-057", "7-019", "normal", 15, ["vbbe"]],
    ["5-057", "7-045", "normal", 15, ["vbdm"]],
    ["5-058", "6-091", "jogress", 0, ["pen", "pen20"]],
    ["5-058", "6-141", "jogress", 0, ["penc"]],
    ["5-058", "6-143", "normal", 3, ["pen", "pen20", "penc"]],
    ["5-059", "6-037", "jogress", 0, ["pen", "pen20", "penc"]],
    ["5-059", "6-099", "jogress", 0, ["penc"]],
    ["5-059", "6-107", "normal", 15, ["penc"]],
    ["5-059", "7-029", "jogress", 0, ["pen20", "penc"]],
    ["5-060", "6-024", "special", 0, ["dmx2"]],
    ["5-060", "6-059", "special", 0, ["dmx2"]],
    ["5-060", "6-102", "special", 0, ["dmx2"]],
    ["5-060", "6-124", "normal", 15, ["dmx2"]],
    ["5-061", "6-011", "jogress", 0, ["vbdm"]],
    ["5-061", "6-142", "normal", 7, ["pen20", "vbdm"]],
    ["5-062", "6-006", "normal", 7, ["penz"]],
    ["5-062", "6-010", "jogress", 0, ["penz"]],
    ["5-062", "6-078", "normal", 7, ["pen20"]],
    ["5-062", "6-103", "jogress", 0, ["penz"]],
    ["5-062", "6-120", "jogress", 0, ["penz"]],
    ["5-062", "6-123", "normal", 15, ["vbbe"]],
    ["5-062", "6-149", "special", 0, ["vbbe"]],
    ["5-063", "6-105", "jogress", 0, ["penc"]],
    ["5-063", "6-114", "normal", 15, ["penc", "vbdm"]],
    ["5-063", "6-123", "normal", 3, ["pen", "pen20", "penc"]],
    ["5-064", "6-024", "special", 0, ["dmx"]],
    ["5-064", "6-108", "normal", 12, ["dmx"]],
    ["5-064", "6-114", "normal", 3, ["dmx"]],
    ["5-064", "6-140", "normal", 3, ["dmx"]],
    ["5-065", "6-009", "normal", 15, ["vbdm"]],
    ["5-065", "6-043", "normal", 15, ["vbdm"]],
    ["5-065", "6-055", "jogress", 0, ["vbdm"]],
    ["5-065", "6-062", "normal", 15, ["penz", "vbdm"]],
    ["5-065", "6-065", "normal", 7, ["penz", "vbdm"]],
    ["5-065", "6-080", "jogress", 0, ["vbdm"]],
    ["5-066", "6-012", "jogress", 0, ["penz"]],
    ["5-066", "6-049", "jogress", 0, ["penz"]],
    ["5-066", "6-062", "normal", 7, ["penz", "vbdm"]],
    ["5-066", "6-065", "jogress", 0, ["penz", "vbdm"]],
    ["5-066", "6-080", "jogress", 0, ["vbdm"]],
    ["5-067", "6-085", "normal", 3, ["dmx"]],
    ["5-067", "6-108", "normal", 12, ["dmx"]],
    ["5-067", "6-114", "special", 0, ["dmx"]],
    ["5-067", "6-144", "special", 0, ["dmx"]],
    ["5-067", "7-004", "special", 0, ["dmx"]],
    ["5-068", "6-011", "jogress", 0, ["penz"]],
    ["5-068", "6-020", "jogress", 0, ["penz"]],
    ["5-068", "6-041", "normal", 15, ["vbbe"]],
    ["5-068", "6-081", "jogress", 0, ["penz"]],
    ["5-068", "6-096", "normal", 7, ["penz", "vbbe"]],
    ["5-069", "6-018", "jogress", 0, ["penz"]],
    ["5-069", "6-057", "jogress", 0, ["penz"]],
    ["5-069", "6-084", "normal", 15, ["vbbe"]],
    ["5-069", "6-091", "jogress", 0, ["penc"]],
    ["5-069", "6-128", "normal", 3, ["pen20", "penz", "vbbe"]],
    ["5-069", "6-143", "jogress", 0, ["penc"]],
    ["5-069", "6-146", "normal", 15, ["vbbe"]],
    ["5-069", "7-032", "jogress", 0, ["pen"]],
    ["5-070", "5-033", "special", 0, ["vbdm"]],
    ["5-070", "6-022", "normal", 7, ["dm20", "dmc", "vbbe"]],
    ["5-070", "6-028", "normal", 15, ["vbdm"]],
    ["5-070", "6-143", "jogress", 0, ["vbdm"]],
    ["5-071", "6-034", "special", 0, ["dmx3"]],
    ["5-071", "6-043", "special", 0, ["dmx3"]],
    ["5-071", "6-046", "normal", 12, ["dmx3"]],
    ["5-071", "6-058", "special", 0, ["dmx3"]],
    ["5-071", "6-067", "special", 0, ["dmx3"]],
    ["5-071", "6-070", "special", 0, ["dmx3"]],
    ["5-071", "6-082", "normal", 3, ["dmx3"]],
    ["5-071", "6-093", "special", 0, ["dmx3"]],
    ["5-072", "6-019", "special", 0, ["dmx2"]],
    ["5-072", "6-027", "special", 0, ["dmx2"]],
    ["5-072", "6-032", "special", 0, ["dmx2"]],
    ["5-072", "6-040", "special", 0, ["dmx2"]],
    ["5-072", "6-051", "normal", 15, ["vbdm"]],
    ["5-072", "6-094", "normal", 12, ["dmx2"]],
    ["5-072", "6-111", "special", 0, ["dmx2"]],
    ["5-072", "6-118", "special", 0, ["dmx2"]],
    ["5-072", "6-122", "special", 0, ["dmx2"]],
    ["5-072", "6-124", "special", 0, ["dmx2"]],
    ["5-073", "6-007", "special", 0, ["vbdm"]],
    ["5-073", "6-013", "jogress", 0, ["penc"]],
    ["5-073", "6-029", "jogress", 0, ["penc"]],
    ["5-073", "6-067", "jogress", 0, ["vbdm"]],
    ["5-073", "6-130", "normal", 1, ["pen", "pen20", "penc", "vbdm"]],
    ["5-074", "6-024", "normal", 3, ["dmx2"]],
    ["5-074", "6-035", "special", 0, ["dmx2"]],
    ["5-074", "6-056", "special", 0, ["dmx2"]],
    ["5-074", "6-059", "special", 0, ["dmx2"]],
    ["5-074", "6-102", "special", 0, ["dmx2"]],
    ["5-074", "6-124", "normal", 12, ["dmx2"]],
    ["5-074", "6-131", "normal", 3, ["dmx2"]],
    ["5-075", "6-005", "normal", 7, ["penz"]],
    ["5-075", "6-018", "jogress", 0, ["penz"]],
    ["5-075", "6-031", "jogress", 0, ["vbdm"]],
    ["5-075", "6-052", "jogress", 0, ["penz"]],
    ["5-076", "6-007", "jogress", 0, ["penz"]],
    ["5-076", "6-056", "normal", 15, ["vbbe"]],
    ["5-076", "6-086", "jogress", 0, ["penz"]],
    ["5-076", "6-095", "jogress", 0, ["vbdm"]],
    ["5-076", "6-108", "normal", 15, ["vbbe"]],
    ["5-076", "6-109", "special", 0, ["vbdm"]],
    ["5-076", "6-121", "normal", 7, ["penz", "vbdm"]],
    ["5-076", "6-146", "normal", 15, ["vbbe"]],
    ["5-077", "6-008", "normal", 15, ["vbdm"]],
    ["5-077", "6-086", "normal", 15, ["vbdm"]],
    ["5-077", "6-095", "jogress", 0, ["penc"]],
    ["5-077", "6-112", "jogress", 0, ["pen", "pen20", "penc"]],
    ["5-078", "6-119", "normal", 7, ["dm20"]],
    ["5-079", "6-115", "normal", 7, ["pen20"]],
    ["5-080", "6-001", "normal", 7, ["dm20"]],
    ["5-080", "6-039", "normal", 3, ["dmc", "pen20"]],
    ["5-080", "6-068", "jogress", 0, ["penc"]],
    ["5-080", "6-080", "normal", 15, ["pen20", "penc", "vbbe"]],
    ["5-080", "6-095", "normal", 15, ["vbbe"]],
    ["5-081", "6-066", "normal", 1, ["pen20", "penc", "vbbe"]],
    ["5-081", "6-123", "normal", 15, ["vbbe"]],
    ["5-082", "6-086", "normal", 1, ["pen", "pen20", "penc"]],
    ["5-082", "6-095", "normal", 15, ["pen20", "penc", "vbdm"]],
    ["5-082", "6-109", "special", 0, ["vbdm"]],
    ["5-082", "6-112", "jogress", 0, ["penc"]],
    ["5-082", "6-121", "jogress", 0, ["vbdm"]],
    ["5-083", "6-032", "normal", 7, ["dmx2"]],
    ["5-083", "6-056", "special", 0, ["dmx2"]],
    ["5-083", "6-131", "normal", 8, ["dmx2"]],
    ["5-084", "6-024", "special", 0, ["dmx2"]],
    ["5-084", "6-035", "special", 0, ["dmx2"]],
    ["5-084", "6-042", "special", 0, ["dmx2"]],
    ["5-084", "6-124", "normal", 15, ["dmx2"]],
    ["5-085", "6-001", "jogress", 0, ["penz"]],
    ["5-085", "6-007", "jogress", 0, ["penz"]],
    ["5-085", "6-008", "normal", 3, ["penz"]],
    ["5-085", "6-075", "jogress", 0, ["penz"]],
    ["5-085", "6-095", "normal", 15, ["vbdm"]],
    ["5-085", "6-109", "jogress", 0, ["vbdm"]],
    ["5-085", "6-121", "jogress", 0, ["vbdm"]],
    ["5-086", "6-028", "normal", 7, ["dm20"]],
    ["5-086", "6-048", "jogress", 0, ["penz"]],
    ["5-086", "6-143", "normal", 7, ["pen", "pen20", "penz"]],
    ["5-087", "5-033", "jogress", 0, ["vbdm"]],
    ["5-087", "6-028", "normal", 15, ["vbdm"]],
    ["5-087", "6-080", "jogress", 0, ["penc"]],
    ["5-087", "6-143", "normal", 15, ["penc", "vbdm"]],
    ["5-088", "6-028", "normal", 3, ["dmc", "vbbe"]],
    ["5-088", "6-051", "jogress", 0, ["vbdm"]],
    ["5-088", "6-143", "normal", 15, ["vbdm"]],
    ["5-089", "6-027", "special", 0, ["dmx2"]],
    ["5-089", "6-032", "special", 0, ["dmx2"]],
    ["5-089", "6-094", "normal", 8, ["dmx2"]],
    ["5-089", "6-111", "special", 0, ["dmx2"]],
    ["5-089", "6-131", "normal", 7, ["dmx2"]],
    ["5-089", "6-138", "special", 0, ["dmx2"]],
    ["5-090", "6-108", "normal", 8, ["dmx"]],
    ["5-090", "6-140", "normal", 7, ["dmx"]],
    ["5-090", "6-144", "special", 0, ["dmx"]],
    ["5-090", "7-021", "special", 0, ["dmx"]],
    ["5-091", "6-038", "normal", 7, ["dm20", "dmc"]],
    ["5-091", "6-062", "jogress", 0, ["vbdm"]],
    ["5-091", "6-065", "normal", 15, ["vbdm"]],
    ["5-091", "6-080", "special", 0, ["vbdm"]],
    ["5-091", "6-091", "jogress", 0, ["pen", "pen20", "penc"]],
    ["5-091", "6-143", "jogress", 0, ["penc"]],
    ["5-092", "6-032", "normal", 7, ["dmx2"]],
    ["5-092", "6-040", "special", 0, ["dmx2"]],
    ["5-092", "6-042", "special", 0, ["dmx2"]],
    ["5-092", "6-094", "normal", 8, ["dmx2"]],
    ["5-092", "6-131", "normal", 7, ["dmx2"]],
    ["5-093", "5-033", "jogress", 0, ["vbdm"]],
    ["5-093", "6-012", "jogress", 0, ["penz"]],
    ["5-093", "6-028", "normal", 15, ["vbdm"]],
    ["5-093", "6-062", "jogress", 0, ["penz"]],
    ["5-093", "6-064", "normal", 7, ["penz", "vbbe"]],
    ["5-093", "6-080", "normal", 7, ["dm20", "dmc", "vbbe"]],
    ["5-093", "6-143", "normal", 15, ["vbdm"]],
    ["5-093", "7-045", "normal", 15, ["vbbe"]],
    ["5-094", "6-085", "normal", 3, ["dmx"]],
    ["5-094", "6-089", "special", 0, ["dmx"]],
    ["5-094", "6-092", "special", 0, ["dmx"]],
    ["5-094", "6-108", "normal", 12, ["dmx"]],
    ["5-094", "6-144", "special", 0, ["dmx"]],
    ["5-094", "7-004", "special", 0, ["dmx"]],
    ["5-094", "7-009", "special", 0, ["dmx"]],
    ["5-094", "7-022", "special", 0, ["dmx"]],
    ["5-095", "6-073", "normal", 15, ["vbbe"]],
    ["5-095", "6-147", "normal", 3, ["dmc", "vbbe"]],
    ["5-096", "6-034", "special", 0, ["dmx3"]],
    ["5-096", "6-043", "normal", 7, ["dmx3"]],
    ["5-096", "6-046", "normal", 8, ["dmx3"]],
    ["5-096", "6-082", "normal", 7, ["dmx3"]],
    ["5-096", "6-101", "special", 0, ["dmx3"]],
    ["5-096", "6-110", "special", 0, ["dmx3"]],
    ["5-097", "5-033", "normal", 3, ["penz"]],
    ["5-097", "6-009", "special", 0, ["vbdm"]],
    ["5-097", "6-016", "jogress", 0, ["penz"]],
    ["5-097", "6-017", "special", 0, ["vbbe"]],
    ["5-097", "6-042", "jogress", 0, ["vbdm"]],
    ["5-097", "6-055", "jogress", 0, ["penz"]],
    ["5-097", "7-019", "normal", 15, ["vbbe"]],
    ["5-097", "7-020", "normal", 15, ["vbbe"]],
    ["5-098", "6-029", "jogress", 0, ["penc"]],
    ["5-098", "6-099", "jogress", 0, ["vbdm"]],
    ["5-098", "6-107", "normal", 15, ["pen", "pen20", "penc", "vbdm"]],
    ["5-098", "6-130", "normal", 1, ["pen"]],
    ["5-098", "7-007", "jogress", 0, ["pen20", "penc"]],
    ["5-099", "6-032", "special", 0, ["dmx2"]],
    ["5-099", "6-035", "special", 0, ["dmx2"]],
    ["5-099", "6-040", "special", 0, ["dmx2"]],
    ["5-099", "6-094", "normal", 15, ["dmx2"]],
    ["5-099", "6-111", "special", 0, ["dmx2"]],
    ["5-100", "5-033", "normal", 7, ["penz", "vbdm"]],
    ["5-100", "6-028", "normal", 15, ["vbdm"]],
    ["5-100", "6-055", "jogress", 0, ["penz"]],
    ["5-100", "6-088", "jogress", 0, ["penz"]],
    ["5-100", "6-143", "jogress", 0, ["vbdm"]],
    ["5-101", "6-061", "normal", 15, ["penc", "vbbe"]],
    ["5-101", "6-066", "normal", 1, ["pen20"]],
    ["5-101", "6-090", "jogress", 0, ["pen", "pen20", "penc"]],
    ["5-101", "6-126", "jogress", 0, ["penc"]],
    ["5-101", "6-135", "normal", 15, ["vbbe"]],
    ["5-102", "6-024", "special", 0, ["dmx2"]],
    ["5-102", "6-059", "special", 0, ["dmx2"]],
    ["5-102", "6-124", "normal", 7, ["dmx2"]],
    ["5-102", "6-131", "normal", 8, ["dmx2"]],
    ["5-103", "6-002", "normal", 7, ["dmx3"]],
    ["5-103", "6-043", "normal", 7, ["dmx3"]],
    ["5-103", "6-046", "normal", 8, ["dmx3"]],
    ["5-103", "6-116", "special", 0, ["dmx3"]],
    ["5-103", "6-135", "special", 0, ["dmx3"]],
    ["5-104", "6-011", "jogress", 0, ["penz"]],
    ["5-104", "6-020", "jogress", 0, ["penz"]],
    ["5-104", "6-038", "normal", 15, ["vbdm"]],
    ["5-104", "6-090", "normal", 15, ["vbbe"]],
    ["5-104", "6-091", "jogress", 0, ["vbdm"]],
    ["5-104", "6-098", "normal", 7, ["penz", "vbbe", "vbdm"]],
    ["5-104", "6-147", "normal", 15, ["vbbe"]],
    ["5-105", "6-009", "jogress", 0, ["penz"]],
    ["5-105", "6-013", "jogress", 0, ["penz"]],
    ["5-105", "6-055", "jogress", 0, ["penz"]],
    ["5-105", "6-061", "jogress", 0, ["vbdm"]],
    ["5-105", "6-062", "jogress", 0, ["penz"]],
    ["5-105", "6-064", "jogress", 0, ["penz"]],
    ["5-105", "6-065", "jogress", 0, ["penz"]],
    ["5-105", "6-084", "normal", 15, ["vbbe", "vbdm"]],
    ["5-105", "6-128", "normal", 15, ["vbbe"]],
    ["5-105", "6-137", "jogress", 0, ["vbdm"]],
    ["5-105", "7-019", "normal", 7, ["pen20", "penz", "vbdm"]],
    ["5-105", "7-020", "special", 0, ["vbbe", "vbdm"]],
    ["5-106", "6-006", "jogress", 0, ["penz"]],
    ["5-106", "6-010", "jogress", 0, ["penz"]],
    ["5-106", "6-038", "jogress", 0, ["vbdm"]],
    ["5-106", "6-091", "normal", 15, ["vbdm"]],
    ["5-106", "6-098", "special", 0, ["vbdm"]],
    ["5-106", "6-120", "normal", 7, ["penz"]],
    ["5-107", "6-037", "normal", 15, ["penc"]],
    ["5-107", "6-099", "normal", 15, ["penc", "vbdm"]],
    ["5-107", "6-107", "jogress", 0, ["pen20", "vbdm"]],
    ["5-108", "6-008", "jogress", 0, ["penz"]],
    ["5-108", "6-075", "normal", 3, ["penz"]],
    ["5-108", "6-095", "jogress", 0, ["vbdm"]],
    ["5-108", "6-109", "jogress", 0, ["vbdm"]],
    ["5-108", "6-121", "normal", 15, ["penz", "vbdm"]],
    ["5-109", "6-031", "normal", 15, ["vbdm"]],
    ["5-109", "6-061", "jogress", 0, ["penc"]],
    ["5-109", "6-081", "jogress", 0, ["penc"]],
    ["5-109", "6-126", "jogress", 0, ["pen", "pen20", "penc"]],
    ["5-110", "6-013", "jogress", 0, ["penc"]],
    ["5-110", "6-029", "jogress", 0, ["pen", "pen20", "penc"]],
    ["5-110", "6-034", "normal", 7, ["dmx3"]],
    ["5-110", "6-043", "normal", 15, ["dmx3"]],
    ["5-110", "6-099", "normal", 7, ["dmx3", "penc", "vbdm"]],
    ["5-110", "6-107", "normal", 15, ["penc", "vbdm"]],
    ["5-110", "6-116", "normal", 7, ["dmx3"]],
    ["5-111", "6-004", "jogress", 0, ["penz"]],
    ["5-111", "6-018", "normal", 7, ["penz"]],
    ["5-111", "6-031", "normal", 3, ["pen20", "vbdm"]],
    ["5-111", "6-052", "jogress", 0, ["penz"]],
    ["5-111", "6-057", "jogress", 0, ["penz"]],
    ["5-112", "6-033", "jogress", 0, ["vbdm"]],
    ["5-112", "6-087", "normal", 7, ["pen20", "vbdm"]],
    ["5-113", "6-012", "jogress", 0, ["penz"]],
    ["5-113", "6-062", "jogress", 0, ["penz", "vbdm"]],
    ["5-113", "6-064", "normal", 3, ["penz"]],
    ["5-113", "6-065", "normal", 15, ["vbdm"]],
    ["5-113", "6-080", "jogress", 0, ["vbdm"]],
    ["5-114", "6-009", "normal", 15, ["vbdm"]],
    ["5-114", "6-043", "normal", 15, ["vbdm"]],
    ["5-114", "6-055", "jogress", 0, ["vbdm"]],
    ["5-115", "6-005", "jogress", 0, ["penz"]],
    ["5-115", "6-018", "jogress", 0, ["penz"]],
    ["5-115", "6-052", "normal", 1, ["pen20"]],
    ["5-115", "6-074", "normal", 14, ["pen20"]],
    ["5-115", "6-129", "normal", 7, ["penz", "vbbe"]],
    ["5-115", "6-133", "normal", 15, ["vbbe"]],
    ["5-116", "6-046", "normal", 8, ["dmx3"]],
    ["5-116", "6-051", "normal", 8, ["dmx3"]],
    ["5-116", "6-058", "special", 0, ["dmx3"]],
    ["5-116", "6-082", "normal", 7, ["dmx3"]],
    ["5-116", "6-104", "normal", 7, ["dmx3"]],
    ["5-116", "6-110", "special", 0, ["dmx3"]],
    ["5-117", "6-030", "normal", 15, ["vbbe"]],
    ["5-117", "6-069", "normal", 7, ["dm20", "pen20", "vbbe"]],
    ["5-118", "5-033", "jogress", 0, ["vbdm"]],
    ["5-118", "6-028", "normal", 15, ["vbdm"]],
    ["5-118", "6-095", "jogress", 0, ["pen", "pen20"]],
    ["5-118", "6-109", "jogress", 0, ["penc"]],
    ["5-118", "6-143", "normal", 15, ["vbdm"]],
    ["5-118", "6-146", "jogress", 0, ["penc"]],
    ["5-119", "6-034", "special", 0, ["dmx3"]],
    ["5-119", "6-043", "special", 0, ["dmx3"]],
    ["5-119", "6-046", "normal", 8, ["dmx3"]],
    ["5-119", "6-051", "normal", 7, ["dmx3"]],
    ["5-119", "6-056", "normal", 15, ["vbbe"]],
    ["5-119", "6-110", "normal", 7, ["dmx3"]],
    ["5-120", "6-007", "jogress", 0, ["penz"]],
    ["5-120", "6-018", "jogress", 0, ["penz"]],
    ["5-120", "6-052", "jogress", 0, ["penz"]],
    ["5-120", "6-057", "jogress", 0, ["penz"]],
    ["5-120", "6-085", "special", 0, ["vbbe"]],
    ["5-120", "6-086", "jogress", 0, ["penz"]],
    ["5-120", "6-121", "jogress", 0, ["penz"]],
    ["5-120", "6-132", "normal", 3, ["penz"]],
    ["5-120", "6-146", "normal", 15, ["vbbe"]],
    ["5-121", "6-061", "jogress", 0, ["penc"]],
    ["5-121", "6-090", "normal", 15, ["pen", "pen20", "penc"]],
    ["5-122", "6-004", "normal", 7, ["penz"]],
    ["5-122", "6-018", "jogress", 0, ["penz"]],
    ["5-122", "6-052", "jogress", 0, ["penz"]],
    ["5-122", "6-057", "jogress", 0, ["penz"]],
    ["5-123", "6-003", "jogress", 0, ["penz"]],
    ["5-123", "6-006", "jogress", 0, ["penz"]],
    ["5-123", "6-010", "jogress", 0, ["penz"]],
    ["5-123", "6-017", "special", 0, ["vbbe"]],
    ["5-123", "6-081", "normal", 15, ["vbbe"]],
    ["5-123", "6-096", "jogress", 0, ["penz"]],
    ["5-123", "6-139", "normal", 7, ["penz", "vbbe"]],
    ["5-123", "6-145", "jogress", 0, ["penz"]],
    ["5-124", "6-004", "normal", 15, ["vbdm"]],
    ["5-124", "6-007", "jogress", 0, ["penz"]],
    ["5-124", "6-008", "normal", 7, ["penz", "vbdm"]],
    ["5-124", "6-083", "jogress", 0, ["vbdm"]],
    ["5-124", "6-086", "jogress", 0, ["penz"]],
    ["5-124", "6-121", "jogress", 0, ["penz"]],
    ["5-125", "6-013", "normal", 15, ["vbdm"]],
    ["5-125", "6-063", "normal", 15, ["vbdm"]],
    ["5-125", "6-108", "normal", 12, ["dmx"]],
    ["5-125", "6-127", "special", 0, ["dmx"]],
    ["5-125", "6-140", "normal", 3, ["dmx"]],
    ["5-125", "7-022", "special", 0, ["dmx"]],
    ["5-126", "6-051", "normal", 15, ["vbdm"]],
    ["5-126", "6-130", "normal", 7, ["dm20", "dmc"]],
    ["5-126", "6-143", "jogress", 0, ["vbdm"]],
    ["5-127", "6-011", "special", 0, ["vbdm"]],
    ["5-127", "6-029", "normal", 15, ["pen", "pen20", "penc"]],
    ["5-127", "6-037", "jogress", 0, ["penc"]],
    ["5-127", "6-099", "jogress", 0, ["penc"]],
    ["5-127", "6-130", "normal", 1, ["pen20", "penc"]],
    ["5-127", "6-142", "jogress", 0, ["vbdm"]],
    ["5-128", "6-019", "normal", 7, ["dmx2"]],
    ["5-128", "6-027", "normal", 7, ["dmx2"]],
    ["5-128", "6-040", "normal", 7, ["dmx2"]],
    ["5-128", "6-056", "special", 0, ["dmx2"]],
    ["5-128", "6-059", "special", 0, ["dmx2"]],
    ["5-128", "6-117", "normal", 15, ["vbbe"]],
    ["5-128", "6-118", "normal", 7, ["dmx2", "vbbe"]],
    ["5-128", "6-124", "normal", 8, ["dmx2"]],
    ["5-130", "6-006", "normal", 7, ["penz"]],
    ["5-130", "6-010", "jogress", 0, ["penz"]],
    ["5-130", "6-114", "jogress", 0, ["vbdm"]],
    ["5-130", "6-145", "jogress", 0, ["penz"]],
    ["5-130", "6-146", "normal", 15, ["vbbe"]],
    ["5-131", "6-009", "jogress", 0, ["vbdm"]],
    ["5-131", "6-042", "normal", 15, ["vbdm"]],
    ["5-131", "6-066", "jogress", 0, ["penc"]],
    ["5-131", "6-090", "jogress", 0, ["penc"]],
    ["5-131", "6-126", "normal", 15, ["pen", "pen20", "penc"]],
    ["5-132", "6-032", "normal", 7, ["dmx2"]],
    ["5-132", "6-094", "normal", 8, ["dmx2"]],
    ["5-132", "6-111", "normal", 7, ["dmx2"]],
    ["5-132", "6-131", "special", 0, ["dmx2"]],
    ["5-132", "6-138", "special", 0, ["dmx2"]],
    ["5-134", "6-009", "jogress", 0, ["vbdm"]],
    ["5-134", "6-043", "normal", 15, ["vbdm"]],
    ["5-134", "6-055", "normal", 15, ["vbdm"]],
    ["5-135", "6-004", "jogress", 0, ["penz"]],
    ["5-135", "6-052", "normal", 7, ["pen20", "penz", "vbdm"]],
    ["5-135", "6-053", "jogress", 0, ["vbdm"]],
    ["5-135", "6-088", "normal", 15, ["vbdm"]],
    ["5-135", "6-129", "jogress", 0, ["penz"]],
    ["5-136", "6-085", "normal", 7, ["dmx"]],
    ["5-136", "6-089", "special", 0, ["dmx"]],
    ["5-136", "6-108", "normal", 8, ["dmx"]],
    ["5-136", "7-009", "special", 0, ["dmx"]],
    ["5-136", "7-021", "special", 0, ["dmx"]],
    ["5-137", "6-013", "normal", 15, ["vbdm"]],
    ["5-137", "6-091", "jogress", 0, ["penc"]],
    ["5-137", "6-126", "normal", 15, ["vbdm"]],
    ["5-137", "6-141", "normal", 15, ["pen20", "penc"]],
    ["5-138", "6-008", "jogress", 0, ["penz"]],
    ["5-138", "6-038", "normal", 15, ["vbdm"]],
    ["5-138", "6-056", "normal", 15, ["vbbe"]],
    ["5-138", "6-075", "normal", 7, ["penz"]],
    ["5-138", "6-091", "normal", 15, ["vbdm"]],
    ["5-138", "6-098", "jogress", 0, ["vbdm"]],
    ["5-138", "6-108", "normal", 15, ["vbbe"]],
    ["5-138", "6-121", "jogress", 0, ["penz"]],
    ["5-139", "6-013", "normal", 15, ["penc"]],
    ["5-139", "6-038", "normal", 15, ["vbdm"]],
    ["5-139", "6-083", "jogress", 0, ["penz"]],
    ["5-139", "6-091", "normal", 7, ["pen", "pen20", "penc", "penz", "vbdm"]],
    ["5-139", "6-098", "jogress", 0, ["vbdm"]],
    ["5-139", "6-099", "jogress", 0, ["penc"]],
    ["5-139", "6-130", "normal", 1, ["pen20", "penc"]],
    ["5-140", "6-092", "special", 0, ["dmx"]],
    ["5-140", "6-108", "normal", 8, ["dmx"]],
    ["5-140", "6-140", "normal", 7, ["dmx"]],
    ["5-140", "7-021", "special", 0, ["dmx"]],
    ["5-141", "6-086", "normal", 15, ["penc", "vbdm"]],
    ["5-141", "6-109", "jogress", 0, ["pen20", "penc"]],
    ["5-141", "6-112", "normal", 15, ["vbdm"]],
    ["5-141", "6-146", "jogress", 0, ["penc"]],
    ["5-142", "6-129", "normal", 15, ["vbbe"]],
    ["5-142", "6-133", "normal", 7, ["dm20", "pen20", "vbbe"]],
    ["5-143", "6-056", "normal", 15, ["vbbe"]],
    ["5-143", "6-086", "normal", 1, ["pen", "pen20", "penc"]],
    ["5-143", "6-146", "normal", 15, ["penc", "vbbe"]],
    ["5-144", "6-148", "normal", 15, ["vbbe", "vbdm"]],
    ["5-145", "6-005", "normal", 15, ["vbdm"]],
    ["5-145", "6-011", "normal", 15, ["vbdm"]],
    ["5-145", "6-048", "jogress", 0, ["vbdm"]],
    ["5-146", "6-002", "normal", 7, ["dm20", "dmx3", "pen20", "vbbe"]],
    ["5-146", "6-043", "normal", 8, ["dmx3"]],
    ["5-146", "6-051", "normal", 7, ["dmx3"]],
    ["5-146", "6-082", "normal", 8, ["dmx3"]],
    ["5-146", "6-150", "normal", 14, ["pen20", "vbbe"]],
    ["5-147", "6-091", "normal", 15, ["vbdm"]],
    ["5-148", "6-003", "normal", 7, ["penz"]],
    ["5-148", "6-009", "jogress", 0, ["vbdm"]],
    ["5-148", "6-081", "jogress", 0, ["penz"]],
    ["5-148", "6-096", "jogress", 0, ["penz"]],
    ["5-148", "6-098", "jogress", 0, ["penz"]],
    ["5-149", "6-005", "jogress", 0, ["vbdm"]],
    ["5-149", "6-011", "normal", 15, ["vbdm"]],
    ["5-149", "6-048", "normal", 15, ["vbdm"]],
    ["6-001", "7-039", "jogress", 0, ["dm20"]],
    ["6-002", "7-001", "jogress", 0, ["dmx3", "pen20", "vbbe"]],
    ["6-003", "6-014", "special", 0, ["penz"]],
    ["6-004", "6-079", "special", 0, ["penz"]],
    ["6-005", "6-079", "special", 0, ["penz"]],
    ["6-006", "6-079", "special", 0, ["penz"]],
    ["6-007", "6-014", "special", 0, ["penz"]],
    ["6-008", "6-014", "special", 0, ["penz"]],
    ["6-009", "6-014", "special", 0, ["penz"]],
    ["6-010", "6-079", "special", 0, ["penz"]],
    ["6-011", "6-014", "special", 0, ["penz"]],
    ["6-012", "6-079", "special", 0, ["penz"]],
    ["6-015", "7-018", "jogress", 0, ["dm20", "vbbe"]],
    ["6-018", "6-050", "special", 0, ["penz"]],
    ["6-019", "7-003", "normal", 7, ["dmx2"]],
    ["6-019", "7-011", "normal", 7, ["dmx2"]],
    ["6-020", "6-050", "special", 0, ["penz"]],
    ["6-021", "7-008", "jogress", 0, ["dmc", "pen20"]],
    ["6-024", "7-004", "normal", 7, ["dmx2"]],
    ["6-024", "7-012", "normal", 7, ["dmx", "dmx2"]],
    ["6-025", "7-005", "jogress", 0, ["pen20"]],
    ["6-026", "7-031", "jogress", 0, ["pen20"]],
    ["6-027", "7-003", "normal", 7, ["dmx2"]],
    ["6-027", "7-010", "special", 0, ["dmx2"]],
    ["6-027", "7-038", "special", 0, ["dmx2"]],
    ["6-028", "7-033", "jogress", 0, ["dm20", "dmc"]],
    ["6-030", "7-014", "jogress", 0, ["dm20", "pen20", "vbbe"]],
    ["6-031", "7-037", "jogress", 0, ["pen20", "vbdm"]],
    ["6-032", "7-010", "special", 0, ["dmx2"]],
    ["6-032", "7-012", "special", 0, ["dmx2"]],
    ["6-032", "7-027", "special", 0, ["dmx2"]],
    ["6-034", "7-022", "normal", 7, ["dmx3"]],
    ["6-034", "7-040", "special", 0, ["dmx3"]],
    ["6-035", "7-003", "normal", 7, ["dmx2"]],
    ["6-035", "7-006", "special", 0, ["dmx2"]],
    ["6-037", "7-031", "jogress", 0, ["pen20"]],
    ["6-038", "7-033", "jogress", 0, ["dm20", "dmc"]],
    ["6-039", "7-008", "jogress", 0, ["dmc", "pen20"]],
    ["6-039", "7-045", "jogress", 0, ["dmc"]],
    ["6-040", "7-003", "normal", 7, ["dmx2"]],
    ["6-040", "7-011", "special", 0, ["dmx2"]],
    ["6-040", "7-027", "special", 0, ["dmx2"]],
    ["6-041", "7-018", "jogress", 0, ["dm20", "vbbe"]],
    ["6-042", "7-003", "normal", 7, ["dmx2"]],
    ["6-042", "7-024", "special", 0, ["dmx2"]],
    ["6-043", "7-009", "normal", 7, ["dmx3"]],
    ["6-043", "7-021", "normal", 7, ["dmx3"]],
    ["6-043", "7-022", "normal", 7, ["dmx3"]],
    ["6-043", "7-026", "normal", 7, ["dmx3"]],
    ["6-044", "7-037", "jogress", 0, ["pen20", "vbdm"]],
    ["6-046", "7-015", "special", 0, ["dmx3"]],
    ["6-046", "7-017", "special", 0, ["dmx3"]],
    ["6-046", "7-021", "special", 0, ["dmx3"]],
    ["6-046", "7-026", "special", 0, ["dmx3"]],
    ["6-047", "6-050", "special", 0, ["penz"]],
    ["6-048", "6-134", "jogress", 0, ["penz", "vbdm"]],
    ["6-051", "7-001", "special", 0, ["dmx3"]],
    ["6-051", "7-009", "normal", 7, ["dmx3"]],
    ["6-051", "7-021", "normal", 7, ["dmx3"]],
    ["6-056", "7-003", "normal", 7, ["dmx2"]],
    ["6-056", "7-024", "special", 0, ["dmx2"]],
    ["6-057", "6-050", "special", 0, ["penz"]],
    ["6-058", "7-015", "special", 0, ["dmx3"]],
    ["6-058", "7-021", "normal", 7, ["dmx3"]],
    ["6-059", "7-003", "normal", 7, ["dmx2"]],
    ["6-059", "7-024", "special", 0, ["dmx2"]],
    ["6-064", "7-002", "normal", 7, ["penz"]],
    ["6-067", "7-009", "normal", 7, ["dmx3"]],
    ["6-067", "7-017", "normal", 7, ["dmx3"]],
    ["6-067", "7-021", "normal", 7, ["dmx3"]],
    ["6-067", "7-023", "normal", 7, ["dmx3"]],
    ["6-067", "7-028", "normal", 7, ["dmx3"]],
    ["6-067", "7-040", "normal", 7, ["dmx3"]],
    ["6-068", "7-045", "jogress", 0, ["penc"]],
    ["6-069", "7-021", "special", 0, ["pen20"]],
    ["6-070", "7-017", "special", 0, ["dmx3"]],
    ["6-070", "7-026", "normal", 7, ["dmx3"]],
    ["6-075", "7-002", "normal", 7, ["penz"]],
    ["6-078", "7-036", "jogress", 0, ["pen20"]],
    ["6-080", "7-039", "jogress", 0, ["dm20"]],
    ["6-080", "7-045", "jogress", 0, ["dmc", "penc"]],
    ["6-081", "6-050", "special", 0, ["penz"]],
    ["6-082", "7-022", "special", 0, ["dmx3"]],
    ["6-082", "7-026", "special", 0, ["dmx3"]],
    ["6-082", "7-028", "special", 0, ["dmx3"]],
    ["6-082", "7-040", "special", 0, ["dmx3"]],
    ["6-083", "6-134", "jogress", 0, ["penz", "vbdm"]],
    ["6-085", "7-012", "special", 0, ["dmx"]],
    ["6-088", "7-002", "normal", 7, ["penz"]],
    ["6-089", "7-016", "special", 0, ["dmx"]],
    ["6-091", "7-032", "normal", 15, ["pen", "pen20", "penc", "penz", "vbdm"]],
    ["6-092", "7-034", "special", 0, ["dmx"]],
    ["6-093", "7-009", "normal", 7, ["dmx3"]],
    ["6-093", "7-013", "normal", 7, ["dmx3"]],
    ["6-093", "7-015", "normal", 7, ["dmx3"]],
    ["6-093", "7-022", "normal", 7, ["dmx3"]],
    ["6-093", "7-028", "normal", 7, ["dmx3"]],
    ["6-093", "7-040", "normal", 7, ["dmx3"]],
    ["6-094", "7-003", "special", 0, ["dmx2"]],
    ["6-094", "7-006", "special", 0, ["dmx2"]],
    ["6-094", "7-025", "special", 0, ["dmx2"]],
    ["6-095", "6-001", "jogress", 0, ["penc"]],
    ["6-099", "6-053", "special", 0, ["dmx3"]],
    ["6-099", "7-016", "unverified", 0, ["dmx3"]],
    ["6-099", "7-023", "normal", 7, ["dmx3"]],
    ["6-099", "7-026", "normal", 7, ["dmx3"]],
    ["6-099", "7-034", "special", 0, ["dmx3"]],
    ["6-101", "7-022", "normal", 7, ["dmx3"]],
    ["6-101", "7-023", "special", 0, ["dmx3"]],
    ["6-102", "7-003", "normal", 7, ["dmx2"]],
    ["6-102", "7-025", "special", 0, ["dmx2"]],
    ["6-104", "7-001", "jogress", 0, ["dmx3", "pen20", "vbbe"]],
    ["6-104", "7-021", "normal", 7, ["dmx3"]],
    ["6-106", "7-013", "special", 0, ["dmx3"]],
    ["6-106", "7-026", "normal", 7, ["dmx3"]],
    ["6-107", "7-007", "jogress", 0, ["pen20", "penc"]],
    ["6-108", "7-034", "special", 0, ["dmx"]],
    ["6-109", "6-001", "jogress", 0, ["penc"]],
    ["6-110", "7-022", "special", 0, ["dmx3"]],
    ["6-110", "7-034", "special", 0, ["dmx3"]],
    ["6-111", "7-010", "special", 0, ["dmx2"]],
    ["6-111", "7-012", "special", 0, ["dmx2"]],
    ["6-111", "7-027", "special", 0, ["dmx2"]],
    ["6-114", "7-026", "special", 0, ["dmx"]],
    ["6-114", "7-030", "special", 0, ["dmx"]],
    ["6-115", "7-035", "jogress", 0, ["pen20"]],
    ["6-116", "7-009", "normal", 7, ["dmx3"]],
    ["6-116", "7-028", "special", 0, ["dmx3"]],
    ["6-118", "7-012", "normal", 7, ["dmx2"]],
    ["6-118", "7-038", "normal", 7, ["dmx2"]],
    ["6-122", "6-009", "special", 0, ["dmx2"]],
    ["6-122", "7-004", "normal", 7, ["dmx2"]],
    ["6-123", "7-036", "jogress", 0, ["pen20"]],
    ["6-124", "7-003", "special", 0, ["dmx2"]],
    ["6-124", "7-006", "special", 0, ["dmx2"]],
    ["6-124", "7-025", "special", 0, ["dmx2"]],
    ["6-127", "7-016", "special", 0, ["dmx"]],
    ["6-131", "7-003", "special", 0, ["dmx2"]],
    ["6-131", "7-024", "special", 0, ["dmx2"]],
    ["6-133", "7-014", "jogress", 0, ["dm20", "pen20", "vbbe"]],
    ["6-135", "6-053", "special", 0, ["dmx3"]],
    ["6-135", "7-009", "special", 0, ["dmx3"]],
    ["6-135", "7-016", "unverified", 0, ["dmx3"]],
    ["6-138", "7-003", "normal", 7, ["dmx2"]],
    ["6-138", "7-024", "special", 0, ["dmx2"]],
    ["6-140", "7-016", "special", 0, ["dmx"]],
    ["6-143", "7-032", "normal", 15, ["pen", "pen20", "penc", "penz", "vbdm"]],
    ["6-144", "7-034", "special", 0, ["dmx"]],
    ["6-145", "6-050", "special", 0, ["penz"]],
    ["7-004", "7-012", "special", 0, ["dmx"]],
    ["7-009", "6-002", "special", 0, ["dmx"]],
    ["7-009", "7-026", "special", 0, ["dmx"]],
    ["7-012", "7-044", "special", 0, ["dmx3"]],
    ["7-017", "7-043", "jogress", 0, ["dmx3"]],
    ["7-019", "7-020", "jogress", 0, ["pen20", "penz"]],
    ["7-021", "6-002", "special", 0, ["dmx"]],
    ["7-021", "7-043", "jogress", 0, ["dmx3"]],
    ["7-022", "6-002", "special", 0, ["dmx"]],
    ["7-022", "7-030", "special", 0, ["dmx"]],
    ["7-032", "7-020", "jogress", 0, ["pen20", "penz"]]
  ],
  requirements: {
    "3-001:7-041": [[3, 50, null]],
    "3-022:7-042": [[3, 50, null]],
    "4-006:5-073": [[7, 12, null], [7, 24, null]],
    "4-009:5-115": [[7, 12, null]],
    "4-011:5-059": [[3, 12, null]],
    "4-011:5-098": [[3, 24, null]],
    "4-013:5-117": [[7, 12, null]],
    "4-014:5-001": [[7, 24, null]],
    "4-014:5-043": [[7, 12, null]],
    "4-016:5-058": [[15, 12, null], [15, 24, null]],
    "4-017:5-082": [[15, 12, null], [15, 24, null]],
    "4-018:5-142": [[7, 12, null]],
    "4-019:5-048": [[7, 12, null]],
    "4-026:5-086": [[3, 12, null], [3, 24, null]],
    "4-027:5-080": [[3, 12, null]],
    "4-028:5-098": [[3, 12, null]],
    "4-031:5-059": [[3, 12, null], [3, 24, null]],
    "4-032:5-143": [[7, 12, null], [7, 24, null]],
    "4-036:5-082": [[15, 12, null], [15, 24, null]],
    "4-045:5-112": [[7, 12, null]],
    "4-046:5-073": [[7, 12, null], [7, 24, null]],
    "4-049:5-101": [[15, 24, null]],
    "4-049:5-121": [[7, 12, null]],
    "4-051:5-077": [[15, 12, null], [15, 24, null]],
    "4-055:5-135": [[3, 0, null], [4, 12, null]],
    "4-057:5-080": [[15, 12, null], [15, 24, null]],
    "4-060:5-143": [[7, 12, null], [7, 24, null]],
    "4-062:5-081": [[1, 12, null], [1, 24, null]],
    "4-063:5-014": [[7, 12, null]],
    "4-066:5-101": [[7, 12, null], [15, 24, null]],
    "4-068:5-061": [[7, 12, null]],
    "4-070:5-086": [[3, 12, null], [3, 24, null]],
    "4-074:5-011": [[7, 12, null]],
    "4-075:5-115": [[7, 12, null]],
    "4-077:5-078": [[15, 12, null]],
    "4-077:5-079": [[7, 12, null]],
    "4-078:5-080": [[15, 12, null], [15, 24, null]],
    "4-079:5-127": [[15, 12, null], [15, 24, null]],
    "4-084:5-131": [[7, 12, null], [7, 24, null]],
    "4-087:5-139": [[7, 12, null], [7, 24, null]],
    "4-090:5-077": [[15, 12, null], [15, 24, null]],
    "4-099:5-009": [[7, 12, null]],
    "4-102:5-020": [[15, 12, null], [15, 24, null]],
    "4-103:5-012": [[7, 12, null]],
    "4-107:5-082": [[15, 12, null], [15, 24, null]],
    "4-110:5-027": [[3, 12, null]],
    "4-115:5-131": [[7, 12, null], [7, 24, null]],
    "4-120:5-062": [[7, 12, null]],
    "4-121:5-058": [[15, 12, null], [15, 24, null]],
    "4-122:5-039": [[3, 12, null]],
    "4-123:5-058": [[15, 12, null], [15, 24, null]],
    "4-124:5-111": [[7, 12, null]],
    "4-127:5-063": [[7, 12, null]],
    "4-129:5-081": [[1, 12, null], [1, 24, null]],
    "4-130:5-027": [[7, 12, null]],
    "4-131:5-006": [[7, 12, null]],
    "4-138:5-001": [[7, 12, null], [7, 24, null]],
    "4-143:5-127": [[15, 12, null], [15, 24, null]],
    "4-145:5-020": [[15, 12, null], [15, 24, null]],
    "4-146:5-036": [[7, 12, null]],
    "5-001:6-105": [[3, 24, null], [6, 12, null]],
    "5-001:6-137": [[1, 12, null], [7, 12, null]],
    "5-004:6-081": [[1, 12, null]],
    "5-009:6-026": [[7, 12, null]],
    "5-010:6-143": [[3, 12, null], [3, 24, null]],
    "5-011:6-025": [[7, 12, null]],
    "5-012:6-074": [[7, 12, null]],
    "5-027:6-025": [[14, 12, null]],
    "5-027:6-026": [[1, 12, null]],
    "5-029:6-105": [[3, 12, null], [3, 24, null]],
    "5-034:6-150": [[14, 12, null]],
    "5-043:6-105": [[7, 12, null]],
    "5-058:6-143": [[3, 12, null], [3, 24, null]],
    "5-061:6-142": [[7, 12, null]],
    "5-062:6-078": [[7, 12, null]],
    "5-063:6-123": [[3, 12, null]],
    "5-073:6-130": [[1, 12, null], [1, 24, null]],
    "5-079:6-115": [[7, 12, null]],
    "5-081:6-066": [[1, 12, null]],
    "5-082:6-086": [[1, 12, null], [1, 24, null]],
    "5-098:6-130": [[1, 24, null]],
    "5-101:6-066": [[1, 12, null]],
    "5-111:6-031": [[3, 12, null]],
    "5-112:6-087": [[7, 12, null]],
    "5-115:6-052": [[1, 12, null]],
    "5-115:6-074": [[14, 12, null]],
    "5-127:6-130": [[1, 12, null]],
    "5-135:6-052": [[3, 0, null], [4, 12, null]],
    "5-139:6-130": [[1, 12, null]],
    "5-143:6-086": [[1, 12, null], [1, 24, null]],
    "5-146:6-150": [[14, 12, null]],
    "6-024:7-004": [[7, 200, null]],
    "6-122:7-004": [[7, 200, null]]
  }
};

// ../digital-pet-core/src/data/evolution-routes.ts
var EVOLUTION_ROUTES = /* @__PURE__ */ new Map();
for (const [fromId, targetId, kind, careMask, sources] of evolution_reference_default.routes) {
  if (typeof fromId !== "string" || typeof targetId !== "string" || kind !== "normal" && kind !== "jogress" && kind !== "special" && kind !== "unverified" || typeof careMask !== "number" || !Number.isInteger(careMask) || careMask < 0 || careMask > 15 || !Array.isArray(sources) || !sources.every((source) => typeof source === "string" && source in evolution_reference_default.sources))
    throw new Error("Invalid referenced evolution route");
  const groups = evolution_reference_default.requirements[`${fromId}:${targetId}`];
  const conditions = groups?.map(([mask, min, max]) => {
    if (mask === null || mask === void 0 || !Number.isInteger(mask) || mask < 1 || mask > 15 || min === null || min === void 0 || !Number.isSafeInteger(min) || min < 0 || max !== null && (max === void 0 || !Number.isSafeInteger(max) || max < min))
      throw new Error("Invalid victory condition");
    return Object.freeze({ careMask: mask, minVictories: adaptEvolutionVictoryMinimum(min), maxVictories: max ?? null });
  });
  EVOLUTION_ROUTES.set(
    fromId,
    Object.freeze([
      ...EVOLUTION_ROUTES.get(fromId) ?? [],
      Object.freeze({
        targetId,
        kind,
        careMask,
        sources: Object.freeze([...sources]),
        ...conditions ? { requirements: Object.freeze(conditions) } : {}
      })
    ])
  );
}

// ../digital-pet-core/src/data/digimon-data.ts
var DIGIMON_DATA = [
  {
    name_en: "Digiegg",
    name_jp: "Digitama",
    next_evolutions: [
      "1-001",
      "1-002",
      "1-003",
      "1-004",
      "1-005",
      "1-006",
      "1-007",
      "1-008",
      "1-009",
      "1-010",
      "1-011",
      "1-012",
      "1-013",
      "1-014",
      "1-015",
      "1-016",
      "1-017",
      "1-018",
      "1-019",
      "1-020",
      "1-021",
      "1-022",
      "1-023",
      "1-024",
      "1-025",
      "1-026",
      "1-027",
      "1-028",
      "1-029",
      "1-030",
      "1-031"
    ],
    stage: 0,
    sprite: "egg",
    id: "0-001",
    url: "https://digimon.net/reference_en/"
  },
  {
    name_en: "Argomon",
    name_jp: "Algomon",
    next_evolutions: ["2-001"],
    stage: 1,
    sprite: "argomon_baby_i",
    id: "1-001",
    url: "https://digimon.net/reference_en/detail.php?directory_name=algomon_lv1"
  },
  {
    name_en: "Botamon",
    name_jp: "Botamon",
    next_evolutions: ["2-013", "2-026", "2-003"],
    stage: 1,
    sprite: "botamon",
    id: "1-002",
    url: "https://digimon.net/reference_en/detail.php?directory_name=botamon"
  },
  {
    name_en: "Chibomon",
    name_jp: "Chicomon",
    next_evolutions: ["2-006"],
    stage: 1,
    sprite: "chibomon",
    id: "1-003",
    url: "https://digimon.net/reference_en/detail.php?directory_name=chicomon"
  },
  {
    name_en: "Choromon",
    name_jp: "Choromon",
    next_evolutions: ["2-011"],
    stage: 1,
    sprite: "choromon",
    id: "1-004",
    url: "https://digimon.net/reference_en/detail.php?directory_name=choromon"
  },
  {
    name_en: "Conomon",
    name_jp: "Cocomon",
    next_evolutions: ["2-012"],
    stage: 1,
    sprite: "conomon",
    id: "1-005",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cocomon"
  },
  {
    name_en: "Cotsucomon",
    name_jp: "Cotsucomon",
    next_evolutions: ["2-010"],
    stage: 1,
    sprite: "cotsucomon",
    id: "1-006",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cotsucomon"
  },
  {
    name_en: "Dodomon",
    name_jp: "Dodomon",
    next_evolutions: ["2-007"],
    stage: 1,
    sprite: "dodomon",
    id: "1-007",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dodomon"
  },
  {
    name_en: "Fufumon",
    name_jp: "Fufumon",
    next_evolutions: ["2-014"],
    stage: 1,
    sprite: "fufumon",
    id: "1-008",
    url: "https://digimon.net/reference_en/detail.php?directory_name=fufumon"
  },
  {
    name_en: "Keemon",
    name_jp: "Kiimon",
    next_evolutions: ["2-027"],
    stage: 1,
    sprite: "keemon",
    id: "1-009",
    url: "https://digimon.net/reference_en/detail.php?directory_name=keemon"
  },
  {
    name_en: "Ketomon",
    name_jp: "Ketomon",
    next_evolutions: ["2-009"],
    stage: 1,
    sprite: "ketomon",
    id: "1-010",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ketomon"
  },
  {
    name_en: "Kuramon",
    name_jp: "Kuramon",
    next_evolutions: ["2-023"],
    stage: 1,
    sprite: "kuramon",
    id: "1-011",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kuramon"
  },
  {
    name_en: "Mokumon",
    name_jp: "Mokumon",
    next_evolutions: ["2-005", "2-011", "2-037"],
    stage: 1,
    sprite: "mokumon",
    id: "1-012",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mokumon"
  },
  {
    name_en: "Nyokimon",
    name_jp: "Nyokimon",
    next_evolutions: ["2-028", "2-003"],
    stage: 1,
    sprite: "nyokimon",
    id: "1-013",
    url: "https://digimon.net/reference_en/detail.php?directory_name=nyokimon"
  },
  {
    name_en: "Pabumon",
    name_jp: "Bubbmon",
    next_evolutions: ["2-015", "2-033"],
    stage: 1,
    sprite: "pabumon",
    id: "1-014",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bubbmon"
  },
  {
    name_en: "Petitmon",
    name_jp: "Petitmon",
    next_evolutions: ["2-002"],
    stage: 1,
    sprite: "petitmon",
    id: "1-015",
    url: "https://digimon.net/reference_en/detail.php?directory_name=petitmon"
  },
  {
    name_en: "Pichimon",
    name_jp: "Pitchmon",
    next_evolutions: ["2-004"],
    stage: 1,
    sprite: "pichimon",
    id: "1-016",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pitchmon"
  },
  {
    name_en: "Poyomon",
    name_jp: "Poyomon",
    next_evolutions: ["2-021"],
    stage: 1,
    sprite: "poyomon",
    id: "1-017",
    url: "https://digimon.net/reference_en/detail.php?directory_name=poyomon"
  },
  {
    name_en: "Punimon",
    name_jp: "Punimon",
    next_evolutions: ["2-024"],
    stage: 1,
    sprite: "punimon",
    id: "1-018",
    url: "https://digimon.net/reference_en/detail.php?directory_name=punimon"
  },
  {
    name_en: "Pururumon",
    name_jp: "Pururumon",
    next_evolutions: ["2-018"],
    stage: 1,
    sprite: "pururumon",
    id: "1-019",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pururumon"
  },
  {
    name_en: "Puttimon",
    name_jp: "Puttimon",
    next_evolutions: ["2-022"],
    stage: 1,
    sprite: "puttimon",
    id: "1-020",
    url: "https://digimon.net/reference_en/detail.php?directory_name=puttimon"
  },
  {
    name_en: "Sakumon",
    name_jp: "Sakumon",
    next_evolutions: ["2-019"],
    stage: 1,
    sprite: "sakumon",
    id: "1-021",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sakumon"
  },
  {
    name_en: "Tsubumon",
    name_jp: "Tsubumon",
    next_evolutions: ["2-025"],
    stage: 1,
    sprite: "tsubumon",
    id: "1-022",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tsubumon"
  },
  {
    name_en: "YukimiBotamon",
    name_jp: "Yukimibotamon",
    next_evolutions: ["2-016", "2-032", "2-034"],
    stage: 1,
    sprite: "yukimibotamon",
    id: "1-023",
    url: "https://digimon.net/reference_en/detail.php?directory_name=yukimibotamon"
  },
  {
    name_en: "Yuramon",
    name_jp: "Yuramon",
    next_evolutions: ["2-020", "2-003"],
    stage: 1,
    sprite: "yuramon",
    id: "1-024",
    url: "https://digimon.net/reference_en/detail.php?directory_name=yuramon"
  },
  {
    name_en: "Zerimon",
    name_jp: "Zerimon",
    next_evolutions: ["2-008"],
    stage: 1,
    sprite: "zerimon",
    id: "1-025",
    url: "https://digimon.net/reference_en/detail.php?directory_name=zerimon"
  },
  {
    name_en: "Zurumon",
    name_jp: "Zurumon",
    next_evolutions: ["2-017", "2-011"],
    stage: 1,
    sprite: "zurumon",
    id: "1-026",
    url: "https://digimon.net/reference_en/detail.php?directory_name=zurumon"
  },
  {
    name_en: "Chibickmon",
    name_jp: "Chibickmon",
    next_evolutions: ["2-035"],
    stage: 1,
    sprite: "chibickmon",
    id: "1-027",
    url: "https://digimon.net/reference_en/detail.php?directory_name=chibickmon"
  },
  {
    name_en: "Dokimon",
    name_jp: "Dokimon",
    next_evolutions: ["2-029"],
    stage: 1,
    sprite: "dokimon",
    id: "1-028",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dokimon"
  },
  {
    name_en: "Jyarimon",
    name_jp: "Jyarimon",
    next_evolutions: ["2-030"],
    stage: 1,
    sprite: "jyarimon",
    id: "1-029",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jyarimon"
  },
  {
    name_en: "Relemon",
    name_jp: "Relemon",
    next_evolutions: ["2-036"],
    stage: 1,
    sprite: "relemon",
    id: "1-030",
    url: "https://digimon.net/reference_en/detail.php?directory_name=relemon"
  },
  {
    name_en: "Sandmon",
    name_jp: "Sunamon",
    next_evolutions: ["2-031"],
    stage: 1,
    sprite: "sandmon",
    id: "1-031",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sunamon"
  },
  {
    name_en: "Argomon",
    name_jp: "Algomon",
    next_evolutions: ["3-005", "3-027", "3-045", "3-080"],
    stage: 2,
    sprite: "argomon_baby_ii",
    id: "2-001",
    url: "https://digimon.net/reference_en/detail.php?directory_name=algomon_lv2"
  },
  {
    name_en: "Bebydomon",
    name_jp: "Babydmon",
    next_evolutions: ["3-016", "3-003"],
    stage: 2,
    sprite: "bebydomon",
    id: "2-002",
    url: "https://digimon.net/reference_en/detail.php?directory_name=babydmon"
  },
  {
    name_en: "Budmon",
    name_jp: "Budmon",
    next_evolutions: ["3-046"],
    stage: 2,
    sprite: "budmon",
    id: "2-003",
    url: "https://digimon.net/reference_en/detail.php?directory_name=budmon"
  },
  {
    name_en: "Bukamon",
    name_jp: "Pukamon",
    next_evolutions: ["3-050", "3-012", "3-029", "3-013", "3-070", "3-065"],
    stage: 2,
    sprite: "bukamon",
    id: "2-004",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pukamon"
  },
  {
    name_en: "DemiMeramon",
    name_jp: "PetiMeramon",
    next_evolutions: ["3-072", "3-011", "3-014", "3-031", "3-079"],
    stage: 2,
    sprite: "demimeramon",
    id: "2-005",
    url: "https://digimon.net/reference_en/detail.php?directory_name=petimeramon"
  },
  {
    name_en: "DemiVeemon",
    name_jp: "Chibimon",
    next_evolutions: ["3-078"],
    stage: 2,
    sprite: "demiveemon",
    id: "2-006",
    url: "https://digimon.net/reference_en/detail.php?directory_name=chibimon"
  },
  {
    name_en: "Dorimon",
    name_jp: "Dorimon",
    next_evolutions: ["3-015", "3-082"],
    stage: 2,
    sprite: "dorimon",
    id: "2-007",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dorimon"
  },
  {
    name_en: "Gummymon",
    name_jp: "Gummymon",
    next_evolutions: ["3-015", "3-075", "3-009", "3-039", "3-057", "3-074"],
    stage: 2,
    sprite: "gummymon",
    id: "2-008",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gummymon"
  },
  {
    name_en: "Hopmon",
    name_jp: "Hopmon",
    next_evolutions: ["3-051", "3-040", "3-078", "3-039"],
    stage: 2,
    sprite: "hopmon",
    id: "2-009",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hopmon"
  },
  {
    name_en: "Kakkinmon",
    name_jp: "Kakkinmon",
    next_evolutions: ["3-049"],
    stage: 2,
    sprite: "kakkinmon",
    id: "2-010",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kakkinmon"
  },
  {
    name_en: "Kapurimon",
    name_jp: "Capromon",
    next_evolutions: ["3-033", "3-042", "3-077"],
    stage: 2,
    sprite: "kapurimon",
    id: "2-011",
    url: "https://digimon.net/reference_en/detail.php?directory_name=capromon"
  },
  {
    name_en: "Kokomon",
    name_jp: "Chocomon",
    next_evolutions: ["3-062", "3-048", "3-009", "3-039", "3-071", "3-047"],
    stage: 2,
    sprite: "kokomon",
    id: "2-012",
    url: "https://digimon.net/reference_en/detail.php?directory_name=chocomon"
  },
  {
    name_en: "Koromon",
    name_jp: "Koromon",
    next_evolutions: ["3-001", "3-007", "3-032", "3-010", "3-051", "3-082"],
    stage: 2,
    sprite: "koromon",
    id: "2-013",
    url: "https://digimon.net/reference_en/detail.php?directory_name=koromon"
  },
  {
    name_en: "Kyokyomon",
    name_jp: "Kyokyomon",
    next_evolutions: ["3-062"],
    stage: 2,
    sprite: "kyokyomon",
    id: "2-014",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kyokyomon"
  },
  {
    name_en: "Motimon",
    name_jp: "Mochimon",
    next_evolutions: ["3-073", "3-031", "3-054", "3-052", "3-046"],
    stage: 2,
    sprite: "motimon",
    id: "2-015",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mochimon"
  },
  {
    name_en: "Nyaromon",
    name_jp: "Nyaromon",
    next_evolutions: ["3-063", "3-001", "3-022"],
    stage: 2,
    sprite: "nyaromon",
    id: "2-016",
    url: "https://digimon.net/reference_en/detail.php?directory_name=nyaromon"
  },
  {
    name_en: "Pagumon",
    name_jp: "Pagumon",
    next_evolutions: ["3-026", "3-028", "3-027"],
    stage: 2,
    sprite: "pagumon",
    id: "2-017",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pagumon"
  },
  {
    name_en: "Poromon",
    name_jp: "Poromon",
    next_evolutions: ["3-060", "3-076", "3-020", "3-034", "3-025", "3-080"],
    stage: 2,
    sprite: "poromon",
    id: "2-018",
    url: "https://digimon.net/reference_en/detail.php?directory_name=poromon"
  },
  {
    name_en: "Sakuttomon",
    name_jp: "Sakuttomon",
    next_evolutions: ["3-081", "3-036", "3-062"],
    stage: 2,
    sprite: "sakuttomon",
    id: "2-019",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sakuttomon"
  },
  {
    name_en: "Tanemon",
    name_jp: "Tanemon",
    next_evolutions: ["3-008", "3-056", "3-076", "3-060"],
    stage: 2,
    sprite: "tanemon",
    id: "2-020",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tanemon"
  },
  {
    name_en: "Tokomon",
    name_jp: "Tokomon",
    next_evolutions: ["3-058", "3-044", "3-066", "3-032"],
    stage: 2,
    sprite: "tokomon",
    id: "2-021",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tokomon"
  },
  {
    name_en: "Tokomon X",
    name_jp: "Tokomon X",
    next_evolutions: ["3-061", "3-004", "3-035", "3-017", "3-023", "3-067"],
    stage: 2,
    sprite: "tokomon_x",
    id: "2-022",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tokomon_x"
  },
  {
    name_en: "Tsumemon",
    name_jp: "Tsumemon",
    next_evolutions: ["3-041", "3-083"],
    stage: 2,
    sprite: "tsumemon",
    id: "2-023",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tsumemon"
  },
  {
    name_en: "Tsunomon",
    name_jp: "Tunomon",
    next_evolutions: ["3-022", "3-019", "3-083"],
    stage: 2,
    sprite: "tsunomon",
    id: "2-024",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tunomon"
  },
  {
    name_en: "Upamon",
    name_jp: "Upamon",
    next_evolutions: ["3-069", "3-065", "3-028", "3-006", "3-058", "3-078"],
    stage: 2,
    sprite: "upamon",
    id: "2-025",
    url: "https://digimon.net/reference_en/detail.php?directory_name=upamon"
  },
  {
    name_en: "Wanyamon",
    name_jp: "Wanyamon",
    next_evolutions: ["3-068", "3-024", "3-052", "3-063", "3-028", "3-059", "3-012", "3-050"],
    stage: 2,
    sprite: "wanyamon",
    id: "2-026",
    url: "https://digimon.net/reference_en/detail.php?directory_name=wanyamon"
  },
  {
    name_en: "Yaamon",
    name_jp: "Yarmon",
    next_evolutions: ["3-030", "3-043", "3-002", "3-035", "3-018", "3-064", "3-055", "3-038", "3-037"],
    stage: 2,
    sprite: "yaamon",
    id: "2-027",
    url: "https://digimon.net/reference_en/detail.php?directory_name=yarmon"
  },
  {
    name_en: "Yokomon",
    name_jp: "Pyocomon",
    next_evolutions: ["3-008", "3-021", "3-056", "3-053", "3-039"],
    stage: 2,
    sprite: "yokomon",
    id: "2-028",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pyocomon"
  },
  {
    name_en: "Bibimon",
    name_jp: "Bibimon",
    next_evolutions: ["3-084", "3-066"],
    stage: 2,
    sprite: "bibimon",
    id: "2-029",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bibimon"
  },
  {
    name_en: "Gigimon",
    name_jp: "Gigimon",
    next_evolutions: ["3-032"],
    stage: 2,
    sprite: "gigimon",
    id: "2-030",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gigimon"
  },
  {
    name_en: "Tumblemon",
    name_jp: "Goromon",
    next_evolutions: ["3-068"],
    stage: 2,
    sprite: "tumblemon",
    id: "2-031",
    url: "https://digimon.net/reference_en/detail.php?directory_name=goromon"
  },
  {
    name_en: "Hiyarimon",
    name_jp: "Hiyarimon",
    next_evolutions: ["3-009"],
    stage: 2,
    sprite: "hiyarimon",
    id: "2-032",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hiyarimon"
  },
  {
    name_en: "Minomon",
    name_jp: "Minomon",
    next_evolutions: ["3-080"],
    stage: 2,
    sprite: "",
    id: "2-033",
    url: "https://digimon.net/reference_en/detail.php?directory_name=minomon"
  },
  {
    name_en: "Moonmon",
    name_jp: "Moonmon",
    next_evolutions: ["3-082", "3-026", "3-047", "3-050"],
    stage: 2,
    sprite: "moonmon",
    id: "2-034",
    url: "https://digimon.net/reference_en/detail.php?directory_name=moonmon"
  },
  {
    name_en: "Pickmon",
    name_jp: "Pickmon",
    next_evolutions: ["3-066"],
    stage: 2,
    sprite: "pickmon",
    id: "2-035",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pickmon"
  },
  {
    name_en: "Viximon",
    name_jp: "Pokomon",
    next_evolutions: ["3-085"],
    stage: 2,
    sprite: "viximon",
    id: "2-036",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pokomon"
  },
  {
    name_en: "Sunmon",
    name_jp: "Sunmon",
    next_evolutions: ["3-012", "3-019", "3-032", "3-063"],
    stage: 2,
    sprite: "sunmon",
    id: "2-037",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sunmon"
  },
  {
    name_en: "Agumon",
    name_jp: "Agumon",
    next_evolutions: [
      "4-054",
      "4-135",
      "4-028",
      "4-079",
      "4-088",
      "4-070",
      "4-004",
      "4-087",
      "4-046",
      "4-008",
      "4-091",
      "4-017",
      "4-023",
      "4-084",
      "4-101",
      "4-050",
      "4-055",
      "4-022",
      "4-019",
      "4-001",
      "4-013",
      "7-041"
    ],
    stage: 3,
    sprite: "agumon",
    id: "3-001",
    url: "https://digimon.net/reference_en/detail.php?directory_name=agumon"
  },
  {
    name_en: "Agumon (Black) X",
    name_jp: "Agumon (Black) X",
    next_evolutions: ["4-024", "4-067", "4-089", "4-003"],
    stage: 3,
    sprite: "agumon_black_x",
    id: "3-002",
    url: "https://digimon.net/reference_en/detail.php?directory_name=agumon_b_x"
  },
  {
    name_en: "Agumon Expert",
    name_jp: "Agumon Hakase",
    next_evolutions: ["4-027", "4-019"],
    stage: 3,
    sprite: "agumon_expert",
    id: "3-003",
    url: "https://digimon.net/reference_en/detail.php?directory_name=agumonhakase"
  },
  {
    name_en: "Agumon X",
    name_jp: "Agumon X",
    next_evolutions: ["4-136", "4-126", "4-021"],
    stage: 3,
    sprite: "agumon_x",
    id: "3-004",
    url: "https://digimon.net/reference_en/detail.php?directory_name=agumon_x"
  },
  {
    name_en: "Argomon",
    name_jp: "Algomon",
    next_evolutions: ["4-008", "4-028", "4-083"],
    stage: 3,
    sprite: "argomon_child",
    id: "3-005",
    url: "https://digimon.net/reference_en/detail.php?directory_name=algomon_lv3"
  },
  {
    name_en: "Armadillomon",
    name_jp: "Armadimon",
    next_evolutions: ["4-005", "4-118", "4-111"],
    stage: 3,
    sprite: "armadillomon",
    id: "3-006",
    url: "https://digimon.net/reference_en/detail.php?directory_name=armadimon"
  },
  {
    name_en: "Betamon",
    name_jp: "Betamon",
    next_evolutions: ["4-002", "4-107", "4-028", "4-079", "4-088"],
    stage: 3,
    sprite: "betamon",
    id: "3-007",
    url: "https://digimon.net/reference_en/detail.php?directory_name=betamon"
  },
  {
    name_en: "Biyomon",
    name_jp: "Piyomon",
    next_evolutions: [
      "4-084",
      "4-064",
      "4-070",
      "4-066",
      "4-085",
      "4-014",
      "4-063",
      "4-145",
      "4-102",
      "4-138",
      "4-127",
      "4-096",
      "4-150"
    ],
    stage: 3,
    sprite: "biyomon",
    id: "3-008",
    url: "https://digimon.net/reference_en/detail.php?directory_name=piyomon"
  },
  {
    name_en: "Bulucomon",
    name_jp: "Blucomon",
    next_evolutions: ["4-094", "4-109", "4-080", "4-128", "4-144", "4-052", "4-093", "4-043", "4-149"],
    stage: 3,
    sprite: "bulucomon",
    id: "3-009",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bulucomon"
  },
  {
    name_en: "BushiAgumon",
    name_jp: "BushiAgumon",
    next_evolutions: ["4-103", "4-009", "4-075"],
    stage: 3,
    sprite: "bushiagumon",
    id: "3-010",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bushiagumon"
  },
  {
    name_en: "Candlemon",
    name_jp: "Candmon",
    next_evolutions: ["4-046", "4-079", "4-143", "4-028", "4-006"],
    stage: 3,
    sprite: "candlemon",
    id: "3-011",
    url: "https://digimon.net/reference_en/detail.php?directory_name=candmon"
  },
  {
    name_en: "Coronamon",
    name_jp: "Coronamon",
    next_evolutions: ["4-040", "4-044", "4-070", "4-001"],
    stage: 3,
    sprite: "coronamon",
    id: "3-012",
    url: "https://digimon.net/reference_en/detail.php?directory_name=coronamon"
  },
  {
    name_en: "Crabmon",
    name_jp: "Ganimon",
    next_evolutions: ["4-032", "4-107", "4-036", "4-017", "4-051", "4-090"],
    stage: 3,
    sprite: "crabmon",
    id: "3-013",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ganimon"
  },
  {
    name_en: "DemiDevimon",
    name_jp: "PicoDevimon",
    next_evolutions: ["4-028", "4-079", "4-031", "4-143", "4-011"],
    stage: 3,
    sprite: "demidevimon",
    id: "3-014",
    url: "https://digimon.net/reference_en/detail.php?directory_name=picodevimon"
  },
  {
    name_en: "Dorumon",
    name_jp: "DORUmon",
    next_evolutions: ["4-033", "4-100", "4-109", "4-080", "4-093"],
    stage: 3,
    sprite: "dorumon",
    id: "3-015",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dorumon"
  },
  {
    name_en: "Dracomon",
    name_jp: "Dracomon",
    next_evolutions: ["4-050"],
    stage: 3,
    sprite: "dracomon",
    id: "3-016",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dracomon"
  },
  {
    name_en: "Dracomon X",
    name_jp: "Dracomon X",
    next_evolutions: ["4-056", "4-114", "4-021"],
    stage: 3,
    sprite: "dracomon_x",
    id: "3-017",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dracomon_x"
  },
  {
    name_en: "Duskmon",
    name_jp: "Duskmon",
    next_evolutions: ["4-024", "4-140", "4-089", "4-092"],
    stage: 3,
    sprite: "duskmon",
    id: "3-018",
    url: "https://digimon.net/reference_en/detail.php?directory_name=duskmon"
  },
  {
    name_en: "Elecmon",
    name_jp: "Elecmon",
    next_evolutions: ["4-014", "4-141", "4-004", "4-043", "4-139"],
    stage: 3,
    sprite: "elecmon",
    id: "3-019",
    url: "https://digimon.net/reference_en/detail.php?directory_name=elecmon"
  },
  {
    name_en: "Falcomon",
    name_jp: "Falcomon",
    next_evolutions: ["4-096", "4-029", "4-139"],
    stage: 3,
    sprite: "falcomon",
    id: "3-020",
    url: "https://digimon.net/reference_en/detail.php?directory_name=falcomon"
  },
  {
    name_en: "Floramon",
    name_jp: "Floramon",
    next_evolutions: ["4-063", "4-014", "4-138", "4-102", "4-127"],
    stage: 3,
    sprite: "floramon",
    id: "3-021",
    url: "https://digimon.net/reference_en/detail.php?directory_name=floramon"
  },
  {
    name_en: "Gabumon",
    name_jp: "Gabumon",
    next_evolutions: [
      "4-062",
      "4-046",
      "4-004",
      "4-043",
      "4-139",
      "4-047",
      "4-070",
      "4-087",
      "4-031",
      "4-008",
      "4-034",
      "4-072",
      "7-042"
    ],
    stage: 3,
    sprite: "gabumon",
    id: "3-022",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gabumon"
  },
  {
    name_en: "Gabumon X",
    name_jp: "Gabumon X",
    next_evolutions: ["4-104", "4-126", "4-021"],
    stage: 3,
    sprite: "gabumon_x",
    id: "3-023",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gabumon_x"
  },
  {
    name_en: "Gaomon",
    name_jp: "Gaomon",
    next_evolutions: ["4-010", "4-044", "4-105", "4-040", "4-069"],
    stage: 3,
    sprite: "gaomon",
    id: "3-024",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gaomon"
  },
  {
    name_en: "Gatomon",
    name_jp: "Tailmon",
    next_evolutions: ["4-007", "4-047"],
    stage: 3,
    sprite: "gatomon",
    id: "3-025",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tailmon"
  },
  {
    name_en: "Gazimon",
    name_jp: "Gazimon",
    next_evolutions: ["4-023", "4-020", "4-027", "4-132", "4-101", "4-035", "4-074"],
    stage: 3,
    sprite: "gazimon",
    id: "3-026",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gazimon"
  },
  {
    name_en: "Ghostmon",
    name_jp: "Ghostmon",
    next_evolutions: ["4-142", "4-008", "4-041", "4-143", "4-028", "4-011", "4-152"],
    stage: 3,
    sprite: "ghostmon",
    id: "3-027",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ghostmon"
  },
  {
    name_en: "Gizamon",
    name_jp: "Gizamon",
    next_evolutions: ["4-042", "4-025", "4-027", "4-132", "4-101", "4-043", "4-111", "4-112", "4-125", "4-036"],
    stage: 3,
    sprite: "gizamon",
    id: "3-028",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gizamon"
  },
  {
    name_en: "Gomamon",
    name_jp: "Gomamon",
    next_evolutions: ["4-060", "4-032", "4-036", "4-017", "4-090", "4-051"],
    stage: 3,
    sprite: "gomamon",
    id: "3-029",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gomamon"
  },
  {
    name_en: "Gomamon X",
    name_jp: "Gomamon X",
    next_evolutions: ["4-076", "4-067", "4-003"],
    stage: 3,
    sprite: "gomamon_x",
    id: "3-030",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gomamon_x"
  },
  {
    name_en: "Gotsumon",
    name_jp: "Gottsumon",
    next_evolutions: ["4-084", "4-129", "4-115", "4-049"],
    stage: 3,
    sprite: "gotsumon",
    id: "3-031",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gottsumon"
  },
  {
    name_en: "Guilmon",
    name_jp: "Guilmon",
    next_evolutions: ["4-055", "4-012", "4-050", "4-009", "4-075", "4-027", "4-001"],
    stage: 3,
    sprite: "guilmon",
    id: "3-032",
    url: "https://digimon.net/reference_en/detail.php?directory_name=guilmon"
  },
  {
    name_en: "Hagurumon",
    name_jp: "Hagurumon",
    next_evolutions: ["4-057", "4-121", "4-054", "4-078", "4-073", "4-101"],
    stage: 3,
    sprite: "hagurumon",
    id: "3-033",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hagurumon"
  },
  {
    name_en: "Hawkmon",
    name_jp: "Hawkmon",
    next_evolutions: ["4-007", "4-096", "4-064"],
    stage: 3,
    sprite: "hawkmon",
    id: "3-034",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hawkmon"
  },
  {
    name_en: "Herissmon",
    name_jp: "Herissmon",
    next_evolutions: ["4-106", "4-136", "4-021", "4-067", "4-039", "4-089", "4-086"],
    stage: 3,
    sprite: "herissmon",
    id: "3-035",
    url: "https://digimon.net/reference_en/detail.php?directory_name=herissmon"
  },
  {
    name_en: "Huckmon",
    name_jp: "Hackmon",
    next_evolutions: ["4-122", "4-009", "4-018", "4-013"],
    stage: 3,
    sprite: "huckmon",
    id: "3-036",
    url: "https://digimon.net/reference_en/detail.php?directory_name=huckmon"
  },
  {
    name_en: "Impmon",
    name_jp: "Impmon",
    next_evolutions: ["4-074", "4-110", "4-130", "4-143"],
    stage: 3,
    sprite: "impmon",
    id: "3-037",
    url: "https://digimon.net/reference_en/detail.php?directory_name=impmon"
  },
  {
    name_en: "Impmon X",
    name_jp: "Impmon X",
    next_evolutions: ["4-092", "4-108", "4-089", "4-003"],
    stage: 3,
    sprite: "impmon_x",
    id: "3-038",
    url: "https://digimon.net/reference_en/detail.php?directory_name=impmon_x"
  },
  {
    name_en: "Jazamon",
    name_jp: "Jazamon",
    next_evolutions: ["4-061", "4-100", "4-093", "4-097", "4-134", "4-065", "4-073", "4-101", "4-014"],
    stage: 3,
    sprite: "jazamon",
    id: "3-039",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jazamon"
  },
  {
    name_en: "Junkmon",
    name_jp: "Junkmon",
    next_evolutions: ["4-065", "4-082", "4-101"],
    stage: 3,
    sprite: "junkmon",
    id: "3-040",
    url: "https://digimon.net/reference_en/detail.php?directory_name=junkmon"
  },
  {
    name_en: "Keramon X",
    name_jp: "Keramon X",
    next_evolutions: ["7-012"],
    stage: 3,
    sprite: "keramon_x",
    id: "3-041",
    url: "https://digimon.net/reference_en/detail.php?directory_name=keramon_x"
  },
  {
    name_en: "Kokuwamon",
    name_jp: "Kokuwamon",
    next_evolutions: ["4-123", "4-057", "4-121", "4-016", "4-026"],
    stage: 3,
    sprite: "kokuwamon",
    id: "3-042",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kokuwamon"
  },
  {
    name_en: "Kokuwamon X",
    name_jp: "Kokuwamon X",
    next_evolutions: ["4-067", "4-039", "4-089", "4-140", "4-003"],
    stage: 3,
    sprite: "kokuwamon_x",
    id: "3-043",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kokuwamon_x"
  },
  {
    name_en: "Kunemon",
    name_jp: "Kunemon",
    next_evolutions: ["4-111", "4-034", "4-091", "4-011", "4-119"],
    stage: 3,
    sprite: "kunemon",
    id: "3-044",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kunemon"
  },
  {
    name_en: "Labramon",
    name_jp: "Labramon",
    next_evolutions: ["4-030", "4-008", "4-083"],
    stage: 3,
    sprite: "labramon",
    id: "3-045",
    url: "https://digimon.net/reference_en/detail.php?directory_name=labramon"
  },
  {
    name_en: "Lalamon",
    name_jp: "Lalamon",
    next_evolutions: ["4-120", "4-059"],
    stage: 3,
    sprite: "lalamon",
    id: "3-046",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lalamon"
  },
  {
    name_en: "Lopmon",
    name_jp: "Lopmon",
    next_evolutions: ["4-131"],
    stage: 3,
    sprite: "lopmon",
    id: "3-047",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lopmon"
  },
  {
    name_en: "Lopmon X",
    name_jp: "Lopmon X",
    next_evolutions: ["4-097", "4-048", "4-144", "4-052"],
    stage: 3,
    sprite: "lopmon_x",
    id: "3-048",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lopmon_x"
  },
  {
    name_en: "Ludomon",
    name_jp: "Ludomon",
    next_evolutions: ["4-124", "4-103"],
    stage: 3,
    sprite: "ludomon",
    id: "3-049",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ludomon"
  },
  {
    name_en: "Lunamon",
    name_jp: "Lunamon",
    next_evolutions: ["4-069", "4-074", "4-044"],
    stage: 3,
    sprite: "lunamon",
    id: "3-050",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lunamon"
  },
  {
    name_en: "Monodramon",
    name_jp: "Monodramon",
    next_evolutions: ["4-054", "4-101", "4-117", "4-037"],
    stage: 3,
    sprite: "monodramon",
    id: "3-051",
    url: "https://digimon.net/reference_en/detail.php?directory_name=monodramon"
  },
  {
    name_en: "Morphomon",
    name_jp: "Morphomon",
    next_evolutions: ["4-059", "4-137", "4-105"],
    stage: 3,
    sprite: "morphomon",
    id: "3-052",
    url: "https://digimon.net/reference_en/detail.php?directory_name=morphomon"
  },
  {
    name_en: "Mushroomon",
    name_jp: "Mushmon",
    next_evolutions: ["4-138", "4-145", "4-127", "4-102", "4-014"],
    stage: 3,
    sprite: "mushroomon",
    id: "3-053",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mushmon"
  },
  {
    name_en: "Otamamon",
    name_jp: "Otamamon",
    next_evolutions: ["4-047", "4-115", "4-066", "4-049"],
    stage: 3,
    sprite: "otamamon",
    id: "3-054",
    url: "https://digimon.net/reference_en/detail.php?directory_name=otamamon"
  },
  {
    name_en: "Otamamon X",
    name_jp: "Otamamon X",
    next_evolutions: ["4-108", "4-039", "4-089", "4-140", "4-003"],
    stage: 3,
    sprite: "otamamon_x",
    id: "3-055",
    url: "https://digimon.net/reference_en/detail.php?directory_name=otamamon_x"
  },
  {
    name_en: "Palmon",
    name_jp: "Palmon",
    next_evolutions: [
      "4-017",
      "4-083",
      "4-070",
      "4-066",
      "4-085",
      "4-127",
      "4-145",
      "4-063",
      "4-102",
      "4-014",
      "4-120",
      "4-095",
      "4-139"
    ],
    stage: 3,
    sprite: "palmon",
    id: "3-056",
    url: "https://digimon.net/reference_en/detail.php?directory_name=palmon"
  },
  {
    name_en: "Palmon X",
    name_jp: "Palmon X",
    next_evolutions: ["4-128", "4-100", "4-093"],
    stage: 3,
    sprite: "palmon_x",
    id: "3-057",
    url: "https://digimon.net/reference_en/detail.php?directory_name=palmon_x"
  },
  {
    name_en: "Patamon",
    name_jp: "Patamon",
    next_evolutions: ["4-137", "4-015", "4-091", "4-011", "4-119", "4-004", "4-113", "5-122", "4-081", "4-005"],
    stage: 3,
    sprite: "patamon",
    id: "3-058",
    url: "https://digimon.net/reference_en/detail.php?directory_name=patamon"
  },
  {
    name_en: "Phascomon",
    name_jp: "Phascomon",
    next_evolutions: ["4-099", "4-110", "4-130", "4-074", "4-070"],
    stage: 3,
    sprite: "phascomon",
    id: "3-059",
    url: "https://digimon.net/reference_en/detail.php?directory_name=phascomon"
  },
  {
    name_en: "Pomumon",
    name_jp: "Pomumon",
    next_evolutions: ["4-095", "4-064", "4-139"],
    stage: 3,
    sprite: "pomumon",
    id: "3-060",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pomumon"
  },
  {
    name_en: "Renamon X",
    name_jp: "Renamon X",
    next_evolutions: ["4-071", "4-106", "4-021"],
    stage: 3,
    sprite: "renamon_x",
    id: "3-061",
    url: "https://digimon.net/reference_en/detail.php?directory_name=renamon_x"
  },
  {
    name_en: "Ryudamon",
    name_jp: "Ryudamon",
    next_evolutions: ["4-052", "4-134", "4-097", "4-144", "4-093", "4-031", "4-025", "4-088"],
    stage: 3,
    sprite: "ryudamon",
    id: "3-062",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ryudamon"
  },
  {
    name_en: "Salamon",
    name_jp: "Plotmon",
    next_evolutions: ["4-077", "4-047", "4-004", "4-046", "4-087", "4-054", "4-137", "4-053", "4-013"],
    stage: 3,
    sprite: "salamon",
    id: "3-063",
    url: "https://digimon.net/reference_en/detail.php?directory_name=plotmon"
  },
  {
    name_en: "Salamon X",
    name_jp: "Plotmon X",
    next_evolutions: ["4-086", "4-108", "4-003"],
    stage: 3,
    sprite: "salamon_x",
    id: "3-064",
    url: "https://digimon.net/reference_en/detail.php?directory_name=plotmon_x"
  },
  {
    name_en: "Sangomon",
    name_jp: "Sangomon",
    next_evolutions: ["4-111", "4-058", "4-112", "4-125", "4-107", "4-090"],
    stage: 3,
    sprite: "sangomon",
    id: "3-065",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sangomon"
  },
  {
    name_en: "Shoutmon",
    name_jp: "Shoutmon",
    next_evolutions: ["4-113", "5-122", "4-081", "4-022", "4-103", "4-147"],
    stage: 3,
    sprite: "shoutmon",
    id: "3-066",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shoutmon"
  },
  {
    name_en: "Sistermon Blanc",
    name_jp: "Sistermon Blanc",
    next_evolutions: ["4-114", "4-104", "4-021"],
    stage: 3,
    sprite: "sistermon_blanc",
    id: "3-067",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sistermonblanc"
  },
  {
    name_en: "Sunarizamon",
    name_jp: "Sunarizamon",
    next_evolutions: ["4-010", "4-053", "4-105", "4-129", "4-127"],
    stage: 3,
    sprite: "sunarizamon",
    id: "3-068",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sunarizamon"
  },
  {
    name_en: "Swimmon",
    name_jp: "Swimmon",
    next_evolutions: ["4-125", "4-118", "4-112"],
    stage: 3,
    sprite: "swimmon",
    id: "3-069",
    url: "https://digimon.net/reference_en/detail.php?directory_name=swimmon"
  },
  {
    name_en: "Syakomon",
    name_jp: "Shakomon",
    next_evolutions: ["4-060", "4-107", "4-051", "4-090", "4-133"],
    stage: 3,
    sprite: "syakomon",
    id: "3-070",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shakomon"
  },
  {
    name_en: "Syakomon X",
    name_jp: "Shakomon X",
    next_evolutions: ["4-134", "4-144", "4-093", "4-052"],
    stage: 3,
    sprite: "syakomon_x",
    id: "3-071",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shakomon_x"
  },
  {
    name_en: "Tapirmon",
    name_jp: "Bakumon",
    next_evolutions: ["4-006", "4-079", "4-143", "4-046"],
    stage: 3,
    sprite: "tapirmon",
    id: "3-072",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bakumon"
  },
  {
    name_en: "Tentomon",
    name_jp: "Tentomon",
    next_evolutions: ["4-062", "4-047", "4-129", "4-066", "4-049", "4-120"],
    stage: 3,
    sprite: "tentomon",
    id: "3-073",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tentomon"
  },
  {
    name_en: "Terriermon",
    name_jp: "Terriermon",
    next_evolutions: ["4-045", "4-131"],
    stage: 3,
    sprite: "terriermon",
    id: "3-074",
    url: "https://digimon.net/reference_en/detail.php?directory_name=terriermon"
  },
  {
    name_en: "Terriermon X",
    name_jp: "Terriermon X",
    next_evolutions: ["4-109", "4-033", "4-080", "4-128"],
    stage: 3,
    sprite: "terriermon_x",
    id: "3-075",
    url: "https://digimon.net/reference_en/detail.php?directory_name=terriermon_x"
  },
  {
    name_en: "Tinkermon",
    name_jp: "Tinkermon",
    next_evolutions: ["4-098", "4-064", "4-095", "4-139"],
    stage: 3,
    sprite: "tinkermon",
    id: "3-076",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tinkermon"
  },
  {
    name_en: "ToyAgumon",
    name_jp: "ToyAgumon",
    next_evolutions: ["4-054", "4-123", "4-016", "4-078", "4-026"],
    stage: 3,
    sprite: "toyagumon",
    id: "3-077",
    url: "https://digimon.net/reference_en/detail.php?directory_name=toyagumon"
  },
  {
    name_en: "Veemon",
    name_jp: "V-mon",
    next_evolutions: ["4-038", "4-065", "4-082", "4-138", "4-072"],
    stage: 3,
    sprite: "veemon",
    id: "3-078",
    url: "https://digimon.net/reference_en/detail.php?directory_name=v-mon"
  },
  {
    name_en: "Vorvomon",
    name_jp: "Vorvomon",
    next_evolutions: ["4-068", "4-014", "4-135", "4-079"],
    stage: 3,
    sprite: "vorvomon",
    id: "3-079",
    url: "https://digimon.net/reference_en/detail.php?directory_name=vorvomon"
  },
  {
    name_en: "Wormmon",
    name_jp: "Wormmon",
    next_evolutions: ["4-116", "4-028", "4-142", "4-110", "4-059", "4-105"],
    stage: 3,
    sprite: "wormmon",
    id: "3-080",
    url: "https://digimon.net/reference_en/detail.php?directory_name=wormmon"
  },
  {
    name_en: "Zubamon",
    name_jp: "Zubamon",
    next_evolutions: ["4-146", "4-122", "4-031", "4-013"],
    stage: 3,
    sprite: "zubamon",
    id: "3-081",
    url: "https://digimon.net/reference_en/detail.php?directory_name=zubamon"
  },
  {
    name_en: "Agumon (Black)",
    name_jp: "Agumon (Black)",
    next_evolutions: ["4-054", "4-023", "4-084", "4-002"],
    stage: 3,
    sprite: "agumon_black",
    id: "3-082",
    url: "https://digimon.net/reference_en/detail.php?directory_name=agumon-black"
  },
  {
    name_en: "Dracmon",
    name_jp: "Dracumon",
    next_evolutions: ["5-067"],
    stage: 3,
    sprite: "dracmon",
    id: "3-083",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dracumon"
  },
  {
    name_en: "Pulsemon",
    name_jp: "Pulsemon",
    next_evolutions: ["4-147", "4-123"],
    stage: 3,
    sprite: "pulsemon",
    id: "3-084",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pulsemon"
  },
  {
    name_en: "Renamon",
    name_jp: "Renamon",
    next_evolutions: ["4-148", "4-096"],
    stage: 3,
    sprite: "renamon",
    id: "3-085",
    url: "https://digimon.net/reference_en/detail.php?directory_name=renamon"
  },
  {
    name_en: "Agunimon",
    name_jp: "Agnimon",
    next_evolutions: ["5-002", "5-016", "5-145", "5-149"],
    stage: 4,
    sprite: "agunimon",
    id: "4-001",
    url: "https://digimon.net/reference_en/detail.php?directory_name=agnimon"
  },
  {
    name_en: "Airdramon",
    name_jp: "Airdramon",
    next_evolutions: ["5-088", "5-086", "5-093", "5-080"],
    stage: 4,
    sprite: "airdramon",
    id: "4-002",
    url: "https://digimon.net/reference_en/detail.php?directory_name=airdramon"
  },
  {
    name_en: "Allomon X",
    name_jp: "Allomon X",
    next_evolutions: ["5-132", "5-074", "5-072", "5-092"],
    stage: 4,
    sprite: "allomon_x",
    id: "4-003",
    url: "https://digimon.net/reference_en/detail.php?directory_name=allomon_x"
  },
  {
    name_en: "Angemon",
    name_jp: "Angemon",
    next_evolutions: ["5-126", "5-069", "5-004", "5-010", "5-120", "5-036", "5-075", "5-091"],
    stage: 4,
    sprite: "angemon",
    id: "4-004",
    url: "https://digimon.net/reference_en/detail.php?directory_name=angemon"
  },
  {
    name_en: "Ankylomon",
    name_jp: "Ankylomon",
    next_evolutions: ["5-076", "5-120", "5-049", "5-085", "5-108", "5-105"],
    stage: 4,
    sprite: "ankylomon",
    id: "4-005",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ankylomon"
  },
  {
    name_en: "Apemon",
    name_jp: "Hanumon",
    next_evolutions: ["5-073", "5-139", "5-110", "5-147"],
    stage: 4,
    sprite: "apemon",
    id: "4-006",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hanumon"
  },
  {
    name_en: "Aquilamon",
    name_jp: "Aquilamon",
    next_evolutions: ["5-123", "5-050", "5-106", "5-130", "5-057", "5-031"],
    stage: 4,
    sprite: "aquilamon",
    id: "4-007",
    url: "https://digimon.net/reference_en/detail.php?directory_name=aquilamon"
  },
  {
    name_en: "Argomon",
    name_jp: "Algomon",
    next_evolutions: [
      "5-007",
      "5-057",
      "5-097",
      "5-087",
      "5-070",
      "5-093",
      "5-003",
      "5-118",
      "5-139",
      "5-013",
      "5-138",
      "5-106",
      "5-015"
    ],
    stage: 4,
    sprite: "argomon_adult",
    id: "4-008",
    url: "https://digimon.net/reference_en/detail.php?directory_name=algomon_lv4"
  },
  {
    name_en: "Arresterdramon",
    name_jp: "Arresterdramon",
    next_evolutions: ["5-115", "5-135", "5-117"],
    stage: 4,
    sprite: "arresterdramon",
    id: "4-009",
    url: "https://digimon.net/reference_en/detail.php?directory_name=arresterdramon"
  },
  {
    name_en: "Baboongamon",
    name_jp: "Baboongamon",
    next_evolutions: ["5-046", "5-055", "5-068"],
    stage: 4,
    sprite: "baboongamon",
    id: "4-010",
    url: "https://digimon.net/reference_en/detail.php?directory_name=baboongamon"
  },
  {
    name_en: "Bakemon",
    name_jp: "Bakemon",
    next_evolutions: ["5-045", "5-107", "5-059", "5-110", "5-011", "5-098"],
    stage: 4,
    sprite: "bakemon",
    id: "4-011",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bakemon"
  },
  {
    name_en: "Baluchimon",
    name_jp: "Baluchimon",
    next_evolutions: ["5-075", "5-111", "5-036", "5-135"],
    stage: 4,
    sprite: "baluchimon",
    id: "4-012",
    url: "https://digimon.net/reference_en/detail.php?directory_name=baluchimon"
  },
  {
    name_en: "BaoHuckmon",
    name_jp: "BaoHuckmon",
    next_evolutions: ["5-117", "5-039", "5-036", "5-048"],
    stage: 4,
    sprite: "baohuckmon",
    id: "4-013",
    url: "https://digimon.net/reference_en/detail.php?directory_name=baohuckmon"
  },
  {
    name_en: "Birdramon",
    name_jp: "Birdramon",
    next_evolutions: ["5-126", "5-043", "5-001", "5-014", "5-029", "5-061", "5-041", "5-048"],
    stage: 4,
    sprite: "birdramon",
    id: "4-014",
    url: "https://digimon.net/reference_en/detail.php?directory_name=birdramon"
  },
  {
    name_en: "Centarumon",
    name_jp: "Centalmon",
    next_evolutions: ["5-045"],
    stage: 4,
    sprite: "centarumon",
    id: "4-015",
    url: "https://digimon.net/reference_en/detail.php?directory_name=centalmon"
  },
  {
    name_en: "Clockmon",
    name_jp: "Clockmon",
    next_evolutions: ["5-003", "5-087", "5-058", "5-137", "5-013"],
    stage: 4,
    sprite: "clockmon",
    id: "4-016",
    url: "https://digimon.net/reference_en/detail.php?directory_name=clockmon"
  },
  {
    name_en: "Coelamon",
    name_jp: "Coelamon",
    next_evolutions: ["5-080", "5-118", "5-141", "5-082", "5-035", "5-003", "5-100", "5-087", "5-093"],
    stage: 4,
    sprite: "coelamon",
    id: "4-017",
    url: "https://digimon.net/reference_en/detail.php?directory_name=coelamon"
  },
  {
    name_en: "Coredramon (Blue)",
    name_jp: "Coredramon (Blue)",
    next_evolutions: ["5-142", "5-048", "5-080", "5-115"],
    stage: 4,
    sprite: "coredramon_blue",
    id: "4-018",
    url: "https://digimon.net/reference_en/detail.php?directory_name=coredramon_b"
  },
  {
    name_en: "Coredramon (Green)",
    name_jp: "Coredramon (Green)",
    next_evolutions: ["5-048", "5-142", "5-080", "5-117"],
    stage: 4,
    sprite: "coredramon_green",
    id: "4-019",
    url: "https://digimon.net/reference_en/detail.php?directory_name=coredramon_g"
  },
  {
    name_en: "Cyclonemon",
    name_jp: "Cyclomon",
    next_evolutions: ["5-028"],
    stage: 4,
    sprite: "cyclonemon",
    id: "4-020",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cyclomon"
  },
  {
    name_en: "Damemon",
    name_jp: "Damemon",
    next_evolutions: ["5-019", "5-067", "5-125", "5-136", "5-021", "5-064", "5-003"],
    stage: 4,
    sprite: "damemon",
    id: "4-021",
    url: "https://digimon.net/reference_en/detail.php?directory_name=damemon"
  },
  {
    name_en: "Darcmon",
    name_jp: "Darcmon",
    next_evolutions: ["5-036", "5-115", "5-122", "6-097"],
    stage: 4,
    sprite: "darcmon",
    id: "4-022",
    url: "https://digimon.net/reference_en/detail.php?directory_name=darcmon"
  },
  {
    name_en: "DarkTyrannomon",
    name_jp: "DarkTyranomon",
    next_evolutions: ["5-093", "5-040", "5-072", "5-088", "5-126", "5-087", "5-080"],
    stage: 4,
    sprite: "darktyrannomon",
    id: "4-023",
    url: "https://digimon.net/reference_en/detail.php?directory_name=darktyranomon"
  },
  {
    name_en: "DarkTyrannomon X",
    name_jp: "DarkTyranomon X",
    next_evolutions: ["5-089", "5-074", "5-132", "5-072"],
    stage: 4,
    sprite: "darktyrannomon_x",
    id: "4-024",
    url: "https://digimon.net/reference_en/detail.php?directory_name=darktyranomon_x"
  },
  {
    name_en: "Deltamon",
    name_jp: "Deltamon",
    next_evolutions: ["5-028", "5-104", "5-095", "5-039"],
    stage: 4,
    sprite: "deltamon",
    id: "4-025",
    url: "https://digimon.net/reference_en/detail.php?directory_name=deltamon"
  },
  {
    name_en: "Deputymon",
    name_jp: "Revolmon",
    next_evolutions: ["5-003", "5-025", "5-058", "5-086", "5-013"],
    stage: 4,
    sprite: "deputymon",
    id: "4-026",
    url: "https://digimon.net/reference_en/detail.php?directory_name=revolmon"
  },
  {
    name_en: "Devidramon",
    name_jp: "Devidramon",
    next_evolutions: ["5-093", "5-080", "5-142", "5-048", "5-135"],
    stage: 4,
    sprite: "devidramon",
    id: "4-027",
    url: "https://digimon.net/reference_en/detail.php?directory_name=devidramon"
  },
  {
    name_en: "Devimon",
    name_jp: "Devimon",
    next_evolutions: [
      "5-088",
      "5-086",
      "5-098",
      "5-059",
      "5-127",
      "5-100",
      "5-057",
      "5-007",
      "5-110",
      "5-011",
      "5-107"
    ],
    stage: 4,
    sprite: "devimon",
    id: "4-028",
    url: "https://digimon.net/reference_en/detail.php?directory_name=devimon"
  },
  {
    name_en: "Diatrymon",
    name_jp: "Diatrymon",
    next_evolutions: ["5-130", "5-050"],
    stage: 4,
    sprite: "diatrymon",
    id: "4-029",
    url: "https://digimon.net/reference_en/detail.php?directory_name=diatrymon"
  },
  {
    name_en: "Dobermon",
    name_jp: "Dobermon",
    next_evolutions: ["5-018", "5-040", "5-057", "5-056", "5-012", "5-124"],
    stage: 4,
    sprite: "dobermon",
    id: "4-030",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dobermon"
  },
  {
    name_en: "Dokugumon",
    name_jp: "Dokugumon",
    next_evolutions: [
      "5-059",
      "5-098",
      "5-110",
      "5-106",
      "5-013",
      "5-104",
      "5-139",
      "5-015",
      "5-051",
      "5-010",
      "5-036"
    ],
    stage: 4,
    sprite: "dokugumon",
    id: "4-031",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dokugumon"
  },
  {
    name_en: "Dolphmon",
    name_jp: "Rukamon",
    next_evolutions: ["5-143", "5-141", "5-032"],
    stage: 4,
    sprite: "dolphmon",
    id: "4-032",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rukamon"
  },
  {
    name_en: "Dorugamon",
    name_jp: "DORUgamon",
    next_evolutions: ["5-034", "5-017", "5-071", "5-047", "5-146"],
    stage: 4,
    sprite: "dorugamon",
    id: "4-033",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dorugamon"
  },
  {
    name_en: "Drimogemon",
    name_jp: "Drimogemon",
    next_evolutions: ["5-045", "5-139", "5-018", "5-147", "4-151"],
    stage: 4,
    sprite: "drimogemon",
    id: "4-034",
    url: "https://digimon.net/reference_en/detail.php?directory_name=drimogemon"
  },
  {
    name_en: "Duskmon",
    name_jp: "Duskmon",
    next_evolutions: ["5-067", "5-134", "5-114", "5-053", "5-065"],
    stage: 4,
    sprite: "duskmon",
    id: "4-035",
    url: "https://digimon.net/reference_en/detail.php?directory_name=duskmon"
  },
  {
    name_en: "Ebidramon",
    name_jp: "Ebidramon",
    next_evolutions: ["5-032", "5-143", "5-118", "5-077", "5-082", "5-141", "5-035", "5-124", "5-012", "5-056"],
    stage: 4,
    sprite: "ebidramon",
    id: "4-036",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ebidramon"
  },
  {
    name_en: "Eosmon",
    name_jp: "Eosmon",
    next_evolutions: ["5-038", "5-066", "5-113"],
    stage: 4,
    sprite: "eosmon_adult",
    id: "4-037",
    url: "https://digimon.net/reference_en/detail.php?directory_name=eosmon_lv4"
  },
  {
    name_en: "ExVeemon",
    name_jp: "XV-mon",
    next_evolutions: ["5-093", "5-105", "5-031", "5-066", "5-113", "5-001", "5-030", "5-069"],
    stage: 4,
    sprite: "exveemon",
    id: "4-038",
    url: "https://digimon.net/reference_en/detail.php?directory_name=xv-mon"
  },
  {
    name_en: "Filmon",
    name_jp: "Filmon",
    next_evolutions: ["5-089", "5-132", "5-128", "5-072", "5-053", "5-099", "5-083", "5-003"],
    stage: 4,
    sprite: "filmon",
    id: "4-039",
    url: "https://digimon.net/reference_en/detail.php?directory_name=filmon"
  },
  {
    name_en: "Firamon",
    name_jp: "Firamon",
    next_evolutions: ["5-041", "5-068"],
    stage: 4,
    sprite: "firamon",
    id: "4-040",
    url: "https://digimon.net/reference_en/detail.php?directory_name=firamon"
  },
  {
    name_en: "Flarerizamon",
    name_jp: "FlareLizamon",
    next_evolutions: ["5-007", "5-040", "5-057", "5-097"],
    stage: 4,
    sprite: "flarerizamon",
    id: "4-041",
    url: "https://digimon.net/reference_en/detail.php?directory_name=flarelizamon"
  },
  {
    name_en: "Flymon",
    name_jp: "Flymon",
    next_evolutions: ["5-093"],
    stage: 4,
    sprite: "flymon",
    id: "4-042",
    url: "https://digimon.net/reference_en/detail.php?directory_name=flymon"
  },
  {
    name_en: "Frigimon",
    name_jp: "Yukidarumon",
    next_evolutions: ["5-091", "5-076", "5-049", "5-124", "5-073", "5-022"],
    stage: 4,
    sprite: "frigimon",
    id: "4-043",
    url: "https://digimon.net/reference_en/detail.php?directory_name=yukidarumon"
  },
  {
    name_en: "Gaogamon",
    name_jp: "Gaogamon",
    next_evolutions: ["5-068", "5-046", "5-118", "5-104", "5-022", "5-148"],
    stage: 4,
    sprite: "gaogamon",
    id: "4-044",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gaogamon"
  },
  {
    name_en: "Gargomon",
    name_jp: "Galgomon",
    next_evolutions: ["5-112", "5-006"],
    stage: 4,
    sprite: "gargomon",
    id: "4-045",
    url: "https://digimon.net/reference_en/detail.php?directory_name=galgomon"
  },
  {
    name_en: "Garurumon",
    name_jp: "Garurumon",
    next_evolutions: [
      "5-091",
      "5-139",
      "5-073",
      "5-110",
      "5-069",
      "5-004",
      "5-015",
      "5-138",
      "5-106",
      "5-104",
      "5-018",
      "5-147",
      "4-151"
    ],
    stage: 4,
    sprite: "garurumon",
    id: "4-046",
    url: "https://digimon.net/reference_en/detail.php?directory_name=garurumon"
  },
  {
    name_en: "Gatomon",
    name_jp: "Tailmon",
    next_evolutions: ["5-004", "5-052", "5-109", "5-069", "5-139", "5-123", "5-055", "5-068", "5-097"],
    stage: 4,
    sprite: "gatomon",
    id: "4-047",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tailmon"
  },
  {
    name_en: "Gatomon X",
    name_jp: "Tailmon X",
    next_evolutions: ["5-005", "5-047", "5-071", "5-096"],
    stage: 4,
    sprite: "gatomon_x",
    id: "4-048",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tailmon_x"
  },
  {
    name_en: "Gekomon",
    name_jp: "Gekomon",
    next_evolutions: ["5-121", "5-131", "5-101", "5-109"],
    stage: 4,
    sprite: "gekomon",
    id: "4-049",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gekomon"
  },
  {
    name_en: "GeoGreymon",
    name_jp: "GeoGreymon",
    next_evolutions: ["5-115", "5-036", "5-122", "5-142"],
    stage: 4,
    sprite: "geogreymon",
    id: "4-050",
    url: "https://digimon.net/reference_en/detail.php?directory_name=geogreymon"
  },
  {
    name_en: "Gesomon",
    name_jp: "Gesomon",
    next_evolutions: ["5-077", "5-118", "5-035", "5-032"],
    stage: 4,
    sprite: "gesomon",
    id: "4-051",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gesomon"
  },
  {
    name_en: "Ginryumon",
    name_jp: "Ginryumon",
    next_evolutions: ["5-051", "5-047", "5-119", "5-071", "5-036", "5-010", "5-104"],
    stage: 4,
    sprite: "ginryumon",
    id: "4-052",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ginryumon"
  },
  {
    name_en: "Golemon",
    name_jp: "Golemon",
    next_evolutions: ["5-046", "5-068", "5-104", "5-131", "5-052", "5-097", "5-118", "5-148"],
    stage: 4,
    sprite: "golemon",
    id: "4-053",
    url: "https://digimon.net/reference_en/detail.php?directory_name=golemon"
  },
  {
    name_en: "Greymon",
    name_jp: "Greymon",
    next_evolutions: [
      "5-088",
      "5-086",
      "5-087",
      "5-025",
      "5-013",
      "5-010",
      "5-091",
      "5-118",
      "5-093",
      "5-003",
      "5-100",
      "5-126",
      "5-040",
      "5-072"
    ],
    stage: 4,
    sprite: "greymon",
    id: "4-054",
    url: "https://digimon.net/reference_en/detail.php?directory_name=greymon"
  },
  {
    name_en: "Growlmon",
    name_jp: "Growmon",
    next_evolutions: ["5-135", "5-075", "5-122", "5-115", "5-012"],
    stage: 4,
    sprite: "growlmon",
    id: "4-055",
    url: "https://digimon.net/reference_en/detail.php?directory_name=growmon"
  },
  {
    name_en: "Growlmon X",
    name_jp: "Growmon X",
    next_evolutions: ["5-136", "5-021", "5-094", "5-023"],
    stage: 4,
    sprite: "growlmon_x",
    id: "4-056",
    url: "https://digimon.net/reference_en/detail.php?directory_name=growmon_x"
  },
  {
    name_en: "Guardromon",
    name_jp: "Guardromon",
    next_evolutions: ["5-080", "5-058", "5-137", "5-013"],
    stage: 4,
    sprite: "guardromon",
    id: "4-057",
    url: "https://digimon.net/reference_en/detail.php?directory_name=guardromon"
  },
  {
    name_en: "Hookmon",
    name_jp: "Hookmon",
    next_evolutions: ["5-124", "5-085", "5-108"],
    stage: 4,
    sprite: "hookmon",
    id: "4-058",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hookmon"
  },
  {
    name_en: "Hudiemon",
    name_jp: "Hudiemon",
    next_evolutions: ["5-008", "5-055", "5-118", "5-104", "5-105", "5-031", "5-038", "5-017", "5-148"],
    stage: 4,
    sprite: "hudiemon",
    id: "4-059",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hudiemon"
  },
  {
    name_en: "Ikkakumon",
    name_jp: "Ikkakumon",
    next_evolutions: ["5-143", "5-141", "5-118", "5-076", "5-119"],
    stage: 4,
    sprite: "ikkakumon",
    id: "4-060",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ikkakumon"
  },
  {
    name_en: "Jazardmon",
    name_jp: "Jazardmon",
    next_evolutions: ["5-054", "5-110", "5-044", "5-017", "5-005", "5-119"],
    stage: 4,
    sprite: "jazardmon",
    id: "4-061",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jazardmon"
  },
  {
    name_en: "Kabuterimon",
    name_jp: "Kabuterimon",
    next_evolutions: ["5-126", "5-081", "5-004", "5-109", "5-052", "5-062"],
    stage: 4,
    sprite: "kabuterimon",
    id: "4-062",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kabuterimon"
  },
  {
    name_en: "Kiwimon",
    name_jp: "Kiwimon",
    next_evolutions: ["5-014", "5-043", "5-063", "5-042", "5-029"],
    stage: 4,
    sprite: "kiwimon",
    id: "4-063",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kiwimon"
  },
  {
    name_en: "Kokatorimon",
    name_jp: "Cockatrimon",
    next_evolutions: ["5-109", "5-050", "5-106", "5-037"],
    stage: 4,
    sprite: "kokatorimon",
    id: "4-064",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cockatrimon"
  },
  {
    name_en: "Komondomon",
    name_jp: "Komondomon",
    next_evolutions: ["5-066", "5-038", "5-113", "5-137"],
    stage: 4,
    sprite: "komondomon",
    id: "4-065",
    url: "https://digimon.net/reference_en/detail.php?directory_name=komondomon"
  },
  {
    name_en: "Kuwagamon",
    name_jp: "Kuwagamon",
    next_evolutions: ["5-109", "5-101", "5-121", "5-017", "5-129"],
    stage: 4,
    sprite: "kuwagamon",
    id: "4-066",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kuwagamon"
  },
  {
    name_en: "Kuwagamon X",
    name_jp: "Kuwagamon X",
    next_evolutions: ["5-102", "5-072", "5-074"],
    stage: 4,
    sprite: "kuwagamon_x",
    id: "4-067",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kuwagamon_x"
  },
  {
    name_en: "Lavorvomon",
    name_jp: "Lavorvomon",
    next_evolutions: ["5-061", "5-041", "5-127"],
    stage: 4,
    sprite: "lavorvomon",
    id: "4-068",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lavorvomon"
  },
  {
    name_en: "Lekismon",
    name_jp: "Lekismon",
    next_evolutions: ["5-022", "5-068"],
    stage: 4,
    sprite: "lekismon",
    id: "4-069",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lekismon"
  },
  {
    name_en: "Leomon",
    name_jp: "Leomon",
    next_evolutions: ["5-080", "5-010", "5-087", "5-091", "5-086", "5-009", "5-041"],
    stage: 4,
    sprite: "leomon",
    id: "4-070",
    url: "https://digimon.net/reference_en/detail.php?directory_name=leomon"
  },
  {
    name_en: "Leomon X",
    name_jp: "Leomon X",
    next_evolutions: ["5-019", "5-090", "5-094", "5-023"],
    stage: 4,
    sprite: "leomon_x",
    id: "4-071",
    url: "https://digimon.net/reference_en/detail.php?directory_name=leomon_x"
  },
  {
    name_en: "Lobomon",
    name_jp: "Wolfmon",
    next_evolutions: ["5-012", "5-056", "5-124"],
    stage: 4,
    sprite: "lobomon",
    id: "4-072",
    url: "https://digimon.net/reference_en/detail.php?directory_name=wolfmon"
  },
  {
    name_en: "Machmon",
    name_jp: "Machmon",
    next_evolutions: ["5-113", "5-025", "5-066", "5-065", "5-091"],
    stage: 4,
    sprite: "machmon",
    id: "4-073",
    url: "https://digimon.net/reference_en/detail.php?directory_name=machmon"
  },
  {
    name_en: "MadLeomon",
    name_jp: "MadLeomon",
    next_evolutions: ["5-011", "5-009", "5-067", "5-065", "5-114", "5-053", "5-134"],
    stage: 4,
    sprite: "madleomon",
    id: "4-074",
    url: "https://digimon.net/reference_en/detail.php?directory_name=madleomon"
  },
  {
    name_en: "Manbomon",
    name_jp: "Manbomon",
    next_evolutions: ["5-115", "5-032"],
    stage: 4,
    sprite: "manbomon",
    id: "4-075",
    url: "https://digimon.net/reference_en/detail.php?directory_name=manbomon"
  },
  {
    name_en: "Mantaraymon X",
    name_jp: "Mantaraymon X",
    next_evolutions: ["5-060", "5-072", "5-102"],
    stage: 4,
    sprite: "mantaraymon_x",
    id: "4-076",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mantaraymon_x"
  },
  {
    name_en: "Meicoomon",
    name_jp: "Meicoomon",
    next_evolutions: ["5-078", "5-079"],
    stage: 4,
    sprite: "meicoomon",
    id: "4-077",
    url: "https://digimon.net/reference_en/detail.php?directory_name=meicoomon"
  },
  {
    name_en: "Mekanorimon",
    name_jp: "Mechanorimon",
    next_evolutions: ["5-137", "5-013", "5-080"],
    stage: 4,
    sprite: "mekanorimon",
    id: "4-078",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mechanorimon"
  },
  {
    name_en: "Meramon",
    name_jp: "Meramon",
    next_evolutions: [
      "5-070",
      "5-127",
      "5-110",
      "5-139",
      "5-107",
      "5-016",
      "5-002",
      "5-041",
      "5-048",
      "5-061",
      "5-145",
      "5-149"
    ],
    stage: 4,
    sprite: "meramon",
    id: "4-079",
    url: "https://digimon.net/reference_en/detail.php?directory_name=meramon"
  },
  {
    name_en: "Meramon X",
    name_jp: "Meramon X",
    next_evolutions: ["5-026", "5-047", "5-103", "5-071", "5-044"],
    stage: 4,
    sprite: "meramon_x",
    id: "4-080",
    url: "https://digimon.net/reference_en/detail.php?directory_name=meramon_x"
  },
  {
    name_en: "Mimicmon",
    name_jp: "Mimicmon",
    next_evolutions: ["5-036", "5-075", "5-122"],
    stage: 4,
    sprite: "mimicmon",
    id: "4-081",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mimicmon"
  },
  {
    name_en: "Minotarumon",
    name_jp: "Minotaurmon",
    next_evolutions: ["5-113", "5-066"],
    stage: 4,
    sprite: "minotarumon",
    id: "4-082",
    url: "https://digimon.net/reference_en/detail.php?directory_name=minotaurmon"
  },
  {
    name_en: "Mojyamon",
    name_jp: "Mojyamon",
    next_evolutions: ["5-109", "5-018", "5-040", "5-057", "5-028", "5-009"],
    stage: 4,
    sprite: "mojyamon",
    id: "4-083",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mojyamon"
  },
  {
    name_en: "Monochromon",
    name_jp: "Monochromon",
    next_evolutions: [
      "5-080",
      "5-131",
      "5-052",
      "5-109",
      "5-121",
      "5-004",
      "5-040",
      "5-072",
      "5-088",
      "5-126",
      "5-087"
    ],
    stage: 4,
    sprite: "monochromon",
    id: "4-084",
    url: "https://digimon.net/reference_en/detail.php?directory_name=monochromon"
  },
  {
    name_en: "Nanimon",
    name_jp: "Nanimon",
    next_evolutions: ["5-030"],
    stage: 4,
    sprite: "nanimon",
    id: "4-085",
    url: "https://digimon.net/reference_en/detail.php?directory_name=nanimon"
  },
  {
    name_en: "Nefertimon X",
    name_jp: "Nefertimon X",
    next_evolutions: ["5-084", "5-072", "5-083"],
    stage: 4,
    sprite: "nefertimon_x",
    id: "4-086",
    url: "https://digimon.net/reference_en/detail.php?directory_name=nefertimon_x"
  },
  {
    name_en: "Ninjamon",
    name_jp: "Igamon",
    next_evolutions: ["5-091", "5-087", "5-139", "5-004", "5-010"],
    stage: 4,
    sprite: "ninjamon",
    id: "4-087",
    url: "https://digimon.net/reference_en/detail.php?directory_name=igamon"
  },
  {
    name_en: "Numemon",
    name_jp: "Numemon",
    next_evolutions: ["5-095", "5-051", "5-039"],
    stage: 4,
    sprite: "numemon",
    id: "4-088",
    url: "https://digimon.net/reference_en/detail.php?directory_name=numemon"
  },
  {
    name_en: "Numemon X",
    name_jp: "Numemon X",
    next_evolutions: ["5-089", "5-102", "5-060", "5-132", "5-128", "5-053", "5-099", "5-083", "5-084", "5-092"],
    stage: 4,
    sprite: "numemon_x",
    id: "4-089",
    url: "https://digimon.net/reference_en/detail.php?directory_name=numemon_x"
  },
  {
    name_en: "Octomon",
    name_jp: "Octmon",
    next_evolutions: ["5-035", "5-032", "5-077", "5-118", "5-076", "5-082", "5-049", "5-085", "5-108"],
    stage: 4,
    sprite: "octomon",
    id: "4-090",
    url: "https://digimon.net/reference_en/detail.php?directory_name=octmon"
  },
  {
    name_en: "Ogremon",
    name_jp: "Orgemon",
    next_evolutions: ["5-003", "5-057", "5-070", "5-100", "5-087", "5-118"],
    stage: 4,
    sprite: "ogremon",
    id: "4-091",
    url: "https://digimon.net/reference_en/detail.php?directory_name=orgemon"
  },
  {
    name_en: "Ogremon X",
    name_jp: "Orgemon X",
    next_evolutions: ["5-099", "5-074", "5-092", "5-072"],
    stage: 4,
    sprite: "ogremon_x",
    id: "4-092",
    url: "https://digimon.net/reference_en/detail.php?directory_name=orgemon_x"
  },
  {
    name_en: "Omekamon",
    name_jp: "Omekamon",
    next_evolutions: [
      "5-024",
      "5-054",
      "5-110",
      "5-071",
      "5-103",
      "5-026",
      "5-034",
      "5-096",
      "5-116",
      "5-051",
      "5-047",
      "5-146"
    ],
    stage: 4,
    sprite: "omekamon",
    id: "4-093",
    url: "https://digimon.net/reference_en/detail.php?directory_name=omekamon"
  },
  {
    name_en: "Paledramon",
    name_jp: "Paledramon",
    next_evolutions: ["5-024", "5-110", "5-026", "5-034", "5-116", "5-051", "5-022", "5-073", "5-146"],
    stage: 4,
    sprite: "paledramon",
    id: "4-094",
    url: "https://digimon.net/reference_en/detail.php?directory_name=paledramon"
  },
  {
    name_en: "Parasaurmon",
    name_jp: "Parasaurmon",
    next_evolutions: ["5-130", "5-050", "5-037", "5-063", "5-014", "5-055"],
    stage: 4,
    sprite: "parasaurmon",
    id: "4-095",
    url: "https://digimon.net/reference_en/detail.php?directory_name=parasaurmon"
  },
  {
    name_en: "Peckmon",
    name_jp: "Peckmon",
    next_evolutions: ["5-106", "5-050", "5-054"],
    stage: 4,
    sprite: "peckmon",
    id: "4-096",
    url: "https://digimon.net/reference_en/detail.php?directory_name=peckmon"
  },
  {
    name_en: "Pegasusmon X",
    name_jp: "Pegasmon X",
    next_evolutions: ["5-096", "5-051", "5-005", "5-047"],
    stage: 4,
    sprite: "pegasusmon_x",
    id: "4-097",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pegasmon_x"
  },
  {
    name_en: "Petermon",
    name_jp: "Petermon",
    next_evolutions: ["5-062", "5-050", "5-106", "5-037"],
    stage: 4,
    sprite: "petermon",
    id: "4-098",
    url: "https://digimon.net/reference_en/detail.php?directory_name=petermon"
  },
  {
    name_en: "Porcupamon",
    name_jp: "Porcupamon",
    next_evolutions: ["5-009", "5-011", "5-027", "5-125"],
    stage: 4,
    sprite: "porcupamon",
    id: "4-099",
    url: "https://digimon.net/reference_en/detail.php?directory_name=porcupamon"
  },
  {
    name_en: "Pteramon X",
    name_jp: "Pteranomon X",
    next_evolutions: ["5-044", "5-017", "5-071"],
    stage: 4,
    sprite: "pteramon_x",
    id: "4-100",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pteranomon_x"
  },
  {
    name_en: "Raremon",
    name_jp: "Raremon",
    next_evolutions: ["5-040", "5-093", "5-113", "5-038", "5-065", "5-091", "5-066"],
    stage: 4,
    sprite: "raremon",
    id: "4-101",
    url: "https://digimon.net/reference_en/detail.php?directory_name=raremon"
  },
  {
    name_en: "RedVegiemon",
    name_jp: "RedVegimon",
    next_evolutions: ["5-042", "5-029", "5-020"],
    stage: 4,
    sprite: "redvegiemon",
    id: "4-102",
    url: "https://digimon.net/reference_en/detail.php?directory_name=redvegimon"
  },
  {
    name_en: "Reppamon",
    name_jp: "Reppamon",
    next_evolutions: ["5-012", "5-115", "5-111", "5-075", "5-109", "5-030", "5-045"],
    stage: 4,
    sprite: "reppamon",
    id: "4-103",
    url: "https://digimon.net/reference_en/detail.php?directory_name=reppamon"
  },
  {
    name_en: "Rhinomon X",
    name_jp: "Rhinomon X",
    next_evolutions: ["5-140", "5-136", "5-023"],
    stage: 4,
    sprite: "rhinomon_x",
    id: "4-104",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rhinomon_x"
  },
  {
    name_en: "Roachmon",
    name_jp: "Gokimon",
    next_evolutions: ["5-008", "5-118", "5-104", "5-031", "5-055", "5-105", "5-148"],
    stage: 4,
    sprite: "roachmon",
    id: "4-105",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gokimon"
  },
  {
    name_en: "Sangloupmon",
    name_jp: "Sangloupmon",
    next_evolutions: ["5-067", "5-019", "5-125"],
    stage: 4,
    sprite: "sangloupmon",
    id: "4-106",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sangloupmon"
  },
  {
    name_en: "Seadramon",
    name_jp: "Seadramon",
    next_evolutions: ["5-070", "5-082", "5-141", "5-032", "5-035", "5-076", "5-108", "5-049", "5-085"],
    stage: 4,
    sprite: "seadramon",
    id: "4-107",
    url: "https://digimon.net/reference_en/detail.php?directory_name=seadramon"
  },
  {
    name_en: "Seadramon X",
    name_jp: "Seadramon X",
    next_evolutions: ["5-083", "5-072", "5-074"],
    stage: 4,
    sprite: "seadramon_x",
    id: "4-108",
    url: "https://digimon.net/reference_en/detail.php?directory_name=seadramon_x"
  },
  {
    name_en: "Seasarmon X",
    name_jp: "Siesamon X",
    next_evolutions: ["5-103", "5-034", "5-044", "5-047", "5-146"],
    stage: 4,
    sprite: "seasarmon_x",
    id: "4-109",
    url: "https://digimon.net/reference_en/detail.php?directory_name=siesamon_x"
  },
  {
    name_en: "Shadramon",
    name_jp: "Shadramon",
    next_evolutions: ["5-027", "5-009", "5-031", "5-055", "5-105"],
    stage: 4,
    sprite: "shadramon",
    id: "4-110",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shadramon"
  },
  {
    name_en: "Shellmon",
    name_jp: "Shellmon",
    next_evolutions: ["5-003", "5-057", "5-138", "5-049", "5-085", "5-108", "5-035", "5-076"],
    stage: 4,
    sprite: "shellmon",
    id: "4-111",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shellmon"
  },
  {
    name_en: "ShellNumemon",
    name_jp: "KaratukiNumemon",
    next_evolutions: ["5-130", "5-119", "5-124", "5-085", "5-108"],
    stage: 4,
    sprite: "shellnumemon",
    id: "4-112",
    url: "https://digimon.net/reference_en/detail.php?directory_name=karatukinumemon"
  },
  {
    name_en: "Shoutmon X3",
    name_jp: "Shoutmon X3",
    next_evolutions: ["5-122", "5-115", "5-135"],
    stage: 4,
    sprite: "shoutmon_x3",
    id: "4-113",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shoutmonx3"
  },
  {
    name_en: "Sistermon Ciel",
    name_jp: "Sistermon Ciel",
    next_evolutions: ["5-021", "5-140", "5-064"],
    stage: 4,
    sprite: "sistermon_ciel",
    id: "4-114",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sistermon_ciel"
  },
  {
    name_en: "Starmon",
    name_jp: "Starmon",
    next_evolutions: ["5-109", "5-004", "5-131", "5-121", "5-016", "5-002", "5-129", "5-145", "5-149"],
    stage: 4,
    sprite: "starmon",
    id: "4-115",
    url: "https://digimon.net/reference_en/detail.php?directory_name=starmon"
  },
  {
    name_en: "Stingmon",
    name_jp: "Stingmon",
    next_evolutions: ["5-100", "5-031", "5-105", "5-040", "5-057", "5-097", "5-055", "5-004"],
    stage: 4,
    sprite: "stingmon",
    id: "4-116",
    url: "https://digimon.net/reference_en/detail.php?directory_name=stingmon"
  },
  {
    name_en: "Strikedramon",
    name_jp: "Strikedramon",
    next_evolutions: ["5-025", "5-066"],
    stage: 4,
    sprite: "strikedramon",
    id: "4-117",
    url: "https://digimon.net/reference_en/detail.php?directory_name=strikedramon"
  },
  {
    name_en: "Submarimon",
    name_jp: "Submarimon",
    next_evolutions: ["5-138", "5-049", "5-085", "5-108", "5-105"],
    stage: 4,
    sprite: "submarimon",
    id: "4-118",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sabmarimon"
  },
  {
    name_en: "Sukamon",
    name_jp: "Scumon",
    next_evolutions: ["5-039", "5-057"],
    stage: 4,
    sprite: "sukamon",
    id: "4-119",
    url: "https://digimon.net/reference_en/detail.php?directory_name=scumon"
  },
  {
    name_en: "Sunflowmon",
    name_jp: "Sunflowmon",
    next_evolutions: ["5-062", "5-055", "5-063", "5-130", "5-014", "5-038", "5-017"],
    stage: 4,
    sprite: "sunflowmon",
    id: "4-120",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sunflowmon"
  },
  {
    name_en: "Tankmon",
    name_jp: "Tankmon",
    next_evolutions: ["5-087", "5-003", "5-013", "5-080", "5-058", "5-137"],
    stage: 4,
    sprite: "tankmon",
    id: "4-121",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tankmon"
  },
  {
    name_en: "Targetmon",
    name_jp: "Targetmon",
    next_evolutions: ["5-039", "5-036", "5-117"],
    stage: 4,
    sprite: "targetmon",
    id: "4-122",
    url: "https://digimon.net/reference_en/detail.php?directory_name=targetmon"
  },
  {
    name_en: "Thundermon",
    name_jp: "Thunderballmon",
    next_evolutions: ["5-013", "5-025", "5-058", "5-137", "5-045", "5-144"],
    stage: 4,
    sprite: "thundermon",
    id: "4-123",
    url: "https://digimon.net/reference_en/detail.php?directory_name=thunderballmon"
  },
  {
    name_en: "TiaLudomon",
    name_jp: "TiaLudomon",
    next_evolutions: ["5-111", "5-075", "5-030", "5-109"],
    stage: 4,
    sprite: "tialudomon",
    id: "4-124",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tialudomon"
  },
  {
    name_en: "Tobiumon",
    name_jp: "Tobiumon",
    next_evolutions: ["5-076", "5-049", "5-085", "5-108", "5-035", "5-082", "5-119", "5-138"],
    stage: 4,
    sprite: "tobiumon",
    id: "4-125",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tobiumon"
  },
  {
    name_en: "TobuCatmon",
    name_jp: "Tobucatmon",
    next_evolutions: ["5-125", "5-090", "5-023", "5-021", "5-140"],
    stage: 4,
    sprite: "tobucatmon",
    id: "4-126",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tobucatmon"
  },
  {
    name_en: "Togemon",
    name_jp: "Togemon",
    next_evolutions: [
      "5-063",
      "5-001",
      "5-014",
      "5-020",
      "5-029",
      "5-043",
      "5-042",
      "5-052",
      "5-131",
      "5-046",
      "5-097",
      "5-118",
      "5-148"
    ],
    stage: 4,
    sprite: "togemon",
    id: "4-127",
    url: "https://digimon.net/reference_en/detail.php?directory_name=togemon"
  },
  {
    name_en: "Togemon X",
    name_jp: "Togemon X",
    next_evolutions: ["5-017", "5-034", "5-026", "5-071", "5-146"],
    stage: 4,
    sprite: "togemon_x",
    id: "4-128",
    url: "https://digimon.net/reference_en/detail.php?directory_name=togemon_x"
  },
  {
    name_en: "Tortomon",
    name_jp: "Tortamon",
    next_evolutions: ["5-081", "5-052", "5-109", "5-046", "5-118", "5-097", "5-131", "5-148"],
    stage: 4,
    sprite: "tortomon",
    id: "4-129",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tortamon"
  },
  {
    name_en: "Troopmon",
    name_jp: "Troopmon",
    next_evolutions: ["5-027"],
    stage: 4,
    sprite: "troopmon",
    id: "4-130",
    url: "https://digimon.net/reference_en/detail.php?directory_name=troopmon"
  },
  {
    name_en: "Turuiemon",
    name_jp: "Turuiemon",
    next_evolutions: ["5-021", "5-006", "5-112"],
    stage: 4,
    sprite: "turuiemon",
    id: "4-131",
    url: "https://digimon.net/reference_en/detail.php?directory_name=turuiemon"
  },
  {
    name_en: "Tuskmon",
    name_jp: "Tuskmon",
    next_evolutions: ["5-028"],
    stage: 4,
    sprite: "tuskmon",
    id: "4-132",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tuskmon"
  },
  {
    name_en: "Tylomon",
    name_jp: "Tylomon",
    next_evolutions: [],
    stage: 4,
    sprite: "tylomon",
    id: "4-133",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tylomon"
  },
  {
    name_en: "Tylomon X",
    name_jp: "Tylomon X",
    next_evolutions: ["5-116", "5-071"],
    stage: 4,
    sprite: "tylomon_x",
    id: "4-134",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tylomon_x"
  },
  {
    name_en: "Tyrannomon",
    name_jp: "Tyranomon",
    next_evolutions: ["5-070", "5-127", "5-048", "5-061"],
    stage: 4,
    sprite: "tyrannomon",
    id: "4-135",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tyranomon"
  },
  {
    name_en: "Tyrannomon X",
    name_jp: "Tyranomon X",
    next_evolutions: ["5-090", "5-094", "5-023"],
    stage: 4,
    sprite: "tyrannomon_x",
    id: "4-136",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tyranomon_x"
  },
  {
    name_en: "Unimon",
    name_jp: "Unimon",
    next_evolutions: ["5-003", "5-057", "5-068", "5-046", "5-008"],
    stage: 4,
    sprite: "unimon",
    id: "4-137",
    url: "https://digimon.net/reference_en/detail.php?directory_name=yunimon"
  },
  {
    name_en: "Veedramon",
    name_jp: "V-dramon",
    next_evolutions: ["5-001", "5-043", "5-029", "5-031", "5-030"],
    stage: 4,
    sprite: "veedramon",
    id: "4-138",
    url: "https://digimon.net/reference_en/detail.php?directory_name=v-dramon"
  },
  {
    name_en: "Vegiemon",
    name_jp: "Vegimon",
    next_evolutions: ["5-133", "5-130", "5-037", "5-062", "5-014", "5-063", "5-055"],
    stage: 4,
    sprite: "vegiemon",
    id: "4-139",
    url: "https://digimon.net/reference_en/detail.php?directory_name=vegimon"
  },
  {
    name_en: "Velgrmon",
    name_jp: "Velgrmon",
    next_evolutions: ["5-060", "5-102", "5-053", "5-072", "5-128", "5-084", "5-092"],
    stage: 4,
    sprite: "velgrmon",
    id: "4-140",
    url: "https://digimon.net/reference_en/detail.php?directory_name=velgrmon"
  },
  {
    name_en: "Whamon",
    name_jp: "Whamon",
    next_evolutions: ["5-091"],
    stage: 4,
    sprite: "whamon",
    id: "4-141",
    url: "https://digimon.net/reference_en/detail.php?directory_name=whamon"
  },
  {
    name_en: "Witchmon",
    name_jp: "Witchmon",
    next_evolutions: ["5-100", "5-040", "5-057", "5-097"],
    stage: 4,
    sprite: "witchmon",
    id: "4-142",
    url: "https://digimon.net/reference_en/detail.php?directory_name=witchmon"
  },
  {
    name_en: "Wizardmon",
    name_jp: "Wizarmon",
    next_evolutions: ["5-110", "5-127", "5-073", "5-107", "5-139", "5-011", "5-098"],
    stage: 4,
    sprite: "wizardmon",
    id: "4-143",
    url: "https://digimon.net/reference_en/detail.php?directory_name=wizarmon"
  },
  {
    name_en: "Wizardmon X",
    name_jp: "Wizarmon X",
    next_evolutions: ["5-116", "5-096", "5-119", "5-071"],
    stage: 4,
    sprite: "wizardmon_x",
    id: "4-144",
    url: "https://digimon.net/reference_en/detail.php?directory_name=wizarmon_x"
  },
  {
    name_en: "Woodmon",
    name_jp: "Woodmon",
    next_evolutions: ["5-020", "5-029", "5-042"],
    stage: 4,
    sprite: "woodmon",
    id: "4-145",
    url: "https://digimon.net/reference_en/detail.php?directory_name=woodmon"
  },
  {
    name_en: "ZubaEagermon",
    name_jp: "Zubaeagermon",
    next_evolutions: ["5-036", "5-039", "5-117", "5-010", "5-051"],
    stage: 4,
    sprite: "zubaeagermon",
    id: "4-146",
    url: "https://digimon.net/reference_en/detail.php?directory_name=zubaeagermon"
  },
  {
    name_en: "Bulkmon",
    name_jp: "Bulkmon",
    next_evolutions: ["5-144"],
    stage: 4,
    sprite: "bulkmon",
    id: "4-147",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bulkmon"
  },
  {
    name_en: "Fugamon",
    name_jp: "Fugamon",
    next_evolutions: [],
    stage: 4,
    sprite: "fugamon",
    id: "4-148",
    url: "https://digimon.net/reference_en/detail.php?directory_name=fugamon"
  },
  {
    name_en: "Hyogamon",
    name_jp: "Hyougamon",
    next_evolutions: ["5-024", "5-073"],
    stage: 4,
    sprite: "hyogamon",
    id: "4-149",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hyougamon"
  },
  {
    name_en: "Piddomon",
    name_jp: "Pidmon",
    next_evolutions: ["5-043"],
    stage: 4,
    sprite: "piddomon",
    id: "4-150",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pidmon"
  },
  {
    name_en: "Rhinomon",
    name_jp: "Rhinomon",
    next_evolutions: [],
    stage: 4,
    sprite: "rhinomon",
    id: "4-151",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rhinomon"
  },
  {
    name_en: "Saberdramon",
    name_jp: "Saberdramon",
    next_evolutions: ["5-025", "5-098", "5-107", "5-011", "5-110"],
    stage: 4,
    sprite: "saberdramon",
    id: "4-152",
    url: "https://digimon.net/reference_en/detail.php?directory_name=saberdramon"
  },
  {
    name_en: "AeroVeedramon",
    name_jp: "AeroV-dramon",
    next_evolutions: ["6-137", "6-105", "6-114", "6-084", "7-019"],
    stage: 5,
    sprite: "aeroveedramon",
    id: "5-001",
    url: "https://digimon.net/reference_en/detail.php?directory_name=earov-dramon"
  },
  {
    name_en: "Aldamon",
    name_jp: "Aldamon",
    next_evolutions: ["6-048", "6-005", "6-011"],
    stage: 5,
    sprite: "aldamon",
    id: "5-002",
    url: "https://digimon.net/reference_en/detail.php?directory_name=aldamon"
  },
  {
    name_en: "Andromon",
    name_jp: "Andromon",
    next_evolutions: ["6-068", "6-091", "6-080", "5-033", "6-143", "6-028", "6-125"],
    stage: 5,
    sprite: "andromon",
    id: "5-003",
    url: "https://digimon.net/reference_en/detail.php?directory_name=andromon"
  },
  {
    name_en: "Angewomon",
    name_jp: "Angewomon",
    next_evolutions: ["6-081", "6-066", "6-090", "7-029", "6-100", "6-020", "6-139", "7-020"],
    stage: 5,
    sprite: "angewomon",
    id: "5-004",
    url: "https://digimon.net/reference_en/detail.php?directory_name=angewomon"
  },
  {
    name_en: "Angewomon X",
    name_jp: "Angewomon X",
    next_evolutions: ["6-101", "6-043", "6-082", "6-046"],
    stage: 5,
    sprite: "angewomon_x",
    id: "5-005",
    url: "https://digimon.net/reference_en/detail.php?directory_name=angewomon_x"
  },
  {
    name_en: "Antylamon",
    name_jp: "Andiramon",
    next_evolutions: ["6-033", "6-087"],
    stage: 5,
    sprite: "antylamon_deva",
    id: "5-006",
    url: "https://digimon.net/reference_en/detail.php?directory_name=andiramon"
  },
  {
    name_en: "Argomon",
    name_jp: "Algomon",
    next_evolutions: ["6-016", "6-055", "5-033"],
    stage: 5,
    sprite: "argomon_perfect",
    id: "5-007",
    url: "https://digimon.net/reference_en/detail.php?directory_name=algomon-ultimate"
  },
  {
    name_en: "Arukenimon",
    name_jp: "Archnemon",
    next_evolutions: ["6-114", "6-085", "6-003", "6-020", "6-098"],
    stage: 5,
    sprite: "arukenimon",
    id: "5-008",
    url: "https://digimon.net/reference_en/detail.php?directory_name=archnemon"
  },
  {
    name_en: "Astamon",
    name_jp: "Astamon",
    next_evolutions: ["6-026", "6-045", "6-007", "6-065"],
    stage: 5,
    sprite: "astamon",
    id: "5-009",
    url: "https://digimon.net/reference_en/detail.php?directory_name=astamon"
  },
  {
    name_en: "Asuramon",
    name_jp: "Asuramon",
    next_evolutions: ["6-143", "6-091", "6-044", "6-104"],
    stage: 5,
    sprite: "asuramon",
    id: "5-010",
    url: "https://digimon.net/reference_en/detail.php?directory_name=asuramon"
  },
  {
    name_en: "Baalmon",
    name_jp: "Baalmon",
    next_evolutions: ["6-025", "7-005", "6-099", "6-107"],
    stage: 5,
    sprite: "baalmon",
    id: "5-011",
    url: "https://digimon.net/reference_en/detail.php?directory_name=baalmon"
  },
  {
    name_en: "Beowolfmon",
    name_jp: "Beowolfmon",
    next_evolutions: ["6-074", "6-083", "6-004", "6-008"],
    stage: 5,
    sprite: "beowolfmon",
    id: "5-012",
    url: "https://digimon.net/reference_en/detail.php?directory_name=beowolfmon"
  },
  {
    name_en: "BigMamemon",
    name_jp: "BigMamemon",
    next_evolutions: ["6-091", "6-068", "6-141", "6-098", "6-038"],
    stage: 5,
    sprite: "bigmamemon",
    id: "5-013",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bigmamemon"
  },
  {
    name_en: "Blossomon",
    name_jp: "Blossomon",
    next_evolutions: ["6-114", "6-137", "6-063"],
    stage: 5,
    sprite: "blossomon",
    id: "5-014",
    url: "https://digimon.net/reference_en/detail.php?directory_name=blossomon"
  },
  {
    name_en: "Bulbmon",
    name_jp: "Valvemon",
    next_evolutions: ["6-091", "6-038", "6-098"],
    stage: 5,
    sprite: "bulbmon",
    id: "5-015",
    url: "https://digimon.net/reference_en/detail.php?directory_name=valvemon"
  },
  {
    name_en: "BurningGreymon",
    name_jp: "Vritramon",
    next_evolutions: ["6-048", "6-005", "6-011"],
    stage: 5,
    sprite: "burninggreymon",
    id: "5-016",
    url: "https://digimon.net/reference_en/detail.php?directory_name=vritramon"
  },
  {
    name_en: "CannonBeemon",
    name_jp: "CannonBeemon",
    next_evolutions: ["6-135", "6-043", "6-116", "6-082", "6-046", "6-066", "6-061"],
    stage: 5,
    sprite: "cannonbeemon",
    id: "5-017",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cannonbeemon"
  },
  {
    name_en: "Cerberusmon",
    name_jp: "Cerberumon",
    next_evolutions: ["6-013", "6-055", "6-009", "6-060"],
    stage: 5,
    sprite: "cerberusmon",
    id: "5-018",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cerberumon"
  },
  {
    name_en: "Cerberusmon X",
    name_jp: "Cerberumon X",
    next_evolutions: ["6-127", "7-022", "6-085", "7-021", "6-108"],
    stage: 5,
    sprite: "cerberusmon_x",
    id: "5-019",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cerberumon_x"
  },
  {
    name_en: "Cherrymon",
    name_jp: "Jyureimon",
    next_evolutions: ["6-113", "6-123"],
    stage: 5,
    sprite: "cherrymon",
    id: "5-020",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jyureimon"
  },
  {
    name_en: "Cho-Hakkaimon",
    name_jp: "Cho-Hakkaimon",
    next_evolutions: ["6-024", "7-009", "6-092", "6-085", "6-108"],
    stage: 5,
    sprite: "cho_hakkaimon",
    id: "5-021",
    url: "https://digimon.net/reference_en/detail.php?directory_name=chohakkaimon"
  },
  {
    name_en: "Crescemon",
    name_jp: "Crescemon",
    next_evolutions: ["6-041", "6-067", "6-007", "6-130", "6-026", "6-096"],
    stage: 5,
    sprite: "crescemon",
    id: "5-022",
    url: "https://digimon.net/reference_en/detail.php?directory_name=crescemon"
  },
  {
    name_en: "Crowmon",
    name_jp: "Yatagaramon",
    next_evolutions: ["6-127", "6-140", "6-085", "6-108", "6-024", "6-120", "6-006", "6-010", "6-093"],
    stage: 5,
    sprite: "crowmon",
    id: "5-023",
    url: "https://digimon.net/reference_en/detail.php?directory_name=yatagaramon"
  },
  {
    name_en: "CrysPaledramon",
    name_jp: "CrysPaledramon",
    next_evolutions: ["6-067", "6-082", "6-070", "6-002", "6-058", "6-104", "6-007", "6-130"],
    stage: 5,
    sprite: "cryspaledramon",
    id: "5-024",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cryspaledramon"
  },
  {
    name_en: "Cyberdramon",
    name_jp: "Cyberdramon",
    next_evolutions: ["6-068", "6-141", "6-065", "6-049", "6-143", "6-071"],
    stage: 5,
    sprite: "cyberdramon",
    id: "5-025",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cyberdramon"
  },
  {
    name_en: "Cyberdramon X",
    name_jp: "Cyberdramon X",
    next_evolutions: ["6-070", "6-106", "6-082", "6-135", "6-051", "6-046"],
    stage: 5,
    sprite: "cyberdramon_x",
    id: "5-026",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cyberdramon_x"
  },
  {
    name_en: "DarkKnightmon",
    name_jp: "DarkKnightmon",
    next_evolutions: ["6-026", "6-025", "7-011"],
    stage: 5,
    sprite: "darkknightmon",
    id: "5-027",
    url: "https://digimon.net/reference_en/detail.php?directory_name=darkknightmon"
  },
  {
    name_en: "Datamon",
    name_jp: "Nanomon",
    next_evolutions: ["6-045"],
    stage: 5,
    sprite: "datamon",
    id: "5-028",
    url: "https://digimon.net/reference_en/detail.php?directory_name=nanomon"
  },
  {
    name_en: "Deramon",
    name_jp: "Delumon",
    next_evolutions: ["6-063", "6-105", "6-123", "6-113"],
    stage: 5,
    sprite: "deramon",
    id: "5-029",
    url: "https://digimon.net/reference_en/detail.php?directory_name=delumon"
  },
  {
    name_en: "Digitamamon",
    name_jp: "Digitamamon",
    next_evolutions: ["6-054", "6-136", "6-137", "6-084", "7-019", "6-031", "6-107"],
    stage: 5,
    sprite: "digitamamon",
    id: "5-030",
    url: "https://digimon.net/reference_en/detail.php?directory_name=digitamamon"
  },
  {
    name_en: "Dinobeemon",
    name_jp: "Dinobeemon",
    next_evolutions: [
      "6-061",
      "6-013",
      "6-055",
      "6-088",
      "6-062",
      "6-065",
      "6-064",
      "7-020",
      "7-019",
      "6-137",
      "6-084",
      "6-081"
    ],
    stage: 5,
    sprite: "dinobeemon",
    id: "5-031",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dinobeemon"
  },
  {
    name_en: "Divermon",
    name_jp: "Hangyomon",
    next_evolutions: ["6-109", "6-086", "6-008", "6-112"],
    stage: 5,
    sprite: "divermon",
    id: "5-032",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hangyomon"
  },
  {
    name_en: "DoneDevimon",
    name_jp: "NeoDevimon",
    next_evolutions: ["6-055", "6-088", "6-028", "6-143"],
    stage: 5,
    sprite: "donedevimon",
    id: "5-033",
    url: "https://digimon.net/reference_en/detail.php?directory_name=neodevimon"
  },
  {
    name_en: "DoruGreymon",
    name_jp: "DORUguremon",
    next_evolutions: ["6-002", "6-051", "6-082", "6-043", "6-150"],
    stage: 5,
    sprite: "dorugreymon",
    id: "5-034",
    url: "https://digimon.net/reference_en/detail.php?directory_name=doruguremon"
  },
  {
    name_en: "Dragomon",
    name_jp: "Dagomon",
    next_evolutions: ["6-112", "6-109", "6-095", "6-121"],
    stage: 5,
    sprite: "dragomon",
    id: "5-035",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dagomon"
  },
  {
    name_en: "Duramon",
    name_jp: "Duramon",
    next_evolutions: ["6-044", "6-129", "6-057", "6-004", "6-104"],
    stage: 5,
    sprite: "duramon",
    id: "5-036",
    url: "https://digimon.net/reference_en/detail.php?directory_name=duramon"
  },
  {
    name_en: "Entmon",
    name_jp: "Entmon",
    next_evolutions: ["6-047", "6-103", "6-010"],
    stage: 5,
    sprite: "entmon",
    id: "5-037",
    url: "https://digimon.net/reference_en/detail.php?directory_name=entmon"
  },
  {
    name_en: "Eosmon",
    name_jp: "Eosmon",
    next_evolutions: ["6-049", "6-062", "6-012", "6-135", "6-149"],
    stage: 5,
    sprite: "eosmon_perfect",
    id: "5-038",
    url: "https://digimon.net/reference_en/detail.php?directory_name=eosmon_lv5"
  },
  {
    name_en: "Etemon",
    name_jp: "Etemon",
    next_evolutions: ["6-021", "6-073", "6-090"],
    stage: 5,
    sprite: "etemon",
    id: "5-039",
    url: "https://digimon.net/reference_en/detail.php?directory_name=etemon"
  },
  {
    name_en: "ExTyrannomon",
    name_jp: "Ex-Tyranomon",
    next_evolutions: ["6-051", "6-113", "6-013", "6-055", "6-009"],
    stage: 5,
    sprite: "extyrannomon",
    id: "5-040",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ex-tyranomon"
  },
  {
    name_en: "Flaremon",
    name_jp: "Flaremon",
    next_evolutions: ["6-015", "6-011", "6-142", "6-096", "6-065"],
    stage: 5,
    sprite: "flaremon",
    id: "5-041",
    url: "https://digimon.net/reference_en/detail.php?directory_name=flaremon"
  },
  {
    name_en: "Garbagemon",
    name_jp: "Gerbemon",
    next_evolutions: ["6-114", "6-113"],
    stage: 5,
    sprite: "garbagemon",
    id: "5-042",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gerbemon"
  },
  {
    name_en: "Garudamon",
    name_jp: "Garudamon",
    next_evolutions: ["6-105", "6-137", "6-063"],
    stage: 5,
    sprite: "garudamon",
    id: "5-043",
    url: "https://digimon.net/reference_en/detail.php?directory_name=garudamon"
  },
  {
    name_en: "Garudamon X",
    name_jp: "Garudamon X",
    next_evolutions: ["6-082", "6-106", "6-135", "6-051", "6-046"],
    stage: 5,
    sprite: "garudamon_x",
    id: "5-044",
    url: "https://digimon.net/reference_en/detail.php?directory_name=garudamon_x"
  },
  {
    name_en: "Giromon",
    name_jp: "Giromon",
    next_evolutions: [],
    stage: 5,
    sprite: "giromon",
    id: "5-045",
    url: "https://digimon.net/reference_en/detail.php?directory_name=giromon"
  },
  {
    name_en: "Gogmamon",
    name_jp: "Gogmamon",
    next_evolutions: ["6-011", "6-081", "6-096", "6-042", "6-009"],
    stage: 5,
    sprite: "gogmamon",
    id: "5-046",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gogmamon"
  },
  {
    name_en: "Grademon",
    name_jp: "Grademon",
    next_evolutions: ["6-051", "6-099", "6-046", "6-002", "6-070", "6-106", "6-058", "6-104", "6-150"],
    stage: 5,
    sprite: "grademon",
    id: "5-047",
    url: "https://digimon.net/reference_en/detail.php?directory_name=grademon"
  },
  {
    name_en: "Groundramon",
    name_jp: "Groundramon",
    next_evolutions: ["6-030", "6-011", "6-142", "6-069"],
    stage: 5,
    sprite: "groundramon",
    id: "5-048",
    url: "https://digimon.net/reference_en/detail.php?directory_name=groundramon"
  },
  {
    name_en: "Gusokumon",
    name_jp: "Gusokumon",
    next_evolutions: ["6-121", "6-001", "6-008", "6-095", "6-109"],
    stage: 5,
    sprite: "gusokumon",
    id: "5-049",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gusokumon"
  },
  {
    name_en: "HippoGryphonmon",
    name_jp: "Hippogriffomon",
    next_evolutions: ["6-103", "6-010", "6-047", "6-145", "6-107"],
    stage: 5,
    sprite: "hippogryphonmon",
    id: "5-050",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hippogriffomon"
  },
  {
    name_en: "Hisyaryumon",
    name_jp: "Hisyaryumon",
    next_evolutions: ["6-104", "6-051", "6-110", "6-082", "6-044", "6-098"],
    stage: 5,
    sprite: "hisyaryumon",
    id: "5-051",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hisyaryumon"
  },
  {
    name_en: "Jagamon",
    name_jp: "Jyagamon",
    next_evolutions: ["6-066", "6-126", "6-081", "6-009", "6-042"],
    stage: 5,
    sprite: "jagamon",
    id: "5-052",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jyagamon"
  },
  {
    name_en: "JagerLoweemon",
    name_jp: "KaiserLeomon",
    next_evolutions: ["6-102", "6-138", "6-122", "6-019", "6-024", "6-035", "6-042", "6-009", "6-055", "6-043"],
    stage: 5,
    sprite: "jagerloweemon",
    id: "5-053",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kaiserleomon"
  },
  {
    name_en: "Jazarichmon",
    name_jp: "Jazarichmon",
    next_evolutions: ["6-093", "6-046", "6-116", "6-135", "6-106", "6-101", "6-110", "6-034", "6-105"],
    stage: 5,
    sprite: "jazarichmon",
    id: "5-054",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jazarichmon"
  },
  {
    name_en: "JewelBeemon",
    name_jp: "Jewelbeemon",
    next_evolutions: ["6-003", "6-081", "6-020", "6-114", "6-061", "7-020"],
    stage: 5,
    sprite: "jewelbeemon",
    id: "5-055",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jewelbeemon"
  },
  {
    name_en: "KendoGarurumon",
    name_jp: "Garummon",
    next_evolutions: ["6-083", "6-004", "6-008"],
    stage: 5,
    sprite: "kendogarurumon",
    id: "5-056",
    url: "https://digimon.net/reference_en/detail.php?directory_name=garummon"
  },
  {
    name_en: "Kimeramon",
    name_jp: "Chimairamon",
    next_evolutions: ["6-021", "6-088", "6-013", "6-055", "5-033", "6-138", "6-017", "6-139", "7-019", "7-045"],
    stage: 5,
    sprite: "kimeramon",
    id: "5-057",
    url: "https://digimon.net/reference_en/detail.php?directory_name=chimairamon"
  },
  {
    name_en: "Knightmon",
    name_jp: "Knightmon",
    next_evolutions: ["6-143", "6-141", "6-091", "6-036", "6-072", "6-077"],
    stage: 5,
    sprite: "knightmon",
    id: "5-058",
    url: "https://digimon.net/reference_en/detail.php?directory_name=knightmon"
  },
  {
    name_en: "LadyDevimon",
    name_jp: "LadyDevimon",
    next_evolutions: ["6-107", "6-037", "6-099", "7-029", "6-076"],
    stage: 5,
    sprite: "ladydevimon",
    id: "5-059",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ladydevimon"
  },
  {
    name_en: "LadyDevimon X",
    name_jp: "LadyDevimon X",
    next_evolutions: ["6-102", "6-059", "6-124", "6-024"],
    stage: 5,
    sprite: "ladydevimon_x",
    id: "5-060",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ladydevimon_x"
  },
  {
    name_en: "Lavogaritamon",
    name_jp: "Lavogaritamon",
    next_evolutions: ["6-142", "6-011"],
    stage: 5,
    sprite: "lavogaritamon",
    id: "5-061",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lavogaritamon"
  },
  {
    name_en: "Lilamon",
    name_jp: "Lilamon",
    next_evolutions: ["6-010", "6-006", "6-120", "6-103", "6-078", "6-123"],
    stage: 5,
    sprite: "lilamon",
    id: "5-062",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lilamon"
  },
  {
    name_en: "Lillymon",
    name_jp: "Lilimon",
    next_evolutions: ["6-123", "6-105", "6-114", "6-149"],
    stage: 5,
    sprite: "lillymon",
    id: "5-063",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lilimon"
  },
  {
    name_en: "Lillymon X",
    name_jp: "Lilimon X",
    next_evolutions: ["6-114", "6-024", "6-140", "6-108"],
    stage: 5,
    sprite: "lillymon_x",
    id: "5-064",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lilimon_x"
  },
  {
    name_en: "LoaderLeomon",
    name_jp: "LoaderLeomon",
    next_evolutions: ["6-009", "6-043", "6-055", "6-062", "6-065", "6-080"],
    stage: 5,
    sprite: "loaderleomon",
    id: "5-065",
    url: "https://digimon.net/reference_en/detail.php?directory_name=loaderleomon"
  },
  {
    name_en: "Locomon",
    name_jp: "Locomon",
    next_evolutions: ["6-062", "6-049", "6-065", "6-012", "6-080"],
    stage: 5,
    sprite: "locomon",
    id: "5-066",
    url: "https://digimon.net/reference_en/detail.php?directory_name=locomon"
  },
  {
    name_en: "Lucemon: Chaos Mode",
    name_jp: "Lucemon: Falldown Mode",
    next_evolutions: ["7-004", "6-144", "6-085", "6-114", "6-108", "6-023", "6-079"],
    stage: 5,
    sprite: "lucemon_chaos_mode",
    id: "5-067",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rucemonfalldownmode"
  },
  {
    name_en: "MachGaogamon",
    name_jp: "MachGaogamon",
    next_evolutions: ["6-096", "6-081", "6-020", "6-011", "6-041"],
    stage: 5,
    sprite: "machgaogamon",
    id: "5-068",
    url: "https://digimon.net/reference_en/detail.php?directory_name=machgaogamon"
  },
  {
    name_en: "MagnaAngemon",
    name_jp: "HolyAngemon",
    next_evolutions: ["6-143", "6-091", "6-128", "6-057", "6-018", "6-084", "6-146"],
    stage: 5,
    sprite: "magnaangemon",
    id: "5-069",
    url: "https://digimon.net/reference_en/detail.php?directory_name=holyangemon"
  },
  {
    name_en: "Mamemon",
    name_jp: "Mamemon",
    next_evolutions: ["6-022", "5-033", "6-028", "6-143"],
    stage: 5,
    sprite: "mamemon",
    id: "5-070",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mamemon"
  },
  {
    name_en: "Mamemon X",
    name_jp: "Mamemon X",
    next_evolutions: ["6-082", "6-043", "6-046", "6-070", "6-067", "6-093", "6-058", "6-034"],
    stage: 5,
    sprite: "mamemon_x",
    id: "5-071",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mamemon_x"
  },
  {
    name_en: "Mametyramon",
    name_jp: "Mametyramon",
    next_evolutions: ["6-111", "6-027", "6-019", "6-122", "6-032", "6-094", "6-118", "6-124", "6-040", "6-051"],
    stage: 5,
    sprite: "mametyramon",
    id: "5-072",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mametyramon"
  },
  {
    name_en: "Mammothmon",
    name_jp: "Mammon",
    next_evolutions: ["6-130", "6-013", "6-029", "6-007", "6-067"],
    stage: 5,
    sprite: "mammothmon",
    id: "5-073",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mammon"
  },
  {
    name_en: "Mammothmon X",
    name_jp: "Mammon X",
    next_evolutions: ["6-059", "6-102", "6-056", "6-035", "6-131", "6-024", "6-124"],
    stage: 5,
    sprite: "mammothmon_x",
    id: "5-074",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mammon_x"
  },
  {
    name_en: "Manticoremon",
    name_jp: "Manticoremon",
    next_evolutions: ["6-005", "6-052", "6-018", "6-031"],
    stage: 5,
    sprite: "manticoremon",
    id: "5-075",
    url: "https://digimon.net/reference_en/detail.php?directory_name=manticoremon"
  },
  {
    name_en: "MarineChimairamon",
    name_jp: "MarinChimairamon",
    next_evolutions: ["6-121", "6-086", "6-007", "6-109", "6-095", "6-056", "6-108", "6-146"],
    stage: 5,
    sprite: "marinechimairamon",
    id: "5-076",
    url: "https://digimon.net/reference_en/detail.php?directory_name=marinchimairamon"
  },
  {
    name_en: "MarineDevimon",
    name_jp: "MarinDevimon",
    next_evolutions: ["6-095", "6-112", "6-086", "6-008"],
    stage: 5,
    sprite: "marinedevimon",
    id: "5-077",
    url: "https://digimon.net/reference_en/detail.php?directory_name=marindevimon"
  },
  {
    name_en: "Maycrackmon",
    name_jp: "Meicrackmon",
    next_evolutions: ["6-119"],
    stage: 5,
    sprite: "maycrackmon",
    id: "5-078",
    url: "https://digimon.net/reference_en/detail.php?directory_name=meicrackmon"
  },
  {
    name_en: "Maycrackmon: Vicious Mode",
    name_jp: "Meicrackmon: Vicious Mode",
    next_evolutions: ["6-115"],
    stage: 5,
    sprite: "maycrackmon_vicious_mode",
    id: "5-079",
    url: "https://digimon.net/reference_en/detail.php?directory_name=meicrackmon_v"
  },
  {
    name_en: "Megadramon",
    name_jp: "Megadramon",
    next_evolutions: ["6-039", "6-001", "6-080", "6-068", "6-095"],
    stage: 5,
    sprite: "megadramon",
    id: "5-080",
    url: "https://digimon.net/reference_en/detail.php?directory_name=megadramon"
  },
  {
    name_en: "MegaKabuterimon (Red)",
    name_jp: "AtlurKabuterimon",
    next_evolutions: ["6-066", "6-123"],
    stage: 5,
    sprite: "megakabuterimon_red",
    id: "5-081",
    url: "https://digimon.net/reference_en/detail.php?directory_name=atlurkabuterimon"
  },
  {
    name_en: "MegaSeadramon",
    name_jp: "MegaSeadramon",
    next_evolutions: ["6-095", "6-086", "6-112", "6-109", "6-121"],
    stage: 5,
    sprite: "megaseadramon",
    id: "5-082",
    url: "https://digimon.net/reference_en/detail.php?directory_name=megaseadramon"
  },
  {
    name_en: "MegaSeadramon X",
    name_jp: "MegaSeadramon X",
    next_evolutions: ["6-056", "6-032", "6-131"],
    stage: 5,
    sprite: "megaseadramon_x",
    id: "5-083",
    url: "https://digimon.net/reference_en/detail.php?directory_name=megaseadramon_x"
  },
  {
    name_en: "Mephistomon X",
    name_jp: "Mephismon X",
    next_evolutions: ["6-035", "6-042", "6-124", "6-024"],
    stage: 5,
    sprite: "mephistomon_x",
    id: "5-084",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mephismon_x"
  },
  {
    name_en: "Mermaimon",
    name_jp: "Mermaimon",
    next_evolutions: ["6-008", "6-001", "6-007", "6-075", "6-095", "6-109", "6-121"],
    stage: 5,
    sprite: "mermaimon",
    id: "5-085",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mermaimon"
  },
  {
    name_en: "MetalGreymon",
    name_jp: "MetalGreymon",
    next_evolutions: ["6-143", "6-028", "6-080", "6-062", "6-065"],
    stage: 5,
    sprite: "metalgreymon_vaccine",
    id: "5-086",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalgreymon"
  },
  {
    name_en: "MetalGreymon (Vaccine)",
    name_jp: "MetalGreymon (Vaccine)",
    next_evolutions: ["6-143", "6-080", "6-028", "5-033"],
    stage: 5,
    sprite: "metalgreymon_vaccine",
    id: "5-087",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalgreymon-v"
  },
  {
    name_en: "MetalGreymon (Virus)",
    name_jp: "MetalGreymon (Virus)",
    next_evolutions: ["6-028", "6-051", "6-143"],
    stage: 5,
    sprite: "metalgreymon_virus",
    id: "5-088",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalgreymon-web"
  },
  {
    name_en: "MetalGreymon (Virus) X",
    name_jp: "MetalGreymon (Virus) X",
    next_evolutions: ["6-027", "6-138", "6-131", "6-111", "6-094", "6-032"],
    stage: 5,
    sprite: "metalgreymon_virus_x",
    id: "5-089",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalgreymon_vi_x"
  },
  {
    name_en: "MetalGreymon X",
    name_jp: "MetalGreymon X",
    next_evolutions: ["6-144", "7-021", "6-140", "6-108"],
    stage: 5,
    sprite: "metalgreymon_vaccine_x",
    id: "5-090",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalgreymon_va_x"
  },
  {
    name_en: "MetalMamemon",
    name_jp: "MetalMamemon",
    next_evolutions: ["6-038", "6-143", "6-091", "6-080", "6-065", "6-062"],
    stage: 5,
    sprite: "metalmamemon",
    id: "5-091",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalmamemon"
  },
  {
    name_en: "MetalPhantomon",
    name_jp: "MetalFantomon",
    next_evolutions: ["6-042", "6-032", "6-131", "6-094", "6-040"],
    stage: 5,
    sprite: "metalphantomon",
    id: "5-092",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalfantomon"
  },
  {
    name_en: "MetalTyrannomon",
    name_jp: "MetalTyranomon",
    next_evolutions: ["6-080", "6-064", "6-012", "6-062", "6-143", "6-028", "5-033", "7-045"],
    stage: 5,
    sprite: "metaltyrannomon",
    id: "5-093",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metaltyranomon"
  },
  {
    name_en: "MetalTyrannomon X",
    name_jp: "MetalTyranomon X",
    next_evolutions: ["7-004", "6-144", "7-022", "6-085", "6-108", "6-089", "6-092", "7-009"],
    stage: 5,
    sprite: "metaltyrannomon_x",
    id: "5-094",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metaltyranomon_x"
  },
  {
    name_en: "Monzaemon",
    name_jp: "Monzaemon",
    next_evolutions: ["6-073", "6-147"],
    stage: 5,
    sprite: "monzaemon",
    id: "5-095",
    url: "https://digimon.net/reference_en/detail.php?directory_name=monzaemon"
  },
  {
    name_en: "Monzaemon X",
    name_jp: "Monzaemon X",
    next_evolutions: ["6-034", "6-101", "6-082", "6-043", "6-110", "6-046"],
    stage: 5,
    sprite: "monzaemon_x",
    id: "5-096",
    url: "https://digimon.net/reference_en/detail.php?directory_name=monzaemon_x"
  },
  {
    name_en: "Mummymon",
    name_jp: "Mummymon",
    next_evolutions: ["5-033", "6-055", "6-016", "6-009", "6-042", "6-017", "7-020", "7-019"],
    stage: 5,
    sprite: "mummymon",
    id: "5-097",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mummymon"
  },
  {
    name_en: "Myotismon",
    name_jp: "Vamdemon",
    next_evolutions: ["6-107", "6-029", "7-007", "6-099"],
    stage: 5,
    sprite: "myotismon",
    id: "5-098",
    url: "https://digimon.net/reference_en/detail.php?directory_name=vamdemon"
  },
  {
    name_en: "Myotismon X",
    name_jp: "Vamdemon X",
    next_evolutions: ["6-040", "6-035", "6-094", "6-111", "6-032"],
    stage: 5,
    sprite: "myotismon_x",
    id: "5-099",
    url: "https://digimon.net/reference_en/detail.php?directory_name=vamdemon_x"
  },
  {
    name_en: "NeoDevimon",
    name_jp: "NeoDevimon",
    next_evolutions: ["5-033", "6-055", "6-088", "6-028", "6-143"],
    stage: 5,
    sprite: "neodevimon",
    id: "5-100",
    url: "https://digimon.net/reference_en/detail.php?directory_name=neodevimon"
  },
  {
    name_en: "Okuwamon",
    name_jp: "Okuwamon",
    next_evolutions: ["6-061", "6-126", "6-090", "6-066", "6-135"],
    stage: 5,
    sprite: "okuwamon",
    id: "5-101",
    url: "https://digimon.net/reference_en/detail.php?directory_name=okuwamon"
  },
  {
    name_en: "Okuwamon X",
    name_jp: "Okuwamon X",
    next_evolutions: ["6-059", "6-124", "6-024", "6-131"],
    stage: 5,
    sprite: "okuwamon_x",
    id: "5-102",
    url: "https://digimon.net/reference_en/detail.php?directory_name=okuwamon_x"
  },
  {
    name_en: "OmniShoutmon X",
    name_jp: "OmegaShoutmon X",
    next_evolutions: ["6-116", "6-002", "6-043", "6-135", "6-046"],
    stage: 5,
    sprite: "omnishoutmon_x",
    id: "5-103",
    url: "https://digimon.net/reference_en/detail.php?directory_name=omegashoutmon_x"
  },
  {
    name_en: "Orochimon",
    name_jp: "Orochimon",
    next_evolutions: ["6-098", "6-020", "6-011", "6-038", "6-091", "6-090", "6-147"],
    stage: 5,
    sprite: "orochimon",
    id: "5-104",
    url: "https://digimon.net/reference_en/detail.php?directory_name=orochimon"
  },
  {
    name_en: "Paildramon",
    name_jp: "Paildramon",
    next_evolutions: [
      "7-019",
      "6-013",
      "6-055",
      "6-009",
      "6-062",
      "6-065",
      "6-064",
      "7-020",
      "6-061",
      "6-137",
      "6-084",
      "6-128"
    ],
    stage: 5,
    sprite: "paildramon",
    id: "5-105",
    url: "https://digimon.net/reference_en/detail.php?directory_name=paildramon"
  },
  {
    name_en: "Parrotmon",
    name_jp: "Parrotmon",
    next_evolutions: ["6-120", "6-006", "6-010", "6-098", "6-091", "6-038"],
    stage: 5,
    sprite: "parrotmon",
    id: "5-106",
    url: "https://digimon.net/reference_en/detail.php?directory_name=parrotmon"
  },
  {
    name_en: "Phantomon",
    name_jp: "Fantomon",
    next_evolutions: ["6-037", "6-099", "6-107"],
    stage: 5,
    sprite: "phantomon",
    id: "5-107",
    url: "https://digimon.net/reference_en/detail.php?directory_name=fantomon"
  },
  {
    name_en: "Piranimon",
    name_jp: "Piranimon",
    next_evolutions: ["6-075", "6-008", "6-121", "6-095", "6-109"],
    stage: 5,
    sprite: "piranimon",
    id: "5-108",
    url: "https://digimon.net/reference_en/detail.php?directory_name=piranimon"
  },
  {
    name_en: "Piximon",
    name_jp: "Piccolomon",
    next_evolutions: ["6-081", "6-126", "6-061", "6-031"],
    stage: 5,
    sprite: "piximon",
    id: "5-109",
    url: "https://digimon.net/reference_en/detail.php?directory_name=picklemon"
  },
  {
    name_en: "Pumpkinmon",
    name_jp: "Pumpmon",
    next_evolutions: ["6-099", "6-043", "6-116", "6-034", "6-029", "6-013", "6-107"],
    stage: 5,
    sprite: "pumpkinmon",
    id: "5-110",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pumpmon"
  },
  {
    name_en: "RaijiLudomon",
    name_jp: "RaijiLudomon",
    next_evolutions: ["6-018", "6-004", "6-057", "6-052", "6-031"],
    stage: 5,
    sprite: "raijiludomon",
    id: "5-111",
    url: "https://digimon.net/reference_en/detail.php?directory_name=raijiludomon"
  },
  {
    name_en: "Rapidmon",
    name_jp: "Rapidmon",
    next_evolutions: ["6-087", "6-033"],
    stage: 5,
    sprite: "rapidmon",
    id: "5-112",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rapidmon"
  },
  {
    name_en: "Rebellimon",
    name_jp: "Rebellimon",
    next_evolutions: ["6-064", "6-012", "6-062", "6-065", "6-080"],
    stage: 5,
    sprite: "rebellimon",
    id: "5-113",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rebellimon"
  },
  {
    name_en: "Rhihimon",
    name_jp: "Raihimon",
    next_evolutions: ["6-009", "6-043", "6-055"],
    stage: 5,
    sprite: "rhihimon",
    id: "5-114",
    url: "https://digimon.net/reference_en/detail.php?directory_name=raihimon"
  },
  {
    name_en: "RizeGreymon",
    name_jp: "RizeGreymon",
    next_evolutions: ["6-129", "6-005", "6-018", "6-052", "6-074", "6-133"],
    stage: 5,
    sprite: "rizegreymon",
    id: "5-115",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rizegreymon"
  },
  {
    name_en: "RizeGreymon X",
    name_jp: "RizeGreymon X",
    next_evolutions: ["6-058", "6-104", "6-082", "6-110", "6-051", "6-046"],
    stage: 5,
    sprite: "rizegreymon_x",
    id: "5-116",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rizegreymon_x"
  },
  {
    name_en: "SaviorHuckmon",
    name_jp: "SaviorHackmon",
    next_evolutions: ["6-069", "6-030"],
    stage: 5,
    sprite: "saviorhuckmon",
    id: "5-117",
    url: "https://digimon.net/reference_en/detail.php?directory_name=saviorhuckmon"
  },
  {
    name_en: "Scorpiomon",
    name_jp: "Anomalocarimon",
    next_evolutions: [
      "6-109",
      "6-095",
      "6-143",
      "6-028",
      "5-033",
      "6-003",
      "6-081",
      "6-096",
      "6-098",
      "6-009",
      "6-146"
    ],
    stage: 5,
    sprite: "scorpiomon",
    id: "5-118",
    url: "https://digimon.net/reference_en/detail.php?directory_name=anomalocarimon"
  },
  {
    name_en: "Scorpiomon X",
    name_jp: "Anomalocarimon X",
    next_evolutions: ["6-110", "6-051", "6-034", "6-043", "6-046", "6-056"],
    stage: 5,
    sprite: "scorpiomon_x",
    id: "5-119",
    url: "https://digimon.net/reference_en/detail.php?directory_name=anomalocarimon-x"
  },
  {
    name_en: "Shakkoumon",
    name_jp: "Shakkoumon",
    next_evolutions: ["6-132", "6-086", "6-007", "6-121", "6-018", "6-057", "6-052", "6-085", "6-146"],
    stage: 5,
    sprite: "shakkoumon",
    id: "5-120",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shakkoumon"
  },
  {
    name_en: "ShogunGekomon",
    name_jp: "TonosamaGekomon",
    next_evolutions: ["6-090", "6-061"],
    stage: 5,
    sprite: "shogungekomon",
    id: "5-121",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tonosamagekomon"
  },
  {
    name_en: "Shoutmon X5",
    name_jp: "Shoutmon X5",
    next_evolutions: ["6-004", "6-018", "6-057", "6-052"],
    stage: 5,
    sprite: "shoutmon_x5",
    id: "5-122",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shoutmonx5"
  },
  {
    name_en: "Silphymon",
    name_jp: "Silphymon",
    next_evolutions: ["6-139", "6-003", "6-096", "6-010", "6-006", "6-145", "6-017", "6-081"],
    stage: 5,
    sprite: "silphymon",
    id: "5-123",
    url: "https://digimon.net/reference_en/detail.php?directory_name=silphymon"
  },
  {
    name_en: "Sirenmon",
    name_jp: "Sirenmon",
    next_evolutions: ["6-008", "6-086", "6-007", "6-121", "6-004", "6-083"],
    stage: 5,
    sprite: "sirenmon",
    id: "5-124",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sirenmon"
  },
  {
    name_en: "SkullBaluchimon",
    name_jp: "SkullBaluchimon",
    next_evolutions: ["6-127", "6-140", "7-022", "6-108", "6-013", "6-063"],
    stage: 5,
    sprite: "skullbaluchimon",
    id: "5-125",
    url: "https://digimon.net/reference_en/detail.php?directory_name=skullbaluchimon"
  },
  {
    name_en: "SkullGreymon",
    name_jp: "SkullGreymon",
    next_evolutions: ["6-130", "6-051", "6-143"],
    stage: 5,
    sprite: "skullgreymon",
    id: "5-126",
    url: "https://digimon.net/reference_en/detail.php?directory_name=skullgreymon"
  },
  {
    name_en: "SkullMeramon",
    name_jp: "DeathMeramon",
    next_evolutions: ["6-029", "6-130"],
    stage: 5,
    sprite: "skullmeramon",
    id: "5-127",
    url: "https://digimon.net/reference_en/detail.php?directory_name=deathmeramon"
  },
  {
    name_en: "Stefilmon",
    name_jp: "Stiffilmon",
    next_evolutions: ["6-027", "6-059", "6-118", "6-019", "6-124", "6-040", "6-056", "6-117"],
    stage: 5,
    sprite: "stefilmon",
    id: "5-128",
    url: "https://digimon.net/reference_en/detail.php?directory_name=stiffilmon"
  },
  {
    name_en: "Tekkamon",
    name_jp: "Tekkamon",
    next_evolutions: [],
    stage: 5,
    sprite: "tekkamon",
    id: "5-129",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tekkamon"
  },
  {
    name_en: "Toropiamon",
    name_jp: "Toropiamon",
    next_evolutions: ["6-006", "6-145", "6-010", "6-114", "6-146"],
    stage: 5,
    sprite: "toropiamon",
    id: "5-130",
    url: "https://digimon.net/reference_en/detail.php?directory_name=toropiamon"
  },
  {
    name_en: "Triceramon",
    name_jp: "Triceramon",
    next_evolutions: ["6-126", "6-066", "6-090", "6-042", "6-009"],
    stage: 5,
    sprite: "triceramon",
    id: "5-131",
    url: "https://digimon.net/reference_en/detail.php?directory_name=triceramon"
  },
  {
    name_en: "Triceramon X",
    name_jp: "Triceramon X",
    next_evolutions: ["6-138", "6-032", "6-111", "6-131", "6-094"],
    stage: 5,
    sprite: "triceramon_x",
    id: "5-132",
    url: "https://digimon.net/reference_en/detail.php?directory_name=triceramon_x"
  },
  {
    name_en: "Vademon",
    name_jp: "Vademon",
    next_evolutions: [],
    stage: 5,
    sprite: "vademon",
    id: "5-133",
    url: "https://digimon.net/reference_en/detail.php?directory_name=vademon"
  },
  {
    name_en: "Velgrmon",
    name_jp: "Velgrmon",
    next_evolutions: ["6-043", "6-055", "6-009"],
    stage: 5,
    sprite: "velgrmon",
    id: "5-134",
    url: "https://digimon.net/reference_en/detail.php?directory_name=velgrmon"
  },
  {
    name_en: "WarGrowlmon",
    name_jp: "MegaloGrowmon",
    next_evolutions: ["6-052", "6-004", "6-129", "6-088", "6-053"],
    stage: 5,
    sprite: "wargrowlmon",
    id: "5-135",
    url: "https://digimon.net/reference_en/detail.php?directory_name=megalogrowmon"
  },
  {
    name_en: "WarGrowlmon X",
    name_jp: "MegaloGrowmon X",
    next_evolutions: ["6-089", "7-009", "7-021", "6-085", "6-108"],
    stage: 5,
    sprite: "wargrowlmon_x",
    id: "5-136",
    url: "https://digimon.net/reference_en/detail.php?directory_name=megalogrowmon_x"
  },
  {
    name_en: "WaruMonzaemon",
    name_jp: "WaruMonzaemon",
    next_evolutions: ["6-141", "6-091", "6-013", "6-126"],
    stage: 5,
    sprite: "warumonzaemon",
    id: "5-137",
    url: "https://digimon.net/reference_en/detail.php?directory_name=warumonzaemon"
  },
  {
    name_en: "WaruSeadramon",
    name_jp: "WaruSeadramon",
    next_evolutions: ["6-075", "6-008", "6-121", "6-091", "6-038", "6-098", "6-056", "6-108"],
    stage: 5,
    sprite: "waruseadramon",
    id: "5-138",
    url: "https://digimon.net/reference_en/detail.php?directory_name=waruseadramon"
  },
  {
    name_en: "WereGarurumon",
    name_jp: "WereGarurumon",
    next_evolutions: ["6-013", "6-130", "6-099", "6-091", "6-038", "6-098"],
    stage: 5,
    sprite: "weregarurumon",
    id: "5-139",
    url: "https://digimon.net/reference_en/detail.php?directory_name=weregarrumon"
  },
  {
    name_en: "WereGarurumon X",
    name_jp: "WereGarurumon X",
    next_evolutions: ["6-092", "7-021", "6-140", "6-108"],
    stage: 5,
    sprite: "weregarurumon_x",
    id: "5-140",
    url: "https://digimon.net/reference_en/detail.php?directory_name=weregarurumon_x"
  },
  {
    name_en: "Whamon",
    name_jp: "Whamon",
    next_evolutions: ["6-086", "6-109", "6-112", "6-146"],
    stage: 5,
    sprite: "whamon",
    id: "5-141",
    url: "https://digimon.net/reference_en/detail.php?directory_name=whamon"
  },
  {
    name_en: "Wingdramon",
    name_jp: "Wingdramon",
    next_evolutions: ["6-133", "6-129"],
    stage: 5,
    sprite: "wingdramon",
    id: "5-142",
    url: "https://digimon.net/reference_en/detail.php?directory_name=wingdramon"
  },
  {
    name_en: "Zudomon",
    name_jp: "Zudomon",
    next_evolutions: ["6-086", "6-056", "6-146"],
    stage: 5,
    sprite: "zudomon",
    id: "5-143",
    url: "https://digimon.net/reference_en/detail.php?directory_name=zudomon"
  },
  {
    name_en: "Boutmon",
    name_jp: "Boutmon",
    next_evolutions: ["6-148"],
    stage: 5,
    sprite: "boutmon",
    id: "5-144",
    url: "https://digimon.net/reference_en/detail.php?directory_name=boutmon"
  },
  {
    name_en: "DarkSuperStarmon",
    name_jp: "DarkSuperStarmon",
    next_evolutions: ["6-011", "6-005", "6-048"],
    stage: 5,
    sprite: "darksuperstarmon",
    id: "5-145",
    url: "https://digimon.net/reference_en/detail.php?directory_name=darksuperstarmon"
  },
  {
    name_en: "Doruguremon",
    name_jp: "DORUguremon",
    next_evolutions: ["6-002", "6-150", "6-051", "6-082", "6-043"],
    stage: 5,
    sprite: "doruguremon",
    id: "5-146",
    url: "https://digimon.net/reference_en/detail.php?directory_name=doruguremon"
  },
  {
    name_en: "Pandamon",
    name_jp: "Pandamon",
    next_evolutions: ["6-091"],
    stage: 5,
    sprite: "pandamon",
    id: "5-147",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pandamon"
  },
  {
    name_en: "SkullScorpiomon",
    name_jp: "Scorpiomon",
    next_evolutions: ["6-003", "6-050", "6-096", "6-098", "6-009"],
    stage: 5,
    sprite: "skullscorpiomon",
    id: "5-148",
    url: "https://digimon.net/reference_en/detail.php?directory_name=scorpiomon"
  },
  {
    name_en: "SuperStarmon",
    name_jp: "SuperStarmon",
    next_evolutions: ["6-048", "6-011", "6-005"],
    stage: 5,
    sprite: "superstarmon",
    id: "5-149",
    url: "https://digimon.net/reference_en/detail.php?directory_name=superstarmon"
  },
  {
    name_en: "Aegisdramon",
    name_jp: "Aegisdramon",
    next_evolutions: ["7-039"],
    stage: 6,
    sprite: "aegisdramon",
    id: "6-001",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ageisdramon"
  },
  {
    name_en: "Alphamon",
    name_jp: "Alphamon",
    next_evolutions: ["7-001"],
    stage: 6,
    sprite: "alphamon",
    id: "6-002",
    url: "https://digimon.net/reference_en/detail.php?directory_name=alphamon"
  },
  {
    name_en: "AncientBeetlemon",
    name_jp: "AncientBeatmon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancientbeetlemon",
    id: "6-003",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancientbeatmon"
  },
  {
    name_en: "AncientGarurumon",
    name_jp: "AncientGarurumon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancientgarurumon",
    id: "6-004",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancientgarurumon"
  },
  {
    name_en: "AncientGreymon",
    name_jp: "AncientGreymon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancientgreymon",
    id: "6-005",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancientgreymon"
  },
  {
    name_en: "AncientKazemon",
    name_jp: "AncientIrismon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancientkazemon",
    id: "6-006",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancientirismon"
  },
  {
    name_en: "AncientMegatheriummon",
    name_jp: "AncientMegatheriumon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancientmegatheriummon",
    id: "6-007",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancientmegatheriumon"
  },
  {
    name_en: "AncientMermaimon",
    name_jp: "AncientMermaimon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancientmermaimon",
    id: "6-008",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancientmermaimon"
  },
  {
    name_en: "AncientSphinxmon",
    name_jp: "AncientSphinxmon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancientsphinxmon",
    id: "6-009",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancientsphinkmon"
  },
  {
    name_en: "AncientTroymon",
    name_jp: "AncientTroiamon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancienttroymon",
    id: "6-010",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancienttroiamon"
  },
  {
    name_en: "AncientVolcanomon",
    name_jp: "AncientVolcamon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancientvolcanomon",
    id: "6-011",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancientvolcamon"
  },
  {
    name_en: "AncientWisemon",
    name_jp: "AncientWisemon",
    next_evolutions: [],
    stage: 6,
    sprite: "ancientwisemon",
    id: "6-012",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ancientwisetmon"
  },
  {
    name_en: "Anubismon",
    name_jp: "Anubimon",
    next_evolutions: [],
    stage: 6,
    sprite: "anubismon",
    id: "6-013",
    url: "https://digimon.net/reference_en/detail.php?directory_name=anubimon"
  },
  {
    name_en: "Apocalymon",
    name_jp: "Apoclymon",
    next_evolutions: [],
    stage: 6,
    sprite: "apocalymon",
    id: "6-014",
    url: "https://digimon.net/reference_en/detail.php?directory_name=apoclymon"
  },
  {
    name_en: "Apollomon",
    name_jp: "Apollomon",
    next_evolutions: ["7-018"],
    stage: 6,
    sprite: "apollomon",
    id: "6-015",
    url: "https://digimon.net/reference_en/detail.php?directory_name=apollomon"
  },
  {
    name_en: "Argomon",
    name_jp: "Algomon",
    next_evolutions: [],
    stage: 6,
    sprite: "argomon_ultimate",
    id: "6-016",
    url: "https://digimon.net/reference_en/detail.php?directory_name=algomon"
  },
  {
    name_en: "Armageddemon",
    name_jp: "Armagemon",
    next_evolutions: [],
    stage: 6,
    sprite: "armageddemon",
    id: "6-017",
    url: "https://digimon.net/reference_en/detail.php?directory_name=armagemon"
  },
  {
    name_en: "Azulongmon",
    name_jp: "Qinglongmon",
    next_evolutions: ["6-050"],
    stage: 6,
    sprite: "azulongmon",
    id: "6-018",
    url: "https://digimon.net/reference_en/detail.php?directory_name=qinglongmon"
  },
  {
    name_en: "Bagramon",
    name_jp: "Bagramon",
    next_evolutions: ["7-011", "7-003"],
    stage: 6,
    sprite: "bagramon",
    id: "6-019",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bagramon"
  },
  {
    name_en: "Baihumon",
    name_jp: "Baihumon",
    next_evolutions: ["6-050"],
    stage: 6,
    sprite: "baihumon",
    id: "6-020",
    url: "https://digimon.net/reference_en/detail.php?directory_name=baihumon"
  },
  {
    name_en: "BanchoLeomon",
    name_jp: "BanchoLeomon",
    next_evolutions: ["7-008"],
    stage: 6,
    sprite: "bancholeomon",
    id: "6-021",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bancholeomon"
  },
  {
    name_en: "BanchoMamemon",
    name_jp: "BanchoMamemon",
    next_evolutions: [],
    stage: 6,
    sprite: "banchomamemon",
    id: "6-022",
    url: "https://digimon.net/reference_en/detail.php?directory_name=banchomamemon"
  },
  {
    name_en: "Barbamon",
    name_jp: "Barbamon",
    next_evolutions: [],
    stage: 6,
    sprite: "barbamon",
    id: "6-023",
    url: "https://digimon.net/reference_en/detail.php?directory_name=barbamon"
  },
  {
    name_en: "BeelStarmon X",
    name_jp: "BeelStarmon X",
    next_evolutions: ["7-012", "7-004"],
    stage: 6,
    sprite: "beelstarmon_x",
    id: "6-024",
    url: "https://digimon.net/reference_en/detail.php?directory_name=beelstarmon_x"
  },
  {
    name_en: "Beelzemon",
    name_jp: "Beelzebumon",
    next_evolutions: ["7-005"],
    stage: 6,
    sprite: "beelzemon",
    id: "6-025",
    url: "https://digimon.net/reference_en/detail.php?directory_name=beelzebumon"
  },
  {
    name_en: "Belphemon: Rage Mode",
    name_jp: "Belphemon: Rage Mode",
    next_evolutions: ["7-031"],
    stage: 6,
    sprite: "belphemon_rage_mode",
    id: "6-026",
    url: "https://digimon.net/reference_en/detail.php?directory_name=belphemonragemode"
  },
  {
    name_en: "BlackWarGreymon X",
    name_jp: "BlackWarGreymon X",
    next_evolutions: ["7-010", "7-038", "7-003"],
    stage: 6,
    sprite: "blackwargreymon_x",
    id: "6-027",
    url: "https://digimon.net/reference_en/detail.php?directory_name=blackwargreymon_x"
  },
  {
    name_en: "BlitzGreymon",
    name_jp: "BlitzGreymon",
    next_evolutions: ["7-033"],
    stage: 6,
    sprite: "blitzgreymon",
    id: "6-028",
    url: "https://digimon.net/reference_en/detail.php?directory_name=blitzgreymon"
  },
  {
    name_en: "Boltmon",
    name_jp: "Boltmon",
    next_evolutions: [],
    stage: 6,
    sprite: "boltmon",
    id: "6-029",
    url: "https://digimon.net/reference_en/detail.php?directory_name=boltmon"
  },
  {
    name_en: "Breakdramon",
    name_jp: "Breakdramon",
    next_evolutions: ["7-014"],
    stage: 6,
    sprite: "breakdramon",
    id: "6-030",
    url: "https://digimon.net/reference_en/detail.php?directory_name=breakdramon"
  },
  {
    name_en: "BryweLudramon",
    name_jp: "BryweLudramon",
    next_evolutions: ["7-037"],
    stage: 6,
    sprite: "bryweludramon",
    id: "6-031",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bryweludramon"
  },
  {
    name_en: "Chaosdramon X",
    name_jp: "Chaosdramon X",
    next_evolutions: ["7-010", "7-012", "7-027"],
    stage: 6,
    sprite: "chaosdramon_x",
    id: "6-032",
    url: "https://digimon.net/reference_en/detail.php?directory_name=chaosdramon-x"
  },
  {
    name_en: "Cherubimon (Virtue)",
    name_jp: "Cherubimon (Virtue)",
    next_evolutions: [],
    stage: 6,
    sprite: "cherubimon_virtue",
    id: "6-033",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cherubimon"
  },
  {
    name_en: "Cherubimon (Virtue) X",
    name_jp: "Cherubimon (Virtue) X",
    next_evolutions: ["7-040", "7-022"],
    stage: 6,
    sprite: "cherubimon_virtue_x",
    id: "6-034",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cherubimon_x"
  },
  {
    name_en: "Cherubimon (Vice) X",
    name_jp: "Cherubimon (Vice) X",
    next_evolutions: ["7-006", "7-003"],
    stage: 6,
    sprite: "cherubimon_vice_x",
    id: "6-035",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cherubimondark_x"
  },
  {
    name_en: "Craniamon",
    name_jp: "Craniummon",
    next_evolutions: [],
    stage: 6,
    sprite: "craniamon",
    id: "6-036",
    url: "https://digimon.net/reference_en/detail.php?directory_name=craniummon"
  },
  {
    name_en: "Creepymon",
    name_jp: "Demon",
    next_evolutions: ["7-031"],
    stage: 6,
    sprite: "creepymon",
    id: "6-037",
    url: "https://digimon.net/reference_en/detail.php?directory_name=demon"
  },
  {
    name_en: "CresGarurumon",
    name_jp: "CresGarurumon",
    next_evolutions: ["7-033"],
    stage: 6,
    sprite: "cresgarurumon",
    id: "6-038",
    url: "https://digimon.net/reference_en/detail.php?directory_name=cresgarurumon"
  },
  {
    name_en: "Darkdramon",
    name_jp: "Darkdramon",
    next_evolutions: ["7-008", "7-045"],
    stage: 6,
    sprite: "darkdramon",
    id: "6-039",
    url: "https://digimon.net/reference_en/detail.php?directory_name=darkdramon"
  },
  {
    name_en: "DarkKnightmon X",
    name_jp: "DarkKnightmon X",
    next_evolutions: ["7-027", "7-011", "7-003"],
    stage: 6,
    sprite: "darkknightmon_x",
    id: "6-040",
    url: "https://digimon.net/reference_en/detail.php?directory_name=darkknightmon_x"
  },
  {
    name_en: "Dianamon",
    name_jp: "Dianamon",
    next_evolutions: ["7-018"],
    stage: 6,
    sprite: "dianamon",
    id: "6-041",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dianamon"
  },
  {
    name_en: "Dinorexmon",
    name_jp: "Dinorexmon",
    next_evolutions: ["7-024", "7-003"],
    stage: 6,
    sprite: "dinorexmon",
    id: "6-042",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dinorexmon"
  },
  {
    name_en: "Dinotigermon",
    name_jp: "Dinotigermon",
    next_evolutions: ["7-026", "7-009", "7-021", "7-022"],
    stage: 6,
    sprite: "dinotigermon",
    id: "6-043",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dinotigermon"
  },
  {
    name_en: "Durandamon",
    name_jp: "Durandamon",
    next_evolutions: ["7-037"],
    stage: 6,
    sprite: "durandamon",
    id: "6-044",
    url: "https://digimon.net/reference_en/detail.php?directory_name=durandamon"
  },
  {
    name_en: "Dynasmon",
    name_jp: "Dynasmon",
    next_evolutions: [],
    stage: 6,
    sprite: "dynasmon",
    id: "6-045",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dynasmon"
  },
  {
    name_en: "Ebemon X",
    name_jp: "Ebemon X",
    next_evolutions: ["7-017", "7-026", "7-015", "7-021"],
    stage: 6,
    sprite: "ebemon_x",
    id: "6-046",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ebemon_x"
  },
  {
    name_en: "Ebonwumon",
    name_jp: "Xuanwumon",
    next_evolutions: ["6-050"],
    stage: 6,
    sprite: "ebonwumon",
    id: "6-047",
    url: "https://digimon.net/reference_en/detail.php?directory_name=xuanwumon"
  },
  {
    name_en: "EmperorGreymon",
    name_jp: "KaiserGreymon",
    next_evolutions: ["6-134"],
    stage: 6,
    sprite: "emperorgreymon",
    id: "6-048",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kaisergreymon"
  },
  {
    name_en: "Eosmon",
    name_jp: "Eosmon",
    next_evolutions: [],
    stage: 6,
    sprite: "eosmon_ultimate",
    id: "6-049",
    url: "https://digimon.net/reference_en/detail.php?directory_name=eosmon_lv6"
  },
  {
    name_en: "Fanglongmon",
    name_jp: "Huanglongmon",
    next_evolutions: [],
    stage: 6,
    sprite: "fanglongmon",
    id: "6-050",
    url: "https://digimon.net/reference_en/detail.php?directory_name=huanglongmon"
  },
  {
    name_en: "Gaiomon",
    name_jp: "Gaioumon",
    next_evolutions: ["7-001", "7-009", "7-021"],
    stage: 6,
    sprite: "gaiomon",
    id: "6-051",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gaioumon"
  },
  {
    name_en: "Gallantmon",
    name_jp: "Dukemon",
    next_evolutions: [],
    stage: 6,
    sprite: "gallantmon",
    id: "6-052",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dukemon"
  },
  {
    name_en: "Gallantmon X",
    name_jp: "Dukemon X",
    next_evolutions: [],
    stage: 6,
    sprite: "gallantmon_x",
    id: "6-053",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dukemon_x"
  },
  {
    name_en: "Gankoomon",
    name_jp: "Gankoomon",
    next_evolutions: [],
    stage: 6,
    sprite: "gankoomon",
    id: "6-054",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gankoomon"
  },
  {
    name_en: "Ghoulmon",
    name_jp: "Deathmon",
    next_evolutions: [],
    stage: 6,
    sprite: "ghoulmon",
    id: "6-055",
    url: "https://digimon.net/reference_en/detail.php?directory_name=deathmon"
  },
  {
    name_en: "GigaSeadramon",
    name_jp: "GigaSeadramon",
    next_evolutions: ["7-024", "7-003"],
    stage: 6,
    sprite: "gigaseadramon",
    id: "6-056",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gigaseadramon"
  },
  {
    name_en: "Goldramon",
    name_jp: "Goddramon",
    next_evolutions: ["6-050"],
    stage: 6,
    sprite: "goldramon",
    id: "6-057",
    url: "https://digimon.net/reference_en/detail.php?directory_name=goddramon"
  },
  {
    name_en: "Goldramon X",
    name_jp: "Goddramon X",
    next_evolutions: ["7-015", "7-021"],
    stage: 6,
    sprite: "goldramon_x",
    id: "6-058",
    url: "https://digimon.net/reference_en/detail.php?directory_name=goddramon_x"
  },
  {
    name_en: "GrandisKuwagamon",
    name_jp: "GrandisKuwagamon",
    next_evolutions: ["7-024", "7-003"],
    stage: 6,
    sprite: "grandiskuwagamon",
    id: "6-059",
    url: "https://digimon.net/reference_en/detail.php?directory_name=grandiskuwagamon"
  },
  {
    name_en: "GranDracmon",
    name_jp: "GrandDracumon",
    next_evolutions: [],
    stage: 6,
    sprite: "grandracmon",
    id: "6-060",
    url: "https://digimon.net/reference_en/detail.php?directory_name=granddracumon"
  },
  {
    name_en: "GranKuwagamon",
    name_jp: "GranKuwagamon",
    next_evolutions: [],
    stage: 6,
    sprite: "grankuwagamon",
    id: "6-061",
    url: "https://digimon.net/reference_en/detail.php?directory_name=grankuwagamon"
  },
  {
    name_en: "GroundLocomon",
    name_jp: "GrandLocomon",
    next_evolutions: [],
    stage: 6,
    sprite: "groundlocomon",
    id: "6-062",
    url: "https://digimon.net/reference_en/detail.php?directory_name=grandlocomon"
  },
  {
    name_en: "Gryphonmon",
    name_jp: "Griffomon",
    next_evolutions: [],
    stage: 6,
    sprite: "gryphonmon",
    id: "6-063",
    url: "https://digimon.net/reference_en/detail.php?directory_name=griffomon"
  },
  {
    name_en: "Gundramon",
    name_jp: "Gundramon",
    next_evolutions: ["7-002"],
    stage: 6,
    sprite: "gundramon",
    id: "6-064",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gundramon"
  },
  {
    name_en: "HeavyLeomon",
    name_jp: "HeavyLeomon",
    next_evolutions: [],
    stage: 6,
    sprite: "heavyleomon",
    id: "6-065",
    url: "https://digimon.net/reference_en/detail.php?directory_name=heavyleomon"
  },
  {
    name_en: "HerculesKabuterimon",
    name_jp: "HerakleKabuterimon",
    next_evolutions: [],
    stage: 6,
    sprite: "herculeskabuterimon",
    id: "6-066",
    url: "https://digimon.net/reference_en/detail.php?directory_name=heraklekabuterimon"
  },
  {
    name_en: "Hexeblaumon",
    name_jp: "Hexeblaumon",
    next_evolutions: ["7-017", "7-028", "7-009", "7-040", "7-023", "7-021"],
    stage: 6,
    sprite: "hexeblaumon",
    id: "6-067",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hexeblaumon"
  },
  {
    name_en: "HiAndromon",
    name_jp: "HiAndromon",
    next_evolutions: ["7-045"],
    stage: 6,
    sprite: "hiandromon",
    id: "6-068",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hiandromon"
  },
  {
    name_en: "Jesmon",
    name_jp: "Jesmon",
    next_evolutions: ["7-021"],
    stage: 6,
    sprite: "jesmon",
    id: "6-069",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jesmon"
  },
  {
    name_en: "Justimon X",
    name_jp: "Justimon X",
    next_evolutions: ["7-017", "7-026"],
    stage: 6,
    sprite: "justimon_x",
    id: "6-070",
    url: "https://digimon.net/reference_en/detail.php?directory_name=justimon_x"
  },
  {
    name_en: "Justimon: Blitz Arm",
    name_jp: "Justimon: Blitz Arm",
    next_evolutions: [],
    stage: 6,
    sprite: "justimon_blitz_arm",
    id: "6-071",
    url: "https://digimon.net/reference_en/detail.php?directory_name=justimon_blitzarm"
  },
  {
    name_en: "Kentaurosmon",
    name_jp: "Sleipmon",
    next_evolutions: [],
    stage: 6,
    sprite: "kentaurosmon",
    id: "6-072",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sleipmon"
  },
  {
    name_en: "KingEtemon",
    name_jp: "KingEtemon",
    next_evolutions: [],
    stage: 6,
    sprite: "kingetemon",
    id: "6-073",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kingetemon"
  },
  {
    name_en: "Leopardmon",
    name_jp: "Duftmon",
    next_evolutions: [],
    stage: 6,
    sprite: "leopardmon",
    id: "6-074",
    url: "https://digimon.net/reference_en/detail.php?directory_name=duftmon"
  },
  {
    name_en: "Leviamon",
    name_jp: "Leviamon",
    next_evolutions: ["7-002"],
    stage: 6,
    sprite: "leviamon",
    id: "6-075",
    url: "https://digimon.net/reference_en/detail.php?directory_name=leviamon"
  },
  {
    name_en: "Lilithmon",
    name_jp: "Lilithmon",
    next_evolutions: [],
    stage: 6,
    sprite: "lilithmon",
    id: "6-076",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lilithmon"
  },
  {
    name_en: "LordKnightmon",
    name_jp: "LordKnightmon",
    next_evolutions: [],
    stage: 6,
    sprite: "lordknightmon",
    id: "6-077",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lordknightmon"
  },
  {
    name_en: "Lotosmon",
    name_jp: "Lotusmon",
    next_evolutions: ["7-036"],
    stage: 6,
    sprite: "lotosmon",
    id: "6-078",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lotusmon"
  },
  {
    name_en: "Lucemon: Satan Mode",
    name_jp: "Lucemon: Satan Mode",
    next_evolutions: [],
    stage: 6,
    sprite: "lucemon_satan_mode",
    id: "6-079",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lucemonsatanmode"
  },
  {
    name_en: "Machinedramon",
    name_jp: "Mugendramon",
    next_evolutions: ["7-039", "6-014", "7-045"],
    stage: 6,
    sprite: "machinedramon",
    id: "6-080",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mugendramon"
  },
  {
    name_en: "Magnadramon",
    name_jp: "Holydramon",
    next_evolutions: ["6-050"],
    stage: 6,
    sprite: "magnadramon",
    id: "6-081",
    url: "https://digimon.net/reference_en/detail.php?directory_name=holydramon"
  },
  {
    name_en: "Magnadramon X",
    name_jp: "Holydramon X",
    next_evolutions: ["7-028", "7-026", "7-040", "7-022"],
    stage: 6,
    sprite: "magnadramon_x",
    id: "6-082",
    url: "https://digimon.net/reference_en/detail.php?directory_name=holydramon_x"
  },
  {
    name_en: "MagnaGarurumon",
    name_jp: "MagnaGarurumon",
    next_evolutions: ["6-134"],
    stage: 6,
    sprite: "magnagarurumon",
    id: "6-083",
    url: "https://digimon.net/reference_en/detail.php?directory_name=magnagarurumon"
  },
  {
    name_en: "Magnamon",
    name_jp: "Magnamon",
    next_evolutions: [],
    stage: 6,
    sprite: "magnamon",
    id: "6-084",
    url: "https://digimon.net/reference_en/detail.php?directory_name=magnamon"
  },
  {
    name_en: "MaloMyotismon",
    name_jp: "BelialVamdemon",
    next_evolutions: ["7-012"],
    stage: 6,
    sprite: "malomyotismon",
    id: "6-085",
    url: "https://digimon.net/reference_en/detail.php?directory_name=belialvamdemon"
  },
  {
    name_en: "MarineAngemon",
    name_jp: "MarinAngemon",
    next_evolutions: [],
    stage: 6,
    sprite: "marineangemon",
    id: "6-086",
    url: "https://digimon.net/reference_en/detail.php?directory_name=marinangemon"
  },
  {
    name_en: "MegaGargomon",
    name_jp: "SaintGalgomon",
    next_evolutions: [],
    stage: 6,
    sprite: "megagargomon",
    id: "6-087",
    url: "https://digimon.net/reference_en/detail.php?directory_name=saintgalgomon"
  },
  {
    name_en: "Megidramon",
    name_jp: "Megidramon",
    next_evolutions: ["7-002"],
    stage: 6,
    sprite: "megidramon",
    id: "6-088",
    url: "https://digimon.net/reference_en/detail.php?directory_name=megidramon"
  },
  {
    name_en: "Megidramon X",
    name_jp: "Megidramon X",
    next_evolutions: ["7-016"],
    stage: 6,
    sprite: "megidramon_x",
    id: "6-089",
    url: "https://digimon.net/reference_en/detail.php?directory_name=megidramon_x"
  },
  {
    name_en: "MetalEtemon",
    name_jp: "MetalEtemon",
    next_evolutions: [],
    stage: 6,
    sprite: "metaletemon",
    id: "6-090",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metaletemon"
  },
  {
    name_en: "MetalGarurumon",
    name_jp: "MetalGarurumon",
    next_evolutions: ["7-032"],
    stage: 6,
    sprite: "metalgarurumon",
    id: "6-091",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalgarurumon"
  },
  {
    name_en: "MetalGarurumon X",
    name_jp: "MetalGarurumon X",
    next_evolutions: ["7-034"],
    stage: 6,
    sprite: "metalgarurumon_x",
    id: "6-092",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalgarurumon_x"
  },
  {
    name_en: "Metallicdramon",
    name_jp: "Metallicdramon",
    next_evolutions: ["7-028", "7-013", "7-009", "7-015", "7-040", "7-022"],
    stage: 6,
    sprite: "metallicdramon",
    id: "6-093",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metallicdramon"
  },
  {
    name_en: "MetalPiranimon",
    name_jp: "MetalPiranimon",
    next_evolutions: ["7-025", "7-003", "7-006"],
    stage: 6,
    sprite: "metalpiranimon",
    id: "6-094",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalpiranimon"
  },
  {
    name_en: "MetalSeadramon",
    name_jp: "MetalSeadramon",
    next_evolutions: ["6-001", "6-014"],
    stage: 6,
    sprite: "metalseadramon",
    id: "6-095",
    url: "https://digimon.net/reference_en/detail.php?directory_name=metalseadramon"
  },
  {
    name_en: "MirageGaogamon",
    name_jp: "MirageGaogamon",
    next_evolutions: [],
    stage: 6,
    sprite: "miragegaogamon",
    id: "6-096",
    url: "https://digimon.net/reference_en/detail.php?directory_name=miragegaogamon"
  },
  {
    name_en: "Murmukusmon",
    name_jp: "Murmukusmon",
    next_evolutions: [],
    stage: 6,
    sprite: "murmukusmon",
    id: "6-097",
    url: "https://digimon.net/reference_en/detail.php?directory_name=murmukusmon"
  },
  {
    name_en: "Nidhoggmon",
    name_jp: "Nidhoggmon",
    next_evolutions: [],
    stage: 6,
    sprite: "nidhoggmon",
    id: "6-098",
    url: "https://digimon.net/reference_en/detail.php?directory_name=nidhoggmon"
  },
  {
    name_en: "NoblePumpkinmon",
    name_jp: "NoblePumpmon",
    next_evolutions: ["7-016", "7-026", "7-034", "7-023"],
    stage: 6,
    sprite: "noblepumpkinmon",
    id: "6-099",
    url: "https://digimon.net/reference_en/detail.php?directory_name=noblepumpmon"
  },
  {
    name_en: "Ophanimon",
    name_jp: "Ofanimon",
    next_evolutions: [],
    stage: 6,
    sprite: "ophanimon",
    id: "6-100",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ofanimon"
  },
  {
    name_en: "Ophanimon X",
    name_jp: "Ofanimon X",
    next_evolutions: ["7-023", "7-022"],
    stage: 6,
    sprite: "ophanimon_x",
    id: "6-101",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ofanimon_x"
  },
  {
    name_en: "Ophanimon: Falldown Mode X",
    name_jp: "Ofanimon: Falldown Mode X",
    next_evolutions: ["7-025", "7-003"],
    stage: 6,
    sprite: "ophanimon_falldown_mode_x",
    id: "6-102",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ofanimonfdm_x"
  },
  {
    name_en: "Ornismon",
    name_jp: "Ornismon",
    next_evolutions: [],
    stage: 6,
    sprite: "ornismon",
    id: "6-103",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ornismon"
  },
  {
    name_en: "Ouryumon",
    name_jp: "Ouryumon",
    next_evolutions: ["7-001", "7-021"],
    stage: 6,
    sprite: "ouryumon",
    id: "6-104",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ouryumon"
  },
  {
    name_en: "Phoenixmon",
    name_jp: "Hououmon",
    next_evolutions: [],
    stage: 6,
    sprite: "phoenixmon",
    id: "6-105",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hououmon"
  },
  {
    name_en: "Phoenixmon X",
    name_jp: "Hououmon X",
    next_evolutions: ["7-013", "7-026"],
    stage: 6,
    sprite: "phoenixmon_x",
    id: "6-106",
    url: "https://digimon.net/reference_en/detail.php?directory_name=hououmon_x"
  },
  {
    name_en: "Piedmon",
    name_jp: "Piemon",
    next_evolutions: ["7-007", "6-014"],
    stage: 6,
    sprite: "piedmon",
    id: "6-107",
    url: "https://digimon.net/reference_en/detail.php?directory_name=piemon"
  },
  {
    name_en: "PlatinumNumemon",
    name_jp: "PlatinumNumemon",
    next_evolutions: ["7-034"],
    stage: 6,
    sprite: "platinumnumemon",
    id: "6-108",
    url: "https://digimon.net/reference_en/detail.php?directory_name=platinumnumemon"
  },
  {
    name_en: "Plesiomon",
    name_jp: "Plesiomon",
    next_evolutions: ["6-001"],
    stage: 6,
    sprite: "plesiomon",
    id: "6-109",
    url: "https://digimon.net/reference_en/detail.php?directory_name=plesiomon"
  },
  {
    name_en: "Plesiomon X",
    name_jp: "Plesiomon X",
    next_evolutions: ["7-034", "7-022"],
    stage: 6,
    sprite: "plesiomon_x",
    id: "6-110",
    url: "https://digimon.net/reference_en/detail.php?directory_name=plesiomon_x"
  },
  {
    name_en: "PrinceMamemon X",
    name_jp: "PrinceMamemon X",
    next_evolutions: ["7-010", "7-012", "7-027"],
    stage: 6,
    sprite: "princemamemon_x",
    id: "6-111",
    url: "https://digimon.net/reference_en/detail.php?directory_name=princemamemon_x"
  },
  {
    name_en: "Pukumon",
    name_jp: "Pukumon",
    next_evolutions: [],
    stage: 6,
    sprite: "pukumon",
    id: "6-112",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pukumon"
  },
  {
    name_en: "Puppetmon",
    name_jp: "Pinochimon",
    next_evolutions: ["6-014"],
    stage: 6,
    sprite: "puppetmon",
    id: "6-113",
    url: "https://digimon.net/reference_en/detail.php?directory_name=pinochimon"
  },
  {
    name_en: "Rafflesimon",
    name_jp: "Rafflesimon",
    next_evolutions: ["7-030", "7-026"],
    stage: 6,
    sprite: "rafflesimon",
    id: "6-114",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rafflesimon"
  },
  {
    name_en: "Raguelmon",
    name_jp: "Raguelmon",
    next_evolutions: ["7-035"],
    stage: 6,
    sprite: "raguelmon",
    id: "6-115",
    url: "https://digimon.net/reference_en/detail.php?directory_name=raguelmon"
  },
  {
    name_en: "Rapidmon X",
    name_jp: "Rapidmon X",
    next_evolutions: ["7-028", "7-009"],
    stage: 6,
    sprite: "rapidmon_x",
    id: "6-116",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rapidmon_x"
  },
  {
    name_en: "Rasenmon",
    name_jp: "Rasenmon",
    next_evolutions: [],
    stage: 6,
    sprite: "rasenmon",
    id: "6-117",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rasenmon"
  },
  {
    name_en: "Rasenmon: Fury Mode",
    name_jp: "Rasenmon: Fury Mode",
    next_evolutions: ["7-038", "7-012"],
    stage: 6,
    sprite: "rasenmon_fury_mode",
    id: "6-118",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rasenmon_f"
  },
  {
    name_en: "Rasielmon",
    name_jp: "Rasielmon",
    next_evolutions: [],
    stage: 6,
    sprite: "rasielmon",
    id: "6-119",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rasielmon"
  },
  {
    name_en: "Ravemon",
    name_jp: "Ravmon",
    next_evolutions: [],
    stage: 6,
    sprite: "ravemon",
    id: "6-120",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ravmon"
  },
  {
    name_en: "Regalecusmon",
    name_jp: "Regalecusmon",
    next_evolutions: [],
    stage: 6,
    sprite: "regalecusmon",
    id: "6-121",
    url: "https://digimon.net/reference_en/detail.php?directory_name=regalecusmon"
  },
  {
    name_en: "Rhihimon",
    name_jp: "Raihimon",
    next_evolutions: ["6-009", "7-004"],
    stage: 6,
    sprite: "rhihimon",
    id: "6-122",
    url: "https://digimon.net/reference_en/detail.php?directory_name=raihimon"
  },
  {
    name_en: "Rosemon",
    name_jp: "Rosemon",
    next_evolutions: ["7-036"],
    stage: 6,
    sprite: "rosemon",
    id: "6-123",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rosemon"
  },
  {
    name_en: "Rosemon X",
    name_jp: "Rosemon X",
    next_evolutions: ["7-025", "7-003", "7-006"],
    stage: 6,
    sprite: "rosemon_x",
    id: "6-124",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rosemon_x"
  },
  {
    name_en: "RustTyrannomon",
    name_jp: "RustTyranomon",
    next_evolutions: [],
    stage: 6,
    sprite: "rusttyrannomon",
    id: "6-125",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rusttyranomon"
  },
  {
    name_en: "SaberLeomon",
    name_jp: "SaberLeomon",
    next_evolutions: [],
    stage: 6,
    sprite: "saberleomon",
    id: "6-126",
    url: "https://digimon.net/reference_en/detail.php?directory_name=saberleomon"
  },
  {
    name_en: "Sakuyamon X",
    name_jp: "Sakuyamon X",
    next_evolutions: ["7-016"],
    stage: 6,
    sprite: "sakuyamon_x",
    id: "6-127",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sakuyamon_x"
  },
  {
    name_en: "Seraphimon",
    name_jp: "Seraphimon",
    next_evolutions: [],
    stage: 6,
    sprite: "seraphimon",
    id: "6-128",
    url: "https://digimon.net/reference_en/detail.php?directory_name=seraphimon"
  },
  {
    name_en: "ShineGreymon",
    name_jp: "ShineGreymon",
    next_evolutions: [],
    stage: 6,
    sprite: "shinegreymon",
    id: "6-129",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shinegreymon"
  },
  {
    name_en: "SkullMammothmon",
    name_jp: "SkullMammon",
    next_evolutions: [],
    stage: 6,
    sprite: "skullmammothmon",
    id: "6-130",
    url: "https://digimon.net/reference_en/detail.php?directory_name=skullmammon"
  },
  {
    name_en: "SkullMammothmon X",
    name_jp: "SkullMammon X",
    next_evolutions: ["7-024", "7-003"],
    stage: 6,
    sprite: "skullmammothmon_x",
    id: "6-131",
    url: "https://digimon.net/reference_en/detail.php?directory_name=skullmammon_x"
  },
  {
    name_en: "SlashAngemon",
    name_jp: "SlashAngemon",
    next_evolutions: [],
    stage: 6,
    sprite: "slashangemon",
    id: "6-132",
    url: "https://digimon.net/reference_en/detail.php?directory_name=slashangemon"
  },
  {
    name_en: "Slayerdramon",
    name_jp: "Slayerdramon",
    next_evolutions: ["7-014"],
    stage: 6,
    sprite: "slayerdramon",
    id: "6-133",
    url: "https://digimon.net/reference_en/detail.php?directory_name=slayerdramon"
  },
  {
    name_en: "Susanomon",
    name_jp: "Susanoomon",
    next_evolutions: [],
    stage: 6,
    sprite: "susanomon",
    id: "6-134",
    url: "https://digimon.net/reference_en/detail.php?directory_name=susanoomon"
  },
  {
    name_en: "TigerVespamon",
    name_jp: "TigerVespamon",
    next_evolutions: ["7-016", "7-009"],
    stage: 6,
    sprite: "tigervespamon",
    id: "6-135",
    url: "https://digimon.net/reference_en/detail.php?directory_name=tigervespamon"
  },
  {
    name_en: "Titamon",
    name_jp: "Titamon",
    next_evolutions: [],
    stage: 6,
    sprite: "titamon",
    id: "6-136",
    url: "https://digimon.net/reference_en/detail.php?directory_name=titamon"
  },
  {
    name_en: "UlforceVeedramon",
    name_jp: "UlforceV-dramon",
    next_evolutions: [],
    stage: 6,
    sprite: "ulforceveedramon",
    id: "6-137",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ulforcevdramon"
  },
  {
    name_en: "UltimateBrachiomon",
    name_jp: "UltimateBrachiomon",
    next_evolutions: ["7-024", "7-003"],
    stage: 6,
    sprite: "ultimatebrachiomon",
    id: "6-138",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ultimatebrakimon"
  },
  {
    name_en: "Valkyrimon",
    name_jp: "Valkyrimon",
    next_evolutions: [],
    stage: 6,
    sprite: "valkyrimon",
    id: "6-139",
    url: "https://digimon.net/reference_en/detail.php?directory_name=valkyrimon"
  },
  {
    name_en: "Varodurumon",
    name_jp: "Valdurmon",
    next_evolutions: ["7-016"],
    stage: 6,
    sprite: "varodurumon",
    id: "6-140",
    url: "https://digimon.net/reference_en/detail.php?directory_name=valdurmon"
  },
  {
    name_en: "VenomMyotismon",
    name_jp: "VenomVamdemon",
    next_evolutions: [],
    stage: 6,
    sprite: "venommyotismon",
    id: "6-141",
    url: "https://digimon.net/reference_en/detail.php?directory_name=venomvamdemon"
  },
  {
    name_en: "Volcanicdramon",
    name_jp: "Volcanicdramon",
    next_evolutions: [],
    stage: 6,
    sprite: "volcanicdramon",
    id: "6-142",
    url: "https://digimon.net/reference_en/detail.php?directory_name=volcanicdramon"
  },
  {
    name_en: "WarGreymon",
    name_jp: "WarGreymon",
    next_evolutions: ["7-032"],
    stage: 6,
    sprite: "wargreymon",
    id: "6-143",
    url: "https://digimon.net/reference_en/detail.php?directory_name=wargreymon"
  },
  {
    name_en: "WarGreymon X",
    name_jp: "WarGreymon X",
    next_evolutions: ["7-034"],
    stage: 6,
    sprite: "wargreymon_x",
    id: "6-144",
    url: "https://digimon.net/reference_en/detail.php?directory_name=wargreymon_x"
  },
  {
    name_en: "Zhuqiaomon",
    name_jp: "Zhuqiaomon",
    next_evolutions: ["6-050"],
    stage: 6,
    sprite: "zhuqiaomon",
    id: "6-145",
    url: "https://digimon.net/reference_en/detail.php?directory_name=zhuqiaomon"
  },
  {
    name_en: "Vikemon",
    name_jp: "Vikemon",
    next_evolutions: [],
    stage: 6,
    sprite: "vikemon",
    id: "6-146",
    url: "https://digimon.net/reference_en/detail.php?directory_name=vikemon"
  },
  {
    name_en: "ShinMonzaemon",
    name_jp: "ShinMonzaemon",
    next_evolutions: [],
    stage: 6,
    sprite: "shinmonzaemon",
    id: "6-147",
    url: "https://digimon.net/reference_en/detail.php?directory_name=shinmonzaemon"
  },
  {
    name_en: "Kazuchimon",
    name_jp: "Kazuchimon",
    next_evolutions: [],
    stage: 6,
    sprite: "kazuchimon",
    id: "6-148",
    url: "https://digimon.net/reference_en/detail.php?directory_name=kazuchimon"
  },
  {
    name_en: "BanchoLillymon",
    name_jp: "BanchoLilimon",
    next_evolutions: [],
    stage: 6,
    sprite: "bancholillymon",
    id: "6-149",
    url: "https://digimon.net/reference_en/detail.php?directory_name=bancholilimon"
  },
  {
    name_en: "Dorugoramon",
    name_jp: "DORUgoramon",
    next_evolutions: [],
    stage: 6,
    sprite: "dorugoramon",
    id: "6-150",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dorugoramon"
  },
  {
    name_en: "Alphamon: Ouryuken",
    name_jp: "Alphamon: Ouryuken",
    next_evolutions: [],
    stage: 7,
    sprite: "alphamon_ouryuken",
    id: "7-001",
    url: "https://digimon.net/reference_en/detail.php?directory_name=alphamon:ouryuken"
  },
  {
    name_en: "Armageddemon",
    name_jp: "Armagemon",
    next_evolutions: [],
    stage: 7,
    sprite: "armageddemon",
    id: "7-002",
    url: "https://digimon.net/reference_en/detail.php?directory_name=armagemon"
  },
  {
    name_en: "Barbamon X",
    name_jp: "Barbamon X",
    next_evolutions: [],
    stage: 7,
    sprite: "barbamon_x",
    id: "7-003",
    url: "https://digimon.net/reference_en/detail.php?directory_name=barbamon_x"
  },
  {
    name_en: "Beelzemon X",
    name_jp: "Beelzebumon X",
    next_evolutions: ["7-012"],
    stage: 7,
    sprite: "beelzemon_x",
    id: "7-004",
    url: "https://digimon.net/reference_en/detail.php?directory_name=beelzebumon_x"
  },
  {
    name_en: "Beelzemon: Blast Mode",
    name_jp: "Beelzebumon: Blast Mode",
    next_evolutions: [],
    stage: 7,
    sprite: "beelzemon_blast_mode",
    id: "7-005",
    url: "https://digimon.net/reference_en/detail.php?directory_name=beelzebumonblastmode"
  },
  {
    name_en: "Belphemon X",
    name_jp: "Belphemon X",
    next_evolutions: [],
    stage: 7,
    sprite: "belphemon_x",
    id: "7-006",
    url: "https://digimon.net/reference_en/detail.php?directory_name=belphemon_x"
  },
  {
    name_en: "Boltboutamon",
    name_jp: "Voltobautamon",
    next_evolutions: [],
    stage: 7,
    sprite: "boltboutamon",
    id: "7-007",
    url: "https://digimon.net/reference_en/detail.php?directory_name=voltobautamon"
  },
  {
    name_en: "Chaosmon",
    name_jp: "Chaosmon",
    next_evolutions: [],
    stage: 7,
    sprite: "chaosmon",
    id: "7-008",
    url: "https://digimon.net/reference_en/detail.php?directory_name=chaosmon"
  },
  {
    name_en: "Craniamon X",
    name_jp: "Craniummon X",
    next_evolutions: ["7-026", "6-002"],
    stage: 7,
    sprite: "craniamon_x",
    id: "7-009",
    url: "https://digimon.net/reference_en/detail.php?directory_name=craniummon_x"
  },
  {
    name_en: "Creepymon X",
    name_jp: "Demon X",
    next_evolutions: [],
    stage: 7,
    sprite: "creepymon_x",
    id: "7-010",
    url: "https://digimon.net/reference_en/detail.php?directory_name=demon_x"
  },
  {
    name_en: "DarknessBagramon",
    name_jp: "DarknessBagramon",
    next_evolutions: [],
    stage: 7,
    sprite: "darknessbagramon",
    id: "7-011",
    url: "https://digimon.net/reference_en/detail.php?directory_name=darknessbagramon"
  },
  {
    name_en: "Diaboromon X",
    name_jp: "Diablomon X",
    next_evolutions: ["7-044"],
    stage: 7,
    sprite: "diaboromon_x",
    id: "7-012",
    url: "https://digimon.net/reference_en/detail.php?directory_name=diablomon_x"
  },
  {
    name_en: "Dynasmon X",
    name_jp: "Dynasmon X",
    next_evolutions: [],
    stage: 7,
    sprite: "dynasmon_x",
    id: "7-013",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dynasmon_x"
  },
  {
    name_en: "Examon",
    name_jp: "Examon",
    next_evolutions: [],
    stage: 7,
    sprite: "examon",
    id: "7-014",
    url: "https://digimon.net/reference_en/detail.php?directory_name=examon"
  },
  {
    name_en: "Examon X",
    name_jp: "Examon X",
    next_evolutions: [],
    stage: 7,
    sprite: "examon_x",
    id: "7-015",
    url: "https://digimon.net/reference_en/detail.php?directory_name=examon_x"
  },
  {
    name_en: "Gallantmon X",
    name_jp: "Dukemon X",
    next_evolutions: [],
    stage: 7,
    sprite: "gallantmon_x",
    id: "7-016",
    url: "https://digimon.net/reference_en/detail.php?directory_name=dukemon_x"
  },
  {
    name_en: "Gankoomon X",
    name_jp: "Gankoomon X",
    next_evolutions: ["7-043"],
    stage: 7,
    sprite: "gankoomon_x",
    id: "7-017",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gankoomon_x"
  },
  {
    name_en: "GraceNovamon",
    name_jp: "GraceNovamon",
    next_evolutions: [],
    stage: 7,
    sprite: "gracenovamon",
    id: "7-018",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gracenovamon"
  },
  {
    name_en: "Imperialdramon: Fighter Mode",
    name_jp: "Imperialdramon: Fighter Mode",
    next_evolutions: ["7-020"],
    stage: 7,
    sprite: "imperialdramon_fighter_mode",
    id: "7-019",
    url: "https://digimon.net/reference_en/detail.php?directory_name=imperialdramonfightermode"
  },
  {
    name_en: "Imperialdramon: Paladin Mode",
    name_jp: "Imperialdramon: Paladin Mode",
    next_evolutions: [],
    stage: 7,
    sprite: "imperialdramon_paladin_mode",
    id: "7-020",
    url: "https://digimon.net/reference_en/detail.php?directory_name=imperialdramonpaladinmode"
  },
  {
    name_en: "Jesmon X",
    name_jp: "Jesmon X",
    next_evolutions: ["6-002", "7-043"],
    stage: 7,
    sprite: "jesmon_x",
    id: "7-021",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jesmon_x"
  },
  {
    name_en: "Kentaurosmon X",
    name_jp: "Sleipmon X",
    next_evolutions: ["7-030", "6-002"],
    stage: 7,
    sprite: "kentaurosmon_x",
    id: "7-022",
    url: "https://digimon.net/reference_en/detail.php?directory_name=sleipmon_x"
  },
  {
    name_en: "Leopardmon X",
    name_jp: "Duftmon X",
    next_evolutions: [],
    stage: 7,
    sprite: "leopardmon_x",
    id: "7-023",
    url: "https://digimon.net/reference_en/detail.php?directory_name=duftmon_x"
  },
  {
    name_en: "Leviamon X",
    name_jp: "Leviamon X",
    next_evolutions: [],
    stage: 7,
    sprite: "leviamon_x",
    id: "7-024",
    url: "https://digimon.net/reference_en/detail.php?directory_name=leviamon_x"
  },
  {
    name_en: "Lilithmon X",
    name_jp: "Lilithmon X",
    next_evolutions: [],
    stage: 7,
    sprite: "lilithmon_x",
    id: "7-025",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lilithmon_x"
  },
  {
    name_en: "LordKnightmon X",
    name_jp: "LordKnightmon X",
    next_evolutions: [],
    stage: 7,
    sprite: "lordknightmon_x",
    id: "7-026",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lordknightmon_x"
  },
  {
    name_en: "Lucemon X",
    name_jp: "Lucemon X",
    next_evolutions: [],
    stage: 7,
    sprite: "lucemon_x",
    id: "7-027",
    url: "https://digimon.net/reference_en/detail.php?directory_name=lucemon_x"
  },
  {
    name_en: "Magnamon X",
    name_jp: "Magnamon X",
    next_evolutions: [],
    stage: 7,
    sprite: "magnamon_x",
    id: "7-028",
    url: "https://digimon.net/reference_en/detail.php?directory_name=magnamon_x"
  },
  {
    name_en: "Mastemon",
    name_jp: "Mastemon",
    next_evolutions: [],
    stage: 7,
    sprite: "mastemon",
    id: "7-029",
    url: "https://digimon.net/reference_en/detail.php?directory_name=mastemon"
  },
  {
    name_en: "Minervamon X",
    name_jp: "Minervamon X",
    next_evolutions: [],
    stage: 7,
    sprite: "minervamon_x",
    id: "7-030",
    url: "https://digimon.net/reference_en/detail.php?directory_name=minervamon_x"
  },
  {
    name_en: "Ogudomon",
    name_jp: "Ogudomon",
    next_evolutions: [],
    stage: 7,
    sprite: "ogudomon",
    id: "7-031",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ogudomon"
  },
  {
    name_en: "Omnimon",
    name_jp: "Omegamon",
    next_evolutions: ["7-020"],
    stage: 7,
    sprite: "omnimon",
    id: "7-032",
    url: "https://digimon.net/reference_en/detail.php?directory_name=omegamon"
  },
  {
    name_en: "Omnimon Alter-S",
    name_jp: "Omegamon Alter-S",
    next_evolutions: [],
    stage: 7,
    sprite: "omnimon_alter_s",
    id: "7-033",
    url: "https://digimon.net/reference_en/detail.php?directory_name=omegamon-alter-s"
  },
  {
    name_en: "Omnimon X",
    name_jp: "Omegamon X",
    next_evolutions: [],
    stage: 7,
    sprite: "omnimon_x",
    id: "7-034",
    url: "https://digimon.net/reference_en/detail.php?directory_name=omegamon-x"
  },
  {
    name_en: "Ordinemon",
    name_jp: "Ordinemon",
    next_evolutions: [],
    stage: 7,
    sprite: "ordinemon",
    id: "7-035",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ordinemon"
  },
  {
    name_en: "Rafflesimon",
    name_jp: "Rafflesimon",
    next_evolutions: [],
    stage: 7,
    sprite: "rafflesimon",
    id: "7-036",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rafflesimon"
  },
  {
    name_en: "RagnaLoardmon",
    name_jp: "RagnaLordmon",
    next_evolutions: [],
    stage: 7,
    sprite: "ragnaloardmon",
    id: "7-037",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ragnaloardmon"
  },
  {
    name_en: "Rasenmon",
    name_jp: "Rasenmon",
    next_evolutions: [],
    stage: 7,
    sprite: "rasenmon",
    id: "7-038",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rasenmon"
  },
  {
    name_en: "RustTyrannomon",
    name_jp: "RustTyranomon",
    next_evolutions: [],
    stage: 7,
    sprite: "rusttyrannomon",
    id: "7-039",
    url: "https://digimon.net/reference_en/detail.php?directory_name=rusttyranomon"
  },
  {
    name_en: "UlforceVeedramon X",
    name_jp: "UlforceV-dramon X",
    next_evolutions: [],
    stage: 7,
    sprite: "ulforceveedramon_x",
    id: "7-040",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ulforcevdramon_x"
  },
  {
    name_en: "Agumon (Bond of Bravery)",
    name_jp: "Agumon (Bond of Bravery)",
    next_evolutions: [],
    stage: 7,
    sprite: "agumon_bond_of_bravery",
    id: "7-041",
    url: "https://digimon.net/reference_en/detail.php?directory_name=agumon_kizuna"
  },
  {
    name_en: "Gabumon (Bond of Friendship)",
    name_jp: "Gabumon (Bond of Friendship)",
    next_evolutions: [],
    stage: 7,
    sprite: "gabumon_bond_of_friendship",
    id: "7-042",
    url: "https://digimon.net/reference_en/detail.php?directory_name=gabumon_kizuna"
  },
  {
    name_en: "Jesmon GX",
    name_jp: "Jesmon GX",
    next_evolutions: [],
    stage: 7,
    sprite: "jesmon_gx",
    id: "7-043",
    url: "https://digimon.net/reference_en/detail.php?directory_name=jesmongx"
  },
  {
    name_en: "Ogudomon X",
    name_jp: "Ogudomon X",
    next_evolutions: [],
    stage: 7,
    sprite: "ogudomon_x",
    id: "7-044",
    url: "https://digimon.net/reference_en/detail.php?directory_name=ogudomon_x"
  },
  {
    name_en: "Chaosdramon",
    name_jp: "Chaosdramon",
    next_evolutions: [],
    stage: 7,
    sprite: "chaosdramon",
    id: "7-045",
    url: "https://digimon.net/reference_en/detail.php?directory_name=chaosdramon"
  }
];

// ../digital-pet-core/src/data/reviewed-digimon-data.ts
var REVIEWED_DIGIMON_DATA = Object.freeze(
  DIGIMON_DATA.map(
    (node) => Object.freeze({ ...node, ...catalog_corrections_default.records[node.id] })
  )
);

// ../digital-pet-core/src/data/catalog.ts
var parseNode = (input) => {
  if (!isDigimonStage(input.stage)) throw new Error(`Invalid stage ${input.stage} for ${input.id}`);
  return Object.freeze({
    id: input.id,
    nameEn: input.name_en,
    nameJp: input.name_jp,
    nextEvolutions: Object.freeze([...input.next_evolutions]),
    sprite: input.sprite,
    stage: input.stage,
    url: input.url,
    combatStats: COMBAT_STATS.get(input.id) ?? NEUTRAL_COMBAT_STATS
  });
};
var parseDigimonCatalog = (input) => {
  const nodes2 = input.map(parseNode);
  const byId = /* @__PURE__ */ new Map();
  for (const node of nodes2) {
    if (byId.has(node.id)) throw new Error(`Duplicate digimon id ${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of nodes2) {
    for (const targetId of node.nextEvolutions) {
      if (!byId.has(targetId)) throw new Error(`Invalid next_evolutions reference ${targetId} from ${node.id}`);
    }
  }
  return Object.freeze({ nodes: Object.freeze(nodes2), byId });
};
var referencedData = REVIEWED_DIGIMON_DATA.map((node) => ({
  ...node,
  next_evolutions: [
    .../* @__PURE__ */ new Set([...node.next_evolutions, ...(EVOLUTION_ROUTES.get(node.id) ?? []).map((route) => route.targetId)])
  ]
}));
var baseCatalog = parseDigimonCatalog(referencedData);
var nodes = baseCatalog.nodes.map((node) => {
  const referenced = (EVOLUTION_ROUTES.get(node.id) ?? []).map((route) => {
    const canonicalTargetId = catalog_corrections_default.canonicalIds[route.targetId];
    return canonicalTargetId ? Object.freeze({ ...route, canonicalTargetId }) : route;
  });
  const known = new Set(referenced.map((route) => route.targetId));
  const legacy = node.nextEvolutions.filter((id) => !known.has(id)).map((targetId) => ({
    targetId,
    kind: node.stage === 0 ? "normal" : "unverified",
    careMask: node.stage === 0 ? 15 : 0,
    sources: []
  }));
  return Object.freeze({ ...node, evolutionRoutes: Object.freeze([...referenced, ...legacy]) });
});
var DIGIMON_CATALOG = Object.freeze({
  nodes: Object.freeze(nodes),
  byId: new Map(nodes.map((node) => [node.id, node]))
});
var loadDigimonCatalog = async () => DIGIMON_CATALOG;

// ../digital-pet-core/src/application/use-cases/freeze-digital-pet.ts
var freezeDigitalPet = (control) => control.freeze();

// assets/i18n/en.json
var en_default3 = {
  "createServerHooks.spawnANewVirtualPet": "Spawn a new virtual pet.",
  "createServerHooks.freezeVirtualPetProgression": "Freeze virtual pet progression.",
  "createServerHooks.unfreezeVirtualPetProgression": "Unfreeze virtual pet progression.",
  "createServerHooks.setTheVirtualPetToADigimonId": "Set the virtual pet to a Digimon ID: $ARGUMENTS",
  "digitalPetToast.digitalPet": "Digital Pet",
  "digitalPetToast.spawnedGeneration": "Spawned {name} (Generation {generation}).",
  "digitalPetToast.digimonProgressionFrozen": "Digimon progression frozen.",
  "digitalPetToast.digimonProgressionResumed": "Digimon progression resumed.",
  "digitalPetToast.digitalPetSetTo": "Digital Pet set to {name} ({nodeId}).",
  "digitalPetToast.evolvedInto": "{fromName} evolved into {toName}!",
  "digitalPetToast.evolutionBattle": "Evolution battle",
  "digitalPetToast.battleAgainstWinToEvolve": "Battle against {opponentName}! Win to evolve.",
  "digitalPetToast.defeatYouLostAllTokensForThisStage": "Defeat! You lost all tokens for this stage.",
  "sessionMessages.unableToListMessagesForIdleSession": "Unable to list messages for idle session {sessionID}",
  "sqliteDigitalPetArchiveReader.digitalPetArchiveIsUnavailable": "Digital Pet archive is unavailable.",
  "install.opencodePluginInstallerExitedWithoutAStatus": "OpenCode plugin installer exited without a status.",
  "install.opencodePluginInstallerExitedWithStatus": "OpenCode plugin installer exited with status {exitCode}.",
  "cli.invalidOpencodeDigitalPetPackageManifest": "Invalid opencode-digital-pet package manifest.",
  "cli.expectedInitOrUpdate": "Expected init or update.",
  "cli.onlyDryRunIsSupportedAfterACommand": "Only --dry-run is supported after a command.",
  "cli.unexpectedCliFailure": "Unexpected CLI failure.",
  "digitalPetFreeze.digitalPetFrozen": "Digital Pet frozen.",
  "digitalPetSet.unknownDigimonId": "Unknown Digimon ID: {requestedId}.",
  "digitalPetSet.digitalPetSetTo": "Digital Pet set to {nameEn} ({id}).",
  "digitalPetSpawn.spawnedGeneration": "Spawned Generation {generation}.",
  "digitalPetUnfreeze.digitalPetUnfrozen": "Digital Pet unfrozen.",
  "attachDevTools.evolutionRevealDidNotPlayEnsureTheSidebar": "Evolution reveal did not play. Ensure the sidebar is visible.",
  "attachDevTools.battleRepositoryIsUnavailable": "Battle repository is unavailable.",
  "attachDevTools.evolutionBattleDidNotStartEnsureAPartner": "Evolution battle did not start. Ensure a partner is active.",
  "buildPartnerInputs.unknownDigimonNode": "Unknown Digimon node: {nodeId}",
  "catalog.digitalPetDevFeed": "Digital Pet Dev Feed",
  "catalog.digitalPetDevActivity": "Digital Pet Dev Activity",
  "catalog.digitalPetDevEvolutionReveal": "Digital Pet Dev Evolution Reveal",
  "catalog.digitalPetDevEvolutionBattle": "Digital Pet Dev Evolution Battle",
  "catalog.digitalPetDevDefeatViaBattle": "Digital Pet Dev Defeat (via battle)",
  "registerDevCommandLayer.digitalPetDev": "Digital Pet Dev",
  "setupScenario.digitalPetDevPartnerNodeIsMissingFrom": "Digital Pet dev: partner node {currentNodeId} is missing from the catalog.",
  "setupScenario.digitalPetDevPartnerIsFrozenUnfreezeBefore": "Digital Pet dev: partner is frozen. Unfreeze before opening an evolution battle.",
  "setupScenario.digitalPetDevClearTheDigimonOverrideBefore": "Digital Pet dev: clear the digimon override before opening an evolution battle.",
  "setupScenario.digitalPetDevPartnerCannotEvolveFurtherSo": "Digital Pet dev: partner cannot evolve further, so no evolution battle can be opened.",
  "setupScenario.digitalPetDevCouldNotReadTheActive": "Digital Pet dev: could not read the active partner snapshot.",
  "setupScenario.digitalPetDevCouldNotOpenAPending": "Digital Pet dev: could not open a pending evolution battle for the current partner.",
  "digitalPetCommandLayer.digitalPetDex": "Digital Pet Dex",
  "digitalPetCommandLayer.browseTheDigitalPetDiscoveryArchive": "Browse the Digital Pet discovery archive.",
  "digitalPetCommandLayer.digitalPetHistory": "Digital Pet History",
  "digitalPetCommandLayer.browseDigitalPetGenerationHistory": "Browse Digital Pet generation history.",
  "digitalPetDexDialog.noDataAvailable": "No data available",
  "digitalPetDexDialog.1Item10ItemsEscClose": "\u2191\u2193: 1 item \xB7 \u2190\u2192: 10 items \xB7 Esc: Close",
  "digitalPetHistoryDialog.active": "Active",
  "digitalPetHistoryDialog.retired": "Retired",
  "digitalPetHistoryDialog.generation": "Generation {generation} \u2014 {createdAt} \u2014 {status}",
  "digitalPetHistoryDialog.noCanonicalEventsRecorded": "No canonical events recorded",
  "openInBrowser.unsupportedPlatformForOpeningUrls": "Unsupported platform for opening URLs: {platform}",
  "sidebarCard.nextCheck": "Next check: ",
  "sidebarCard.encyclopediaEntry": "Encyclopedia entry",
  "sidebarCard.evolutionBattle": "{NEXT_CHECK_PREFIX}Evolution battle!",
  "sidebarCard.none": "{NEXT_CHECK_PREFIX}None",
  "sidebarCard.set": "{name} (set)",
  "sidebarCard.frozen": "{stage} (frozen)",
  "phase.battle": "BATTLE",
  "phase.evolving": "EVOLVING",
  "phase.evolved": "EVOLVED",
  "phase.defeated": "DEFEATED",
  "phase.draw": "DRAW",
  "phase.feeding": "FEEDING",
  "cli.help": "Usage: opencode-digital-pet <init|update> [--dry-run]\n\nCommands:\n  init       Install the current package version through OpenCode's global plugin installer.\n  update     Reinstall the current package version through the same installer.\n\nOptions:\n  --dry-run  Show the native OpenCode command without running it.\n  --help      Show this help text.\n",
  "cli.installed": "OpenCode plugin installation completed. Restart OpenCode.\n",
  "phase.no_evolution": "NO EVOLUTIONS AVAILABLE"
};

// assets/i18n/es.json
var es_default3 = {
  "createServerHooks.spawnANewVirtualPet": "Crea una nueva mascota virtual.",
  "createServerHooks.freezeVirtualPetProgression": "Pausa el progreso de la mascota virtual.",
  "createServerHooks.unfreezeVirtualPetProgression": "Reanuda el progreso de la mascota virtual.",
  "createServerHooks.setTheVirtualPetToADigimonId": "Asigna a la mascota un ID de Digimon: $ARGUMENTS",
  "digitalPetToast.digitalPet": "Digital Pet",
  "digitalPetToast.spawnedGeneration": "Creado {name} (generaci\xF3n {generation}).",
  "digitalPetToast.digimonProgressionFrozen": "Progreso del Digimon pausado.",
  "digitalPetToast.digimonProgressionResumed": "Progreso del Digimon reanudado.",
  "digitalPetToast.digitalPetSetTo": "Digital Pet asignado a {name} ({nodeId}).",
  "digitalPetToast.evolvedInto": "\xA1{fromName} ha evolucionado a {toName}!",
  "digitalPetToast.evolutionBattle": "Combate de evoluci\xF3n",
  "digitalPetToast.battleAgainstWinToEvolve": "\xA1Combate contra {opponentName}! Gana para evolucionar.",
  "digitalPetToast.defeatYouLostAllTokensForThisStage": "\xA1Derrota! Has perdido todos los tokens de esta etapa.",
  "sessionMessages.unableToListMessagesForIdleSession": "No se pudieron listar los mensajes de la sesi\xF3n inactiva {sessionID}",
  "sqliteDigitalPetArchiveReader.digitalPetArchiveIsUnavailable": "El archivo de Digital Pet no est\xE1 disponible.",
  "install.opencodePluginInstallerExitedWithoutAStatus": "El instalador de plugins de OpenCode finaliz\xF3 sin estado.",
  "install.opencodePluginInstallerExitedWithStatus": "El instalador de plugins de OpenCode finaliz\xF3 con estado {exitCode}.",
  "cli.invalidOpencodeDigitalPetPackageManifest": "El manifiesto de opencode-digital-pet no es v\xE1lido.",
  "cli.expectedInitOrUpdate": "Se esperaba init o update.",
  "cli.onlyDryRunIsSupportedAfterACommand": "Solo se permite --dry-run despu\xE9s de un comando.",
  "cli.unexpectedCliFailure": "Fallo inesperado de la l\xEDnea de comandos.",
  "digitalPetFreeze.digitalPetFrozen": "Digital Pet pausado.",
  "digitalPetSet.unknownDigimonId": "ID de Digimon desconocido: {requestedId}.",
  "digitalPetSet.digitalPetSetTo": "Digital Pet asignado a {nameEn} ({id}).",
  "digitalPetSpawn.spawnedGeneration": "Generaci\xF3n {generation} creada.",
  "digitalPetUnfreeze.digitalPetUnfrozen": "Digital Pet reanudado.",
  "attachDevTools.evolutionRevealDidNotPlayEnsureTheSidebar": "La animaci\xF3n de evoluci\xF3n no se reprodujo. Comprueba que la barra lateral est\xE9 visible.",
  "attachDevTools.battleRepositoryIsUnavailable": "El repositorio de combates no est\xE1 disponible.",
  "attachDevTools.evolutionBattleDidNotStartEnsureAPartner": "El combate de evoluci\xF3n no comenz\xF3. Comprueba que haya un compa\xF1ero activo.",
  "buildPartnerInputs.unknownDigimonNode": "Digimon desconocido: {nodeId}",
  "catalog.digitalPetDevFeed": "Prueba de alimentaci\xF3n de Digital Pet",
  "catalog.digitalPetDevActivity": "Prueba de actividad de Digital Pet",
  "catalog.digitalPetDevEvolutionReveal": "Prueba de evoluci\xF3n de Digital Pet",
  "catalog.digitalPetDevEvolutionBattle": "Prueba de combate de evoluci\xF3n de Digital Pet",
  "catalog.digitalPetDevDefeatViaBattle": "Prueba de derrota de Digital Pet (combate)",
  "registerDevCommandLayer.digitalPetDev": "Desarrollo de Digital Pet",
  "setupScenario.digitalPetDevPartnerNodeIsMissingFrom": "Digital Pet: el Digimon {currentNodeId} no est\xE1 en el cat\xE1logo.",
  "setupScenario.digitalPetDevPartnerIsFrozenUnfreezeBefore": "Digital Pet: el compa\xF1ero est\xE1 pausado. Rean\xFAdalo antes de iniciar un combate de evoluci\xF3n.",
  "setupScenario.digitalPetDevClearTheDigimonOverrideBefore": "Digital Pet: elimina la asignaci\xF3n manual de Digimon antes de iniciar un combate de evoluci\xF3n.",
  "setupScenario.digitalPetDevPartnerCannotEvolveFurtherSo": "Digital Pet: el compa\xF1ero no puede evolucionar m\xE1s, por lo que no puede combatir para evolucionar.",
  "setupScenario.digitalPetDevCouldNotReadTheActive": "Digital Pet: no se pudo leer el estado del compa\xF1ero activo.",
  "setupScenario.digitalPetDevCouldNotOpenAPending": "Digital Pet: no se pudo iniciar el combate de evoluci\xF3n del compa\xF1ero actual.",
  "digitalPetCommandLayer.digitalPetDex": "Digital Pet Dex",
  "digitalPetCommandLayer.browseTheDigitalPetDiscoveryArchive": "Explora el archivo de descubrimientos de Digital Pet.",
  "digitalPetCommandLayer.digitalPetHistory": "Historial de Digital Pet",
  "digitalPetCommandLayer.browseDigitalPetGenerationHistory": "Explora el historial de generaciones de Digital Pet.",
  "digitalPetDexDialog.noDataAvailable": "No hay datos disponibles",
  "digitalPetDexDialog.1Item10ItemsEscClose": "\u2191\u2193: 1 elemento \xB7 \u2190\u2192: 10 elementos \xB7 Esc: Cerrar",
  "digitalPetHistoryDialog.active": "Activo",
  "digitalPetHistoryDialog.retired": "Retirado",
  "digitalPetHistoryDialog.generation": "Generaci\xF3n {generation} \u2014 {createdAt} \u2014 {status}",
  "digitalPetHistoryDialog.noCanonicalEventsRecorded": "No hay eventos registrados",
  "openInBrowser.unsupportedPlatformForOpeningUrls": "Plataforma no compatible para abrir enlaces: {platform}",
  "sidebarCard.nextCheck": "Pr\xF3xima evoluci\xF3n: ",
  "sidebarCard.encyclopediaEntry": "Ficha de la enciclopedia",
  "sidebarCard.evolutionBattle": "{NEXT_CHECK_PREFIX}\xA1Combate de evoluci\xF3n!",
  "sidebarCard.none": "{NEXT_CHECK_PREFIX}Ninguna",
  "sidebarCard.set": "{name} (manual)",
  "sidebarCard.frozen": "{stage} (pausado)",
  "phase.battle": "COMBATE",
  "phase.evolving": "EVOLUCIONANDO",
  "phase.evolved": "EVOLUCIONADO",
  "phase.defeated": "DERROTADO",
  "phase.draw": "EMPATE",
  "phase.feeding": "COMIENDO",
  "cli.help": "Uso: opencode-digital-pet <init|update> [--dry-run]\n\nComandos:\n  init       Instala la versi\xF3n actual mediante el instalador global de OpenCode.\n  update     Reinstala la versi\xF3n actual mediante el mismo instalador.\n\nOpciones:\n  --dry-run  Muestra el comando nativo de OpenCode sin ejecutarlo.\n  --help     Muestra esta ayuda.\n",
  "cli.installed": "Instalaci\xF3n de OpenCode completada. Reinicia OpenCode.\n",
  "phase.no_evolution": "SIN EVOLUCIONES"
};

// assets/i18n/gl.json
var gl_default3 = {
  "createServerHooks.spawnANewVirtualPet": "Crea unha nova mascota virtual.",
  "createServerHooks.freezeVirtualPetProgression": "Pausa o progreso da mascota virtual.",
  "createServerHooks.unfreezeVirtualPetProgression": "Retoma o progreso da mascota virtual.",
  "createServerHooks.setTheVirtualPetToADigimonId": "Asigna \xE1 mascota un ID de Digimon: $ARGUMENTS",
  "digitalPetToast.digitalPet": "Digital Pet",
  "digitalPetToast.spawnedGeneration": "Creado {name} (xeraci\xF3n {generation}).",
  "digitalPetToast.digimonProgressionFrozen": "Progreso do Digimon pausado.",
  "digitalPetToast.digimonProgressionResumed": "Progreso do Digimon retomado.",
  "digitalPetToast.digitalPetSetTo": "Digital Pet asignado a {name} ({nodeId}).",
  "digitalPetToast.evolvedInto": "{fromName} evolucionou a {toName}!",
  "digitalPetToast.evolutionBattle": "Combate de evoluci\xF3n",
  "digitalPetToast.battleAgainstWinToEvolve": "Combate contra {opponentName}! Ga\xF1a para evolucionar.",
  "digitalPetToast.defeatYouLostAllTokensForThisStage": "Derrota! Perdiches todos os tokens desta etapa.",
  "sessionMessages.unableToListMessagesForIdleSession": "Non se puideron listar as mensaxes da sesi\xF3n inactiva {sessionID}",
  "sqliteDigitalPetArchiveReader.digitalPetArchiveIsUnavailable": "O arquivo de Digital Pet non est\xE1 dispo\xF1ible.",
  "install.opencodePluginInstallerExitedWithoutAStatus": "O instalador de plugins de OpenCode rematou sen estado.",
  "install.opencodePluginInstallerExitedWithStatus": "O instalador de plugins de OpenCode rematou con estado {exitCode}.",
  "cli.invalidOpencodeDigitalPetPackageManifest": "O manifesto de opencode-digital-pet non \xE9 v\xE1lido.",
  "cli.expectedInitOrUpdate": "Agard\xE1base init ou update.",
  "cli.onlyDryRunIsSupportedAfterACommand": "S\xF3 se permite --dry-run despois dun comando.",
  "cli.unexpectedCliFailure": "Fallo inesperado da li\xF1a de comandos.",
  "digitalPetFreeze.digitalPetFrozen": "Digital Pet pausado.",
  "digitalPetSet.unknownDigimonId": "ID de Digimon desco\xF1ecido: {requestedId}.",
  "digitalPetSet.digitalPetSetTo": "Digital Pet asignado a {nameEn} ({id}).",
  "digitalPetSpawn.spawnedGeneration": "Xeraci\xF3n {generation} creada.",
  "digitalPetUnfreeze.digitalPetUnfrozen": "Digital Pet retomado.",
  "attachDevTools.evolutionRevealDidNotPlayEnsureTheSidebar": "A animaci\xF3n de evoluci\xF3n non se reproduciu. Comproba que a barra lateral estea visible.",
  "attachDevTools.battleRepositoryIsUnavailable": "O repositorio de combates non est\xE1 dispo\xF1ible.",
  "attachDevTools.evolutionBattleDidNotStartEnsureAPartner": "O combate de evoluci\xF3n non comezou. Comproba que haxa un compa\xF1eiro activo.",
  "buildPartnerInputs.unknownDigimonNode": "Digimon desco\xF1ecido: {nodeId}",
  "catalog.digitalPetDevFeed": "Proba de alimentaci\xF3n de Digital Pet",
  "catalog.digitalPetDevActivity": "Proba de actividade de Digital Pet",
  "catalog.digitalPetDevEvolutionReveal": "Proba de evoluci\xF3n de Digital Pet",
  "catalog.digitalPetDevEvolutionBattle": "Proba de combate de evoluci\xF3n de Digital Pet",
  "catalog.digitalPetDevDefeatViaBattle": "Proba de derrota de Digital Pet (combate)",
  "registerDevCommandLayer.digitalPetDev": "Desenvolvemento de Digital Pet",
  "setupScenario.digitalPetDevPartnerNodeIsMissingFrom": "Digital Pet: o Digimon {currentNodeId} non est\xE1 no cat\xE1logo.",
  "setupScenario.digitalPetDevPartnerIsFrozenUnfreezeBefore": "Digital Pet: o compa\xF1eiro est\xE1 pausado. Ret\xF3mao antes de iniciar un combate de evoluci\xF3n.",
  "setupScenario.digitalPetDevClearTheDigimonOverrideBefore": "Digital Pet: elimina a asignaci\xF3n manual de Digimon antes de iniciar un combate de evoluci\xF3n.",
  "setupScenario.digitalPetDevPartnerCannotEvolveFurtherSo": "Digital Pet: o compa\xF1eiro non pode evolucionar m\xE1is, polo que non pode combater para evolucionar.",
  "setupScenario.digitalPetDevCouldNotReadTheActive": "Digital Pet: non se puido ler o estado do compa\xF1eiro activo.",
  "setupScenario.digitalPetDevCouldNotOpenAPending": "Digital Pet: non se puido iniciar o combate de evoluci\xF3n do compa\xF1eiro actual.",
  "digitalPetCommandLayer.digitalPetDex": "Digital Pet Dex",
  "digitalPetCommandLayer.browseTheDigitalPetDiscoveryArchive": "Explora o arquivo de descubrimentos de Digital Pet.",
  "digitalPetCommandLayer.digitalPetHistory": "Historial de Digital Pet",
  "digitalPetCommandLayer.browseDigitalPetGenerationHistory": "Explora o historial de xeraci\xF3ns de Digital Pet.",
  "digitalPetDexDialog.noDataAvailable": "Non hai datos dispo\xF1ibles",
  "digitalPetDexDialog.1Item10ItemsEscClose": "\u2191\u2193: 1 elemento \xB7 \u2190\u2192: 10 elementos \xB7 Esc: Pechar",
  "digitalPetHistoryDialog.active": "Activo",
  "digitalPetHistoryDialog.retired": "Retirado",
  "digitalPetHistoryDialog.generation": "Xeraci\xF3n {generation} \u2014 {createdAt} \u2014 {status}",
  "digitalPetHistoryDialog.noCanonicalEventsRecorded": "Non hai eventos rexistrados",
  "openInBrowser.unsupportedPlatformForOpeningUrls": "Plataforma non compatible para abrir ligaz\xF3ns: {platform}",
  "sidebarCard.nextCheck": "Seguinte evoluci\xF3n: ",
  "sidebarCard.encyclopediaEntry": "Ficha da enciclopedia",
  "sidebarCard.evolutionBattle": "{NEXT_CHECK_PREFIX}Combate de evoluci\xF3n!",
  "sidebarCard.none": "{NEXT_CHECK_PREFIX}Ningunha",
  "sidebarCard.set": "{name} (manual)",
  "sidebarCard.frozen": "{stage} (pausado)",
  "phase.battle": "COMBATE",
  "phase.evolving": "EVOLUCIONANDO",
  "phase.evolved": "EVOLUCIONADO",
  "phase.defeated": "DERROTADO",
  "phase.draw": "EMPATE",
  "phase.feeding": "COMENDO",
  "cli.help": "Uso: opencode-digital-pet <init|update> [--dry-run]\n\nComandos:\n  init       Instala a versi\xF3n actual mediante o instalador global de OpenCode.\n  update     Reinstala a versi\xF3n actual mediante o mesmo instalador.\n\nOpci\xF3ns:\n  --dry-run  Amosa o comando nativo de OpenCode sen executalo.\n  --help     Amosa esta axuda.\n",
  "cli.installed": "Instalaci\xF3n de OpenCode completada. Reinicia OpenCode.\n",
  "phase.no_evolution": "SEN EVOLUCI\xD3NS"
};

// assets/i18n/ko.json
var ko_default3 = {
  "createServerHooks.spawnANewVirtualPet": "\uC0C8 \uAC00\uC0C1 \uD3AB\uC744 \uC0DD\uC131\uD569\uB2C8\uB2E4.",
  "createServerHooks.freezeVirtualPetProgression": "\uAC00\uC0C1 \uD3AB\uC758 \uC131\uC7A5\uC744 \uC77C\uC2DC \uC815\uC9C0\uD569\uB2C8\uB2E4.",
  "createServerHooks.unfreezeVirtualPetProgression": "\uAC00\uC0C1 \uD3AB\uC758 \uC131\uC7A5\uC744 \uB2E4\uC2DC \uC2DC\uC791\uD569\uB2C8\uB2E4.",
  "createServerHooks.setTheVirtualPetToADigimonId": "\uAC00\uC0C1 \uD3AB\uC744 \uB514\uC9C0\uBAAC ID\uB85C \uC9C0\uC815\uD569\uB2C8\uB2E4: $ARGUMENTS",
  "digitalPetToast.digitalPet": "Digital Pet",
  "digitalPetToast.spawnedGeneration": "{name} \uC0DD\uC131 \uC644\uB8CC ({generation}\uC138\uB300).",
  "digitalPetToast.digimonProgressionFrozen": "\uB514\uC9C0\uBAAC\uC758 \uC131\uC7A5\uC744 \uC77C\uC2DC \uC815\uC9C0\uD588\uC2B5\uB2C8\uB2E4.",
  "digitalPetToast.digimonProgressionResumed": "\uB514\uC9C0\uBAAC\uC758 \uC131\uC7A5\uC744 \uB2E4\uC2DC \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4.",
  "digitalPetToast.digitalPetSetTo": "Digital Pet\uC744 {name} ({nodeId})\uC73C\uB85C \uC9C0\uC815\uD588\uC2B5\uB2C8\uB2E4.",
  "digitalPetToast.evolvedInto": "{fromName}\uC774 {toName}\uC73C\uB85C \uC9C4\uD654\uD588\uC2B5\uB2C8\uB2E4!",
  "digitalPetToast.evolutionBattle": "\uC9C4\uD654 \uC804\uD22C",
  "digitalPetToast.battleAgainstWinToEvolve": "{opponentName}\uACFC \uC804\uD22C! \uC2B9\uB9AC\uD558\uBA74 \uC9C4\uD654\uD569\uB2C8\uB2E4.",
  "digitalPetToast.defeatYouLostAllTokensForThisStage": "\uD328\uBC30! \uC774 \uB2E8\uACC4\uC758 \uD1A0\uD070\uC744 \uBAA8\uB450 \uC783\uC5C8\uC2B5\uB2C8\uB2E4.",
  "sessionMessages.unableToListMessagesForIdleSession": "\uB300\uAE30 \uC138\uC158 {sessionID}\uC758 \uBA54\uC2DC\uC9C0\uB97C \uB098\uC5F4\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4",
  "sqliteDigitalPetArchiveReader.digitalPetArchiveIsUnavailable": "Digital Pet \uAE30\uB85D\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
  "install.opencodePluginInstallerExitedWithoutAStatus": "OpenCode \uD50C\uB7EC\uADF8\uC778 \uC124\uCE58 \uD504\uB85C\uADF8\uB7A8\uC774 \uC0C1\uD0DC \uC5C6\uC774 \uC885\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
  "install.opencodePluginInstallerExitedWithStatus": "OpenCode \uD50C\uB7EC\uADF8\uC778 \uC124\uCE58 \uD504\uB85C\uADF8\uB7A8\uC774 \uC0C1\uD0DC {exitCode}\uC73C\uB85C \uC885\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
  "cli.invalidOpencodeDigitalPetPackageManifest": "opencode-digital-pet \uD328\uD0A4\uC9C0 \uB9E4\uB2C8\uD398\uC2A4\uD2B8\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.",
  "cli.expectedInitOrUpdate": "init \uB610\uB294 update\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.",
  "cli.onlyDryRunIsSupportedAfterACommand": "\uBA85\uB839\uC5B4 \uB4A4\uC5D0\uB294 --dry-run\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
  "cli.unexpectedCliFailure": "\uC608\uC0C1\uD558\uC9C0 \uBABB\uD55C CLI \uC624\uB958\uC785\uB2C8\uB2E4.",
  "digitalPetFreeze.digitalPetFrozen": "Digital Pet\uC744 \uC77C\uC2DC \uC815\uC9C0\uD588\uC2B5\uB2C8\uB2E4.",
  "digitalPetSet.unknownDigimonId": "\uC54C \uC218 \uC5C6\uB294 \uB514\uC9C0\uBAAC ID: {requestedId}.",
  "digitalPetSet.digitalPetSetTo": "Digital Pet\uC744 {nameEn} ({id})\uC73C\uB85C \uC9C0\uC815\uD588\uC2B5\uB2C8\uB2E4.",
  "digitalPetSpawn.spawnedGeneration": "{generation}\uC138\uB300\uB97C \uC0DD\uC131\uD588\uC2B5\uB2C8\uB2E4.",
  "digitalPetUnfreeze.digitalPetUnfrozen": "Digital Pet\uC744 \uB2E4\uC2DC \uD65C\uC131\uD654\uD588\uC2B5\uB2C8\uB2E4.",
  "attachDevTools.evolutionRevealDidNotPlayEnsureTheSidebar": "\uC9C4\uD654 \uACF5\uAC1C \uC560\uB2C8\uBA54\uC774\uC158\uC774 \uC7AC\uC0DD\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC0AC\uC774\uB4DC\uBC14\uAC00 \uBCF4\uC774\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694.",
  "attachDevTools.battleRepositoryIsUnavailable": "\uC804\uD22C \uC800\uC7A5\uC18C\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
  "attachDevTools.evolutionBattleDidNotStartEnsureAPartner": "\uC9C4\uD654 \uC804\uD22C\uAC00 \uC2DC\uC791\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uD65C\uC131 \uD30C\uD2B8\uB108\uAC00 \uC788\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694.",
  "buildPartnerInputs.unknownDigimonNode": "\uC54C \uC218 \uC5C6\uB294 \uB514\uC9C0\uBAAC: {nodeId}",
  "catalog.digitalPetDevFeed": "Digital Pet \uBA39\uC774 \uD14C\uC2A4\uD2B8",
  "catalog.digitalPetDevActivity": "Digital Pet \uD65C\uB3D9 \uD14C\uC2A4\uD2B8",
  "catalog.digitalPetDevEvolutionReveal": "Digital Pet \uC9C4\uD654 \uACF5\uAC1C \uD14C\uC2A4\uD2B8",
  "catalog.digitalPetDevEvolutionBattle": "Digital Pet \uC9C4\uD654 \uC804\uD22C \uD14C\uC2A4\uD2B8",
  "catalog.digitalPetDevDefeatViaBattle": "Digital Pet \uD328\uBC30 \uD14C\uC2A4\uD2B8 (\uC804\uD22C)",
  "registerDevCommandLayer.digitalPetDev": "Digital Pet \uAC1C\uBC1C",
  "setupScenario.digitalPetDevPartnerNodeIsMissingFrom": "Digital Pet \uAC1C\uBC1C: \uB3C4\uAC10\uC5D0 \uB514\uC9C0\uBAAC {currentNodeId}\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.",
  "setupScenario.digitalPetDevPartnerIsFrozenUnfreezeBefore": "Digital Pet \uAC1C\uBC1C: \uD30C\uD2B8\uB108\uAC00 \uC77C\uC2DC \uC815\uC9C0\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4. \uC9C4\uD654 \uC804\uD22C \uC804\uC5D0 \uD65C\uC131\uD654\uD558\uC138\uC694.",
  "setupScenario.digitalPetDevClearTheDigimonOverrideBefore": "Digital Pet \uAC1C\uBC1C: \uC9C4\uD654 \uC804\uD22C \uC804\uC5D0 \uC218\uB3D9 \uB514\uC9C0\uBAAC \uC9C0\uC815\uC744 \uD574\uC81C\uD558\uC138\uC694.",
  "setupScenario.digitalPetDevPartnerCannotEvolveFurtherSo": "Digital Pet \uAC1C\uBC1C: \uD30C\uD2B8\uB108\uAC00 \uB354 \uC774\uC0C1 \uC9C4\uD654\uD560 \uC218 \uC5C6\uC5B4 \uC9C4\uD654 \uC804\uD22C\uB97C \uC2DC\uC791\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
  "setupScenario.digitalPetDevCouldNotReadTheActive": "Digital Pet \uAC1C\uBC1C: \uD65C\uC131 \uD30C\uD2B8\uB108\uC758 \uC0C1\uD0DC\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
  "setupScenario.digitalPetDevCouldNotOpenAPending": "Digital Pet \uAC1C\uBC1C: \uD604\uC7AC \uD30C\uD2B8\uB108\uC758 \uC9C4\uD654 \uC804\uD22C\uB97C \uC2DC\uC791\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
  "digitalPetCommandLayer.digitalPetDex": "Digital Pet \uB3C4\uAC10",
  "digitalPetCommandLayer.browseTheDigitalPetDiscoveryArchive": "Digital Pet \uBC1C\uACAC \uAE30\uB85D\uC744 \uD0D0\uC0C9\uD569\uB2C8\uB2E4.",
  "digitalPetCommandLayer.digitalPetHistory": "Digital Pet \uAE30\uB85D",
  "digitalPetCommandLayer.browseDigitalPetGenerationHistory": "Digital Pet \uC138\uB300 \uAE30\uB85D\uC744 \uD0D0\uC0C9\uD569\uB2C8\uB2E4.",
  "digitalPetDexDialog.noDataAvailable": "\uC0AC\uC6A9\uD560 \uC218 \uC788\uB294 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4",
  "digitalPetDexDialog.1Item10ItemsEscClose": "\u2191\u2193: 1\uAC1C \xB7 \u2190\u2192: 10\uAC1C \xB7 Esc: \uB2EB\uAE30",
  "digitalPetHistoryDialog.active": "\uD65C\uC131",
  "digitalPetHistoryDialog.retired": "\uC740\uD1F4",
  "digitalPetHistoryDialog.generation": "{generation}\uC138\uB300 \u2014 {createdAt} \u2014 {status}",
  "digitalPetHistoryDialog.noCanonicalEventsRecorded": "\uB4F1\uB85D\uB41C \uC774\uBCA4\uD2B8\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4",
  "openInBrowser.unsupportedPlatformForOpeningUrls": "URL \uC5F4\uAE30\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD50C\uB7AB\uD3FC\uC785\uB2C8\uB2E4: {platform}",
  "sidebarCard.nextCheck": "\uB2E4\uC74C \uC9C4\uD654: ",
  "sidebarCard.encyclopediaEntry": "\uBC31\uACFC\uC0AC\uC804 \uD56D\uBAA9",
  "sidebarCard.evolutionBattle": "{NEXT_CHECK_PREFIX}\uC9C4\uD654 \uC804\uD22C!",
  "sidebarCard.none": "{NEXT_CHECK_PREFIX}\uC5C6\uC74C",
  "sidebarCard.set": "{name} (\uC218\uB3D9 \uC9C0\uC815)",
  "sidebarCard.frozen": "{stage} (\uC77C\uC2DC \uC815\uC9C0)",
  "phase.battle": "\uC804\uD22C",
  "phase.evolving": "\uC9C4\uD654 \uC911",
  "phase.evolved": "\uC9C4\uD654 \uC644\uB8CC",
  "phase.defeated": "\uD328\uBC30",
  "phase.draw": "\uBB34\uC2B9\uBD80",
  "phase.feeding": "\uBA39\uB294 \uC911",
  "cli.help": "\uC0AC\uC6A9\uBC95: opencode-digital-pet <init|update> [--dry-run]\n\n\uBA85\uB839\uC5B4:\n  init       OpenCode \uC804\uC5ED \uD50C\uB7EC\uADF8\uC778 \uC124\uCE58 \uD504\uB85C\uADF8\uB7A8\uC73C\uB85C \uD604\uC7AC \uBC84\uC804\uC744 \uC124\uCE58\uD569\uB2C8\uB2E4.\n  update     \uAC19\uC740 \uC124\uCE58 \uD504\uB85C\uADF8\uB7A8\uC73C\uB85C \uD604\uC7AC \uBC84\uC804\uC744 \uB2E4\uC2DC \uC124\uCE58\uD569\uB2C8\uB2E4.\n\n\uC635\uC158:\n  --dry-run  \uC2E4\uD589\uD558\uC9C0 \uC54A\uACE0 OpenCode \uBA85\uB839\uC5B4\uB9CC \uD45C\uC2DC\uD569\uB2C8\uB2E4.\n  --help     \uB3C4\uC6C0\uB9D0\uC744 \uD45C\uC2DC\uD569\uB2C8\uB2E4.\n",
  "cli.installed": "OpenCode \uD50C\uB7EC\uADF8\uC778 \uC124\uCE58\uAC00 \uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. OpenCode\uB97C \uB2E4\uC2DC \uC2DC\uC791\uD558\uC138\uC694.\n",
  "phase.no_evolution": "\uC9C4\uD654 \uC5C6\uC74C"
};

// src/i18n.ts
var catalogs2 = { en: en_default3, es: es_default3, gl: gl_default3, ko: ko_default3 };
var IntlModule3 = IntlModule.register("opencode", catalogs2);

// src/commands/digital-pet-freeze.ts
var runDigitalPetFreezeCommand = async (control, context) => {
  const outcome = freezeDigitalPet(control);
  const parts = [
    {
      id: context.messageID,
      sessionID: context.sessionID,
      messageID: context.messageID,
      type: "text",
      text: IntlModule3.translate("digitalPetFreeze.digitalPetFrozen")
    }
  ];
  switch (outcome.kind) {
    case "frozen":
      return { parts, event: { kind: "frozen" } };
    case "already_frozen":
      return { parts };
    default: {
      const unexpectedOutcome = outcome;
      return unexpectedOutcome;
    }
  }
};

// ../digital-pet-core/src/application/use-cases/set-digital-pet-cheat-node.ts
var setDigitalPetCheatNode = (control, validatedNodeId) => control.setCheatNode(validatedNodeId);

// src/commands/digital-pet-set.ts
var textPart = (context, text) => ({
  id: context.messageID,
  sessionID: context.sessionID,
  messageID: context.messageID,
  type: "text",
  text
});
var runDigitalPetSetCommand = async (control, context, loadCatalog) => {
  if (context.arguments.includes("\n")) return { parts: [textPart(context, "Usage: /digital-pet-set <id>.")] };
  const tokens = context.arguments.trim().split(/\s+/);
  if (context.arguments.trim() === "" || tokens.length !== 1)
    return { parts: [textPart(context, "Usage: /digital-pet-set <id>.")] };
  const requestedId = tokens[0];
  if (requestedId === void 0) return { parts: [textPart(context, "Usage: /digital-pet-set <id>.")] };
  const node = (await loadCatalog()).byId.get(requestedId);
  if (node === void 0)
    return {
      parts: [textPart(context, IntlModule3.translate("digitalPetSet.unknownDigimonId", { requestedId }))]
    };
  const outcome = setDigitalPetCheatNode(control, node.id);
  const parts = [
    textPart(context, IntlModule3.translate("digitalPetSet.digitalPetSetTo", { nameEn: node.nameEn, id: node.id }))
  ];
  switch (outcome.kind) {
    case "set":
      return { parts, event: { kind: "set", nodeId: node.id } };
    case "already_set":
      return { parts };
    default: {
      const unexpectedOutcome = outcome;
      return unexpectedOutcome;
    }
  }
};

// ../digital-pet-core/src/application/use-cases/spawn-partner.ts
var spawnPartner = (lifecycle, createdAt) => {
  const partner = lifecycle.spawnPartner({
    currentNodeId: "0-001",
    gauge: 0,
    isTerminal: false,
    createdAt
  });
  return { generation: partner.generation };
};

// src/commands/digital-pet-spawn.ts
var runDigitalPetSpawnCommand = async (lifecycle, context) => {
  const partner = spawnPartner(lifecycle, context.createdAt);
  return {
    parts: [
      {
        id: context.messageID,
        sessionID: context.sessionID,
        messageID: context.messageID,
        type: "text",
        text: IntlModule3.translate("digitalPetSpawn.spawnedGeneration", { generation: partner.generation })
      }
    ],
    event: { kind: "spawned", nodeId: "0-001", generation: partner.generation }
  };
};

// ../digital-pet-core/src/application/use-cases/unfreeze-digital-pet.ts
var unfreezeDigitalPet = (control) => control.unfreeze();

// src/commands/digital-pet-unfreeze.ts
var runDigitalPetUnfreezeCommand = async (control, context) => {
  const outcome = unfreezeDigitalPet(control);
  const parts = [
    {
      id: context.messageID,
      sessionID: context.sessionID,
      messageID: context.messageID,
      type: "text",
      text: IntlModule3.translate("digitalPetUnfreeze.digitalPetUnfrozen")
    }
  ];
  switch (outcome.kind) {
    case "unfrozen":
      return { parts, event: { kind: "unfrozen" } };
    case "already_unfrozen":
      return { parts };
    default: {
      const unexpectedOutcome = outcome;
      return unexpectedOutcome;
    }
  }
};

// src/adapters/opencode/digital-pet-toast.ts
var assertNever = (value) => {
  throw new Error(`Unhandled Digital Pet toast event: ${JSON.stringify(value)}`);
};
var selectName = (node, language) => {
  switch (language) {
    case "en":
      return node.nameEn;
    case "jp":
      return node.nameJp;
    default:
      return assertNever(language);
  }
};
var namedPayload = (nodeId, language, catalog) => {
  const node = catalog.byId.get(nodeId);
  return node === void 0 ? void 0 : selectName(node, language);
};
var formatDigitalPetToast = (event, language, catalog) => {
  switch (event.kind) {
    case "spawn": {
      const name = namedPayload(event.nodeId, language, catalog);
      return name === void 0 ? void 0 : {
        title: IntlModule3.translate("digitalPetToast.digitalPet"),
        message: IntlModule3.translate("digitalPetToast.spawnedGeneration", {
          name,
          generation: event.generation
        }),
        variant: "success",
        duration: 5e3
      };
    }
    case "freeze":
      return {
        title: IntlModule3.translate("digitalPetToast.digitalPet"),
        message: IntlModule3.translate("digitalPetToast.digimonProgressionFrozen"),
        variant: "info",
        duration: 3e3
      };
    case "unfreeze":
      return {
        title: IntlModule3.translate("digitalPetToast.digitalPet"),
        message: IntlModule3.translate("digitalPetToast.digimonProgressionResumed"),
        variant: "info",
        duration: 3e3
      };
    case "set": {
      const name = namedPayload(event.nodeId, language, catalog);
      return name === void 0 ? void 0 : {
        title: IntlModule3.translate("digitalPetToast.digitalPet"),
        message: IntlModule3.translate("digitalPetToast.digitalPetSetTo", { name, nodeId: event.nodeId }),
        variant: "info",
        duration: 3e3
      };
    }
    case "evolution": {
      const fromName = namedPayload(event.fromNodeId, language, catalog);
      const toName = namedPayload(event.toNodeId, language, catalog);
      return fromName === void 0 || toName === void 0 ? void 0 : {
        title: "Digi-evolution",
        message: IntlModule3.translate("digitalPetToast.evolvedInto", { fromName, toName }),
        variant: "success",
        duration: 5e3
      };
    }
    case "evolution_battle": {
      const opponentName = namedPayload(event.opponentNodeId, language, catalog);
      return opponentName === void 0 ? void 0 : {
        title: IntlModule3.translate("digitalPetToast.evolutionBattle"),
        message: IntlModule3.translate("digitalPetToast.battleAgainstWinToEvolve", { opponentName }),
        variant: "info",
        duration: 5e3
      };
    }
    case "defeat":
      return {
        title: "Defeat",
        message: IntlModule3.translate("digitalPetToast.defeatYouLostAllTokensForThisStage"),
        variant: "info",
        duration: 5e3
      };
    default:
      return assertNever(event);
  }
};
var createBestEffortDigitalPetToastNotifier = (transport) => {
  return async (payload) => await Promise.resolve().then(() => transport(payload)).then(
    () => void 0,
    () => void 0
  );
};

// src/adapters/opencode/usage-event-mapper.ts
var isCompletedAssistantMessage = (message) => {
  return message.role === "assistant" && "time" in message && message.time.completed !== void 0;
};
var toCompletedUsageFromMessage = (message) => {
  if (!isCompletedAssistantMessage(message)) return null;
  const completedAt = message.time.completed;
  if (completedAt === void 0) return null;
  return {
    receiptKey: `message:${message.id}`,
    eventId: `usage:${message.id}`,
    tokenDelta: message.tokens.input + message.tokens.output + message.tokens.reasoning + message.tokens.cache.read + message.tokens.cache.write,
    cost: Number.isFinite(message.cost) && message.cost > 0 ? message.cost : null,
    createdAt: new Date(completedAt).toISOString()
  };
};
var toCompletedUsageFromEvent = (event) => {
  if (event.type !== "message.updated") return null;
  return toCompletedUsageFromMessage(event.properties.info);
};

// src/adapters/opencode/create-server-hooks.ts
var noOpNotifier = async () => {
};
var EMPTY_CATALOG = Object.freeze({ nodes: Object.freeze([]), byId: /* @__PURE__ */ new Map() });
var toToastEvent = (result) => {
  switch (result.kind) {
    case "applied":
      if (result.evolutionBattlePending !== void 0) {
        return { kind: "evolution_battle", opponentNodeId: result.evolutionBattlePending.opponentNodeId };
      }
      return result.evolution === void 0 ? void 0 : { kind: "evolution", ...result.evolution };
    case "duplicate":
    case "no_active_partner":
      return void 0;
    default: {
      const unexpectedResult = result;
      return unexpectedResult;
    }
  }
};
var toCommandToastEvent = (event) => {
  switch (event.kind) {
    case "spawned":
      return { kind: "spawn", nodeId: event.nodeId, generation: event.generation };
    case "frozen":
      return { kind: "freeze" };
    case "unfrozen":
      return { kind: "unfreeze" };
    case "set":
      return { kind: "set", nodeId: event.nodeId };
  }
};
var requiresCatalog = (event) => {
  switch (event.kind) {
    case "spawn":
    case "set":
    case "evolution":
    case "evolution_battle":
      return true;
    case "freeze":
    case "unfreeze":
    case "defeat":
      return false;
  }
};
var createCommandConfig = () => ({
  "digital-pet-spawn": { template: IntlModule3.translate("createServerHooks.spawnANewVirtualPet") },
  "digital-pet-freeze": { template: IntlModule3.translate("createServerHooks.freezeVirtualPetProgression") },
  "digital-pet-unfreeze": { template: IntlModule3.translate("createServerHooks.unfreezeVirtualPetProgression") },
  "digital-pet-set": { template: IntlModule3.translate("createServerHooks.setTheVirtualPetToADigimonId") }
});
var createServerHooks = ({
  repository,
  resource,
  evolutionSelector = Math.random,
  evolutionThresholds = STAGE_GAUGE_THRESHOLDS,
  fetchMessages,
  language = "jp",
  notificationsEnabled = true,
  loadCatalog = loadDigimonCatalog,
  notify = noOpNotifier
}) => {
  let closePromise;
  const notifyUsageResult = async (result, catalog) => {
    if (result.kind !== "applied") return;
    if (result.evolutionBattlePending !== void 0) {
      const battleToast = toToastEvent(result);
      if (battleToast !== void 0) await notifyEvent(battleToast, catalog);
      return;
    }
    const toastEvent = toToastEvent(result);
    if (toastEvent !== void 0) await notifyEvent(toastEvent, catalog);
  };
  const notifyEvent = async (event, catalog) => {
    if (!notificationsEnabled) return;
    await Promise.resolve().then(async () => {
      const resolvedCatalog = catalog ?? (requiresCatalog(event) ? await loadCatalog() : EMPTY_CATALOG);
      const payload = formatDigitalPetToast(event, language, resolvedCatalog);
      if (payload !== void 0) await notify(payload);
    }).then(
      () => void 0,
      () => void 0
    );
  };
  return {
    async config(config) {
      config.command = {
        ...config.command,
        ...createCommandConfig()
      };
    },
    async "command.execute.before"(input, output) {
      const messageID = `digital-pet-${input.command}-${input.sessionID}-${crypto.randomUUID()}`;
      switch (input.command) {
        case "digital-pet-spawn":
          {
            const result = await runDigitalPetSpawnCommand(repository, {
              sessionID: input.sessionID,
              messageID,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            });
            output.parts.push(...result.parts);
            if (result.event !== void 0) await notifyEvent(toCommandToastEvent(result.event));
          }
          return;
        case "digital-pet-freeze":
          {
            const result = await runDigitalPetFreezeCommand(repository, { sessionID: input.sessionID, messageID });
            output.parts.push(...result.parts);
            if (result.event !== void 0) await notifyEvent(toCommandToastEvent(result.event));
          }
          return;
        case "digital-pet-unfreeze":
          {
            const result = await runDigitalPetUnfreezeCommand(repository, { sessionID: input.sessionID, messageID });
            output.parts.push(...result.parts);
            if (result.event !== void 0) await notifyEvent(toCommandToastEvent(result.event));
          }
          return;
        case "digital-pet-set":
          {
            let catalog;
            const loadCommandCatalog = async () => catalog ??= await loadCatalog();
            const result = await runDigitalPetSetCommand(
              repository,
              { sessionID: input.sessionID, messageID, arguments: input.arguments },
              loadCommandCatalog
            );
            output.parts.push(...result.parts);
            if (result.event !== void 0)
              await notifyEvent(toCommandToastEvent(result.event), await loadCommandCatalog());
          }
          return;
        default:
          return;
      }
    },
    async event({ event }) {
      switch (event.type) {
        case "message.updated": {
          const usage = toCompletedUsageFromEvent(event);
          if (usage === null) return;
          const catalog = await loadCatalog();
          const result = recordUsage({
            usage,
            ledger: repository,
            digimonById: catalog.byId,
            catalogNodes: catalog.nodes,
            selector: evolutionSelector,
            thresholds: evolutionThresholds
          });
          await notifyUsageResult(result, catalog);
          return;
        }
        case "session.idle": {
          if (fetchMessages === void 0) return;
          const messages = await fetchMessages(event.properties.sessionID);
          const usages = messages.flatMap((message) => {
            const usage = toCompletedUsageFromMessage(message);
            return usage === null ? [] : [usage];
          });
          const catalog = await loadCatalog();
          const results = reconcileUsage({
            usages,
            ledger: repository,
            digimonById: catalog.byId,
            catalogNodes: catalog.nodes,
            selector: evolutionSelector,
            thresholds: evolutionThresholds
          });
          for (const result of results) {
            await notifyUsageResult(result, catalog);
          }
          return;
        }
        default:
          return;
      }
    },
    async dispose() {
      closePromise ??= resource.close();
      await closePromise;
    }
  };
};

// src/adapters/opencode/session-messages.ts
var createSessionMessagesFetcher = (client) => {
  return async (sessionID) => {
    const result = await client.session.messages({ path: { id: sessionID } });
    if (result.data === void 0)
      throw new Error(
        IntlModule3.translate("sessionMessages.unableToListMessagesForIdleSession", { sessionID })
      );
    return result.data.map(({ info }) => info);
  };
};

// ../digital-pet-core/src/adapters/sqlite/app-data-path.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var APP_DIRECTORY_NAME = "opencode-digital-pet";
var LEGACY_APP_DIRECTORY_NAME = "opencode-vpet";
var DATABASE_FILE_NAME = "pet.db";
var resolveDefaultAppDataRoot = () => {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    const { APPDATA } = process.env;
    return APPDATA ?? join(homedir(), "AppData", "Roaming");
  }
  return join(homedir(), ".local", "share");
};
var resolveHostDataDirectory = (options = {}) => {
  const root = options.appDataRoot ?? resolveDefaultAppDataRoot();
  const currentDirectory = join(root, APP_DIRECTORY_NAME);
  const legacyDirectory = join(root, LEGACY_APP_DIRECTORY_NAME);
  if (!existsSync(join(currentDirectory, DATABASE_FILE_NAME)) && existsSync(join(legacyDirectory, DATABASE_FILE_NAME))) {
    return legacyDirectory;
  }
  return currentDirectory;
};
var resolveHostDatabasePath = (options = {}) => {
  return join(resolveHostDataDirectory(options), DATABASE_FILE_NAME);
};

// ../digital-pet-core/src/adapters/sqlite/sqlite-combat-progress.ts
var readCombatProgress = (executor, partnerId, nodeId) => executor.get(
  "SELECT victories, battle_id FROM partner_combat_progress WHERE partner_id = ? AND node_id = ?",
  [partnerId, nodeId]
) ?? { victories: 0, battle_id: null };
var syncCombatProgress = (executor, partnerId, progress) => {
  const previous = readCombatProgress(executor, partnerId, progress.currentNodeId);
  const battleId = progress.battleOpponentNodeId ? previous.battle_id ?? executor.get("SELECT lower(hex(randomblob(16))) AS id")?.id ?? null : null;
  executor.run(
    "INSERT INTO partner_combat_progress (partner_id, node_id, victories, battle_id) VALUES (?, ?, ?, ?) ON CONFLICT(partner_id) DO UPDATE SET node_id = excluded.node_id, victories = excluded.victories, battle_id = excluded.battle_id",
    [partnerId, progress.currentNodeId, previous.victories, battleId]
  );
};

// ../digital-pet-core/src/adapters/sqlite/sqlite-digital-pet-schema.ts
var PARTNER_COLUMNS = `
    partner_id,
    generation,
    current_node_id,
    gauge,
    is_terminal,
    pending_evolution_target_id,
    battle_opponent_node_id,
    created_at,
    retired_at
`;
var LEGACY_ACTIVE_PARTNER_SELECT = `
  SELECT
    ${PARTNER_COLUMNS}
  FROM partners
  WHERE retired_at IS NULL
  LIMIT 1
`;
var ACTIVE_PARTNER_SELECT = `
  SELECT ${PARTNER_COLUMNS}
  FROM partners
  WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1)
    AND retired_at IS NULL
  LIMIT 1
`;
var readSqliteActivePartner = (executor) => {
  const migrated = executor.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partner_team'"
  );
  return executor.get(migrated ? ACTIVE_PARTNER_SELECT : LEGACY_ACTIVE_PARTNER_SELECT);
};
var PARTNERS_SELECT = `
  SELECT
    ${PARTNER_COLUMNS}
  FROM partners
  ORDER BY generation ASC, created_at ASC, partner_id ASC
`;
var ARCHIVE_PARTNERS_SELECT = `
  SELECT
    ${PARTNER_COLUMNS}
  FROM partners
  ORDER BY partner_id ASC
`;
var PARTNER_BY_GENERATION_SELECT = `
  SELECT
    ${PARTNER_COLUMNS}
  FROM partners
  WHERE generation = ?
  LIMIT 1
`;
var PARTNER_EVENTS_SELECT = `
  SELECT
    event_id,
    partner_id,
    kind,
    current_node_id,
    gauge,
    is_terminal,
    token_delta,
    receipt_key,
    created_at
  FROM partner_events
  WHERE partner_id = ?
  ORDER BY created_at ASC, event_id ASC
`;
var USAGE_RECEIPTS_SELECT = `
  SELECT receipt_key, partner_id, event_id, token_delta, cost, created_at
  FROM usage_receipts
  ORDER BY created_at ASC, receipt_key ASC
`;
var toPartner = (row) => {
  return {
    partnerId: row.partner_id,
    generation: row.generation,
    currentNodeId: row.current_node_id,
    gauge: row.gauge,
    isTerminal: row.is_terminal === 1,
    pendingEvolutionTargetId: row.pending_evolution_target_id,
    battleOpponentNodeId: row.battle_opponent_node_id,
    createdAt: row.created_at,
    retiredAt: row.retired_at
  };
};
var toPersistedPartnerEvent = (row) => {
  return {
    eventId: row.event_id,
    partnerId: row.partner_id,
    kind: row.kind,
    currentNodeId: row.current_node_id,
    gauge: row.gauge,
    isTerminal: row.is_terminal === 1,
    tokenDelta: row.token_delta,
    receiptKey: row.receipt_key,
    createdAt: row.created_at
  };
};
var toUsageReceiptRecord = (row) => {
  return {
    receiptKey: row.receipt_key,
    partnerId: row.partner_id,
    eventId: row.event_id,
    tokenDelta: row.token_delta,
    createdAt: row.created_at
  };
};

// ../digital-pet-core/src/domain/hygiene.ts
var HOUR = 60 * 60 * 1e3;
var HYGIENE_INTERVALS_MS = [2 * HOUR, 8 * HOUR, 16 * HOUR];
var createHygiene = (now) => ({
  poops: [],
  nextAt: now + HYGIENE_INTERVALS_MS[0],
  happyUntil: 0
});
var advanceHygiene = (state, isEgg, now) => {
  if (isEgg) return void 0;
  if (!state) return createHygiene(now);
  let nextAt = state.nextAt;
  if (nextAt === null || now < nextAt) return state;
  const poops = [...state.poops];
  while (nextAt !== null && now >= nextAt && poops.length < HYGIENE_INTERVALS_MS.length) {
    poops.push(nextAt);
    const interval = HYGIENE_INTERVALS_MS[poops.length];
    nextAt = interval === void 0 ? null : nextAt + interval;
  }
  return { ...state, poops, nextAt };
};
var parseHygiene = (value) => {
  if (typeof value !== "object" || value === null) throw new Error(IntlModule2.translate("errors.invalidHygieneState"));
  const state = value;
  const time = (input) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
  if (!Array.isArray(state.poops)) throw new Error(IntlModule2.translate("errors.invalidHygieneState"));
  const poops = state.poops;
  if (!poops.every(time) || state.poops.length > 3 || new Set(state.poops).size !== state.poops.length || !time(state.happyUntil) || (state.poops.length === 3 ? state.nextAt !== null : !time(state.nextAt)) || poops.some((id, index) => index > 0 && Number(id) <= Number(poops[index - 1])))
    throw new Error(IntlModule2.translate("errors.invalidHygieneState"));
  return { poops: [...state.poops], nextAt: state.nextAt, happyUntil: state.happyUntil };
};

// ../digital-pet-core/src/adapters/sqlite/sqlite-evolution-care.ts
var readEvolutionHygiene = (executor, partnerId) => {
  const saved = executor.get("SELECT state FROM partner_hygiene WHERE partner_id = ?", [partnerId]);
  return saved ? parseHygiene(JSON.parse(saved.state)) : void 0;
};
var readEvolutionCare = (executor, partnerId, now) => advanceHygiene(readEvolutionHygiene(executor, partnerId), false, now)?.poops.length ?? 0;

// ../digital-pet-core/src/adapters/sqlite/sqlite-evolution-resolution.ts
var createSqliteEvolutionBattleStore = (executor) => {
  const active = () => {
    const row = executor.get(ACTIVE_PARTNER_SELECT);
    return row ? toPartner(row) : null;
  };
  const commit = (partner, next, createdAt) => {
    executor.run(
      "UPDATE partners SET current_node_id = ?, gauge = ?, is_terminal = ?, pending_evolution_target_id = ?, battle_opponent_node_id = ? WHERE partner_id = ?",
      [
        next.currentNodeId,
        next.gauge,
        next.isTerminal,
        next.pendingEvolutionTargetId,
        next.battleOpponentNodeId,
        partner.partnerId
      ]
    );
    syncCombatProgress(executor, partner.partnerId, next);
    executor.run(
      "INSERT INTO partner_events (event_id, partner_id, kind, current_node_id, gauge, is_terminal, token_delta, receipt_key, created_at) VALUES (?, ?, 'usage_applied', ?, ?, ?, NULL, NULL, ?)",
      [
        `event-battle-${partner.partnerId}-${createdAt}`,
        partner.partnerId,
        next.currentNodeId,
        next.gauge,
        next.isTerminal,
        createdAt
      ]
    );
    return next.currentNodeId !== partner.currentNodeId ? { kind: "won", evolution: { fromNodeId: partner.currentNodeId, toNodeId: next.currentNodeId } } : { kind: "lost" };
  };
  return {
    getEvolutionBattleId: () => {
      const partner = active();
      return partner ? readCombatProgress(executor, partner.partnerId, partner.currentNodeId).battle_id : null;
    },
    resolveEvolutionBattle: (next, createdAt) => executor.transaction(() => {
      const partner = active();
      return partner?.battleOpponentNodeId ? commit(partner, next, createdAt) : { kind: "no_pending_battle" };
    }),
    completeEvolutionBattle: (won, createdAt, expected, selector = Math.random) => executor.transaction(() => {
      const partner = active();
      if (!partner?.battleOpponentNodeId) return { kind: "no_pending_battle" };
      const progress = readCombatProgress(executor, partner.partnerId, partner.currentNodeId);
      if (expected && (partner.partnerId !== expected.partnerId || partner.currentNodeId !== expected.currentNodeId || partner.pendingEvolutionTargetId !== expected.pendingEvolutionTargetId || partner.battleOpponentNodeId !== expected.battleOpponentNodeId || expected.battleId !== void 0 && progress.battle_id !== expected.battleId))
        return { kind: "no_pending_battle" };
      const current = DIGIMON_CATALOG.byId.get(partner.currentNodeId);
      if (!current) throw new Error("Unknown evolution participant");
      const next = resolveEvolutionBattle(
        {
          current,
          gauge: partner.gauge,
          isTerminal: partner.isTerminal,
          pendingEvolutionTargetId: partner.pendingEvolutionTargetId,
          battleOpponentNodeId: partner.battleOpponentNodeId,
          combatVictories: progress.victories
        },
        won,
        DIGIMON_CATALOG.byId,
        readEvolutionCare(executor, partner.partnerId, Date.parse(createdAt)),
        selector
      );
      const result = commit(
        partner,
        {
          currentNodeId: next.current.id,
          gauge: next.gauge,
          isTerminal: next.isTerminal,
          pendingEvolutionTargetId: null,
          battleOpponentNodeId: null
        },
        createdAt
      );
      executor.run("UPDATE partner_combat_progress SET victories = ? WHERE partner_id = ?", [
        next.combatVictories ?? 0,
        partner.partnerId
      ]);
      return won && next.current.id === current.id ? { kind: "won_without_evolution" } : result;
    })
  };
};

// ../digital-pet-core/src/adapters/sqlite/sqlite-migrations.ts
var MIGRATIONS = [
  {
    version: 1,
    sql: [
      `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS trainer_state (
          trainer_id INTEGER PRIMARY KEY CHECK (trainer_id = 1),
          total_tokens INTEGER NOT NULL
        )
      `,
      `
        INSERT INTO trainer_state (trainer_id, total_tokens)
        VALUES (1, 0)
        ON CONFLICT (trainer_id) DO NOTHING
      `,
      `
        CREATE TABLE IF NOT EXISTS partners (
          partner_id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL,
          current_node_id TEXT NOT NULL,
          gauge INTEGER NOT NULL,
          is_terminal INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          retired_at TEXT
        )
      `,
      `
        CREATE UNIQUE INDEX IF NOT EXISTS partners_one_active_partner
        ON partners ((1))
        WHERE retired_at IS NULL
      `,
      `
        CREATE TABLE IF NOT EXISTS partner_events (
          event_id TEXT PRIMARY KEY,
          partner_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          current_node_id TEXT NOT NULL,
          gauge INTEGER NOT NULL,
          is_terminal INTEGER NOT NULL,
          token_delta INTEGER,
          receipt_key TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (partner_id) REFERENCES partners (partner_id)
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS partner_events_partner_created_at
        ON partner_events (partner_id, created_at, event_id)
      `,
      `
        CREATE TABLE IF NOT EXISTS usage_receipts (
          receipt_key TEXT PRIMARY KEY,
          partner_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          token_delta INTEGER NOT NULL,
          cost REAL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (partner_id) REFERENCES partners (partner_id),
          FOREIGN KEY (event_id) REFERENCES partner_events (event_id)
        )
      `
    ]
  },
  {
    version: 2,
    sql: ["CREATE UNIQUE INDEX IF NOT EXISTS partners_generation_unique ON partners (generation)"]
  },
  {
    version: 3,
    sql: [
      `
        CREATE TABLE IF NOT EXISTS vpet_control_state (
          control_id INTEGER PRIMARY KEY CHECK (control_id = 1),
          frozen INTEGER NOT NULL CHECK (frozen IN (0, 1)),
          cheat_node_id TEXT
        )
      `,
      `
        INSERT INTO vpet_control_state (control_id, frozen, cheat_node_id)
        VALUES (1, 0, NULL)
        ON CONFLICT (control_id) DO NOTHING
      `,
      `
        CREATE TABLE IF NOT EXISTS vpet_control_receipts (
          receipt_key TEXT PRIMARY KEY,
          mode TEXT NOT NULL CHECK (mode IN ('frozen', 'cheat')),
          token_delta INTEGER NOT NULL,
          cost REAL,
          created_at TEXT NOT NULL
        )
      `
    ]
  },
  {
    version: 4,
    sql: [
      "ALTER TABLE partners ADD COLUMN pending_evolution_target_id TEXT",
      "ALTER TABLE partners ADD COLUMN battle_opponent_node_id TEXT"
    ]
  },
  {
    version: 5,
    sql: [
      "CREATE TABLE IF NOT EXISTS partner_hygiene (partner_id TEXT PRIMARY KEY REFERENCES partners(partner_id), state TEXT NOT NULL)"
    ]
  },
  {
    version: 6,
    sql: [
      "CREATE TABLE IF NOT EXISTS partner_adventures (partner_id TEXT PRIMARY KEY REFERENCES partners(partner_id), state TEXT NOT NULL)"
    ]
  },
  {
    version: 7,
    sql: [
      "CREATE TABLE IF NOT EXISTS adventure_schedule (schedule_id INTEGER PRIMARY KEY CHECK (schedule_id = 1), ready_at INTEGER NOT NULL)"
    ]
  },
  {
    version: 8,
    sql: [
      "CREATE TABLE IF NOT EXISTS boss_victories (region_id TEXT NOT NULL, node_id TEXT NOT NULL, defeated_at TEXT NOT NULL, PRIMARY KEY (region_id, node_id))"
    ]
  },
  {
    version: 9,
    sql: [
      `CREATE TABLE partner_team (
        team_id INTEGER PRIMARY KEY CHECK (team_id = 1),
        principal_id TEXT REFERENCES partners(partner_id),
        reserve_id TEXT REFERENCES partners(partner_id),
        reserve_paused_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        CHECK (reserve_id IS NULL OR (principal_id IS NOT NULL AND reserve_id <> principal_id)),
        CHECK ((reserve_id IS NULL AND reserve_paused_at IS NULL) OR
          (reserve_id IS NOT NULL AND reserve_paused_at IS NOT NULL AND reserve_paused_at >= 0))
      )`,
      `INSERT INTO partner_team (team_id, principal_id, reserve_id, reserve_paused_at, revision)
        VALUES (1, (SELECT partner_id FROM partners WHERE retired_at IS NULL LIMIT 1), NULL, NULL, 0)`,
      "DROP INDEX partners_one_active_partner",
      `CREATE TRIGGER partners_limit_owned_insert BEFORE INSERT ON partners
        WHEN NEW.retired_at IS NULL AND (SELECT COUNT(*) FROM partners WHERE retired_at IS NULL) >= 2
        BEGIN SELECT RAISE(ABORT, 'A team can own at most two partners'); END`,
      `CREATE TRIGGER partners_limit_owned_restore BEFORE UPDATE OF retired_at ON partners
        WHEN OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL
          AND (SELECT COUNT(*) FROM partners WHERE retired_at IS NULL) >= 2
        BEGIN SELECT RAISE(ABORT, 'A team can own at most two partners'); END`
    ]
  },
  {
    version: 10,
    sql: [
      `CREATE TABLE partner_combat_progress (
      partner_id TEXT PRIMARY KEY REFERENCES partners(partner_id),
      node_id TEXT NOT NULL,
      victories INTEGER NOT NULL DEFAULT 0 CHECK (victories BETWEEN 0 AND 1000000),
      battle_id TEXT
    )`
    ]
  },
  {
    version: 11,
    sql: [
      `CREATE TABLE partner_adventure_schedule (
        partner_id TEXT PRIMARY KEY REFERENCES partners(partner_id),
        ready_at INTEGER NOT NULL CHECK (ready_at >= 0)
      )`,
      `INSERT INTO partner_adventure_schedule (partner_id, ready_at)
        SELECT principal_id, max(0, ready_at) FROM partner_team, adventure_schedule
        WHERE team_id = 1 AND schedule_id = 1 AND principal_id IS NOT NULL`,
      "DROP TABLE adventure_schedule"
    ]
  },
  {
    version: 12,
    sql: [
      // Living final forms also earn EXP and fight threshold duels; history remains untouched.
      "UPDATE partners SET is_terminal = 0 WHERE retired_at IS NULL AND is_terminal = 1"
    ]
  }
];
var runMigrations = (database) => {
  return database.transaction(() => {
    database.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const appliedVersions = new Set(
      database.all("SELECT version FROM schema_migrations ORDER BY version ASC").map((row) => row.version)
    );
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      for (const statement of migration.sql) {
        database.run(statement);
      }
      database.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        (/* @__PURE__ */ new Date()).toISOString()
      ]);
      appliedVersions.add(migration.version);
    }
    return [...appliedVersions].sort((left, right) => left - right);
  });
};

// ../digital-pet-core/src/adapters/sqlite/sqlite-partner-lifecycle.ts
var spawnSqlitePartner = (executor, input, slot = "principal") => {
  if (slot === "principal")
    executor.run("UPDATE vpet_control_state SET frozen = 0, cheat_node_id = NULL WHERE control_id = 1");
  const activePartnerRow = executor.get(
    slot === "principal" ? ACTIVE_PARTNER_SELECT : "SELECT * FROM partners WHERE partner_id = (SELECT reserve_id FROM partner_team WHERE team_id = 1) AND retired_at IS NULL"
  );
  if (activePartnerRow !== null) {
    const activePartner = toPartner(activePartnerRow);
    executor.run("UPDATE partners SET retired_at = ? WHERE partner_id = ?", [input.createdAt, activePartner.partnerId]);
    executor.run(
      "INSERT INTO partner_events (event_id, partner_id, kind, current_node_id, gauge, is_terminal, token_delta, receipt_key, created_at) VALUES (?, ?, 'retired', ?, ?, ?, NULL, NULL, ?)",
      [
        `event-retired-${activePartner.generation}`,
        activePartner.partnerId,
        activePartner.currentNodeId,
        activePartner.gauge,
        activePartner.isTerminal,
        input.createdAt
      ]
    );
  }
  const generationRow = executor.get(
    "SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM partners"
  );
  if (generationRow === null) throw new Error(IntlModule2.translate("errors.generationAllocationFailed"));
  const partnerId = `partner-${generationRow.generation}`;
  executor.run(
    "INSERT INTO partners (partner_id, generation, current_node_id, gauge, is_terminal, pending_evolution_target_id, battle_opponent_node_id, created_at, retired_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)",
    [partnerId, generationRow.generation, input.currentNodeId, input.gauge, input.isTerminal, input.createdAt]
  );
  executor.run(
    "INSERT INTO partner_events (event_id, partner_id, kind, current_node_id, gauge, is_terminal, token_delta, receipt_key, created_at) VALUES (?, ?, 'spawned', ?, ?, ?, NULL, NULL, ?)",
    [
      `event-spawn-${generationRow.generation}`,
      partnerId,
      input.currentNodeId,
      input.gauge,
      input.isTerminal,
      input.createdAt
    ]
  );
  if (slot === "principal")
    executor.run("UPDATE partner_team SET principal_id = ?, revision = revision + 1 WHERE team_id = 1", [partnerId]);
  else
    executor.run(
      "UPDATE partner_team SET reserve_id = ?, reserve_paused_at = ?, revision = revision + 1 WHERE team_id = 1",
      [partnerId, Date.parse(input.createdAt)]
    );
  return {
    partnerId,
    generation: generationRow.generation,
    ...input,
    pendingEvolutionTargetId: null,
    battleOpponentNodeId: null,
    retiredAt: null
  };
};

// ../digital-pet-core/src/domain/adventure-encounter.ts
var ADVENTURE_BATTLE_REWARDS = Object.freeze({ lower: 0.02, same: 0.05, higher: 0.15, boss: 0.5 });

// ../digital-pet-core/src/domain/adventure-pacing.ts
var ADVENTURE_PACING = Object.freeze({
  quietMinMs: 45e3,
  quietMaxMs: 65e3,
  cooldownMs: 2 * 60 * 60 * 1e3
});

// ../digital-pet-core/src/domain/adventure.ts
var ADVENTURE_POLICY = Object.freeze({
  lootLifetimeMs: 8e3,
  recruitmentChance: 0.15,
  foodExperienceFraction: 0.02,
  fragmentExperienceFraction: 0.02,
  difficultStatBonus: 15
});
var adventureBusy = (state) => state?.status === "travel" && (state.running || state.event?.kind === "battle" || state.event?.kind === "offer");
var parseAdventure = (raw) => {
  if (!raw || typeof raw !== "object") return void 0;
  const state = raw;
  if (typeof state.id !== "string" || !state.id || typeof state.nodeId !== "string" || typeof state.regionId !== "string" || typeof state.running !== "boolean" || !["travel", "complete", "defeated", "evolved"].includes(state.status ?? "") || ![state.elapsedMs, state.lastTickAt, state.nextEventAt, state.sequence, state.collected, state.victories].every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
  ) || state.encounters !== void 0 && (!Array.isArray(state.encounters) || state.encounters.length > 5 || !state.encounters.every((kind) => ["fragment", "food", "battle"].includes(kind))))
    return void 0;
  const event = state.event;
  if (event !== void 0) {
    if (!event || typeof event !== "object") return void 0;
    if (!Number.isSafeInteger(event.id) || event.id < 1) return void 0;
    if (event.kind === "loot") {
      if (!["food", "fragment"].includes(event.item) || !Number.isFinite(event.appearedAt) || event.appearedAt < 0)
        return void 0;
    } else if (event.kind === "offer") {
      if (typeof event.opponentNodeId !== "string" || state.running || state.status !== "travel") return void 0;
    } else if (event.kind === "battle") {
      if (typeof event.opponentNodeId !== "string" || typeof event.difficult !== "boolean" || event.rank !== void 0 && !["lower", "same", "higher", "boss"].includes(event.rank) || !event.plan || !["player", "opponent", "draw"].includes(event.plan.outcome) || !Array.isArray(event.plan.shots) || !event.plan.shots.length || event.plan.shots.length > COMBAT_POLICY.maxShots || !event.plan.shots.every(
        (shot) => shot && ["player", "opponent"].includes(shot.shooter) && typeof shot.hit === "boolean"
      ) || !Number.isInteger(event.completedShots) || event.completedShots < 0 || event.completedShots > event.plan.shots.length)
        return void 0;
    } else return void 0;
  }
  return state;
};

// ../digital-pet-core/src/domain/partner-rest.ts
var resumePartnerHygiene = (state, pausedAt, now) => ({
  ...state,
  nextAt: state.nextAt === null ? null : now + Math.max(0, state.nextAt - pausedAt),
  happyUntil: state.happyUntil <= pausedAt ? 0 : now + state.happyUntil - pausedAt
});

// ../digital-pet-core/src/domain/partner-team.ts
var rejectTeamCommand = (team, command, blocked) => {
  if (command.expectedRevision !== team.revision || command.expectedPrincipalId !== (team.principal?.partnerId ?? null) || command.expectedReserveId !== (team.reserve?.partnerId ?? null))
    return { kind: "rejected", reason: "stale" };
  if (blocked || team.principal?.pendingEvolutionTargetId || team.reserve?.pendingEvolutionTargetId || team.principal?.battleOpponentNodeId || team.reserve?.battleOpponentNodeId)
    return { kind: "rejected", reason: "busy" };
  if (command.kind === "switch" && !team.reserve) return { kind: "rejected", reason: "empty_reserve" };
  if (command.kind === "switch" && !team.principal) return { kind: "rejected", reason: "no_principal" };
  if (command.kind === "place") {
    if (command.slot === "reserve" && !team.principal) return { kind: "rejected", reason: "no_principal" };
    if (!/^[0-7]-\d{3}$/.test(command.partner.currentNodeId) || !Number.isSafeInteger(command.partner.gauge) || command.partner.gauge < 0 || !Number.isFinite(Date.parse(command.partner.createdAt)))
      return { kind: "rejected", reason: "invalid_input" };
  }
  return null;
};

// ../digital-pet-core/src/adapters/sqlite/sqlite-partner-team-store.ts
var readRow = (executor) => {
  const row = executor.get(
    "SELECT principal_id, reserve_id, reserve_paused_at, revision FROM partner_team WHERE team_id = 1"
  );
  if (!row) throw new Error("Missing partner team");
  return row;
};
var readTeam = (executor, row = readRow(executor)) => {
  const read2 = (id) => {
    const partner = id ? executor.get("SELECT * FROM partners WHERE partner_id = ? AND retired_at IS NULL", [id]) : null;
    return partner ? toPartner(partner) : null;
  };
  return { revision: row.revision, principal: read2(row.principal_id), reserve: read2(row.reserve_id) };
};
var readAdventure = (executor, partnerId) => {
  if (!partnerId) return void 0;
  const row = executor.get("SELECT state FROM partner_adventures WHERE partner_id = ?", [partnerId]);
  return row ? parseAdventure(JSON.parse(row.state)) : void 0;
};
var createSqlitePartnerTeamStore = (executor) => ({
  readTeam: () => executor.transaction(() => readTeam(executor)),
  applyTeamCommand: (command, now) => executor.transaction(() => {
    if (!Number.isSafeInteger(now) || now < 0) return { kind: "rejected", reason: "invalid_input" };
    const row = readRow(executor);
    const team = readTeam(executor, row);
    const control = executor.get(
      "SELECT frozen, cheat_node_id FROM vpet_control_state WHERE control_id = 1"
    );
    const blocked = !control || control.frozen === 1 || control.cheat_node_id !== null || adventureBusy(readAdventure(executor, team.principal?.partnerId)) || adventureBusy(readAdventure(executor, team.reserve?.partnerId));
    const rejection = rejectTeamCommand(team, command, blocked);
    if (rejection) return rejection;
    if (command.kind === "place") {
      if (!DIGIMON_CATALOG.byId.has(command.partner.currentNodeId))
        return { kind: "rejected", reason: "invalid_input" };
      spawnSqlitePartner(executor, { ...command.partner, createdAt: new Date(now).toISOString() }, command.slot);
    } else {
      const principal = team.principal;
      const reserve = team.reserve;
      if (!principal || !reserve || row.reserve_paused_at === null)
        throw new Error("Cannot switch an incomplete team");
      const pausedAt = row.reserve_paused_at;
      if (now < pausedAt) return { kind: "rejected", reason: "invalid_input" };
      const current = DIGIMON_CATALOG.byId.get(principal.currentNodeId);
      if (!current) throw new Error("Unknown principal companion");
      const hygiene = advanceHygiene(readEvolutionHygiene(executor, principal.partnerId), current.stage === 0, now);
      if (hygiene)
        executor.run(
          "INSERT INTO partner_hygiene (partner_id, state) VALUES (?, ?) ON CONFLICT(partner_id) DO UPDATE SET state = excluded.state",
          [principal.partnerId, JSON.stringify(hygiene)]
        );
      const restingHygiene = readEvolutionHygiene(executor, reserve.partnerId);
      if (restingHygiene)
        executor.run("UPDATE partner_hygiene SET state = ? WHERE partner_id = ?", [
          JSON.stringify(resumePartnerHygiene(restingHygiene, pausedAt, now)),
          reserve.partnerId
        ]);
      const restingAdventure = readAdventure(executor, reserve.partnerId);
      if (restingAdventure)
        executor.run("UPDATE partner_adventures SET state = ? WHERE partner_id = ?", [
          JSON.stringify({ ...restingAdventure, lastTickAt: now }),
          reserve.partnerId
        ]);
      executor.run(
        "UPDATE partner_team SET principal_id = ?, reserve_id = ?, reserve_paused_at = ?, revision = revision + 1 WHERE team_id = 1",
        [reserve.partnerId, principal.partnerId, now]
      );
    }
    return { kind: "applied", team: readTeam(executor) };
  })
});

// ../digital-pet-core/src/adapters/sqlite/sqlite-digital-pet-write-store.ts
var createSqliteDigitalPetWriteStore = (options) => {
  const { databasePath, executor, close } = options;
  const appliedMigrations = runMigrations(executor);
  const store = {
    ...createSqlitePartnerTeamStore(executor),
    databasePath,
    async close() {
      await close();
    },
    getAppliedMigrations() {
      return appliedMigrations;
    },
    getTrainerState() {
      const trainerState = executor.get("SELECT total_tokens FROM trainer_state WHERE trainer_id = 1");
      if (trainerState === null) throw new Error(IntlModule2.translate("errors.missingTrainerState"));
      return { totalTokens: trainerState.total_tokens };
    },
    getActivePartner() {
      const activePartner = executor.get(ACTIVE_PARTNER_SELECT);
      return activePartner === null ? null : toPartner(activePartner);
    },
    listPartners() {
      return executor.all(PARTNERS_SELECT).map(toPartner);
    },
    getPartnerByGeneration(generation) {
      const partner = executor.get(PARTNER_BY_GENERATION_SELECT, [generation]);
      return partner === null ? null : toPartner(partner);
    },
    freeze() {
      return executor.transaction(() => {
        const controlState = executor.get(
          "SELECT frozen, cheat_node_id FROM vpet_control_state WHERE control_id = 1"
        );
        if (controlState === null) throw new Error(IntlModule2.translate("errors.missingControlState"));
        if (controlState.frozen === 1) return { kind: "already_frozen" };
        executor.run("UPDATE vpet_control_state SET frozen = 1 WHERE control_id = 1");
        return { kind: "frozen" };
      });
    },
    unfreeze() {
      return executor.transaction(() => {
        const controlState = executor.get(
          "SELECT frozen, cheat_node_id FROM vpet_control_state WHERE control_id = 1"
        );
        if (controlState === null) throw new Error(IntlModule2.translate("errors.missingControlState"));
        if (controlState.frozen === 0) return { kind: "already_unfrozen" };
        executor.run("UPDATE vpet_control_state SET frozen = 0 WHERE control_id = 1");
        return { kind: "unfrozen" };
      });
    },
    setCheatNode(cheatNodeId) {
      return executor.transaction(() => {
        const controlState = executor.get(
          "SELECT frozen, cheat_node_id FROM vpet_control_state WHERE control_id = 1"
        );
        if (controlState === null) throw new Error(IntlModule2.translate("errors.missingControlState"));
        if (controlState.cheat_node_id === cheatNodeId) return { kind: "already_set", cheatNodeId };
        executor.run("UPDATE vpet_control_state SET cheat_node_id = ? WHERE control_id = 1", [cheatNodeId]);
        return { kind: "set", cheatNodeId };
      });
    },
    spawnPartner(input) {
      return executor.transaction(() => {
        return spawnSqlitePartner(executor, input);
      });
    },
    listPartnerEvents(partnerId) {
      return executor.all(PARTNER_EVENTS_SELECT, [partnerId]).map(toPersistedPartnerEvent);
    },
    applyUsageReceipt(metadata, evolve) {
      return executor.transaction(() => {
        const canonicalReceipt = executor.get(
          "SELECT receipt_key FROM usage_receipts WHERE receipt_key = ? LIMIT 1",
          [metadata.receiptKey]
        );
        const controlReceipt = executor.get(
          "SELECT receipt_key FROM vpet_control_receipts WHERE receipt_key = ? LIMIT 1",
          [metadata.receiptKey]
        );
        if (canonicalReceipt !== null || controlReceipt !== null) return { kind: "duplicate" };
        const controlState = executor.get(
          "SELECT frozen, cheat_node_id FROM vpet_control_state WHERE control_id = 1"
        );
        if (controlState === null) throw new Error(IntlModule2.translate("errors.missingControlState"));
        if (controlState.cheat_node_id !== null) {
          executor.run(
            "INSERT INTO vpet_control_receipts (receipt_key, mode, token_delta, cost, created_at) VALUES (?, 'cheat', ?, ?, ?)",
            [metadata.receiptKey, metadata.tokenDelta, metadata.cost ?? null, metadata.createdAt]
          );
          return { kind: "applied" };
        }
        if (controlState.frozen === 1) {
          executor.run(
            "INSERT INTO vpet_control_receipts (receipt_key, mode, token_delta, cost, created_at) VALUES (?, 'frozen', ?, ?, ?)",
            [metadata.receiptKey, metadata.tokenDelta, metadata.cost ?? null, metadata.createdAt]
          );
          executor.run("UPDATE trainer_state SET total_tokens = total_tokens + ? WHERE trainer_id = 1", [
            metadata.tokenDelta
          ]);
          return { kind: "applied" };
        }
        const activePartnerRow = executor.get(ACTIVE_PARTNER_SELECT);
        if (activePartnerRow === null) return { kind: "no_active_partner" };
        const activePartner = toPartner(activePartnerRow);
        const nextState = evolve(activePartner, readEvolutionCare(executor, activePartner.partnerId, Date.now()));
        executor.run(
          "UPDATE partners SET current_node_id = ?, gauge = ?, is_terminal = ?, pending_evolution_target_id = ?, battle_opponent_node_id = ? WHERE partner_id = ?",
          [
            nextState.currentNodeId,
            nextState.gauge,
            nextState.isTerminal,
            nextState.pendingEvolutionTargetId,
            nextState.battleOpponentNodeId,
            activePartner.partnerId
          ]
        );
        syncCombatProgress(executor, activePartner.partnerId, nextState);
        executor.run(
          "INSERT INTO partner_events (event_id, partner_id, kind, current_node_id, gauge, is_terminal, token_delta, receipt_key, created_at) VALUES (?, ?, 'usage_applied', ?, ?, ?, ?, ?, ?)",
          [
            metadata.eventId,
            activePartner.partnerId,
            nextState.currentNodeId,
            nextState.gauge,
            nextState.isTerminal,
            metadata.tokenDelta,
            metadata.receiptKey,
            metadata.createdAt
          ]
        );
        executor.run(
          "INSERT INTO usage_receipts (receipt_key, partner_id, event_id, token_delta, cost, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            metadata.receiptKey,
            activePartner.partnerId,
            metadata.eventId,
            metadata.tokenDelta,
            metadata.cost ?? null,
            metadata.createdAt
          ]
        );
        executor.run("UPDATE trainer_state SET total_tokens = total_tokens + ? WHERE trainer_id = 1", [
          metadata.tokenDelta
        ]);
        return { kind: "applied" };
      });
    },
    listUsageReceipts() {
      return executor.all(USAGE_RECEIPTS_SELECT).map(toUsageReceiptRecord);
    },
    ...createSqliteEvolutionBattleStore(executor)
  };
  return store;
};

// src/adapters/sqlite/bun-sqlite-driver.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
var createExecutor = (database) => ({
  run(sql, params = []) {
    database.run(sql, Array.from(params));
  },
  get(sql, params = []) {
    return database.query(sql).get(...Array.from(params)) ?? null;
  },
  all(sql, params = []) {
    return database.query(sql).all(...Array.from(params));
  },
  transaction(operation) {
    return database.transaction(operation).immediate();
  }
});
var configureWriter = (database) => {
  database.run("PRAGMA busy_timeout = 5000");
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
};
var openWritableDatabase = (databasePath) => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath, { create: true, readwrite: true });
  configureWriter(database);
  return database;
};

// src/adapters/sqlite/sqlite-sidebar-snapshot-reader.ts
var TRAINER_STATE_SELECT = "SELECT total_tokens FROM trainer_state WHERE trainer_id = 1";
var CONTROL_STATE_SELECT = "SELECT frozen, cheat_node_id FROM vpet_control_state WHERE control_id = 1";
var readSidebarSnapshotFromExecutor = (executor) => {
  const trainer = executor.get(TRAINER_STATE_SELECT);
  const control = executor.get(CONTROL_STATE_SELECT);
  if (control?.cheat_node_id !== null && control?.cheat_node_id !== void 0) {
    return {
      currentNodeId: control.cheat_node_id,
      gauge: 0,
      isTerminal: true,
      frozen: false,
      isSetOverride: true,
      trainerTotalTokens: trainer?.total_tokens ?? 0,
      pendingEvolutionTargetId: null,
      battleOpponentNodeId: null
    };
  }
  const partnerRow = readSqliteActivePartner(executor);
  if (partnerRow === null) return null;
  const partner = toPartner(partnerRow);
  return {
    currentNodeId: partner.currentNodeId,
    gauge: partner.gauge,
    isTerminal: partner.isTerminal,
    frozen: control?.frozen === 1,
    isSetOverride: false,
    trainerTotalTokens: trainer?.total_tokens ?? 0,
    pendingEvolutionTargetId: partner.pendingEvolutionTargetId,
    battleOpponentNodeId: partner.battleOpponentNodeId
  };
};

// src/adapters/sqlite/sqlite-digital-pet-write-store.ts
var createSqliteDigitalPetRepository = async (options = {}) => {
  const databasePath = options.databasePath ?? resolveHostDatabasePath(options);
  const database = openWritableDatabase(databasePath);
  const executor = createExecutor(database);
  const writeStore = createSqliteDigitalPetWriteStore({
    databasePath,
    executor,
    close: () => {
      database.close();
    }
  });
  return {
    ...writeStore,
    getSidebarSnapshot: () => readSidebarSnapshotFromExecutor(executor)
  };
};

// src/config/global-digital-pet-settings.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// ../digital-pet-core/src/config/theme.ts
var VISUAL_THEME_IDS = Object.freeze(["lcd", "color"]);
var DEFAULT_VISUAL_THEME = "lcd";
var isVisualThemeId = (value) => value === "lcd" || value === "color";
var normalizeVisualTheme = (value) => isVisualThemeId(value) ? value : DEFAULT_VISUAL_THEME;

// ../digital-pet-core/src/config/defaults.ts
var EN_STAGE_LABELS = Object.freeze({
  egg: catalogs.en["stages.egg"],
  babyI: catalogs.en["stages.babyI"],
  babyII: catalogs.en["stages.babyII"],
  child: catalogs.en["stages.child"],
  adult: catalogs.en["stages.adult"],
  perfect: catalogs.en["stages.perfect"],
  ultimate: catalogs.en["stages.ultimate"],
  superUltimate: catalogs.en["stages.superUltimate"]
});
var JP_STAGE_LABELS = Object.freeze({
  egg: catalogs.en["legacyStages.egg"],
  babyI: catalogs.en["legacyStages.babyI"],
  babyII: catalogs.en["legacyStages.babyII"],
  child: catalogs.en["legacyStages.child"],
  adult: catalogs.en["legacyStages.adult"],
  perfect: catalogs.en["legacyStages.perfect"],
  ultimate: catalogs.en["legacyStages.ultimate"],
  superUltimate: catalogs.en["legacyStages.superUltimate"]
});
var DIGITAL_PET_STAGE_LABELS = Object.freeze({
  en: EN_STAGE_LABELS,
  jp: JP_STAGE_LABELS
});
var DEFAULT_STAGE_THRESHOLDS = Object.freeze({
  egg: 5e6,
  babyI: 1e7,
  babyII: 2e7,
  child: 4e7,
  adult: 75e6,
  perfect: 125e6,
  ultimate: 2e8,
  superUltimate: 3e8
});
var DEFAULT_DIGITAL_PET_SETTINGS = Object.freeze({
  theme: DEFAULT_VISUAL_THEME,
  language: "jp",
  notifications: true,
  stageLabels: DIGITAL_PET_STAGE_LABELS,
  stageThresholds: DEFAULT_STAGE_THRESHOLDS
});

// ../digital-pet-core/src/config/normalize.ts
var isRecord2 = (value) => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};
var isLanguage = (value) => value === "en" || value === "jp";
var isBoolean = (value) => typeof value === "boolean";
var isThreshold = (value) => {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
};
var read = (input, key) => {
  try {
    return input[key];
  } catch {
    return void 0;
  }
};
var normalizeThreshold = (input, key) => {
  const value = read(input, key);
  return isThreshold(value) ? value : DEFAULT_STAGE_THRESHOLDS[key];
};
var normalizeDigitalPetSettings = (input) => {
  try {
    if (!isRecord2(input)) return DEFAULT_DIGITAL_PET_SETTINGS;
    const thresholdInput = read(input, "stageThresholds");
    const thresholds = isRecord2(thresholdInput) ? thresholdInput : {};
    const stageThresholds = Object.freeze({
      egg: normalizeThreshold(thresholds, "egg"),
      babyI: normalizeThreshold(thresholds, "babyI"),
      babyII: normalizeThreshold(thresholds, "babyII"),
      child: normalizeThreshold(thresholds, "child"),
      adult: normalizeThreshold(thresholds, "adult"),
      perfect: normalizeThreshold(thresholds, "perfect"),
      ultimate: normalizeThreshold(thresholds, "ultimate"),
      superUltimate: normalizeThreshold(thresholds, "superUltimate")
    });
    const language = read(input, "language");
    const notifications = read(input, "notifications");
    return Object.freeze({
      theme: normalizeVisualTheme(read(input, "theme")),
      language: isLanguage(language) ? language : DEFAULT_DIGITAL_PET_SETTINGS.language,
      notifications: isBoolean(notifications) ? notifications : DEFAULT_DIGITAL_PET_SETTINGS.notifications,
      stageLabels: DEFAULT_DIGITAL_PET_SETTINGS.stageLabels,
      stageThresholds
    });
  } catch {
    return DEFAULT_DIGITAL_PET_SETTINGS;
  }
};

// src/config/global-digital-pet-settings.ts
var resolveGlobalDigitalPetConfigPath = (options = {}) => {
  const pathApi = options.pathApi ?? { join: join2 };
  const env = options.env ?? process.env;
  const home = options.home ?? homedir2();
  const configDirectory = (options.platform ?? process.platform) === "win32" ? pathApi.join(env["APPDATA"] ?? pathApi.join(home, "AppData", "Roaming")) : pathApi.join(home, ".config");
  const currentPath = pathApi.join(configDirectory, "opencode-digital-pet.json");
  const legacyPath = pathApi.join(configDirectory, "opencode-vpet.json");
  if (!existsSync2(currentPath) && existsSync2(legacyPath)) return legacyPath;
  return currentPath;
};
var loadGlobalDigitalPetSettings = async (options = {}) => {
  try {
    return normalizeDigitalPetSettings(JSON.parse(await readFile(resolveGlobalDigitalPetConfigPath(options), "utf8")));
  } catch {
    return DEFAULT_DIGITAL_PET_SETTINGS;
  }
};

// src/config/ui-language.ts
var initializeUiLanguage = () => {
  IntlModule.setLocale(
    resolveLocale(process.env["DIGITAL_PET_LANGUAGE"], [
      process.env["LC_ALL"] ?? process.env["LC_MESSAGES"] ?? process.env["LANG"] ?? "en"
    ])
  );
};

// src/index.ts
var getStringOption = (options, name) => {
  const value = options?.[name];
  return typeof value === "string" ? value : void 0;
};
var toEvolutionThresholds = (settings) => Object.freeze({
  0: settings.stageThresholds.egg,
  1: settings.stageThresholds.babyI,
  2: settings.stageThresholds.babyII,
  3: settings.stageThresholds.child,
  4: settings.stageThresholds.adult,
  5: settings.stageThresholds.perfect,
  6: settings.stageThresholds.ultimate,
  7: settings.stageThresholds.superUltimate
});
var plugin = async (input, options) => {
  initializeUiLanguage();
  const appDataRoot = getStringOption(options, "appDataRoot");
  const databasePath = getStringOption(options, "databasePath");
  const settings = await loadGlobalDigitalPetSettings();
  const repository = await createSqliteDigitalPetRepository({
    ...appDataRoot === void 0 ? {} : { appDataRoot },
    ...databasePath === void 0 ? {} : { databasePath }
  });
  return createServerHooks({
    repository,
    resource: repository,
    evolutionThresholds: toEvolutionThresholds(settings),
    fetchMessages: createSessionMessagesFetcher(input.client),
    language: settings.language,
    notificationsEnabled: settings.notifications,
    notify: createBestEffortDigitalPetToastNotifier(
      async (payload) => (await input.client.tui.showToast({ body: payload })).data ?? false
    )
  });
};
var entryPlugin = {
  id: "opencode-digital-pet",
  server: plugin
};
var index_default = entryPlugin;
export {
  DIGIMON_DATA,
  createCommandConfig,
  index_default as default,
  plugin
};
