// src/services/claude.js
// Handles all AI conversation logic.
// Builds the system prompt from business config, sends conversation history,
// and parses the response for lead data or special signals.

import Anthropic from '@anthropic-ai/sdk';

// Lazy singleton — consistent with db/index.js and services/sms.js patterns.
// Also gives a clean error at call time if the key is missing, not at import.
let _anthropic = null;
function ai() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// Use Haiku — fastest and cheapest, more than capable for short SMS conversations.
// Do NOT use Sonnet/Opus here. Each SMS costs fractions of a cent with Haiku;
// Sonnet would be ~10x more expensive for no meaningful quality difference on
// 2-3 sentence replies.
const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Build the system prompt for a specific business.
 * This is the core of the product — it's what makes Claude act like
 * a knowledgeable receptionist for THIS specific business.
 */
function buildSystemPrompt(business) {
  const faqSection = business.custom_faqs
    ? `\nFREQUENTLY ASKED QUESTIONS:\n${business.custom_faqs}`
    : '';

  return `You are a friendly, professional receptionist for ${business.name}, a local ${business.business_type} business. You are responding via SMS to someone who just missed a call.

YOUR GOAL:
Warmly greet the caller, understand what they need, and collect three pieces of information:
1. Their first name
2. A brief description of their problem or what they need
3. Their preferred time to receive a callback

Once you have all three, wrap up the conversation and let them know someone will call them back.

BUSINESS INFORMATION:
- Business name: ${business.name}
- Services offered: ${business.services}
- Service area: ${business.service_area}
- Hours: ${business.hours}
${business.price_note ? `- Pricing note: ${business.price_note}` : ''}
${faqSection}

RULES — FOLLOW THESE EXACTLY:
- Keep every reply to 2-3 sentences maximum. This is SMS, not email.
- Never quote specific prices. Say "we'll give you a free estimate" or "pricing depends on the job."
- Never commit to a specific appointment time. Say "someone will call you back to schedule."
- Only answer questions about the services listed above. For anything else, say the team will address it when they call.
- Be warm but efficient. Don't use filler phrases like "Great!" or "Absolutely!" repeatedly.
- If someone is clearly not a real customer (spam, gibberish, hostile), use the SPAM signal below.

RESPONSE FORMAT:
Write your normal SMS reply to the customer. Then, if you have collected all three pieces of info (name, issue, preferred time), add this on a NEW LINE at the very end — the customer will NOT see this part:

LEAD_CAPTURED:{"name":"their name","issue":"their problem","preferred_time":"when they want a callback"}

If the conversation seems like spam or the person is being hostile:
SPAM_DETECTED

If you need to escalate because someone has a genuine emergency (flooding, no heat in winter, gas smell):
ESCALATE:{"reason":"brief reason for escalation"}

Do NOT include LEAD_CAPTURED, SPAM_DETECTED, or ESCALATE in the visible part of your message. Only append them on a new line after your reply.`;
}

/**
 * Parse Claude's raw response for any signals embedded after the SMS text.
 * Returns the clean SMS text and any extracted data.
 */
function parseResponse(rawText) {
  const lines = rawText.trim().split('\n');
  const visibleText = [];
  let leadData = null;
  let isSpam = false;
  let escalation = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('LEAD_CAPTURED:')) {
      try {
        leadData = JSON.parse(trimmed.slice('LEAD_CAPTURED:'.length));
      } catch {
        console.error('Failed to parse LEAD_CAPTURED JSON:', trimmed);
      }
    } else if (trimmed === 'SPAM_DETECTED') {
      isSpam = true;
    } else if (trimmed.startsWith('ESCALATE:')) {
      try {
        escalation = JSON.parse(trimmed.slice('ESCALATE:'.length));
      } catch {
        escalation = { reason: 'Emergency situation' };
      }
    } else {
      visibleText.push(line);
    }
  }

  return {
    smsText: visibleText.join('\n').trim(),
    leadData,
    isSpam,
    escalation,
  };
}

/**
 * Main function: get the next AI response for an ongoing conversation.
 *
 * @param {object} business   - Business config row from Supabase
 * @param {Array}  history    - Array of {role, content} messages from DB
 * @param {string} newMessage - The latest incoming message from the caller
 * @returns {object} { smsText, leadData, isSpam, escalation }
 */
export async function getChatResponse(business, history, newMessage) {
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: newMessage },
  ];

  const response = await ai().messages.create({
    model: MODEL,
    max_tokens: 300, // SMS replies should be short — 300 tokens is plenty
    system: buildSystemPrompt(business),
    messages,
  });

  const rawText = response.content[0]?.text
    ?? "I'm sorry, I had a technical issue. Please call us back directly!";

  return parseResponse(rawText);
}

/**
 * Generate the very first message sent after a missed call.
 * Static string — no Claude call — so it arrives within seconds, not 1-2s.
 */
export function getInitialMessage(businessName) {
  // Strip trailing period so "Aurora Plumbing Co." doesn't become "Co.." in the SMS.
  const name = businessName.replace(/\.$/,  "");
  return `Hi! You just missed a call from ${name}. We want to make sure you get the help you need — what can we assist you with today?`;
}
