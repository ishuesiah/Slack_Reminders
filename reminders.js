/**
 * Privacy reminders
 *
 * Required env:
 *  - NOTION_TOKEN
 *  - NOTION_DATABASE_ID
 *
 * Optional env:
 *  - SLACK_WEBHOOK_URL         (posts digest to channel via incoming webhook)
 *  - LOOKAHEAD_DAYS            (default 7)
 *  - POST_WHEN_EMPTY           ("true"/"false", default "true")
 *  - DONE_STATUS_NAME          (default "Done")
 *
 * DM env (optional):
 *  - SLACK_BOT_TOKEN           (xoxb-..., required to send DMs)
 *  - SLACK_DM_USER_IDS         (comma/space separated list of U... or D... ids)
 *
 * Notion properties expected (rename constants if yours differ):
 *  - Title:  "Name"
 *  - Date:   "Next due"
 *  - Status: "Status" (Select or Status type)
 *  - Type:   "Type" (optional)
 *  - Environment: "Environment" (optional)
 */

import "dotenv/config";
import dayjs from "dayjs";
import { Client as NotionClient } from "@notionhq/client";
import { WebClient as SlackWebClient } from "@slack/web-api";

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

// ====== ENV / CONFIG ======
const REQUIRED_ENVS = ["NOTION_TOKEN", "NOTION_DATABASE_ID"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) throw new Error(`Missing required env var: ${k}`);
}

const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || ""; // optional
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";     // optional (required for DMs)

const LOOKAHEAD_DAYS = parseInt(process.env.LOOKAHEAD_DAYS || "7", 10);
const POST_WHEN_EMPTY = (process.env.POST_WHEN_EMPTY || "true").toLowerCase() === "true";
const DONE_STATUS_NAME = process.env.DONE_STATUS_NAME || "Done";

// DM targets (U... user IDs and/or D... DM channel IDs)
const DM_TARGETS = (process.env.SLACK_DM_USER_IDS || "")
  .split(/[, \n\r\t]+/g)
  .map((s) => s.trim())
  .filter(Boolean);

// Only create Slack client if we have a bot token
const slack = SLACK_BOT_TOKEN ? new SlackWebClient(SLACK_BOT_TOKEN) : null;

// ====== Notion property names ======
const PROP_TITLE = "Name";
const PROP_NEXT_DUE = "Next due";
const PROP_STATUS = "Status";
const PROP_TYPE = "Type";
const PROP_ENV = "Environment";

// ====== Helpers ======
function safeISO(d) {
  return d.toISOString();
}

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

function getSelectName(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop) return "";
  if (prop.type === "select") return prop.select?.name || "";
  return "";
}

function getStatusName(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop) return "";
  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "status") return prop.status?.name || "";
  return "";
}

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
      const type = getSelectName(p, PROP_TYPE);
      const env = getSelectName(p, PROP_ENV);
      const status = getStatusName(p, PROP_STATUS);

      const prefixBits = [type, env].filter(Boolean);
      const prefix = prefixBits.length ? `${prefixBits.join(" / ")} — ` : "";
      const statusTxt = status ? ` _(Status: ${status})_` : "";

      lines.push(`• ${prefix}${title}${statusTxt}`);
    }
  }

  return `${header}\n${lines.join("\n")}`;
}

// ====== Notion query ======
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
    sorts: [{ property: PROP_NEXT_DUE, direction: "ascending" }],
  });

  // Filter out Done locally (works for Status-as-Select or Status-as-Status)
  return (response.results || []).filter((p) => getStatusName(p, PROP_STATUS) !== DONE_STATUS_NAME);
}

// ====== Slack sending ======
async function postToSlackWebhook(text) {
  if (!SLACK_WEBHOOK_URL) return false;

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed: ${res.status} ${body}`);
  }
  return true;
}

async function openBotDmWithUser(userId) {
  if (!slack) throw new Error("Missing SLACK_BOT_TOKEN (required for DMs).");

  // Open/resume bot<->user DM, then we can post to that DM channel ID (D...)
  const openResp = await slack.conversations.open({ users: userId, return_im: true });
  const dmChannelId = openResp?.channel?.id;

  if (!dmChannelId) throw new Error(`Could not open DM with user ${userId}`);
  return dmChannelId;
}

async function dmTarget(targetId, text) {
  if (!slack) throw new Error("Missing SLACK_BOT_TOKEN (required for DMs).");

  // If you provide a DM channel ID (D...), post directly to it
  if (targetId.startsWith("D")) {
    await slack.chat.postMessage({ channel: targetId, text });
    return;
  }

  // If you provide a user ID (U...), open the bot DM then post to that DM channel
  if (targetId.startsWith("U")) {
    const dmChannelId = await openBotDmWithUser(targetId);
    await slack.chat.postMessage({ channel: dmChannelId, text });
    return;
  }

  throw new Error(`DM target must start with U or D. Got: ${targetId}`);
}

// ====== Main ======
async function main() {
  const items = await fetchDueItems();
  const message = formatDigest(items);

  // Channel digest
  const postedToChannel = (items.length || POST_WHEN_EMPTY) ? await postToSlackWebhook(message) : false;

  // DMs only when there are due items
  let dmsSent = 0;
  if (items.length && DM_TARGETS.length) {
    if (!slack) {
      throw new Error("SLACK_DM_USER_IDS is set but SLACK_BOT_TOKEN is missing.");
    }

    for (const target of DM_TARGETS) {
      await dmTarget(target, message);
      dmsSent += 1;
      // polite pacing
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  console.log(
    `Done. Due items: ${items.length}. Channel posted: ${postedToChannel ? 1 : 0}. DMs sent: ${dmsSent}.`
  );
}

main().catch((err) => {
  console.error("Reminder job failed:", err?.message || err);
  process.exit(1);
});
