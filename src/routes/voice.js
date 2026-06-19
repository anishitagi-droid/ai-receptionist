// src/routes/voice.js
// Handles two Twilio voice webhooks:
//
//   POST /voice
//     Called when someone dials the Twilio number.
//     Returns TwiML that forwards the call to the real business number.
//     If not answered within 20s, Twilio POSTs to /voice/no-answer.
//
//   POST /voice/no-answer
//     Called when the forwarded call wasn't answered (timeout, busy, failed).
//     This is the trigger: we send the initial SMS to the caller.

import { Router } from 'express';
import twilio from 'twilio';
import { validateTwilioSignature } from '../middleware/validateTwilio.js';
import { getBusinessByTwilioNumber, getOrCreateConversation, saveMessage } from '../db/index.js';
import { sendSMS } from '../services/sms.js';
import { getInitialMessage } from '../services/claude.js';

const { twiml: { VoiceResponse } } = twilio;
const router = Router();

// ─── POST /voice ──────────────────────────────────────────────────────────────
// Step 1: Someone calls our Twilio number.
// We forward the call to the real business number.
// If not answered within 20 seconds, Twilio POSTs to /voice/no-answer.
router.post('/', validateTwilioSignature, async (req, res) => {
  const { To: twilioNumber } = req.body;

  let business;
  try {
    business = await getBusinessByTwilioNumber(twilioNumber);
  } catch (err) {
    console.error('Could not find business for Twilio number:', twilioNumber);
    const vr = new VoiceResponse();
    vr.say({ voice: 'alice' }, "We're sorry, this number is not currently configured. Please try again later.");
    return res.type('text/xml').send(vr.toString());
  }

  // BUG FIX: Twilio requires an ABSOLUTE URL for the action attribute.
  // A relative path like '/voice/no-answer' silently fails — Twilio drops it
  // and never sends the no-answer callback, breaking the entire product.
  // APP_URL must be set in your .env (e.g. https://yourapp.railway.app).
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    console.error('APP_URL environment variable is not set — no-answer callback will not fire');
  }
  const noAnswerUrl = appUrl
    ? `${appUrl}/voice/no-answer`
    : `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}/voice/no-answer`; // fallback for local dev

  const vr = new VoiceResponse();
  const dial = vr.dial({
    timeout: 20,
    action: noAnswerUrl,
    method: 'POST',
  });
  dial.number(business.real_number);

  res.type('text/xml').send(vr.toString());
});

// ─── POST /voice/no-answer ────────────────────────────────────────────────────
// Step 2: The call wasn't answered.
// DialCallStatus will be 'no-answer', 'busy', or 'failed'.
// We send an SMS to the caller and start the conversation.
router.post('/no-answer', validateTwilioSignature, async (req, res) => {
  const {
    To: twilioNumber,          // Our Twilio number — identifies the business
    From: callerPhone,         // The person who called
    DialCallStatus: callStatus,
  } = req.body;

  console.log(`Missed call from ${callerPhone} to ${twilioNumber} — status: ${callStatus}`);

  // 'completed' means the owner actually picked up — no SMS needed.
  if (callStatus === 'completed') {
    return res.type('text/xml').send('<Response></Response>');
  }

  try {
    const business = await getBusinessByTwilioNumber(twilioNumber);
    const { conversation } = await getOrCreateConversation(callerPhone, business.id);

    // Send the initial SMS immediately — static string, no Claude call,
    // so it arrives within a second or two of the missed call.
    const initialMsg = getInitialMessage(business.name);
    await sendSMS(callerPhone, twilioNumber, initialMsg);
    await saveMessage(conversation.id, 'assistant', initialMsg);

    console.log(`Initial SMS sent to ${callerPhone} for: ${business.name}`);
  } catch (err) {
    console.error('Error handling missed call:', err.message);
  }

  // Always return valid TwiML — the call leg is done, this just closes it out.
  res.type('text/xml').send('<Response></Response>');
});

export default router;
