name: Privacy & Security Reminders

on:
  schedule:
    # GitHub Actions cron is UTC.
    # 19:00 UTC = 11:00am Pacific during Standard Time.
    - cron: "0 19 * * 1"
  workflow_dispatch: {}

jobs:
  send-reminders:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Run reminder script
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
          NOTION_DATABASE_ID: ${{ secrets.NOTION_DATABASE_ID }}
          LOOKAHEAD_DAYS: "7"

          # Channel digest (incoming webhook)
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}

          # DMs (bot token + DM targets)
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
          SLACK_DM_USER_IDS: ${{ secrets.SLACK_DM_USER_IDS }}

        run: node reminders.js
