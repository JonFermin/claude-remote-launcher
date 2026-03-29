# iOS Shortcut Setup

One-tap shortcut: pick a project, launch a Claude remote-control session, open it in Safari.

## Prerequisites

1. Server running on your PC: `node server.js`
2. Tailscale Serve exposing it: `tailscale serve --bg 3777`
3. Note your Tailscale URL (e.g. `https://your-machine.tail12345.ts.net`)
4. Note your `LAUNCHER_TOKEN` from `.env`

## Build the Shortcut

Open the **Shortcuts** app on your iPhone and create a new shortcut.

### Step 1: Set Variables

Add a **Text** action:
```
https://your-machine.tail12345.ts.net
```
Set variable name: `BaseURL`

Add another **Text** action:
```
your-launcher-token-here
```
Set variable name: `Token`

### Step 2: Fetch Project List

Add **Get Contents of URL**:
- URL: `BaseURL/projects`
- Method: `GET`
- Headers:
  - `Authorization`: `Bearer [Token]`

### Step 3: Pick a Project

Add **Get Dictionary Value**:
- Get: `Value` for key `projects`

Add **Choose from List**:
- This shows the project list — tap to pick one

Add **Get Dictionary Value**:
- Get: `Value` for key `path` from the chosen item

Set variable name: `ProjectPath`

### Step 4: Launch Remote Control

Add **Get Contents of URL**:
- URL: `BaseURL/remote-control`
- Method: `POST`
- Headers:
  - `Authorization`: `Bearer [Token]`
  - `Content-Type`: `application/json`
- Request Body (JSON):
  ```json
  { "cwd": "[ProjectPath]" }
  ```

### Step 5: Extract URL

Add **Get Dictionary Value**:
- Get: `Value` for key `url`

Set variable name: `SessionURL`

### Step 6: Handle Polling (if URL not immediately available)

Add **If**:
- Input: `SessionURL`
- Condition: `has any value`

  **If yes**: skip to Step 7

  **Otherwise**:
  - Get Dictionary Value: key `id` from Step 4 result → `SessionID`
  - **Repeat 15 times**:
    - **Wait** 2 seconds
    - **Get Contents of URL**: `BaseURL/status/[SessionID]` (GET, same auth headers)
    - **Get Dictionary Value**: key `url`
    - **If** has any value:
      - Set variable `SessionURL`
      - **Exit Repeat**

**End If**

### Step 7: Open the Session

Add **Open URL**:
- URL: `SessionURL`

This opens the Claude Code session in Safari.

## Finishing Touches

- Tap the shortcut name at top → rename to **"Claude"**
- Tap the icon → pick a color/glyph (the terminal icon works well)
- Tap **"Add to Home Screen"** to get a one-tap launcher

## Alternative: Simpler Version (No Project Picker)

If you usually work in one project, skip Steps 2-3 and hardcode the path:

**Text** action: `/path/to/your/project` → set as `ProjectPath`

Then continue from Step 4.

## Troubleshooting

- **"Unauthorized"**: Check your token matches `.env`
- **No URL returned**: The `claude remote-control` command may take a few seconds. The polling in Step 6 handles this.
- **Can't reach server**: Make sure Tailscale is connected on both devices. Check `tailscale status`.
- **Timeout**: The server waits up to 15s for the URL. If Claude is slow to start, increase the repeat count in Step 6.
