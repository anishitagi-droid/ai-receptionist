// src/index.js
// Main server entry point.
// Starts Express, registers all routes, and listens for incoming requests.

import 'dotenv/config';
import express from 'express';
import voiceRouter from './routes/voice.js';
import smsRouter from './routes/sms.js';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
// Parse both URL-encoded bodies (Twilio's format) and JSON
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
// Railway and Render ping this to confirm the server is alive.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Twilio webhook routes ─────────────────────────────────────────────────────
app.use('/voice', voiceRouter); // Handles inbound calls + no-answer trigger
app.use('/sms',   smsRouter);   // Handles inbound SMS replies from callers

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       AI Receptionist — Running          ║
╠══════════════════════════════════════════╣
║  Port:         ${String(PORT).padEnd(26)}║
║  Environment:  ${(process.env.NODE_ENV || 'development').padEnd(26)}║
╠══════════════════════════════════════════╣
║  Endpoints:                              ║
║  POST /voice           (inbound call)    ║
║  POST /voice/no-answer (missed call)     ║
║  POST /sms             (SMS reply)       ║
║  GET  /health          (health check)    ║
╚══════════════════════════════════════════╝
  `);
});

export default app;
