// 1.3 全部自动同意 (#727 review 1): a persistent indicator for as long as the conversation is in auto-approve.
// One slim line (Nolan): amber shield + 全部自动同意已开启 on the left, the way back to 每次询问 on the right, nothing in
// between. What the mode does for this Agent (Codex: sandbox off, Claude: skips all permission checks …) is the left
// label's tooltip and its accessible description; the permission menu shows the same wording. Not dismissible.
import { useId } from "react";
import { Icon } from "./Icons";
import { autoApproveBannerDesc } from "../i18n/modes.js";
import { t } from "../i18n/index.js";

export function AutoApproveBanner({ providerId, onBack }: { providerId?: string; onBack?: () => void }) {
  const desc = autoApproveBannerDesc(providerId);
  const descId = useId();
  return (
    <div className="cp-auto-on" role="status" aria-live="polite" data-testid="auto-on">
      <span className="cp-auto-t" title={desc} aria-describedby={descId} tabIndex={0}>
        <span className="cp-auto-ic" aria-hidden><Icon name="shieldCheck" size={13} /></span>
        <b>{t("composer.autoOn.title")}</b>
      </span>
      <span id={descId} className="sr-only">{desc}</span>
      {onBack && (
        <button type="button" className="cp-auto-back" onClick={onBack}>{t("composer.autoOn.back")}</button>
      )}
    </div>
  );
}
