// 1.3 全部自动同意 (#727 review 1): a persistent indicator for as long as the conversation is in auto-approve.
// Not dismissible (1.2's red 全部放行 banner was always there too); it says what the mode does for this Agent
// (Codex: sandbox off, Claude: skips all permission checks …) and offers the way back to 每次询问.
import { Icon } from "./Icons";
import { autoModeDesc } from "../i18n/modes.js";
import { t } from "../i18n/index.js";

export function AutoApproveBanner({ providerId, onBack }: { providerId?: string; onBack?: () => void }) {
  const desc = autoModeDesc(providerId);
  return (
    <div className="cp-auto-on" role="status" aria-live="polite" data-testid="auto-on" title={`${desc}\n${t("composer.autoOn.keeps")}`}>
      <span className="cp-auto-ic"><Icon name="shieldCheck" size={14} /></span>
      <span className="cp-auto-t">
        <b>{t("composer.autoOn.title")}</b>
        <span className="cp-auto-d">{desc}</span>
      </span>
      {onBack && (
        <button type="button" className="cp-auto-back" onClick={onBack}>{t("composer.autoOn.back")}</button>
      )}
    </div>
  );
}
