/**
 * The password-reset email Authentik sends IS renderBrandEmail's output
 * (2026-10-22), so it cannot drift from every other GOTCHA email.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildResetEmailTemplate } from "../email/reset-email-template";

const FILE = path.resolve(__dirname, "../../../../../scripts/authentik/templates/gotcha_password_reset.html");
const committed = fs.readFileSync(FILE, "utf8");

describe("★ gotcha_password_reset.html", () => {
  it("is exactly the generator's output (run scripts/authentik/build-reset-email.ts after changing brand-email.ts)", () => {
    expect(committed).toBe(buildResetEmailTemplate());
  });

  it("picks Hebrew (RTL) or English by the language Authentik renders it in", () => {
    const [head, rest] = committed.split('{% if LANGUAGE_CODE|slice:":2" == "he" %}');
    expect(head).toContain("{% get_current_language as LANGUAGE_CODE %}");
    const [he, en] = rest!.split("{% else %}");
    expect(he).toMatch(/<html lang="he" dir="rtl"/);
    expect(en).toMatch(/<html lang="en" dir="ltr"/);
    expect(en).toContain("{% endif %}");
  });

  it.each(["he", "en"])("the %s version carries the link (button and fallback), the name and the expiry", (lang) => {
    const part = lang === "he" ? committed.split("{% else %}")[0]! : committed.split("{% else %}")[1]!;
    expect(part).toContain('href="{{ url }}"');
    expect((part.match(/\{\{ url \}\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(part).toContain("{{ user.name|default:user.username }}");
    expect(part).toContain("{{ expires|timeuntil }}");
  });

  it("holds no Django tag but its own (the brand HTML must not be read as a template tag)", () => {
    const tags = committed.match(/\{%[^%]*%\}|\{\{[^}]*\}\}|\{#[^#]*#\}/g) ?? [];
    const allowed = new Set([
      "{% load i18n %}", "{% get_current_language as LANGUAGE_CODE %}", '{% if LANGUAGE_CODE|slice:":2" == "he" %}',
      "{% else %}", "{% endif %}", "{{ url }}", "{{ user.name|default:user.username }}", "{{ expires|timeuntil }}",
    ]);
    expect(tags.filter((t) => !allowed.has(t) && !t.startsWith("{#"))).toEqual([]);
  });

  it("the brand look, not the old one: no purple, the white logo from the app", () => {
    expect(committed).not.toMatch(/7C3291/i);
    expect(committed).toContain('src="https://app.gotcha.co.il/full_icon_white.png"');
    expect(committed).toContain("#0A0A0B");
  });
});
