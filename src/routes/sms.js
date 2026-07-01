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
//  9. Save messages to DB first, THEN send SMS (so history is always consistent)
// 10. If lead captured → close conversation first, then notify owner

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
  res.status(200).type('text/xml').send('<Response></Response>');

  const {
    To: twilioNumber,
    From: callerPhone,
    Body: rawBody,
  } = req.body;

  // Body can be undefined for MMS-only messages or malformed webhooks.
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
    const history = await getMessages(conversation.id);
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
      return;
    }

    // ── 7. Handle emergency escalation ────────────────────────────────────
    if (escalation) {
      console.log(`Emergency escalation from ${callerPhone}: ${escalation.reason}`);
      await saveMessage(conversation.id, 'user', incomingText);
      await saveMessage(conversation.id, 'assistant', smsText);
      await incrementMessageCount(conversation.id);
      await updateConversationStatus(conversation.id, 'escalated');
      // Send AFTER DB writes — history is safe even if Twilio fails
      await sendSMS(callerPhone, twilioNumber, smsText);
      await notifyOwnerEmergency(business, escalation.reason, callerPhone);
      return;
    }

    // ── 8. Normal reply ────────────────────────────────────────────────────
    // BUG FIX: Save to DB BEFORE sending the SMS.
    // If sendSMS is called first and DB writes then fail, Claude's message
    // history is missing this exchange. On the caller's next text, Claude
    // loses context and may ask for info the customer already provided.
    // Saving first means history is always consistent. If sendSMS then fails,
    // the outer catch sends a fallback SMS — the customer gets a "technical
    // issue" message rather than silence.
    await saveMessage(conversation.id, 'user', incomingText);
    await saveMessage(conversation.id, 'assistant', smsText);
    await incrementMessageCount(conversation.id);
    await sendSMS(callerPhone, twilioNumber, smsText);

    // ── 9. Lead captured ───────────────────────────────────────────────────
    if (leadData) {
      console.log(`Lead captured for ${business.name}:`, leadData);
      const lead = await saveLead(conversation.id, business.id, callerPhone, leadData);

      // BUG FIX: Close the conversation BEFORE notifying the owner.
      // If notifyOwner fails (Twilio error), the conversation is still correctly
      // closed. Without this order, a Twilio failure would leave the conversation
      // active, Claude would capture the lead again on the next message, and the
      // owner would get duplicate lead notifications when Twilio recovered.
      await updateConversationStatus(conversation.id, 'lead_captured');

      // Notify owner separately — failure here doesn't corrupt state.
      // The lead is saved in DB with owner_notified=false, which is accurate.
      try {
        await notifyOwner(business, leadData, callerPhone);
        await markLeadNotified(lead.id);
      } catch (notifyErr) {
        // Log and move on — the lead is not lost, owner_notified stays false.
        // Future enhancement: a cron job could retry unnotified leads.
        console.error(`Failed to notify owner for lead ${lead.id}:`, notifyErr.message);
      }
    }

  } catch (err) {
    console.error('SMS handler error:', err.message, '\n', err.stack);
    // Best-effort fallback using already-scoped variables (not req.body.*)
    if (callerPhone && twilioNumber) {
      try {
        await sendSMS(
          callerPhone,
          twilioNumber,
          "Sorry, we hit a technical issue. Please call us directly — we want to help!"
        );
      } catch (fallbackErr) {
        console.error('Fallback SMS failed:', fallbackErr.message);
      }
    }
  }
});

// ─── Helper: too many messages without a captured lead ────────────────────────
async function handleMaxMessagesReached(business, conversation, callerPhone, twilioNumber) {
  // BUG FIX: This function previously had no try/catch. If the first sendSMS
  // threw, updateConversationStatus was never called. The conversation stayed
  // active with message_count >= max_messages, so every subsequent message
  // from this caller re-entered this function — infinite error loop.
  // Fix: always close the conversation first, then attempt SMS best-effort.
  await updateConversationStatus(conversation.id, 'escalated');

  try {
    await sendSMS(
      callerPhone,
      twilioNumber,
      `We want to make sure you get taken care of! I'll have someone from ${business.name} call you directly as soon as possible.`
    );
  } catch (err) {
    console.error(`Failed to send max-messages SMS to caller ${callerPhone}:`, err.message);
  }

  try {
    await sendSMS(
      business.owner_phone,
      twilioNumber,
      `FOLLOW-UP NEEDED - ${business.name}\n` +
      `---\n` +
      `Caller: ${callerPhone}\n` +
      `Reason: Hit message limit without capturing lead.\n` +
      `Action: Call them back directly.`
    );
  } catch (err) {
    console.error(`Failed to send max-messages alert to owner ${business.owner_phone}:`, err.message);
  }
}

export default router;
