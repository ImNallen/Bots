import { DomUtils, parseDocument } from "htmlparser2";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown.tsx";

const render = (text: string, streaming = false) => renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);
const tags = (html: string, name: string) => DomUtils.getElementsByTagName(name, parseDocument(html).children);
const texts = (html: string, name: string) => tags(html, name).map(DomUtils.textContent);
const links = (html: string) => tags(html, "a").map((link) => link.attribs);
const safeLink = (href: string) => expect.objectContaining({ href, target: "_blank", rel: "noopener noreferrer" });

describe("Markdown", () => {
  describe("raw HTML", () => {
    it.each([
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<iframe src=https://evil.example></iframe>",
      'Hi <b onclick="alert(1)">there</b>',
      "<a href=https://evil.example>click</a>",
      "<style>body{display:none}</style>",
      '<svg><a href="javascript:alert(1)">click</a></svg>',
    ])("never turns %s into active HTML", (source) => {
      expect(render(source)).not.toMatch(/<(script|img|iframe|b|a|style|svg)[\s>]|onclick=|onerror=/);
    });

    it("keeps HTML visible inside inline and fenced code", () => {
      const source = '<img src="https://evil.example/a" onerror="alert(1)">';
      const html = render(`\`${source}\`\n\n\`\`\`html\n${source}\n\`\`\``);
      expect(texts(html, "code").map((text) => text.trim())).toEqual([source, source]);
      expect(tags(html, "img")).toHaveLength(0);
    });
  });

  describe("images", () => {
    it("never loads an image, and shows its alt text and URL as a link", () => {
      const html = render("![The chart](https://evil.example/leak.png?secret=1)");
      expect(tags(html, "img")).toHaveLength(0);
      expect(links(html)).toEqual([safeLink("https://evil.example/leak.png?secret=1")]);
      expect(texts(html, "a")).toEqual(["The chart https://evil.example/leak.png?secret=1"]);
    });

    it("does not load a reference-style image or one with no alt text", () => {
      expect(tags(render("![a][r]\n\n[r]: https://evil.example/a.png"), "img")).toHaveLength(0);
      const html = render("![](https://evil.example/b.png)");
      expect(tags(html, "img")).toHaveLength(0);
      expect(texts(html, "a")).toEqual(["https://evil.example/b.png"]);
    });

    it.each(["javascript:alert(1)", "data:image/png;base64,AAAA", "/auth/token", "file:///etc/passwd"])(
      "shows only the alt text for an image at %s",
      (url) => {
        const html = render(`![Picture](${url})`);
        expect(tags(html, "img")).toHaveLength(0);
        expect(links(html)).toEqual([]);
        expect(html).not.toContain(url);
        expect(DomUtils.textContent(parseDocument(html)).trim()).toBe("Picture");
      },
    );

    it("does not nest a link inside the link around an image", () => {
      const html = render("[![Badge](https://evil.example/b.png)](https://example.com/)");
      expect(tags(html, "img")).toHaveLength(0);
      expect(links(html)).toEqual([safeLink("https://example.com/")]);
      expect(texts(html, "a")).toEqual(["Badge https://evil.example/b.png"]);
    });

    it("escapes decoded image labels and URLs without creating attributes or elements", () => {
      const html = render('![&lt;img src=x onerror=alert(1)&gt;](https://e.example/?x=&quot;onmouseover=&quot;x "title > here")');
      expect(tags(html, "img")).toHaveLength(0);
      expect(links(html)).toEqual([safeLink('https://e.example/?x=%22onmouseover=%22x')]);
      expect(texts(html, "a")[0]).toContain("<img src=x onerror=alert(1)>");
      expect(tags(html, "a")[0]?.attribs).not.toHaveProperty("onmouseover");
    });
  });

  describe("links", () => {
    it.each([
      ["[a](https://example.com/x)", "https://example.com/x"],
      ["[a](http://example.com/x)", "http://example.com/x"],
      ["[a](mailto:me@example.com)", "mailto:me@example.com"],
      ["<https://example.com/x>", "https://example.com/x"],
      ["see www.example.com now", "http://www.example.com"],
      ["[a](HTTPS://example.com/x)", "HTTPS://example.com/x"],
      ['[**a**](https://example.com/?a=&quot;b&quot;&c=1 "title > here")', 'https://example.com/?a=%22b%22&c=1'],
    ])("makes %s a safe link in a new tab", (source, href) => {
      expect(links(render(source))).toEqual([safeLink(href)]);
    });

    it.each([
      "[a](javascript:alert(1))",
      "[a](JaVaScRiPt:alert(1))",
      "[a](java&#10;script:alert(1))",
      "[a](java&#9;script:alert(1))",
      "[a](&#x6A;avascript:alert(1))",
      "<javascript:alert(1)>",
      "[a](data:text/html,<script>alert(1)</script>)",
      "[a](vbscript:msgbox(1))",
      "[a](file:///etc/passwd)",
      "[a](/auth/token)",
      "[a](//evil.example/x)",
      "[a](#top)",
      "[a][r]\n\n[r]: javascript:alert(1)",
      "[a](ftp://example.com)",
      "[a](tel:1234)",
    ])("gives %s no working link", (source) => {
      expect(links(render(source))).toEqual([]);
      expect(render(source)).not.toContain("href=");
    });
  });

  describe("formatting", () => {
    it("renders bold, lists, nested lists, inline code, headings, and blockquotes", () => {
      const html = render("# Title\n\n**bold** and `code`\n\n- one\n  - two\n\n1. first\n\n> quoted");
      expect(texts(html, "h1")).toEqual(["Title"]);
      expect(texts(html, "strong")).toEqual(["bold"]);
      expect(texts(html, "code")).toEqual(["code"]);
      const [list] = tags(html, "ul");
      expect(list && DomUtils.getElementsByTagName("ul", list.children)).toHaveLength(1);
      expect(texts(html, "ol").map((text) => text.trim())).toEqual(["first"]);
      expect(texts(html, "blockquote").map((text) => text.trim())).toEqual(["quoted"]);
    });

    it("highlights code without line numbers and wraps tables for scrolling", () => {
      const html = render("```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
      expect(texts(html, "pre")).toEqual(["const a = 1;\n"]);
      expect(tags(html, "span").some((node) => node.attribs.style?.includes("light-dark("))).toBe(true);
      expect(html).not.toContain('data-markdown="line-numbers"');
      const [table] = tags(html, "table");
      expect(table?.parent && "attribs" in table.parent && table.parent.attribs.class).toBe("md-scroll");
      expect(texts(html, "td")).toEqual(["1", "2"]);
    });

    it("keeps unsupported languages as plain code", () => {
      const source = '<tag> & "quoted"';
      const html = render(`\`\`\`unsupported-language\n${source}\n\`\`\``);
      expect(texts(html, "pre")).toEqual([`${source}\n`]);
      expect(html).not.toContain("light-dark(");
      expect(tags(html, "tag")).toHaveLength(0);
    });
  });

  describe("text that is still arriving", () => {
    it("keeps an unfinished code fence inside a code block", () => {
      const html = render("Look:\n\n```sh\necho hi\nand then", true);
      expect(texts(html, "p")).toEqual(["Look:"]);
      expect(texts(html, "pre")[0]?.trimEnd()).toBe("echo hi\nand then");
    });

    it("repairs unfinished emphasis only while streaming", () => {
      expect(texts(render("**bol", true), "strong")).toEqual(["bol"]);
      expect(texts(render("**bol"), "strong")).toEqual([]);
      expect(texts(render("**bol"), "p")).toEqual(["**bol"]);
      expect(texts(render("**bold**"), "strong")).toEqual(["bold"]);
    });

    it.each(["**bol", "[link](http", "| a | b |\n|--", "- ", "![pic](https://evil.example/a"])(
      "renders the partial %j without an image or an error",
      (source) => {
        expect(tags(render(source, true), "img")).toHaveLength(0);
      },
    );
  });

  it("renders plain code if the highlighter cannot load", async () => {
    vi.resetModules();
    vi.doMock("@pierre/words/highlights", () => { throw new Error("Highlighter unavailable"); });
    try {
      const { Markdown: PlainMarkdown } = await import("./Markdown.tsx");
      const html = renderToStaticMarkup(<PlainMarkdown text={'```js\nconst a = "<safe>";\n```'} />);
      expect(texts(html, "pre")).toEqual(['const a = "<safe>";\n']);
      expect(tags(html, "safe")).toHaveLength(0);
      expect(html).not.toContain("light-dark(");
    } finally {
      vi.doUnmock("@pierre/words/highlights");
      vi.resetModules();
    }
  });
});
