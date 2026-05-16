/**
 * Slack → Slate bridge (free tier friendly)
 * Receives Slack Events API / slash commands, triggers a Slate workflow via API.
 *
 * FIXES:
 * 1. Deduplicate Slack events using event_id (prevents retry duplicates)
 * 2. Acknowledge Slack immediately (200 OK) before triggering Slate
 * 3. Startup grace period — drops buffered Slack retries on restart
 * 4. Skip bot messages and edited/deleted subtypes (prevents feedback loops)
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
// When the server restarts, Slack immediately replays buffered events.
// We drop all events in the first 8 seconds to avoid duplicate Slate runs.
const START_TIME = Date.now();
const STARTUP_GRACE_MS = 8000;

function inStartupGrace() {
  return Date.now() - START_TIME < STARTUP_GRACE_MS;
}
// ──────────────────────────────────────────────────────────────────────────

// ── Deduplication cache ────────────────────────────────────────────────────
// Slack retries events if it doesn't get a fast 200. We cache event_ids for
// 60 s to drop duplicates before they hit Slate and cause 429 errors.
const seenEventIds = new Set();

function isDuplicate(eventId) {
  if (!eventId) return false;
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.add(eventId);
  setTimeout(() => seenEventIds.delete(eventId), 60_000);
  return false;
}
// ──────────────────────────────────────────────────────────────────────────

// Health check for Render/hosting
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'slack-slate-bridge',
    slate_configured: !!(SLATE_TOKEN && SLATE_WORKFLOW_ID),
    uptime_ms: Date.now() - START_TIME,
  });
});

// Slack Events API endpoint (set this as Request URL in Slack app)
app.post('/slack/events', (req, res) => {
  const body = req.body;

  // 1. URL verification challenge — must respond synchronously
  if (body?.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // 2. Acknowledge Slack IMMEDIATELY so it doesn't retry the event
  res.sendStatus(200);

  // 3. Drop events during startup grace window (Slack buffered retries)
  if (inStartupGrace()) {
    console.log('Startup grace period — event dropped:', body.event_id || '(no id)');
    return;
  }

  // 4. Deduplicate using event_id
  if (isDuplicate(body.event_id)) {
    console.log('Duplicate event dropped:', body.event_id);
    return;
  }

  // 5. Only handle event_callback
  if (body.type !== 'event_callback' || !body.event) return;

  const event = body.event;

  // 6. Skip bot messages and system subtypes (prevents feedback loops)
  if (event.bot_id) return;
  if (event.subtype === 'bot_message') return;
  if (event.subtype === 'message_changed') return;
  if (event.subtype === 'message_deleted') return;

  // 7. Fire Slate workflow asynchronously
  triggerSlate({ slackEvent: JSON.stringify(body) });
});

// Slack Slash commands (optional)
app.post('/slack/commands', (req, res) => {
  res.sendStatus(200);

  if (inStartupGrace()) {
    console.log('Startup grace period — slash command dropped');
    return;
  }

  triggerSlate({ slackCommand: req.body });
});

function triggerSlate(inputs) {
  if (!SLATE_TOKEN || !SLATE_WORKFLOW_ID) {
    console.error('Missing SLATE_API_TOKEN or SLATE_WORKFLOW_ID');
    return;
  }

  const url = `${SLATE_API_BASE}/workflow-service/api/public/v1/workflows/${SLATE_WORKFLOW_ID}/runs`;

  fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLATE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs, metadata: {} }),
  })
    .then((r) => {
      if (!r.ok) {
        return r.text().then((t) => {
          throw new Error(`Slate API ${r.status}: ${t}`);
        });
      }
      return r.json();
    })
    .then((data) => console.log('Slate run started:', data?.id || data))
    .catch((err) => console.error('Slate trigger failed:', err.message));
}

app.listen(PORT, () => {
  console.log(`Bridge listening on port ${PORT}`);
});
