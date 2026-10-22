/**
 * A channel's HTML email template: the sanitizer, the save-time checks and the
 * placeholders (2026-10-22). Pure functions, no database.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeEmailTemplate,
  prepareEmailTemplate,
  renderEmailTemplate,
  textToEmailHtml,
  parseStoredEmailTemplate,
  EMAIL_TEMPLATE_MAX_BYTES,
} from "../email/email-template";

describe("★ sanitizeEmailTemplate strips what can run or submit", () => {
  it("drops <script> with its content, and reports it", () => {
    const r = sanitizeEmailTemplate(`<p>a</p><script>alert(1)</script><p>b</p>`);
    expect(r.html).toBe("<p>a</p><p>b</p>");
    expect(r.removed).toEqual(["script"]);
  });

  it("drops iframe, object and embed with their content", () => {
    const r = sanitizeEmailTemplate(`<iframe src="x">t</iframe><object data="y">o</object><embed src="z"><p>ok</p>`);
    expect(r.html).toBe("<p>ok</p>");
    expect(r.removed).toEqual(["iframe", "object", "embed"]);
  });

  it("removes form controls but keeps the text they wrap", () => {
    const r = sanitizeEmailTemplate(`<form action="/x"><p>Hello</p><input name="q"><button>Go</button></form>`);
    expect(r.html).toBe("<p>Hello</p>Go");
    expect(r.removed).toEqual(["form"]);
  });

  it("removes every on* handler, whatever its case", () => {
    const r = sanitizeEmailTemplate(`<img src="a.png" onerror="x()" ONLOAD='y()' alt="logo">`);
    expect(r.html).toBe(`<img src="a.png" alt="logo">`);
    expect(r.removed).toEqual(["on*"]);
  });

  it("removes javascript: URLs, including entity- and whitespace-hidden ones", () => {
    for (const href of [
      `"javascript:alert(1)"`,
      `"  JaVaScRiPt:alert(1)"`,
      `"java&#x09;script:alert(1)"`,
      `"&#106;avascript:alert(1)"`,
      `"javascript&colon;alert(1)"`,
      `javascript:alert(1)`,
    ]) {
      const r = sanitizeEmailTemplate(`<a href=${href}>x</a>`);
      expect(r.html, href).toBe("<a>x</a>");
      expect(r.removed, href).toEqual(["javascript:"]);
    }
  });

  it("removes a style that runs script, keeps an ordinary one", () => {
    expect(sanitizeEmailTemplate(`<td style="background:url(javascript:x)">a</td>`).html).toBe("<td>a</td>");
    expect(sanitizeEmailTemplate(`<td style="color:#111;padding:8px">a</td>`).html).toBe(`<td style="color:#111;padding:8px">a</td>`);
  });

  it("a nested trick cannot reassemble a script tag", () => {
    const r = sanitizeEmailTemplate(`<scr<script>x</script>ipt>alert(1)</script>`);
    expect(r.html.toLowerCase()).not.toContain("<script");
    expect(r.removed).toContain("script");
  });

  it("an unclosed <script> takes the rest with it, as a browser would", () => {
    expect(sanitizeEmailTemplate(`<p>a</p><script>alert(1)<p>b</p>`).html).toBe("<p>a</p>");
  });

  it("keeps layout: tables, <style>, doctype, Outlook conditional comments, mailto/https links", () => {
    const html = [
      "<!DOCTYPE html>",
      `<html><head><style>.x{color:red}</style></head><body>`,
      `<!--[if mso]><table><tr><td><![endif]-->`,
      `<table width="600" cellpadding="0"><tr><td><a href="https://acme.test">site</a> <a href="mailto:a@acme.test">mail</a>{{content}}</td></tr></table>`,
      `<!--[if mso]></td></tr></table><![endif]-->`,
      `</body></html>`,
    ].join("");
    const r = sanitizeEmailTemplate(html);
    expect(r.html).toBe(html);
    expect(r.removed).toEqual([]);
  });

  it("sanitizes inside a conditional comment too", () => {
    expect(sanitizeEmailTemplate(`<!--[if mso]><script>x</script><![endif]-->`).html).toBe(`<!--[if mso]><![endif]-->`);
  });

  it("an attribute VALUE that merely mentions onclick is untouched", () => {
    expect(sanitizeEmailTemplate(`<p title="onclick is a word">a</p>`).html).toBe(`<p title="onclick is a word">a</p>`);
  });

  it("a bare < in text cannot combine with what follows", () => {
    expect(sanitizeEmailTemplate(`a < b`).html).toBe("a &lt; b");
  });
});

describe("★ prepareEmailTemplate: the save-time contract", () => {
  it("rejects a template without {{content}}", () => {
    expect(prepareEmailTemplate("<p>hello</p>")).toEqual({ ok: false, error: { code: "EMAIL_TEMPLATE_CONTENT_PLACEHOLDER_MISSING" } });
  });

  it("a {{content}} that only lived inside a stripped <script> does not count", () => {
    const r = prepareEmailTemplate(`<p>x</p><script>{{content}}</script>`);
    expect(r).toEqual({ ok: false, error: { code: "EMAIL_TEMPLATE_CONTENT_PLACEHOLDER_MISSING" } });
  });

  it("accepts spaced placeholders and returns what was removed", () => {
    const r = prepareEmailTemplate(`<div onclick="x">{{ content }}</div>`);
    expect(r).toEqual({ ok: true, html: `<div>{{ content }}</div>`, removed: ["on*"] });
  });

  it("measures the 100 KB limit in UTF-8 BYTES, not characters", () => {
    // 60,000 Hebrew letters = 120,000 bytes: over the limit though under 100K characters.
    const hebrew = "{{content}}" + "ש".repeat(60_000);
    expect(hebrew.length).toBeLessThan(EMAIL_TEMPLATE_MAX_BYTES);
    expect(prepareEmailTemplate(hebrew)).toEqual({ ok: false, error: { code: "EMAIL_TEMPLATE_TOO_LARGE", max: 102400 } });
    const ascii = "{{content}}" + "a".repeat(EMAIL_TEMPLATE_MAX_BYTES - 11);
    expect(prepareEmailTemplate(ascii).ok).toBe(true);
    expect(prepareEmailTemplate(ascii + "a")).toMatchObject({ ok: false });
  });
});

describe("★ renderEmailTemplate: placeholders", () => {
  const tpl = `<h1>{{business_name}}</h1><div>{{content}}</div><p>{{agent_name}} for {{ customer_name }}</p><i>{{unknown}}</i>`;

  it("escapes every value except content, and leaves unknown placeholders as typed", () => {
    const out = renderEmailTemplate(tpl, {
      contentHtml: "<b>hi</b>",
      agentName: `<img src=x onerror=1>`,
      businessName: `A & B "Co"`,
      customerName: "דנה",
    });
    expect(out).toBe(
      `<h1>A &amp; B &quot;Co&quot;</h1><div><b>hi</b></div><p>&lt;img src=x onerror=1&gt; for דנה</p><i>{{unknown}}</i>`,
    );
  });

  it("missing values render empty, not 'undefined'", () => {
    expect(renderEmailTemplate("[{{agent_name}}]", { contentHtml: "" })).toBe("[]");
  });

  it("content placed twice appears twice (the template decides)", () => {
    expect(renderEmailTemplate("{{content}}|{{content}}", { contentHtml: "x" })).toBe("x|x");
  });
});

describe("textToEmailHtml: a plain-text reply as HTML", () => {
  it("escapes and keeps line breaks, including the quoted history", () => {
    expect(textToEmailHtml(`Hi <Dana>\nThanks & bye\r\n> On Mon you wrote:\n> hello`)).toBe(
      "Hi &lt;Dana&gt;<br>\nThanks &amp; bye<br>\n&gt; On Mon you wrote:<br>\n&gt; hello",
    );
  });
});

describe("parseStoredEmailTemplate", () => {
  it("reads a stored template and treats anything unreadable as none", () => {
    expect(parseStoredEmailTemplate(JSON.stringify({ html: "{{content}}", enabled: true, updatedAt: "t", updatedBy: "u" })))
      .toEqual({ html: "{{content}}", enabled: true, updatedAt: "t", updatedBy: "u" });
    expect(parseStoredEmailTemplate(null)).toBeNull();
    expect(parseStoredEmailTemplate("not json")).toBeNull();
    expect(parseStoredEmailTemplate(JSON.stringify({ enabled: true }))).toBeNull();
    expect(parseStoredEmailTemplate(JSON.stringify({ html: "x", enabled: "yes" }))?.enabled).toBe(false);
  });
});
