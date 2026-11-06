// Markdown → sanitized HTML (marked + DOMPurify + highlight.js), kept apart from the React component so it can be
// bundled and tested on its own in a real browser.
// Fenced code is built as the final .cb / header / numbered / highlighted HTML inside marked's renderer (1.3.7), so
// React paints the stable height in one commit. The model's markdown is sanitized with the html profile only (as in
// 1.3.6: an <svg> the model writes is dropped); the code block icons are placeholders until after sanitize.
import { marked, Renderer, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { t } from "../i18n/index.js";
import { buildCodeBlockHtml, isClosedFence, restoreCodeBlockIcons } from "./codeBlock";

marked.setOptions({ gfm: true, breaks: true });

const purify = (html: string) =>
  DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "aria-pressed", "aria-label", "aria-hidden", "data-i"],
  });

export type RenderedMarkdown = { html: string; raws: string[] };

export type RenderMarkdownOptions = {
  /** indexes of the code blocks (in this text) drawn soft-wrapped */
  wrapped?: ReadonlySet<number>;
  /** the message is still streaming: an unlabelled fence that isn't closed yet stays plain "text" (no
   *  highlightAuto flip-flop while it grows); closed unlabelled blocks are auto-detected (cached) */
  streaming?: boolean;
};

export function renderMarkdown(text: string, opts: RenderMarkdownOptions = {}): RenderedMarkdown {
  const { wrapped, streaming = false } = opts;
  const raws: string[] = [];
  const renderer = new Renderer();
  renderer.code = ({ text: code, lang, raw, codeBlockStyle }: Tokens.Code) => {
    const index = raws.length;
    raws.push(code);
    const autoDetect = !streaming || isClosedFence(raw, codeBlockStyle);
    return buildCodeBlockHtml(code, lang, index, {
      wrap: t("timeline.codeWrap"),
      copy: t("common.copy"),
    }, wrapped?.has(index) ?? false, autoDetect);
  };
  const dirty = marked.parse(text, { async: false, renderer }) as string;
  return { html: restoreCodeBlockIcons(purify(dirty)), raws };
}
