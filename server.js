/**
 * Slack → Slate bridge (free tier friendly)
 * Receives Slack Events API / slash commands, triggers a Slate workflow via API.
 */
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SLATE_TOKEN = process.env.SLATE_API_TOKEN;
const SLATE_WORKFLOW_ID = process.env.SLATE_WORKFLOW_ID;
const SLATE_API_BASE = process.env.SLATE_API_BASE || 'https://api.slatehq.ai';

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
  // URL verification challenge – must return challenge to verify
  if (req.body?.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  res.sendStatus(200);

  const event = req.body;
  if (event.type === 'event_callback' && event.event) {
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

app.listen(PORT, () => {
  console.log(`Bridge listening on port ${PORT}`);
});
