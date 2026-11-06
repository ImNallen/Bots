import { createContext, memo, useContext, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const REMARK_PLUGINS = [remarkGfm];

// Bot output is untrusted. The URL parser reads a link as the browser will, so tabs, line breaks, and letter case cannot
// disguise a protocol, and a relative URL fails here rather than pointing into this app.
function safeUrl(url: string): string | undefined {
  try {
    return LINK_PROTOCOLS.has(new URL(url).protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

const InsideLink = createContext(false);

function MarkdownLink({ href, children }: ComponentProps<"a">) {
  if (href === undefined) {
    return <span>{children}</span>;
  }
  return (
    <InsideLink.Provider value={true}>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    </InsideLink.Provider>
  );
}

// Loading an image would send data to any URL a bot picks, with no click, so an image only ever shows as text.
function MarkdownImage({ src, alt }: ComponentProps<"img">) {
  const insideLink = useContext(InsideLink);
  if (typeof src !== "string") {
    return <span className="md-image">{alt || "Image"}</span>;
  }
  const label = (
    <>
      {alt && <span>{alt} </span>}
      <span className="md-image-url">{src}</span>
    </>
  );
  // A link cannot hold another link.
  return insideLink ? (
    <span className="md-image">{label}</span>
  ) : (
    <a className="md-image" href={src} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

function MarkdownTable({ children }: ComponentProps<"table">) {
  return (
    <div className="md-scroll">
      <table>{children}</table>
    </div>
  );
}

const COMPONENTS: Components = { a: MarkdownLink, img: MarkdownImage, table: MarkdownTable };

// Memoized, because each streamed word renders the whole conversation again, and only the newest message has changed.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} urlTransform={safeUrl}>
      {text}
    </ReactMarkdown>
  );
});
