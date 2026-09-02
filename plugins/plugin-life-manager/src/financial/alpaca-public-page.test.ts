import { describe, expect, it } from "vitest";
import { renderAlpacaPublicPage } from "./alpaca-public-page.js";

describe("Alpaca public page", () => {
  it("renders a read-only projection client with no mutation surface", () => {
    const html = renderAlpacaPublicPage();
    expect(html).toContain("Paper trading only");
    expect(html).toContain("/api/life-manager/alpaca/public");
    expect(html).toContain("textContent");
    expect(html).not.toMatch(/<(button|form|input|textarea|select)\b/i);
    expect(html).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(html).not.toContain("<script src=");
  });
});
