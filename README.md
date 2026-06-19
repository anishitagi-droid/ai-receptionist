# AI Receptionist

Automated missed-call SMS system for local service businesses. When a call goes unanswered, the caller gets a text within 60 seconds. Claude handles the conversation, collects lead info, and notifies the business owner.

---

## How It Works

```
Customer calls Twilio number
        ↓
Twilio forwards to real business number
        ↓
    No answer?
        ↓
Twilio hits POST /voice/no-answer
        ↓
Server sends initial SMS to caller
        ↓
Caller replies → POST /sms
        ↓
Claude reads conversation history
        ↓
Claude replies + checks for lead info
        ↓
Lead captured → owner gets notified via SMS
```

---

## Part 1: Local Development Setup

### Step 1 — Clone and install

```bash
git clone <your-repo-url>
cd ai-receptionist
npm install
```

### Step 2 — Create your .env file

```bash
cp .env.example .env
```

Open `.env` in VS Code. You'll fill in each value in the steps below. Leave it open.

### Step 3 — Get your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Click **API Keys** in the left sidebar
4. Click **Create Key** — name it "ai-receptionist"
5. Copy the key (starts with `sk-ant-`)
6. Paste it into `.env` as `ANTHROPIC_API_KEY`

> ⚠️ You need to add a credit card and add at least $5 of credits. Go to **Billing** in the console.

### Step 4 — Set up Supabase

1. Go to [app.supabase.com](https://app.supabase.com) and create a free account
2. Click **New Project** — name it "ai-receptionist", pick a region close to you (US East or US West)
3. Wait ~2 minutes for it to spin up
4. Go to **Settings → API** in the left sidebar
5. Copy **Project URL** → paste as `SUPABASE_URL` in `.env`
6. Copy **service_role** key (click the eye icon to reveal) → paste as `SUPABASE_SERVICE_ROLE_KEY`
   > Use service_role (not anon) — it bypasses row-level security for server-to-server calls
7. Go to **SQL Editor** in the left sidebar
8. Click **New Query**
9. Open `supabase/schema.sql` from this project, copy the entire contents, paste into the editor, and click **Run**
10. You should see "Success" and the tables will appear in the **Table Editor**

### Step 5 — Set up Twilio

1. Go to [twilio.com](https://twilio.com) and create a free account
2. Verify your personal phone number during signup
3. From the **Console Dashboard**, copy:
   - **Account SID** → paste as `TWILIO_ACCOUNT_SID` in `.env`
   - **Auth Token** (click eye to reveal) → paste as `TWILIO_AUTH_TOKEN`
4. Buy a phone number:
   - Go to **Phone Numbers → Manage → Buy a Number**
   - Search for numbers in your area code
   - Make sure **Voice** and **SMS** capabilities are checked
   - Click **Buy** (~$1.15/month per number)
5. Copy that new number (e.g. `+16305550001`)
   - Update the `twilio_number` field in the sample business row in `supabase/schema.sql`
   - Or go to **Table Editor → businesses** in Supabase and update it there

> 💡 Free Twilio trial accounts can only send SMS to verified numbers. To test with any number, go to **Billing** and upgrade (costs nothing until you actually use it).

### Step 6 — Install ngrok (local tunnel)

Twilio needs a public URL to send webhooks to. During development, ngrok creates a temporary public URL that tunnels to your local machine.

```bash
# Install ngrok
npm install -g ngrok

# OR download from ngrok.com/download and follow their instructions
```

Create a free account at [ngrok.com](https://ngrok.com) and run:
```bash
ngrok config add-authtoken <your-ngrok-token>
```

### Step 7 — Run locally

Open **two terminal windows**:

**Terminal 1 — start the server:**
```bash
npm run dev
```
You should see the startup banner with all routes listed.

**Terminal 2 — start ngrok:**
```bash
ngrok http 3000
```

ngrok will show something like:
```
Forwarding   https://abc123.ngrok-free.app -> http://localhost:3000
```

Copy that `https://` URL. This is your temporary public URL.

### Step 8 — Connect Twilio to your server

1. Go back to Twilio → **Phone Numbers → Manage → Active Numbers**
2. Click your phone number
3. Scroll to **Voice & Fax**
4. Set **A Call Comes In** → Webhook → `https://YOUR-NGROK-URL/voice`
5. Scroll to **Messaging**
6. Set **A Message Comes In** → Webhook → `https://YOUR-NGROK-URL/sms`
7. Click **Save**

### Step 9 — Test it

1. Call your Twilio number from a phone
2. Let it ring (it will try to forward to the `real_number` in your DB — set that to your own phone first for testing, or just let it time out)
3. After ~20 seconds with no answer, you should get a text message
4. Reply to the text
5. Claude will respond based on the business config in your DB
6. Check your Supabase **Table Editor → messages** to see the conversation being saved

**Test the full lead capture flow:**
Reply to the SMS with your name, describe a fake problem, and say when you want a callback. After 2–3 messages, Claude should capture the lead and you should get a notification text to the `owner_phone` in your DB.

---

## Part 2: Deploying to Production (Railway)

Once it works locally, you deploy to Railway so it runs 24/7 without your laptop being open.

### Step 1 — Push your code to GitHub

```bash
git init
git add .
git commit -m "initial commit"
```

Go to [github.com](https://github.com), create a new repository named `ai-receptionist`, then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/ai-receptionist.git
git branch -M main
git push -u origin main
```

> ⚠️ Make sure `.env` is in your `.gitignore` — NEVER push your real API keys to GitHub.

Create a `.gitignore` file:
```
node_modules/
.env
```

### Step 2 — Create a Railway account

1. Go to [railway.app](https://railway.app)
2. Sign in with GitHub
3. You get $5/month free credit — enough for this project

### Step 3 — Deploy

1. Click **New Project → Deploy from GitHub Repo**
2. Select your `ai-receptionist` repository
3. Railway auto-detects Node.js and starts deploying

### Step 4 — Add environment variables to Railway

1. Click your deployed service
2. Go to the **Variables** tab
3. Add each variable from your `.env` file:
   ```
   TWILIO_ACCOUNT_SID     = ACxxx...
   TWILIO_AUTH_TOKEN      = your_token
   ANTHROPIC_API_KEY      = sk-ant-xxx...
   SUPABASE_URL           = https://xxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY = eyJxxx...
   NODE_ENV               = production
   ```
4. Railway automatically redeploys when you save variables

### Step 5 — Get your Railway URL

1. Go to **Settings → Networking → Public Networking**
2. Click **Generate Domain**
3. Copy the URL (e.g. `https://ai-receptionist-production.up.railway.app`)

### Step 6 — Update Twilio webhooks

Go back to Twilio → your phone number → update both webhooks with your Railway URL:
- Voice: `https://YOUR-RAILWAY-URL/voice`
- SMS: `https://YOUR-RAILWAY-URL/sms`

### Step 7 — Verify it's working

Visit `https://YOUR-RAILWAY-URL/health` in your browser. You should see:
```json
{ "status": "ok", "timestamp": "2024-..." }
```

Call your Twilio number and test the full flow again with the production URL.

---

## Adding a Real Client (Onboarding a New Business)

When you sign up a new client, add a row to the `businesses` table in Supabase:

1. Go to Supabase → **Table Editor → businesses → Insert Row**
2. Fill in all fields:
   ```
   name            → "Smith's Plumbing"
   twilio_number   → "+16305550001"   ← buy this in Twilio first
   owner_phone     → "+16305559999"   ← owner's mobile number
   real_number     → "+16305558888"   ← business's actual phone
   business_type   → "plumber"
   services        → "drain cleaning, water heater repair, leak detection..."
   service_area    → "Aurora, Naperville, and surrounding areas"
   hours           → "Mon-Fri 7am-7pm, Sat 8am-3pm, 24/7 emergency"
   price_note      → "Free estimates on all jobs"
   custom_faqs     → "Q: Do you work on weekends? A: Yes, Saturdays 8am-3pm."
   ```
3. Each client needs their own Twilio phone number (~$1.15/month)
4. Point that Twilio number's Voice and SMS webhooks at your Railway server

---

## Project File Structure

```
ai-receptionist/
├── src/
│   ├── index.js                 ← Express server, entry point
│   ├── middleware/
│   │   └── validateTwilio.js    ← Security: verify requests are from Twilio
│   ├── routes/
│   │   ├── voice.js             ← Inbound call handling + no-answer trigger
│   │   └── sms.js               ← Inbound SMS handler (main product loop)
│   ├── services/
│   │   ├── claude.js            ← AI conversation logic, prompt, response parsing
│   │   └── sms.js               ← Outbound SMS + owner notifications
│   └── db/
│       └── index.js             ← All Supabase database operations
├── supabase/
│   └── schema.sql               ← Run this once to set up your database
├── .env.example                 ← Template — copy to .env and fill in values
├── .gitignore
├── package.json
└── README.md
```

---

## Common Errors and Fixes

**"Business not found for number +1..."**
The Twilio number in the webhook doesn't match any row in your `businesses` table.
Fix: Check the `twilio_number` column in Supabase matches the Twilio number exactly, including the `+1`.

**"Invalid Twilio signature — request rejected"**
Your `TWILIO_AUTH_TOKEN` is wrong, or the URL in Twilio doesn't exactly match what your server sees.
Fix in development: make sure `NODE_ENV=development` in `.env` to skip validation.
Fix in production: double-check the auth token in Railway variables matches what's in Twilio console.

**Claude API errors / 401**
Your `ANTHROPIC_API_KEY` is invalid or has no credits.
Fix: Check the key in console.anthropic.com and add billing credits.

**SMS sends but conversation isn't saved to Supabase**
Usually a `SUPABASE_SERVICE_ROLE_KEY` issue.
Fix: Make sure you're using the `service_role` key, not the `anon` key.

**ngrok URL expired**
Free ngrok URLs expire when you restart ngrok. You'll need to update the Twilio webhook URLs every time.
Fix: For consistent local testing, get a static ngrok domain (free with a ngrok account).

---

## What to Build Next (Phase 2)

Once this is working with 1–2 real clients:

1. **Dashboard** — A simple Next.js page showing each business's leads and conversation stats. This is your retention tool — clients who can see their captured leads don't cancel.

2. **Monthly email report** — Auto-send a summary on the 1st of each month: leads captured, conversations started, estimated job value recovered.

3. **Multi-language support** — Claude already handles Spanish and other languages. Add a note in your pitch that it works for businesses with diverse customer bases.

4. **Calendly integration** — When a lead is captured, the bot can offer a direct booking link. Reduces friction for clients who use scheduling software.
