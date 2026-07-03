// src/db/index.js
// All database operations in one place.
// Nothing else in the app imports Supabase directly.

import { createClient } from '@supabase/supabase-js';

// Lazy singleton — only instantiated on first DB call so missing env vars
// don't throw at import time (important for test/lint runs without .env).
let _client = null;
function db() {
  if (!_client) {
    if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is not set');
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _client;
}

// ─── Business ─────────────────────────────────────────────────────────────────

/**
 * Find the business config for an incoming Twilio number.
 * Throws if not found — a missing business is a real error, not a normal case.
 */
export async function getBusinessByTwilioNumber(twilioNumber) {
  const { data, error } = await db()
    .from('businesses')
    .select('*')
    .eq('twilio_number', twilioNumber)
    .eq('active', true)
    .single(); // .single() is correct here — zero rows IS an error

  if (error) throw new Error(`Business not found for number ${twilioNumber}: ${error.message}`);
  return data;
}

// ─── Conversations ────────────────────────────────────────────────────────────

/**
 * Get an existing conversation OR create a new one.
 *
 * IMPORTANT: Returns ANY recent conversation for this caller, not just active ones.
 * This is intentional — the status guard in sms.js (step 3) needs to see the
 * actual status of the last conversation to decide whether to process the message.
 *
 * If we only returned active conversations, a caller who texts AFTER their lead
 * is captured would get a brand new active conversation created (since the closed
 * one isn't found), the status guard would see 'active', and Claude would treat
 * them as a new caller — re-asking for their name even though they were already
 * qualified. This is the actual bug: the status guard is bypassed because
 * getOrCreateConversation creates a new conversation before the guard can fire.
 *
 * Fix: fetch the most recent conversation regardless of status. If it's closed
 * (lead_captured, escalated, spam), return it — the status guard in sms.js will
 * correctly block the message. Only create a new conversation if there is truly
 * no prior conversation at all, or if the most recent one is 'completed' (a
 * deliberate terminal state meaning the business closed it intentionally).
 */
export async function getOrCreateConversation(callerPhone, businessId) {
  // Fetch most recent conversation regardless of status
  const { data: recent, error: fetchError } = await db()
    .from('conversations')
    .select('*')
    .eq('caller_phone', callerPhone)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to check existing conversation: ${fetchError.message}`);

  // If there's a conversation that isn't in a terminal "completed" state,
  // return it so the caller can either continue (active) or be blocked (closed).
  if (recent && recent.status !== 'completed') {
    return { conversation: recent, isNew: false };
  }

  // No prior conversation, or only a 'completed' one — create a fresh one.
  const { data: newConvo, error: createError } = await db()
    .from('conversations')
    .insert({ caller_phone: callerPhone, business_id: businessId, status: 'active' })
    .select()
    .single();

  if (createError) {
    // RACE CONDITION: 23505 = unique constraint on idx_unique_active_conversation.
    // Two concurrent requests both passed the check above. Re-fetch the winner.
    if (createError.code === '23505') {
      const { data: winner, error: refetchError } = await db()
        .from('conversations')
        .select('*')
        .eq('caller_phone', callerPhone)
        .eq('business_id', businessId)
        .eq('status', 'active')
        .single();

      if (refetchError) throw new Error(`Failed to recover from conversation race condition: ${refetchError.message}`);
      return { conversation: winner, isNew: false };
    }
    throw new Error(`Failed to create conversation: ${createError.message}`);
  }

  return { conversation: newConvo, isNew: true };
}

/**
 * Atomically increment the message count on a conversation.
 *
 * Uses a direct UPDATE with message_count + 1 — this is atomic at the DB level.
 * The old approach used read-then-write which had a race condition: two simultaneous
 * messages would both read count=3 and both write count=4 instead of count=5.
 * The Postgres UPDATE is a single statement, so no race is possible.
 */
export async function incrementMessageCount(conversationId) {
  const { error } = await db()
    .rpc('increment_message_count', { conv_id: conversationId });

  if (error) throw new Error(`Failed to increment message count: ${error.message}`);
}

/**
 * Mark a conversation as a specific status so it stops receiving AI replies.
 * status: 'lead_captured' | 'escalated' | 'spam' | 'completed'
 */
export async function updateConversationStatus(conversationId, status) {
  const { error } = await db()
    .from('conversations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', conversationId);

  if (error) throw new Error(`Failed to update conversation status: ${error.message}`);
}

// ─── Messages ─────────────────────────────────────────────────────────────────

/**
 * Store a single SMS message (user or assistant).
 */
export async function saveMessage(conversationId, role, content) {
  const { error } = await db()
    .from('messages')
    .insert({ conversation_id: conversationId, role, content });

  if (error) throw new Error(`Failed to save message: ${error.message}`);
}

/**
 * Load all messages in a conversation ordered oldest → newest.
 * Passed directly to Claude as conversation history.
 */
export async function getMessages(conversationId) {
  const { data, error } = await db()
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to load messages: ${error.message}`);
  return data || [];
}

// ─── Leads ────────────────────────────────────────────────────────────────────

/**
 * Save a captured lead to the database.
 */
export async function saveLead(conversationId, businessId, callerPhone, leadData) {
  const { data, error } = await db()
    .from('leads')
    .insert({
      conversation_id: conversationId,
      business_id: businessId,
      caller_phone: callerPhone,
      caller_name: leadData.name || null,
      issue: leadData.issue || null,
      preferred_time: leadData.preferred_time || null,
      raw_data: leadData,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to save lead: ${error.message}`);
  return data;
}

/**
 * Mark a lead as notified after we've texted the business owner.
 */
export async function markLeadNotified(leadId) {
  const { error } = await db()
    .from('leads')
    .update({ owner_notified: true })
    .eq('id', leadId);

  if (error) console.error(`Failed to mark lead notified: ${error.message}`);
}

/**
 * Get all leads for a business (used by the dashboard).
 */
export async function getLeadsForBusiness(businessId, limit = 50) {
  const { data, error } = await db()
    .from('leads')
    .select('*, conversations(caller_phone, created_at)')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch leads: ${error.message}`);
  return data || [];
}
