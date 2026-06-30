// src/services/sms.js
// Wraps all outbound SMS operations.
// sendSMS       — sends a text to any number
// notifyOwner   — sends a formatted lead summary to the business owner

import twilio from 'twilio';

// Lazy singleton — same reason as db(): don't throw at import time
let _client = null;
function client() {
  if (!_client) {
    if (!process.env.TWILIO_ACCOUNT_SID) throw new Error('TWILIO_ACCOUNT_SID is not set');
    if (!process.env.TWILIO_AUTH_TOKEN)  throw new Error('TWILIO_AUTH_TOKEN is not set');
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}

/**
 * Send an SMS message via Twilio.
 * @param {string} to   - Recipient phone number (E.164 format, e.g. +16305551234)
 * @param {string} from - Your Twilio number (E.164 format)
 * @param {string} body - Message text
 */
export async function sendSMS(to, from, body) {
  try {
    const message = await client().messages.create({ to, from, body });
    console.log(`SMS sent to ${to} — SID: ${message.sid}`);
    return message;
  } catch (err) {
    console.error(`Failed to send SMS to ${to}:`, err.message);
    throw err;
  }
}

/**
 * Notify the business owner that a new lead was captured.
 * Sends a clean, formatted text to the owner's phone immediately.
 *
 * @param {object} business  - Business config row from Supabase
 * @param {object} leadData  - { name, issue, preferred_time }
 * @param {string} callerPhone - The caller's phone number
 */
export async function notifyOwner(business, leadData, callerPhone) {
  const name          = leadData.name         || 'Not provided';
  const issue         = leadData.issue        || 'Not specified';
  const preferredTime = leadData.preferred_time || 'No preference given';

  // Format the caller's number for readability
  const formattedCaller = formatPhone(callerPhone);

  const message =
    `🔔 NEW LEAD — ${business.name}\n` +
    `──────────────────\n` +
    `Name: ${name}\n` +
    `Phone: ${formattedCaller}\n` +
    `Issue: ${issue}\n` +
    `Best time to call: ${preferredTime}\n` +
    `──────────────────\n` +
    `Reply to this number to reach them.`;

  await sendSMS(business.owner_phone, business.twilio_number, message);
}

/**
 * Notify the owner of an emergency escalation.
 * Sent immediately, skips normal lead flow.
 */
export async function notifyOwnerEmergency(business, reason, callerPhone) {
  const formattedCaller = formatPhone(callerPhone);

  const message =
    `🚨 EMERGENCY — ${business.name}\n` +
    `──────────────────\n` +
    `Caller: ${formattedCaller}\n` +
    `Reason: ${reason}\n` +
    `──────────────────\n` +
    `Call them back immediately.`;

  await sendSMS(business.owner_phone, business.twilio_number, message);
}

/**
 * Format a raw E.164 phone number as (XXX) XXX-XXXX for human readability.
 */
function formatPhone(phone) {
  // Defensive guard: callerPhone normally always comes from Twilio's From
  // field on a real request, but NODE_ENV=development intentionally skips
  // signature validation for local testing, so malformed input CAN reach
  // here during dev work. Without this guard, .replace() on undefined/null
  // throws and notifyOwner never sends — meaning a real captured lead never
  // reaches the business owner.
  if (!phone) return 'Unknown number';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') {
    const d = digits.slice(1);
    return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  }
  return phone; // Return as-is if it doesn't match US format
}
