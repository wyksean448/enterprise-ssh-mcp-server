import { describe, expect, it } from "vitest";

import { jsonResponse, setCompactJsonResponse } from "../src/tool-result.js";

describe("tool result JSON formatting", () => {
  it("returns compact JSON when enabled", () => {
    setCompactJsonResponse(true);

    expect(jsonResponse({ ok: true }).content[0]).toMatchObject({
      type: "text",
      text: '{"ok":true}',
    });
  });

  it("returns pretty JSON when disabled", () => {
    setCompactJsonResponse(false);

    expect(jsonResponse({ ok: true }).content[0]).toMatchObject({
      type: "text",
      text: '{\n  "ok": true\n}',
    });
  });
});
