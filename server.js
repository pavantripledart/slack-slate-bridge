/**
 * Slack → Slate bridge (free tier friendly)
 * Receives Slack Events API / slash commands, triggers a Slate workflow via API.
 *
 * FIXES:
 * 1. Deduplicate Slack events using event_id to prevent multiple concurrent Slate runs
 * 2. Acknowledge Slack immediately (200 OK) before triggering Slate so Slack doesn't retry
 * 3. Skip bot messages and message_changed subtypes to avoid feedback loops
 */

const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SLATE_TOKEN = process.env.SLATE_API_TOKEN;
const SLATE_WORKFLOW_ID = process.env.SLATE_WORKFLOW_ID;
const SLATE_API_BASE = process.env.SLATE_API_BASE || 'https://api.slatehq.ai';

// ── Deduplication cache ────────────────────────────────────────────────────
// Slack retries events if it doesn't get a fast 200. We cache event_ids for
// 60 s to drop duplicates before they hit Slate and cause 429 errors.
const seenEventIds = new Set();

function isDuplicate(eventId) {
  if (!eventId) return false;
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.add(eventId);
  // Auto-clean after 60 s so the Set doesn't grow forever
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
  });
});

// Slack Events API endpoint (set this as Request URL in Slack app)
app.post('/slack/events', (req, res) => {
  const body = req.body;

  // 1. URL verification challenge – must return challenge to verify endpoint
  if (body?.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // 2. Acknowledge Slack IMMEDIATELY so it doesn't retry the event
  res.sendStatus(200);

  // 3. Deduplicate using event_id
  if (isDuplicate(body.event_id)) {
    console.log('Duplicate event dropped:', body.event_id);
    return;
  }

  // 4. Only handle event_callback events
  if (body.type !== 'event_callback' || !body.event) return;

  const event = body.event;

  // 5. Skip bot messages and edited messages to prevent feedback loops
  if (event.bot_id) return;
  if (event.subtype === 'bot_message') return;
  if (event.subtype === 'message_changed') return;
  if (event.subtype === 'message_deleted') return;

  // 6. Fire Slate workflow asynchronously
  triggerSlate({ slackEvent: JSON.stringify(body) });
});

// Slack Slash commands (optional – use if you add slash commands)
app.post('/slack/commands', (req, res) => {
  // Acknowledge immediately
  res.sendStatus(200);
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
