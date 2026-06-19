// src/routes/sms.js
// Handles POST /sms — fires every time a caller replies to our initial text.
// This is the core product loop: receive → load history → Claude → reply → save.
//
// Flow per incoming message:
//  1. Immediately ACK Twilio with 200 + empty TwiML (avoids 10-second timeout)
//  2. Look up business from the Twilio number
//  3. Find or create conversation for this caller
//  4. Guard: skip if conversation is already closed
//  5. Guard: escalate if message count is at the limit
//  6. Load full message history for Claude context
//  7. Get Claude's response + parse for embedded signals
//  8. Handle signals (spam, emergency escalation)
//  9. Send the reply SMS, save both messages to DB
// 10. If lead captured → save lead + notify owner

import { Router } from 'express';
import { validateTwilioSignature } from '../middleware/validateTwilio.js';
import {
  getBusinessByTwilioNumber,
  getOrCreateConversation,
  getMessages,
  saveMessage,
  updateConversationStatus,
  saveLead,
  markLeadNotified,
  incrementMessageCount,
} from '../db/index.js';
import { getChatResponse } from '../services/claude.js';
import { sendSMS, notifyOwner, notifyOwnerEmergency } from '../services/sms.js';

const router = Router();

// ─── POST /sms ────────────────────────────────────────────────────────────────
router.post('/', validateTwilioSignature, async (req, res) => {
  // ACK Twilio immediately — must respond within 10 seconds or Twilio retries.
  // We reply to the caller via the Twilio REST API below, not via TwiML here.
  // BUG FIX: must set Content-Type: text/xml — Twilio expects it even for empty responses.
  res.status(200).type('text/xml').send('<Response></Response>');

  const {
    To: twilioNumber,
    From: callerPhone,
    Body: rawBody,
  } = req.body;

  // BUG FIX: Body can be undefined for MMS-only messages or malformed webhooks.
  // Calling .trim() on undefined throws a TypeError that kills the entire handler.
  const incomingText = rawBody?.trim();
  if (!incomingText) {
    console.log(`Empty or missing Body from ${callerPhone} — skipping`);
    return;
  }

  console.log(`Incoming SMS from ${callerPhone}: "${incomingText}"`);

  try {
    // ── 1. Load business config ────────────────────────────────────────────
    const business = await getBusinessByTwilioNumber(twilioNumber);

    // ── 2. Get or create conversation ─────────────────────────────────────
    const { conversation } = await getOrCreateConversation(callerPhone, business.id);

    // ── 3. Guard: closed conversation ─────────────────────────────────────
    if (['spam', 'escalated', 'lead_captured'].includes(conversation.status)) {
      console.log(`Ignoring message from ${callerPhone} — status: ${conversation.status}`);
      return;
    }

    // ── 4. Guard: message limit ────────────────────────────────────────────
    if (conversation.message_count >= (business.max_messages || 10)) {
      await handleMaxMessagesReached(business, conversation, callerPhone, twilioNumber);
      return;
    }

    // ── 5. Load history + get Claude response ──────────────────────────────
    const history  = await getMessages(conversation.id);
    const { smsText, leadData, isSpam, escalation } = await getChatResponse(
      business,
      history,
      incomingText
    );

    // ── 6. Handle spam signal ──────────────────────────────────────────────
    if (isSpam) {
      console.log(`Spam detected from ${callerPhone}`);
      await saveMessage(conversation.id, 'user', incomingText);
      await updateConversationStatus(conversation.id, 'spam');
      return; // No reply — just close the conversation
    }

    // ── 7. Handle emergency escalation ────────────────────────────────────
    if (escalation) {
      console.log(`Emergency escalation from ${callerPhone}: ${escalation.reason}`);
      await saveMessage(conversation.id, 'user', incomingText);
      await saveMessage(conversation.id, 'assistant', smsText);
      await sendSMS(callerPhone, twilioNumber, smsText);
      await notifyOwnerEmergency(business, escalation.reason, callerPhone);
      await updateConversationStatus(conversation.id, 'escalated');
      await incrementMessageCount(conversation.id);
      return;
    }

    // ── 8. Normal reply: send SMS and save to DB ───────────────────────────
    await sendSMS(callerPhone, twilioNumber, smsText);
    await saveMessage(conversation.id, 'user', incomingText);
    await saveMessage(conversation.id, 'assistant', smsText);
    await incrementMessageCount(conversation.id);

    // ── 9. Lead captured ───────────────────────────────────────────────────
    if (leadData) {
      console.log(`Lead captured for ${business.name}:`, leadData);
      const lead = await saveLead(conversation.id, business.id, callerPhone, leadData);
      await updateConversationStatus(conversation.id, 'lead_captured');
      await notifyOwner(business, leadData, callerPhone);
      await markLeadNotified(lead.id);
    }

  } catch (err) {
    console.error('SMS handler error:', err.message, '\n', err.stack);
    // Best-effort fallback: let the caller know something went wrong
    try {
      await sendSMS(
        req.body.From,
        req.body.To,
        "Sorry, we hit a technical issue. Please call us directly — we want to help!"
      );
    } catch (fallbackErr) {
      console.error('Fallback SMS failed:', fallbackErr.message);
    }
  }
});

// ─── Helper: too many messages without a captured lead ───────────────────────
async function handleMaxMessagesReached(business, conversation, callerPhone, twilioNumber) {
  await sendSMS(
    callerPhone,
    twilioNumber,
    `We want to make sure you get taken care of! I'll have someone from ${business.name} call you directly as soon as possible.`
  );
  await sendSMS(
    business.owner_phone,
    twilioNumber,
    `📋 FOLLOW-UP NEEDED — ${business.name}\n──────────────────\nCaller: ${callerPhone}\nReason: Hit message limit without capturing lead.\nAction: Call them back directly.`
  );
  await updateConversationStatus(conversation.id, 'escalated');
}

export default router;
