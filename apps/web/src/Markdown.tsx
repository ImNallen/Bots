import pierreDark from "@pierre/highlights/themes/pierre-dark";
import pierreLight from "@pierre/highlights/themes/pierre-light";
import { escapeHtml, type Components, type PluginConfig } from "@pierre/words/html";
import { Markdown as Words } from "@pierre/words/react";
import { DomUtils, parseDocument } from "htmlparser2";
import { memo } from "react";

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const LINK_ATTRIBUTES = 'target="_blank" rel="noopener noreferrer"';

// The URL parser handles disguised protocols and rejects relative URLs into this app.
function safeUrl(url: string): string | undefined {
  try {
    return LINK_PROTOCOLS.has(new URL(url).protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

function imageLabel({ src = "", alt = "" }: { src?: string; alt?: string }): string {
  const url = safeUrl(src);
  return url === undefined
    ? escapeHtml(alt || "Image")
    : `${alt ? `${escapeHtml(alt)} ` : ""}<span class="md-image-url">${escapeHtml(url)}</span>`;
}

function linkHtml(html: string): string {
  const document = parseDocument(html);
  const [link] = DomUtils.getElementsByTagName("a", document.children);
  if (link === undefined) return html;
  // Images inside a link become text before the standalone image hook runs.
  for (const image of DomUtils.getElementsByTagName("img", link.children)) {
    image.children = parseDocument(imageLabel(image.attribs)).children;
    image.name = "span";
    image.attribs = { class: "md-image" };
  }
  const label = DomUtils.getInnerHTML(link);
  const url = safeUrl(link.attribs.href ?? "");
  return url === undefined ? `<span>${label}</span>` : `<a href="${escapeHtml(url)}" ${LINK_ATTRIBUTES}>${label}</a>`;
}

function imageHtml(html: string): string {
  const [image] = DomUtils.getElementsByTagName("img", parseDocument(html).children);
  if (image === undefined) return "";
  const label = imageLabel(image.attribs);
  const url = safeUrl(image.attribs.src ?? "");
  // Loading an image would send data to a bot-chosen URL without the owner's click.
  return url === undefined
    ? `<span class="md-image">${label}</span>`
    : `<a class="md-image" href="${escapeHtml(url)}" ${LINK_ATTRIBUTES}>${label}</a>`;
}

const COMPONENTS: Components = {
  a: linkHtml,
  img: imageHtml,
  table: (html) => `<div class="md-scroll">${html}</div>`,
};

// A failed highlighter download must not hide the message. Words falls back to plain code.
const PLUGINS: PluginConfig = await import("@pierre/words/highlights").then(({ createHighlightsPlugin }) => ({
  code: createHighlightsPlugin({ themes: { light: pierreLight, dark: pierreDark }, defaultColor: "light-dark()" }),
})).catch(() => ({}));

// Keep invalid images until the image hook can show their alt text without a URL.
const urlTransform = (url: string, key: "href" | "src") => safeUrl(url) ?? (key === "src" ? "" : undefined);

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <Words
      className="md"
      isAnimating={streaming}
      components={COMPONENTS}
      plugins={PLUGINS}
      controls={false}
      lineNumbers={false}
      urlTransform={urlTransform}
    >
      {text}
    </Words>
  );
});
