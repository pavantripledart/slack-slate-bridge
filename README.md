# Slack → Slate bridge (free)

Receives Slack events and slash commands at a public URL, then triggers your Slate workflow via API. Designed to run on **Render free tier** (no credit card).

## 1. Get your Slate workflow ID

In Slate, open the workflow you want to run when Slack events arrive. The workflow ID is in the URL or in the workflow settings. Your Slate workflow will receive:

- **Events** (e.g. messages, app_mention): `inputs.slackEvent`
- **Slash commands**: `inputs.slackCommand`

## 2. Deploy on Render (free)

1. Connect this repo in Render (New → Web Service → connect GitHub → select this repo).
2. **Build command:** `npm install`
3. **Start command:** `npm start`
4. In **Environment** add:
   - `SLATE_API_TOKEN` = your Slate API token (e.g. `slat_...`)
   - `SLATE_WORKFLOW_ID` = your Slate workflow ID
5. Deploy. Use the Render URL as your Slack Request URL: `https://YOUR-APP.onrender.com/slack/events`

## 3. Configure Slack

1. [api.slack.com/apps](https://api.slack.com/apps) → your app → **Event Subscriptions** → **Enable Events**.
2. **Request URL:** `https://YOUR-RENDER-URL.onrender.com/slack/events`
3. Subscribe to the events you need (e.g. `app_mention`, `message.channels`).
4. For **Slash commands**, set Request URL to: `https://YOUR-RENDER-URL.onrender.com/slack/commands`

## Endpoints

| Path              | Method | Use in Slack          |
|-------------------|--------|------------------------|
| `/slack/events`   | POST   | Event Subscriptions   |
| `/slack/commands` | POST   | Slash command URL     |
| `/`               | GET    | Health check          |
