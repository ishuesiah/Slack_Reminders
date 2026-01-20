/**
 * Notion → Slack reminders (Channel + DMs)
 *
 * Channel post: Slack Incoming Webhook
 * DMs: Slack Web API (bot token)
 *
 * Required env vars:
 *  - NOTION_TOKEN
 *  - NOTION_DATABASE_ID
 *  - SLACK_WEBHOOK_URL
 *
 * Optional env vars:
 *  - LOOKAHEAD_DAYS (default 7)
 *  - POST_WHEN_EMPTY ("true"|"false", default "true")
 *  - DONE_STATUS_NAME (default "Done")
 *
 * DM env vars :
 *  - SLACK_DM_USER_IDS   
 *  - SLACK_BOT_TOKEN     
 *
 * Notion property names expected (change these constants if yours differ):
 *  - Title: "Name"
 *  - Date:  "Next due"
 *  - Status:"Status"  (Select OR Status type)
 *  - Type:  "Type"    (optional)
 */

import "dotenv/config";
import dayjs from "dayjs";
import { Client as NotionClient } from "@notionhq/client";
import { WebClient as SlackWebClient } from "@slack/web-api";

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

// ====== CONFIG ======
const REQUIRED_ENVS = ["NOTION_TOKEN", "NOTION_DATABASE_ID", "SLACK_WEBHOOK_URL"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) throw new Error(`Missing required env var: ${k}`);
}

const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const LOOKAHEAD_DAYS = parseInt(process.env.LOOKAHEAD_DAYS || "7", 10);
const POST_WHEN_EMPTY = (process.env.POST_WHEN_EMPTY || "true").toLowerCase() === "true";
const DONE_STATUS_NAME = process.env.DONE_STATUS_NAME || "Done";

// DM recipients (Option A)
const DM_USER_IDS = (process.env.SLACK_DM_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const slack = SLACK_BOT_TOKEN ? new SlackWebClient(SLACK_BOT_TOKEN) : null;

// Notion property names (edit if your DB uses different column names)
const PROP_TITLE = "Name";
const PROP_NEXT_DUE = "Next due";
const PROP_STATUS = "Status";
const PROP_TYPE = "Type";

// ====== HELPERS (Notion) ======
function getTitle(page) {
  const prop = page.properties?.[PROP_TITLE];
  if (!prop || prop.type !== "title") return "(Untitled)";
  return (prop.title || []).map((t) => t.plain_text).join("").trim() || "(Untitled)";
}

function getDate(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop) return null;
  if (prop.type === "date") return prop.date?.start || null;
  return null;
}

function getTypeName(page) {
  const prop = page.properties?.[PROP_TYPE];
  if (!prop) return "";
  if (prop.type === "select") return prop.select?.name || "";
  return "";
}

function getStatusName(page) {
  const prop = page.properties?.[PROP_STATUS];
  if (!prop) return "";
  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "status") return prop.status?.name || "";
  return "";
}

function safeISO(d) {
  return d.toISOString();
}

// ====== NOTION QUERY ======
async function fetchDueItems() {
  const start = dayjs().startOf("day");
  const end = start.add(LOOKAHEAD_DAYS, "day").endOf("day");

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: PROP_NEXT_DUE, date: { on_or_after: safeISO(start.toDate()) } },
        { property: PROP_NEXT_DUE, date: { on_or_before: safeISO(end.toDate()) } },
      ],
    },
    // Sorting is nice once your property name is correct
    sorts: [{ property: PROP_NEXT_DUE, direction: "ascending" }],
  });

  // Filter out Done locally (works whether Status is Select or Status type)
  return response.results.filter((p) => getStatusName(p) !== DONE_STATUS_NAME);
}

// ====== MESSAGE FORMATTING ======
function groupByDueDate(items) {
  const groups = new Map();
  for (const p of items) {
    const due = getDate(p, PROP_NEXT_DUE);
    const key = due ? dayjs(due).format("YYYY-MM-DD") : "No due date";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

function formatDigest(items) {
  const header = `🔔 *Privacy & Security Reminders* (next ${LOOKAHEAD_DAYS} days)`;

  if (!items.length) {
    return `${header}\n✅ Nothing due in the next ${LOOKAHEAD_DAYS} days.`;
  }

  const grouped = groupByDueDate(items);
  const lines = [];

  for (const [dueDate, pages] of grouped.entries()) {
    lines.push(`\n*${dueDate}*`);
    for (const p of pages) {
      const title = getTitle(p);
      const type = getTypeName(p);
      const status = getStatusName(p);
      const prefix = type ? `${type} — ` : "";
      const statusTxt = status ? ` _(Status: ${status})_` : "";
      lines.push(`• ${prefix}${title}${statusTxt}`);
    }
  }

  return `${header}\n${lines.join("\n")}`;
}

// ====== SLACK (Webhook) ======
async function postToSlackWebhook(text) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed: ${res.status} ${body}`);
  }
}

// ====== SLACK (DM via Bot Token) ======
async function dmUser(userId, text) {
  if (!slack) throw new Error("SLACK_BOT_TOKEN is missing (required for DMs).");

  // Open (or get) DM channel, then post message
  const openResp = await slack.conversations.open({ users: userId, return_im: true });
  const channelId = openResp?.channel?.id;

  if (!channelId) throw new Error(`Could not open DM with user ${userId}`);

  await slack.chat.postMessage({ channel: channelId, text });
}

// ====== MAIN ======
async function main() {
  const items = await fetchDueItems();

  // Channel digest
  if (items.length || POST_WHEN_EMPTY) {
    const message = formatDigest(items);
    await postToSlackWebhook(message);
  } else {
    console.log(`No items due in next ${LOOKAHEAD_DAYS} days. Not posting (POST_WHEN_EMPTY=false).`);
  }

  // DMs (Option A): same DM recipients every time
  if (DM_USER_IDS.length) {
    if (!slack) {
      console.warn(
        "SLACK_DM_USER_IDS is set but SLACK_BOT_TOKEN is missing. Skipping DMs."
      );
    } else if (items.length) {
      const dmText = `👋 Here are the items due soon:\n\n${formatDigest(items)}`;
      for (const uid of DM_USER_IDS) {
        await dmUser(uid, dmText);
        // gentle pacing to avoid rate-limit issues
        await new Promise((r) => setTimeout(r, 1100));
      }
    } else {
      console.log("No due items; skipping DMs.");
    }
  }

  console.log(
    `Done. Due items: ${items.length}. Channel posted: ${items.length || POST_WHEN_EMPTY}. DMs: ${
      DM_USER_IDS.length ? "configured" : "not configured"
    }.`
  );
}

main().catch((err) => {
  console.error("Reminder job failed:", err?.message || err);
  process.exit(1);
});
