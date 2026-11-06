import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);
const LINK_ATTRIBUTES = 'target="_blank" rel="noopener noreferrer"';

describe("Markdown", () => {
  describe("raw HTML", () => {
    it.each([
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<iframe src=https://evil.example></iframe>",
      'Hi <b onclick="alert(1)">there</b>',
      "<a href=https://evil.example>click</a>",
      "<style>body{display:none}</style>",
    ])("shows %s as text", (source) => {
      const html = render(source);
      expect(html).toContain("&lt;");
      expect(html).not.toMatch(/<(script|img|iframe|b|a|style)[\s>]/);
    });
  });

  describe("images", () => {
    it("never loads an image, and shows its alt text and URL as a link", () => {
      const html = render("![The chart](https://evil.example/leak.png?secret=1)");
      expect(html).not.toContain("<img");
      expect(html).toContain('href="https://evil.example/leak.png?secret=1"');
      expect(html).toContain(LINK_ATTRIBUTES);
      expect(html).toContain("The chart");
      expect(html).toContain(">https://evil.example/leak.png?secret=1<");
    });

    it("does not load a reference-style image or one with no alt text", () => {
      expect(render("![a][r]\n\n[r]: https://evil.example/a.png")).not.toContain("<img");
      const html = render("![](https://evil.example/b.png)");
      expect(html).not.toContain("<img");
      expect(html).toContain(">https://evil.example/b.png<");
    });

    it.each(["javascript:alert(1)", "data:image/png;base64,AAAA", "/auth/token", "file:///etc/passwd"])(
      "shows only the alt text for an image at %s",
      (url) => {
        const html = render(`![Picture](${url})`);
        expect(html).not.toContain("<img");
        expect(html).not.toContain("<a ");
        expect(html).not.toContain(url);
        expect(html).toContain("Picture");
      },
    );

    it("does not nest a link inside the link around an image", () => {
      const html = render("[![Badge](https://evil.example/b.png)](https://example.com/)");
      expect(html).not.toContain("<img");
      expect(html.match(/<a /g)).toHaveLength(1);
      expect(html).toContain('href="https://example.com/"');
      expect(html).toContain("https://evil.example/b.png");
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
    ])("makes %s a safe link in a new tab", (source, href) => {
      const html = render(source);
      expect(html).toContain(`<a href="${href}" ${LINK_ATTRIBUTES}>`);
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
    ])("gives %s no working link", (source) => {
      expect(render(source)).not.toMatch(/<a[\s>]|href=/);
    });
  });

  describe("formatting", () => {
    it("renders bold, lists, nested lists, inline code, headings, and blockquotes", () => {
      const html = render("# Title\n\n**bold** and `code`\n\n- one\n  - two\n\n1. first\n\n> quoted");
      expect(html).toContain("<h1>Title</h1>");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<code>code</code>");
      expect(html).toMatch(/<ul>\s*<li>one\s*<ul>\s*<li>two<\/li>\s*<\/ul>\s*<\/li>\s*<\/ul>/);
      expect(html).toContain("<ol>");
      expect(html).toMatch(/<blockquote>\s*<p>quoted<\/p>\s*<\/blockquote>/);
    });

    it("renders a code block, and a table inside its own scrolling container", () => {
      const html = render("```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
      expect(html).toMatch(/<pre><code[^>]*>const a = 1;\s*<\/code><\/pre>/);
      expect(html).toMatch(/<div class="md-scroll"><table>.*<\/table><\/div>/s);
      expect(html).toContain("<td>1</td>");
    });
  });

  describe("text that is still arriving", () => {
    it("keeps an unfinished code fence inside a code block", () => {
      const html = render("Look:\n\n```sh\necho hi\nand then");
      expect(html).toContain("<p>Look:</p>");
      expect(html).toMatch(/<pre><code[^>]*>echo hi\nand then\s*<\/code><\/pre>/);
    });

    it.each(["**bol", "[link](http", "| a | b |\n|--", "- ", "![pic](https://evil.example/a"])(
      "renders the partial %j without an image or an error",
      (source) => {
        expect(render(source)).not.toContain("<img");
      },
    );
  });
});
