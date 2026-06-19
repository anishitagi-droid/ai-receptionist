// src/middleware/validateTwilio.js
// Security middleware that verifies every incoming request is genuinely from Twilio.
// Twilio signs every webhook request using your Auth Token.
// Without this, anyone who found your URL could fake a missed call.
//
// HOW IT WORKS:
// Twilio computes an HMAC-SHA1 signature over your URL + POST params using your Auth Token.
// It sends this signature in the X-Twilio-Signature header.
// We recompute the signature server-side and compare. If they match, it's real.

import twilio from 'twilio';

const { validateRequest } = twilio;

export function validateTwilioSignature(req, res, next) {
  // Skip validation in development so you can test with curl or Postman locally.
  // NEVER skip in production.
  if (process.env.NODE_ENV === 'development') {
    console.warn('[DEV] Skipping Twilio signature validation');
    return next();
  }

  const twilioSignature = req.headers['x-twilio-signature'];
  const authToken      = process.env.TWILIO_AUTH_TOKEN;

  // Build the full URL Twilio signed. This must match exactly what Twilio used.
  // If you're behind a proxy (like Railway), you need the forwarded proto.
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const url   = `${proto}://${req.headers.host}${req.originalUrl}`;

  const isValid = validateRequest(authToken, twilioSignature, url, req.body);

  if (!isValid) {
    console.error('Invalid Twilio signature — request rejected:', url);
    return res.status(403).send('Forbidden');
  }

  next();
}
