import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseResponse, buildSystemPrompt, getInitialMessage, getChatResponse } from "../src/services/claude.js";

describe("parseResponse", () => {
  test("plain visible text with no signals", () => {
    const result = parseResponse("Sure, we can help with that. What's your address?");
    assert.equal(result.smsText, "Sure, we can help with that. What's your address?");
    assert.equal(result.leadData, null);
    assert.equal(result.isSpam, false);
    assert.equal(result.escalation, null);
  });

  test("extracts LEAD_CAPTURED JSON and strips it from the visible text", () => {
    const raw = `Great, we've got your info and will call you back shortly!\nLEAD_CAPTURED:{"name":"Jane Doe","issue":"leaking pipe","preferred_time":"tomorrow morning"}`;
    const result = parseResponse(raw);
    assert.equal(result.smsText, "Great, we've got your info and will call you back shortly!");
    assert.deepEqual(result.leadData, { name: "Jane Doe", issue: "leaking pipe", preferred_time: "tomorrow morning" });
  });

  test("detects SPAM_DETECTED as a standalone signal line", () => {
    const result = parseResponse("SPAM_DETECTED");
    assert.equal(result.isSpam, true);
    assert.equal(result.smsText, "");
  });

  test("extracts ESCALATE JSON and strips it from the visible text", () => {
    const raw = `Calling emergency services now, hang tight.\nESCALATE:{"reason":"gas leak reported"}`;
    const result = parseResponse(raw);
    assert.equal(result.smsText, "Calling emergency services now, hang tight.");
    assert.deepEqual(result.escalation, { reason: "gas leak reported" });
  });

  test("malformed ESCALATE JSON falls back to a generic reason rather than losing the escalation entirely", () => {
    const raw = `Emergency!\nESCALATE:{not valid json`;
    const result = parseResponse(raw);
    assert.deepEqual(result.escalation, { reason: "Emergency situation" });
  });

  test("malformed LEAD_CAPTURED JSON is dropped (characterization test, not necessarily desired)", () => {
    // Characterizes current behavior: unlike ESCALATE's fallback, a malformed
    // LEAD_CAPTURED silently leaves leadData null with no fallback at all --
    // there's no generic substitute that would recover the actual lost name/
    // issue/preferred_time, so there's no clearly better fallback to fall to.
    // This test exists so a future change to that behavior is deliberate.
    const raw = `Got it, thanks!\nLEAD_CAPTURED:{not valid json`;
    const result = parseResponse(raw);
    assert.equal(result.leadData, null);
    assert.equal(result.smsText, "Got it, thanks!");
  });

  test("multiple lines of visible text are preserved with their line breaks", () => {
    const raw = "Line one.\nLine two.\nLine three.";
    const result = parseResponse(raw);
    assert.equal(result.smsText, "Line one.\nLine two.\nLine three.");
  });
});

describe("buildSystemPrompt", () => {
  test("includes the business's name, services, and hours in the prompt", () => {
    const business = {
      name: "Aurora Plumbing Co.",
      business_type: "plumber",
      services: "drain cleaning, leak detection",
      service_area: "Aurora, IL",
      hours: "Mon-Fri 7am-7pm",
      price_note: "Free estimates",
      custom_faqs: null,
      max_messages: 10,
    };
    const prompt = buildSystemPrompt(business);
    assert.match(prompt, /Aurora Plumbing Co\./);
    assert.match(prompt, /drain cleaning, leak detection/);
    assert.match(prompt, /Mon-Fri 7am-7pm/);
  });

  test("instructs the model to use the exact LEAD_CAPTURED/SPAM_DETECTED/ESCALATE signal formats parseResponse expects", () => {
    // Cross-file consistency check: the prompt's instructions and parseResponse's
    // parsing logic must agree on the exact signal syntax, or the model could
    // emit something the parser silently never recognizes.
    const business = { name: "x", business_type: "x", services: "x", service_area: "x", hours: "x", price_note: "x", custom_faqs: null, max_messages: 10 };
    const prompt = buildSystemPrompt(business);
    assert.match(prompt, /LEAD_CAPTURED:/);
    assert.match(prompt, /SPAM_DETECTED/);
    assert.match(prompt, /ESCALATE:/);
  });
});

describe("getInitialMessage", () => {
  test("includes the business name in the greeting", () => {
    assert.match(getInitialMessage("Aurora Plumbing Co."), /Aurora Plumbing Co\./);
  });
});

describe("getChatResponse (with an injected fake Anthropic client)", () => {
  function fakeClient(responseText) {
    const calls = [];
    return {
      calls,
      messages: {
        create: async (request) => {
          calls.push(request);
          return { content: [{ type: "text", text: responseText }] };
        },
      },
    };
  }

  test("passes conversation history and the new message to the model in order", async () => {
    const client = fakeClient("Sure, what's the issue?");
    const business = { name: "x", business_type: "x", services: "x", service_area: "x", hours: "x", price_note: "x", custom_faqs: null, max_messages: 10 };
    const history = [
      { role: "assistant", content: "Hi, how can I help?" },
      { role: "user", content: "My sink is leaking" },
    ];
    await getChatResponse(business, history, "It's under the cabinet", client);

    const sentMessages = client.calls[0].messages;
    assert.equal(sentMessages.length, 3);
    assert.equal(sentMessages[2].content, "It's under the cabinet");
  });

  test("returns the parsed result (smsText/leadData/isSpam/escalation), not the raw API response", async () => {
    const client = fakeClient(`All set!\nLEAD_CAPTURED:{"name":"Bob","issue":"leak","preferred_time":"today"}`);
    const business = { name: "x", business_type: "x", services: "x", service_area: "x", hours: "x", price_note: "x", custom_faqs: null, max_messages: 10 };
    const result = await getChatResponse(business, [], "hi", client);
    assert.equal(result.smsText, "All set!");
    assert.deepEqual(result.leadData, { name: "Bob", issue: "leak", preferred_time: "today" });
  });
});
