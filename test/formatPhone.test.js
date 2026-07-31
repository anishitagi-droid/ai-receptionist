import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatPhone } from "../src/services/sms.js";

describe("formatPhone", () => {
  test("formats an E.164 US number as (XXX) XXX-XXXX", () => {
    assert.equal(formatPhone("+16305551234"), "(630) 555-1234");
  });

  test("returns non-US-shaped numbers unchanged", () => {
    assert.equal(formatPhone("+442071838750"), "+442071838750");
  });

  test("returns 'Unknown number' for null/undefined instead of throwing (regression test)", () => {
    // Regression test: callerPhone normally always comes from Twilio's From field
    // on a real signature-validated request, but NODE_ENV=development skips that
    // validation for local testing, so malformed/missing input can reach here
    // during dev work. Without this guard .replace() on null/undefined throws,
    // and notifyOwner never sends -- a real captured lead silently never reaches
    // the business owner.
    assert.equal(formatPhone(null), "Unknown number");
    assert.equal(formatPhone(undefined), "Unknown number");
    assert.equal(formatPhone(""), "Unknown number");
  });
});
