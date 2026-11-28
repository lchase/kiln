import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cronPhrase, tabTitle } from "../src/serve-page.js";

describe("plain copy on the serve pages", () => {
  it("shows the needs-you count in the tab title only when it is above zero", () => {
    assert.equal(tabTitle(0), "Kiln");
    assert.equal(tabTitle(3), "(3) Kiln");
  });

  it("reads common crons in words and leaves others as written", () => {
    assert.equal(cronPhrase("0 * * * *"), "every hour");
    assert.equal(cronPhrase("*/15 * * * *"), "every 15 minutes");
    assert.equal(cronPhrase("30 9 * * 1"), "30 9 * * 1");
  });
});
