-- ─────────────────────────────────────────────────────────────────────────────
-- AI Receptionist — Database Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor → New Query
-- ─────────────────────────────────────────────────────────────────────────────

-- Businesses table
-- One row per client. One Twilio number = one business.
CREATE TABLE businesses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  twilio_number   TEXT NOT NULL UNIQUE,  -- The Twilio number callers dial, e.g. +16305550001
  owner_phone     TEXT NOT NULL,         -- Where we send lead notifications
  owner_email     TEXT,                  -- Optional, for future email reports
  real_number     TEXT NOT NULL,         -- Business's actual phone we forward calls to
  business_type   TEXT NOT NULL,         -- e.g. "plumber", "HVAC", "electrician"
  services        TEXT NOT NULL,         -- Comma-separated list of services
  service_area    TEXT NOT NULL,         -- e.g. "Aurora, Naperville, and surrounding suburbs"
  hours           TEXT NOT NULL,         -- e.g. "Mon-Fri 7am-6pm, Sat 8am-2pm"
  price_note      TEXT,                  -- e.g. "Free estimates, emergency rates apply after hours"
  custom_faqs     TEXT,                  -- Newline-separated Q&A pairs fed to the AI
  max_messages    INTEGER DEFAULT 10,    -- Max SMS exchanges before escalating to owner
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations table
-- One row per missed-call → SMS thread.
CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  caller_phone    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  -- status values: active | lead_captured | escalated | spam | completed
  message_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Messages table
-- Every SMS exchanged in a conversation, stored for Claude context.
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Leads table
-- Populated when Claude collects all required info from a caller.
CREATE TABLE leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  caller_phone    TEXT NOT NULL,
  caller_name     TEXT,
  issue           TEXT,
  preferred_time  TEXT,
  raw_data        JSONB,
  owner_notified  BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_businesses_twilio_number ON businesses(twilio_number);
CREATE INDEX idx_conversations_caller     ON conversations(caller_phone, business_id);
CREATE INDEX idx_conversations_status     ON conversations(status);
CREATE INDEX idx_messages_conversation    ON messages(conversation_id, created_at);
CREATE INDEX idx_leads_business           ON leads(business_id, created_at);

-- ─── Concurrency safety: one active conversation per caller ──────────────────
-- Without this, two simultaneous /sms webhooks for the same caller (e.g. they
-- send two texts within milliseconds of each other, or Twilio retries a
-- webhook delivery) could both pass the "no active conversation exists" check
-- in getOrCreateConversation() and both INSERT a new row. That splits message
-- history across two threads, confuses Claude's context, and can trigger the
-- owner notification twice for what should be a single lead.
--
-- This partial unique index makes it impossible for two ACTIVE rows to exist
-- for the same (caller_phone, business_id) pair. The second concurrent INSERT
-- will fail with a unique violation (error code 23505), which db/index.js
-- catches and converts into a re-fetch of the row the other request created.
CREATE UNIQUE INDEX idx_unique_active_conversation
  ON conversations (caller_phone, business_id)
  WHERE status = 'active';

-- ─── increment_message_count RPC ─────────────────────────────────────────────
-- Called by db/index.js to safely increment a conversation's message count.
-- Using a SQL function makes the increment ATOMIC — a plain read-then-write
-- in JavaScript has a race condition where two simultaneous messages both read
-- count=3 and both write count=4 instead of count=5. This function cannot
-- have that problem because Postgres executes the UPDATE as a single statement.
CREATE OR REPLACE FUNCTION increment_message_count(conv_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE conversations
  SET
    message_count = message_count + 1,
    updated_at    = NOW()
  WHERE id = conv_id;
$$;

-- ─── Sample business for local testing ───────────────────────────────────────
-- Update all three phone numbers before testing, then delete before going live
-- with a real client (or just leave it — inactive rows don't affect anything).
INSERT INTO businesses (
  name, twilio_number, owner_phone, real_number,
  business_type, services, service_area, hours, price_note
) VALUES (
  'Aurora Plumbing Co.',
  '+16305550001',   -- ← Replace with your actual Twilio number
  '+16305559999',   -- ← Replace with the owner''s real mobile
  '+16305558888',   -- ← Replace with the business''s real phone
  'plumber',
  'drain cleaning, water heater repair/replacement, leak detection, pipe repair, sump pump service, faucet/fixture installation',
  'Aurora, Naperville, Oswego, and surrounding Kane/DuPage County areas',
  'Mon-Fri 7am-7pm, Sat 8am-3pm, emergency service available 24/7',
  'Free estimates on all jobs. Emergency after-hours rates apply.'
);
