/**
 * Slack → Slate bridge — with queue to handle concurrent run limits
 *
 * FIXES:
 * 1. Queue — if Slate is busy (429), retry after a delay instead of dropping
 * 2. Deduplication — drop Slack retry duplicates via event_id cache
 * 3. Immediate 200 ACK — so Slack never retries due to slow response
 * 4. Bot/subtype filters — prevent feedback loops
 * 5. Startup grace — drop buffered Slack events on server restart
 */

const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SLATE_TOKEN = process.env.SLATE_API_TOKEN;
const SLATE_WORKFLOW_ID = process.env.SLATE_WORKFLOW_ID;
const SLATE_API_BASE = process.env.SLATE_API_BASE || 'https://api.slatehq.ai';

// ── Startup grace period ───────────────────────────────────────────────────
const START_TIME = Date.now();
const STARTUP_GRACE_MS = 8000;
function inStartupGrace() {
  return Date.now() - START_TIME < STARTUP_GRACE_MS;
}

// ── Deduplication cache ────────────────────────────────────────────────────
const seenEventIds = new Set();
function isDuplicate(eventId) {
  if (!eventId) return false;
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.add(eventId);
  setTimeout(() => seenEventIds.delete(eventId), 60_000);
  return false;
}

// ── Queue ──────────────────────────────────────────────────────────────────
// Slate free tier only allows 1 concurrent run. We queue events and
// process them one at a time with a delay between each.
const queue = [];
let processing = false;

const RETRY_DELAY_MS = 15000; // wait 15s before retrying after a 429
const MAX_RETRIES = 4;        // give up after 4 attempts (~60s total)

function enqueue(inputs) {
  queue.push({ inputs, attempts: 0 });
  processQueue();
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  const item = queue[0];
  item.attempts += 1;

  try {
    const success = await fireSlate(item.inputs);
    if (success) {
      queue.shift(); // remove from queue on success
      processing = false;
      if (queue.length > 0) {
        setTimeout(processQueue, 2000); // small gap before next item
      }
    } else {
      // 429 or transient error — retry after delay if attempts remain
      if (item.attempts >= MAX_RETRIES) {
        console.error('Max retries reached, dropping event');
        queue.shift();
        processing = false;
        if (queue.length > 0) setTimeout(processQueue, 2000);
      } else {
        console.log(`Slate busy — retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${item.attempts}/${MAX_RETRIES})`);
        processing = false;
        setTimeout(processQueue, RETRY_DELAY_MS);
      }
    }
  } catch (err) {
    console.error('Unexpected error in queue processing:', err.message);
    queue.shift();
    processing = false;
    if (queue.length > 0) setTimeout(processQueue, 2000);
  }
}

// Returns true on success, false on 429/error
async function fireSlate(inputs) {
  if (!SLATE_TOKEN || !SLATE_WORKFLOW_ID) {
    console.error('Missing SLATE_API_TOKEN or SLATE_WORKFLOW_ID');
    return true; // don't retry config errors
  }

  const url = `${SLATE_API_BASE}/workflow-service/api/public/v1/workflows/${SLATE_WORKFLOW_ID}/runs`;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLATE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs, metadata: {} }),
    });

    if (r.status === 429) {
      console.log('Slate returned 429 — Too many concurrent runs');
      return false; // signal to retry
    }

    if (!r.ok) {
      const t = await r.text();
      console.error(`Slate API ${r.status}: ${t}`);
      return true; // non-429 errors — don't retry
    }

    const data = await r.json();
    console.log('Slate run started:', data?.id || data);
    return true;
  } catch (err) {
    console.error('Slate trigger failed:', err.message);
    return true; // network errors — don't retry to avoid infinite loops
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'slack-slate-bridge',
    slate_configured: !!(SLATE_TOKEN && SLATE_WORKFLOW_ID),
    uptime_ms: Date.now() - START_TIME,
    queue_length: queue.length,
    processing,
  });
});

app.post('/slack/events', (req, res) => {
  const body = req.body;

  // URL verification
  if (body?.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // Acknowledge immediately
  res.sendStatus(200);

  // Startup grace
  if (inStartupGrace()) {
    console.log('Startup grace — event dropped:', body.event_id || '(no id)');
    return;
  }

  // Deduplicate
  if (isDuplicate(body.event_id)) {
    console.log('Duplicate event dropped:', body.event_id);
    return;
  }

  if (body.type !== 'event_callback' || !body.event) return;

  const event = body.event;

  // Skip bot messages / system subtypes
  if (event.bot_id) return;
  if (event.subtype === 'bot_message') return;
  if (event.subtype === 'message_changed') return;
  if (event.subtype === 'message_deleted') return;

  // Enqueue (will retry on 429 automatically)
  enqueue({ slackEvent: JSON.stringify(body) });
});

app.post('/slack/commands', (req, res) => {
  res.sendStatus(200);
  if (inStartupGrace()) return;
  enqueue({ slackCommand: req.body });
});

app.listen(PORT, () => {
  console.log(`Bridge listening on port ${PORT}`);
});
