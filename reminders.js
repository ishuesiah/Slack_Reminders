/**
 * Notion → Slack Incoming Webhook reminders
 *
 * Required env vars:
 *  - NOTION_TOKEN
 *  - NOTION_DATABASE_ID
 *  - SLACK_WEBHOOK_URL
 *
 * Optional:
 *  - LOOKAHEAD_DAYS (default 7)
 *  - POST_WHEN_EMPTY ("true"|"false", default "true")
 *  - DONE_STATUS_NAME (default "Done")
 *
 * Notion property names (edit if your DB uses different names):
 *  - Title: "Name"
 *  - Date:  "Next due"
 *  - Status:"Status"
 *  - Type:  "Type" (optional; only used for nicer formatting)
 */

import "dotenv/config";
import dayjs from "dayjs";
import { Client as NotionClient } from "@notionhq/client";

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

const REQUIRED_ENVS = ["NOTION_TOKEN", "NOTION_DATABASE_ID", "SLACK_WEBHOOK_URL"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    throw new Error(`Missing required env var: ${k}`);
  }
}

const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const LOOKAHEAD_DAYS = parseInt(process.env.LOOKAHEAD_DAYS || "7", 10);
const POST_WHEN_EMPTY = (process.env.POST_WHEN_EMPTY || "true").toLowerCase() === "true";
const DONE_STATUS_NAME = process.env.DONE_STATUS_NAME || "Done";

// Notion property names (change these if your DB columns are named differently)
const PROP_TITLE = "Name";
const PROP_NEXT_DUE = "Next due";
const PROP_STATUS = "Status";
const PROP_TYPE = "Type";

function getTitle(page) {
  const prop = page.properties?.[PROP_TITLE];
  if (!prop || prop.type !== "title") return "(Untitled)";
  return prop.title?.map((t) => t.plain_text).join("")?.trim() || "(Untitled)";
}

function getSelect(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop) return "";
  if (prop.type === "select") return prop.select?.name || "";
  return "";
}

function getDate(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop) return null;
  if (prop.type === "date") return prop.date?.start || null;
  return null;
}

function safeISO(dateObj) {
  // Notion date filters accept ISO strings; keep it UTC-safe
  return dateObj.toISOString();
}

async function fetchDueItems() {
  const start = dayjs().startOf("day");
  const end = start.add(LOOKAHEAD_DAYS, "day").endOf("day");

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: PROP_NEXT_DUE, date: { on_or_after: safeISO(start.toDate()) } },
        { property: PROP_NEXT_DUE, date: { on_or_before: safeISO(end.toDate()) } },
        { property: PROP_STATUS, select: { does_not_equal: DONE_STATUS_NAME } },
      ],
    },
    sorts: [{ property: PROP_NEXT_DUE, direction: "ascending" }],
  });

  return response.results;
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

function formatMessage(items) {
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
      const type = getSelect(p, PROP_TYPE);
      const status = getSelect(p, PROP_STATUS);
      const tag = type ? `${type} — ` : "";
      const statusTxt = status ? ` _(Status: ${status})_` : "";
      lines.push(`• ${tag}${title}${statusTxt}`);
    }
  }

  return `${header}\n${lines.join("\n")}`;
}

async function postToSlack(text) {
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

async function main() {
  const items = await fetchDueItems();

  if (!items.length && !POST_WHEN_EMPTY) {
    console.log(`No items due in next ${LOOKAHEAD_DAYS} days. Not posting (POST_WHEN_EMPTY=false).`);
    return;
  }

  const message = formatMessage(items);
  await postToSlack(message);
  console.log(`Posted Slack reminder. Items: ${items.length}`);
}

main().catch((err) => {
  console.error("Reminder job failed:", err?.message || err);
  process.exit(1);
});
