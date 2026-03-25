/**
 * Slack → Slate bridge (production / high-volume)
 * Receives Slack Events API / slash commands, triggers a Slate workflow via API.
 * 
 * Added for high-volume:
 * - Redis-based event deduplication
 * - Retry header detection
 * - Bot message loop prevention
 */
const express = require('express');
const Redis = require('ioredis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SLATE_TOKEN = process.env.SLATE_API_TOKEN;
const SLATE_WORKFLOW_ID = process.env.SLATE_WORKFLOW_ID;
const SLATE_API_BASE = process.env.SLATE_API_BASE || 'https://api.slatehq.ai';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEDUP_TTL_SECONDS = 600; // 10 minutes

// Redis client
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
});

redis.on('connect', () => console.log('Redis connected'));
redis.on('error', (err) => console.error('Redis error:', err.message));

/**
 * Check if event was already processed (Redis-backed)
 */
async function isDuplicate(eventId) {
  if (!eventId) return false;
  
  const key = `slack:event:${eventId}`;
  const exists = await redis.get(key);
  
  if (exists) return true;
  
  await redis.setex(key, DEDUP_TTL_SECONDS, '1');
  return false;
}

// Health check for Render/hosting
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'slack-slate-bridge',
    slate_configured: !!(SLATE_TOKEN && SLATE_WORKFLOW_ID),
    redis_status: redis.status,
  });
});

// Slack Events API endpoint (set this as Request URL in Slack app)
app.post('/slack/events', async (req, res) => {
  // URL verification challenge – must return challenge to verify
  if (req.body?.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  res.sendStatus(200);

  // Ignore Slack retries via header
  if (req.headers['x-slack-retry-num']) {
    console.log(`Ignoring retry #${req.headers['x-slack-retry-num']}`);
    return;
  }

  const event = req.body;

  // Deduplicate by event_id
  if (await isDuplicate(event.event_id)) {
    console.log(`Duplicate skipped: ${event.event_id}`);
    return;
  }

  if (event.type === 'event_callback' && event.event) {
    const innerEvent = event.event;

    // Skip bot messages to prevent loops
    if (innerEvent.bot_id || innerEvent.subtype === 'bot_message') {
      console.log('Skipping bot message');
      return;
    }

    triggerSlate({ slackEvent: event });
  }
});

// Slack Slash commands (optional – use if you add slash commands)
app.post('/slack/commands', (req, res) => {
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
    body: JSON.stringify({
      inputs,
      metadata: {},
    }),
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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await redis.quit();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Bridge listening on port ${PORT}`);
});
