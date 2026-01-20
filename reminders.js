import 'dotenv/config';
import dayjs from 'dayjs';
import { Client as NotionClient } from '@notionhq/client';
import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const LOOKAHEAD_DAYS = parseInt(process.env.LOOKAHEAD_DAYS || '7', 10);

function getTitle(page) {
  const prop = page.properties?.Name;
  const title = prop?.title?.[0]?.plain_text;
  return title || '(Untitled)';
}

function getSelect(page, propName) {
  const prop = page.properties?.[propName];
  return prop?.select?.name || '';
}

function getDate(page, propName) {
  const prop = page.properties?.[propName];
  return prop?.date?.start || null;
}

async function fetchDueItems() {
  const today = dayjs().startOf('day');
  const end = today.add(LOOKAHEAD_DAYS, 'day').endOf('day');

  // Notion date filters support on_or_after/on_or_before. :contentReference[oaicite:8]{index=8}
  const resp = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: 'Next due', date: { on_or_after: today.toISOString() } },
        { property: 'Next due', date: { on_or_before: end.toISOString() } },
        { property: 'Status', select: { does_not_equal: 'Done' } },
      ],
    },
    sorts: [{ property: 'Next due', direction: 'ascending' }],
  });

  return resp.results;
}

function formatDigest(items) {
  const header = `🔔 Privacy & Security Reminders (next ${LOOKAHEAD_DAYS} days)`;

  if (!items.length) {
    return `${header}\n✅ Nothing due in the next ${LOOKAHEAD_DAYS} days.`;
  }

  const lines = items.map((p) => {
    const name = getTitle(p);
    const type = getSelect(p, 'Type');
    const due = getDate(p, 'Next due');
    const dueFmt = due ? dayjs(due).format('YYYY-MM-DD') : 'No date';
    const status = getSelect(p, 'Status');
    return `• ${dueFmt} — ${type || 'Task'} — ${name}${status ? ` (Status: ${status})` : ''}`;
  });

  return `${header}\n${lines.join('\n')}`;
}

async function postToSlack(text) {
  // chat.postMessage posts to channels/conversations your bot can access. :contentReference[oaicite:9]{index=9}
  await slack.chat.postMessage({
    channel: CHANNEL_ID,
    text,
  });
}

(async () => {
  const items = await fetchDueItems();
  const message = formatDigest(items);
  await postToSlack(message);
  console.log('Posted reminders:', items.length);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
