const express = require('express');
const app = express();
app.use(express.json());

// ============================================
// IN-MEMORY DEDUPLICATION (No Redis needed!)
// ============================================
const processedEvents = new Map();
const EVENT_TTL = 60000; // 60 seconds

function isDuplicate(eventId) {
  if (!eventId) return false;
  
  // Clean old entries every check
  const now = Date.now();
  for (const [id, timestamp] of processedEvents) {
    if (now - timestamp > EVENT_TTL) {
      processedEvents.delete(id);
    }
  }
  
  if (processedEvents.has(eventId)) {
    return true;
  }
  
  processedEvents.set(eventId, now);
  return false;
}

// ============================================
// WORKFLOW ROUTING
// ============================================
const WORKFLOWS = {
  'C0ALJAHLV3N': {
    name: 'GSC & GA4 Agent',
    slateUrl: 'https://app.slatehq.ai/api/v1/run/69b3f42f3f4ea8bbd0d2fc04/sync'
  }
  // Add more channels here as needed
};

// ============================================
// SLACK ENDPOINT
// ============================================
app.post('/slack/events', async (req, res) => {
  const body = req.body;
  
  // Handle Slack URL verification
  if (body.type === 'url_verification') {
    console.log('Slack verification challenge received');
    return res.json({ challenge: body.challenge });
  }
  
  // Ignore retries via header (belt)
  if (req.headers['x-slack-retry-num']) {
    console.log('Ignoring Slack retry');
    return res.status(200).send('OK - ignoring retry');
  }
  
  // Ignore duplicates via event ID (suspenders)
  const eventId = body.event_id;
  if (isDuplicate(eventId)) {
    console.log(`Duplicate event ${eventId}, skipping`);
    return res.status(200).send('OK - duplicate');
  }
  
  // Respond immediately to Slack (required within 3 seconds)
  res.status(200).send('OK');
  
  // Process the event
  const event = body.event;
  if (!event || event.type !== 'app_mention') {
    console.log('Not an app_mention, ignoring');
    return;
  }
  
  const channel = event.channel;
  const workflow = WORKFLOWS[channel];
  
  if (!workflow) {
    console.log(`No workflow configured for channel ${channel}`);
    return;
  }
  
  console.log(`Triggering ${workflow.name} for channel ${channel}`);
  
  try {
    const response = await fetch(workflow.slateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slackEvent: body })
    });
    
    const result = await response.text();
    console.log(`Slate response: ${response.status} - ${result.substring(0, 200)}`);
  } catch (error) {
    console.error('Error triggering Slate:', error.message);
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Slack-Slate Bridge is running');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Bridge listening on port ${PORT}`);
});
