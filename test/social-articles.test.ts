import { describe, expect, it } from "vitest";
import { bodyHtmlToMarkdown, buildPasteKit } from "../src/tools/social-articles.js";

describe("bodyHtmlToMarkdown", () => {
  it("converts headings, lists, links and image markers", () => {
    const html =
      '<h2>Why</h2><p>Hello <strong>bold</strong> and <em>it</em> <a href="https://x.com/a">link</a>.</p>' +
      '<p data-image-marker="1"></p><ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol><blockquote><p>q</p></blockquote>';
    const md = bodyHtmlToMarkdown(html);
    expect(md).toContain("## Why");
    expect(md).toContain("Hello **bold** and *it* [link](https://x.com/a).");
    expect(md).toContain("[Image 1]");
    expect(md).toContain("- one\n- two");
    expect(md).toContain("1. a\n2. b");
    expect(md).toContain("> q");
    expect(md).not.toMatch(/<[a-z]/);
  });
});

describe("buildPasteKit", () => {
  it("returns title, markdown body, images, teaser and platform editor", () => {
    const kit = buildPasteKit({
      platform: "x",
      title: "T",
      subtitle: null,
      bodyHtml: '<p>hi</p><p data-image-marker="2"></p>',
      coverImage: { url: "https://c/img.png", alt: "cover" },
      inlineImages: [{ marker: 2, url: "https://c/2.png", alt: "two", caption: "cap" }],
      teaserPost: "go read",
    });
    expect(kit.bodyMarkdown).toBe("hi\n\n[Image 2]");
    expect(kit.coverImage?.url).toBe("https://c/img.png");
    expect(kit.inlineImages[0]).toEqual({ marker: 2, url: "https://c/2.png", alt: "two", caption: "cap" });
    expect(kit.editorUrl).toContain("x.com");
    expect(kit.teaserPost).toBe("go read");
  });

  it("lists empty slots as no image yet with their prompt", () => {
    const kit = buildPasteKit({
      platform: "linkedin",
      title: "T",
      bodyHtml: "<p>x</p>",
      coverImage: { marker: 0, url: null, alt: "c", prompt: "a cover" },
      inlineImages: [{ marker: 1, url: "https://c/1.png", alt: "one" }],
    });
    expect(kit.coverImage).toMatchObject({ url: null, status: "no image yet", prompt: "a cover" });
    expect(kit.imagesMissing).toEqual([0]);
  });
});
