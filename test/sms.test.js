import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sendSMS, notifyOwner, notifyOwnerEmergency } from "../src/services/sms.js";

function fakeTwilioClient() {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push(request);
        return { sid: "SM_fake_123" };
      },
    },
  };
}

describe("sendSMS", () => {
  test("passes to/from/body straight through to the injected client", async () => {
    const client = fakeTwilioClient();
    await sendSMS("+16305551234", "+16305559999", "hello", client);
    assert.deepEqual(client.calls[0], { to: "+16305551234", from: "+16305559999", body: "hello" });
  });

  test("re-throws on failure rather than swallowing it (a caller waiting on this must know it failed)", async () => {
    const client = { messages: { create: async () => { throw new Error("Twilio down"); } } };
    await assert.rejects(() => sendSMS("+1", "+1", "x", client), /Twilio down/);
  });
});

describe("notifyOwner", () => {
  test("sends the lead summary to the owner's phone from the business's Twilio number", async () => {
    const client = fakeTwilioClient();
    const business = { name: "Aurora Plumbing Co.", owner_phone: "+16305559999", twilio_number: "+16305550001" };
    const leadData = { name: "Jane Doe", issue: "leaking pipe", preferred_time: "tomorrow morning" };

    await notifyOwner(business, leadData, "+16305551234", client);

    const sent = client.calls[0];
    assert.equal(sent.to, "+16305559999");
    assert.equal(sent.from, "+16305550001");
    assert.match(sent.body, /Jane Doe/);
    assert.match(sent.body, /leaking pipe/);
    assert.match(sent.body, /\(630\) 555-1234/); // formatted caller number
  });

  test("falls back to a placeholder for missing lead fields instead of printing 'undefined'", async () => {
    const client = fakeTwilioClient();
    const business = { name: "x", owner_phone: "+1", twilio_number: "+1" };
    await notifyOwner(business, {}, "+16305551234", client);
    const body = client.calls[0].body;
    assert.ok(!body.includes("undefined"));
    assert.match(body, /Not provided/);
    assert.match(body, /Not specified/);
  });

  test("keeps the message in the ASCII range to avoid UCS-2 SMS encoding (regression test)", async () => {
    // Regression test for a documented past bug: box-drawing characters/emoji
    // forced UCS-2 encoding (70 chars/segment instead of 160), doubling Twilio
    // costs. Confirms the current plain-ASCII formatting stays that way.
    const client = fakeTwilioClient();
    const business = { name: "Aurora Plumbing Co.", owner_phone: "+1", twilio_number: "+1" };
    await notifyOwner(business, { name: "Jane", issue: "leak", preferred_time: "today" }, "+16305551234", client);
    const body = client.calls[0].body;
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x00-\x7F]*$/.test(body), `expected plain ASCII, got: ${body}`);
  });
});

describe("notifyOwnerEmergency", () => {
  test("sends an emergency alert with the reason and formatted caller number", async () => {
    const client = fakeTwilioClient();
    const business = { name: "Aurora Plumbing Co.", owner_phone: "+16305559999", twilio_number: "+16305550001" };
    await notifyOwnerEmergency(business, "gas leak reported", "+16305551234", client);
    const body = client.calls[0].body;
    assert.match(body, /gas leak reported/);
    assert.match(body, /\(630\) 555-1234/);
  });
});
