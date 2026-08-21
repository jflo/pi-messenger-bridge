# pi-messenger-bridge — Orientation

This document gives an overview of the repo. It also gives a tour of every
source file. Read it first if you are new to this codebase.

## 1. Purpose

`pi-messenger-bridge` is a `pi` extension. `pi` is a coding agent framework.
The extension connects `pi` to chat platforms: Slack, Discord, Telegram,
WhatsApp, and Matrix.

A user sends a chat message on any platform. The extension turns that
message into a `pi` agent turn. The agent replies. The extension sends the
reply back to the same platform.

The extension hides platform differences behind one common interface. `pi`
core code does not need per-platform logic. Only this extension does.

This repo is a fork of `tintinweb/pi-messenger-bridge` on GitHub. The fork
lives at `jflo/pi-messenger-bridge`. The gorgor project (`gorgors-notebook`)
clones a pinned commit of this fork into its Docker build. Gorgor uses
Slack as its primary transport.

## 2. Architecture overview

### Entry point

`src/index.ts` is the extension's entry point. It exports one default
function. `pi` calls this function once, at extension load time. The
function receives a `pi: ExtensionAPI` object and wires up all extension
behavior:

- Event handlers for `session_start`, `turn_start`, `turn_end`, and
  `session_shutdown`.
- A tool, `slack_upload_file`, that lets the agent post a local file to the
  active Slack chat.
- A command, `/msg-bridge`, with subcommands for status, connect,
  disconnect, configure, and more.

### Transport layer

A **transport** is one platform integration: Slack, Discord, Telegram,
WhatsApp, or Matrix. Every transport implements the same contract, defined
in `src/transports/interface.ts` as the `ITransportProvider` interface.
This document uses the term "transport" for this concept throughout.

`ITransportProvider` requires each transport to implement:

- `connect()` and `disconnect()` — open and close the platform connection.
- `sendMessage(chatId, text, options)` — send a text reply.
- `sendTyping(chatId, messageId)` and `clearTyping(...)` — signal that the
  agent is working on a reply.
- `onMessage(handler)` and `onError(handler)` — register callbacks for
  inbound messages and errors.
- `type` (a string like `"slack"`) and `isConnected` (a boolean).

`src/transports/manager.ts` defines `TransportManager`. It holds every
active transport in a map, keyed by `type`. It forwards each transport's
messages and errors to one shared handler. It exposes `connectAll()`,
`disconnectAll()`, and per-transport `sendMessage`/`sendTyping`/
`clearTyping` calls that look up the right transport by `type`.
`src/index.ts` owns exactly one `TransportManager` instance per session.

### Platform transports

Each platform has its own file under `src/transports/`:

- `slack.ts` — uses `@slack/bolt`, socket mode.
- `discord.ts` — uses `discord.js`.
- `telegram.ts` — uses `node-telegram-bot-api`, polling mode.
- `whatsapp.ts` — uses `@whiskeysockets/baileys`, QR-code pairing.
- `matrix.ts` — uses `matrix-bot-sdk`, works with any Matrix homeserver.

Two files hold pure formatting helpers, split out from their transport so
they can be unit-tested without a live SDK connection:

- `matrix-utils.ts` — Markdown-to-Matrix-HTML conversion, mention
  detection, event filtering.
- `slack-utils.ts` — Markdown-to-Slack-mrkdwn conversion, including a
  GFM table fallback.

### Supporting modules

- `src/auth/challenge-auth.ts` — `ChallengeAuth` class. Handles user trust
  and admin commands. See section 4.
- `src/config.ts` — loads and saves `~/.pi/msg-bridge.json`. Environment
  variables override the file. See section 6 for the variable names.
- `src/formatting.ts` — turns a `pi` `AssistantMessage` into plain text for
  a chat reply. Splits long replies into chunks.
- `src/lock.ts` — a single-instance guard. Stops two `pi` processes from
  connecting the same transport twice.
- `src/types.ts` — shared TypeScript interfaces: `ExternalMessage`,
  `MsgBridgeConfig`, `PendingRemoteChat`, `SendMessageOptions`,
  `TransportStatus`.
- `src/ui/main-menu.ts` — the interactive menu for `/msg-bridge` with no
  arguments. Skipped in RPC mode (see section 6).
- `src/ui/status-widget.ts` — builds the one-line status string shown in
  the `pi` TUI.

### Tests

Test files sit next to the source file they cover, named `*.test.ts`:
`src/auth/challenge-auth.test.ts`, `src/transports/matrix-utils.test.ts`,
`src/transports/slack-utils.test.ts`, `src/ui/main-menu.test.ts`. A second
set of tests lives under `tests/`, covering `config.ts`, `formatting.ts`,
`lock.ts`, and `index.ts`'s RPC command handling. The test runner is
`vitest` (`npm test`).

### Build and lint

`npm run build` runs `tsc` and writes output to `dist/`. `package.json`'s
`main` field points at `dist/index.js` — this is what `pi` actually loads.
`npm run lint` runs Biome (`biome.json`). Biome only checks `src/**/*.ts`;
it does not format code (`formatter.enabled` is `false`). CI
(`.github/workflows/ci.yml`) runs on every push and pull request to
`master`: install, lint, typecheck, test, in that order.

## 3. File-by-file tour

### Entry point

**`src/index.ts`**

Holds all extension wiring in one closure. Key pieces:

- `isRpcMode(context)` — returns `true` when `pi` runs without an
  interactive UI. Checks `context.mode` first, falls back to
  `!context.hasUI`. See section 6.
- `safeNotify(message, level)` — wraps `ctx.ui.notify()`. Catches and logs
  errors instead of throwing. `ctx` can go stale after a session reload;
  an uncaught throw here would crash the whole `pi` process. See section 5.
- `emitEvent(type, data)` — writes one JSON line to `stderr`, prefixed
  `[msg-bridge:event]`, only in RPC mode. This is how an RPC client
  observes bridge state. `stdout` is `pi`'s own protocol stream in RPC
  mode — this code must never write there.
- `applyToolAccess(desired)` — narrows the agent's active tool set to
  read-only tools for non-admin remote users, for the duration of one
  message.
- The `session_start` handler builds every configured transport, connects
  them in the background, and registers the shared `onMessage`/`onError`
  callbacks on `transportManager`.
- The `turn_start` handler sends a typing signal to the platform the
  current remote message came from.
- The `turn_end` handler extracts the agent's reply text, splits it into
  chunks, and sends each chunk back through the originating transport.
- The `session_shutdown` handler disconnects every transport and releases
  the instance lock.
- The `slack_upload_file` tool and the `/msg-bridge` command (with its
  `configure`/`connect`/`disconnect`/`status`/`widget`/`toggletools`/
  `togglethreads` subcommands) are registered at the end of the function.

### Transport interface and manager

**`src/transports/interface.ts`** — the `ITransportProvider` contract.
Read this file first, before any individual transport. Every transport
file implements it the same way.

**`src/transports/manager.ts`** — `TransportManager`. Routes messages and
errors from every transport to one shared handler. Looks up a transport by
`type` string for outbound sends.

### Platform transports

**`src/transports/slack.ts`** — `SlackProvider`. Connects via
`@slack/bolt` socket mode. Listens for the `message` event, filters bot
messages and duplicates, resolves the sender's display name, and detects
whether the channel is a direct message. Downloads file attachments to
`<cwd>/.pi/msg-bridge-uploads/`. Sends a Slack reaction
(`hourglass_flowing_sand`) as its typing indicator, because Slack bots have
no native typing indicator. See section 5 for the file-download memory
cap.

**`src/transports/discord.ts`** — `DiscordProvider`. Uses `discord.js`
with the `MessageContent` privileged intent, which must be enabled in the
Discord Developer Portal for the bot to read message text. Uses
`Partials.Channel` and `Partials.Message` so direct messages arrive
correctly.

**`src/transports/telegram.ts`** — `TelegramProvider`. Uses polling, not
webhooks. Converts standard Markdown to Telegram's MarkdownV1 dialect in
`formatForTelegram()`. Escapes literal `_`, `*`, `[`, and `` ` `` so a
snake_case tool name like `hud_canvas` does not trigger a parse error.

**`src/transports/whatsapp.ts`** — `WhatsAppProvider`. Uses
`@whiskeysockets/baileys`. First connection requires scanning a QR code
shown in the terminal. Session credentials persist under
`~/.pi/msg-bridge-whatsapp-auth/`.

**`src/transports/matrix.ts`** — `MatrixProvider`. Uses `matrix-bot-sdk`.
Works with any Matrix homeserver: Element X, Element Web, FluffyChat.
Optional end-to-end encryption uses a Rust/SQLite crypto store under
`~/.pi/msg-bridge-matrix-crypto/`. A device using encryption must be
verified once from another Matrix client before E2EE rooms work.

**`src/transports/matrix-utils.ts`** — pure functions used by
`matrix.ts`: `formatForMatrix` (Markdown to Matrix HTML),
`shouldSkipEvent`, `extractUsername`, `wasBotMentioned`,
`stripBotMention`. No network calls — this is why they have their own
test file.

**`src/transports/slack-utils.ts`** — pure function `formatForSlack`:
Markdown to Slack mrkdwn. Converts GFM tables into a monospaced code
block, since Slack mrkdwn has no table syntax. Also has its own test file
for the same reason as `matrix-utils.ts`.

### Auth

**`src/auth/challenge-auth.ts`** — `ChallengeAuth` class. See section 4
for the full flow. Also implements admin DM commands: `/help`, `/enable`,
`/disable`, `/channels`, `/trusted`, `/revoke`, `/toggletools`,
`/togglethreads`.

### Shared utilities

**`src/config.ts`** — `loadConfig()` and `saveConfig()`. Reads and writes
`~/.pi/msg-bridge.json`, mode `0600`. Warns if the file has looser
permissions than that. Environment variables listed in section 6 override
file values on load.

**`src/formatting.ts`** — `extractTextFromMessage`, `hasToolCalls`,
`formatToolCalls`, `truncate`, `splitMessage`. Turns a `pi`
`AssistantMessage` into the text sent back to a chat platform.
`splitMessage` breaks long replies at a newline, then a space, then a hard
character limit, in that order of preference.

**`src/lock.ts`** — `acquireLock()` and `releaseLock()`. Two layers: a
same-process global flag, and a PID file at `~/.pi/msg-bridge.lock` for
cross-process duplicates. Stops two `pi` processes from double-connecting
the same transport (which platforms reject with a conflict error).

**`src/types.ts`** — every shared interface: `ExternalMessage` (one
inbound message, normalized across all transports), `MsgBridgeConfig`
(the shape of `msg-bridge.json`), `PendingRemoteChat` (the in-flight
remote chat waiting for the current agent turn to finish),
`SendMessageOptions`, `TransportStatus`.

### UI

**`src/ui/main-menu.ts`** — `openMainMenu()`. An interactive menu shown
when a user runs `/msg-bridge` with no arguments, in TUI mode only.

**`src/ui/status-widget.ts`** — `createStatusWidget()`. Builds a one-line
status string, for example `💬 [slk:2][tg]`, shown in the `pi` TUI.

## 4. Key flow: an inbound Slack message and its reply

This section walks one message end to end. Slack is gorgor's primary
transport.

1. A user sends a message in a Slack channel or DM.
2. `SlackProvider`'s `app.message()` handler in `slack.ts` fires. It skips
   bot messages, message edits, and duplicate message IDs.
3. It resolves the sender's display name and checks whether the channel is
   a DM, using two in-memory caches (`userCache`, `channelCache`).
4. It calls `this.auth.checkAuthorization(...)`. This is
   `ChallengeAuth.checkAuthorization` in `challenge-auth.ts`:
   - In a DM from a trusted user, this returns `true` immediately.
   - In a DM from a new user, this starts a challenge: a 6-digit code is
     shown in the `pi` terminal via `onShowCode`, and a message asking for
     the code is sent back to the user. The function returns `false` for
     this first message.
   - In a group channel, this checks the channel's configured mode:
     `all`, `mentions` (bot must be @-mentioned), or `trusted-only`.
5. If the message is not authorized, `SlackProvider` stops here. The
   `checkAuthorization` call already sent any needed challenge or error
   text.
6. If the message carries file attachments, `downloadAndSaveFile()` saves
   each one to `<cwd>/.pi/msg-bridge-uploads/`, capped at
   `MAX_UPLOAD_BYTES` (see section 5). A note with the saved path is
   appended to the message text so the agent can read the file with its
   own tools.
7. `SlackProvider` builds an `ExternalMessage` and calls its own
   `messageHandler`. `TransportManager.addTransport()` wired this handler
   at startup to forward into one shared handler.
8. The shared handler, set in `index.ts`'s `session_start` block, stores
   the message as `pendingRemoteChat`, applies read-only or full tool
   access based on whether the sender is an admin, and calls
   `pi.sendUserMessage()` with `{ deliverAs: "followUp" }`. This queues
   the message as a new agent turn rather than interrupting one already
   in progress.
9. `pi` runs the agent turn. `index.ts`'s `turn_start` handler sends a
   typing signal — for Slack, this adds an hourglass reaction to the
   triggering message, since Slack bots have no real typing indicator.
10. When the turn ends, `index.ts`'s `turn_end` handler extracts the reply
    text via `extractTextFromMessage()`, appends a tool-call summary
    unless `hideToolCalls` is set, and splits the result into chunks of at
    most 4000 characters via `splitMessage()`.
11. Each chunk goes to `transportManager.sendMessage()`, which calls
    `SlackProvider.sendMessage()`. That method runs the reply text through
    `formatForSlack()` (Markdown to mrkdwn) before posting it.
12. If the agent's reply included a call to the `slack_upload_file` tool,
    that tool calls `SlackProvider.uploadFile()` directly — a second,
    separate path from `sendMessage()`, since Slack file uploads use a
    different API call (`files.uploadV2`) than text messages.
13. Once the turn has no more pending tool calls, `turn_end` clears the
    typing signal (removes the reaction), restores full tool access, and
    clears `pendingRemoteChat`.

## 5. Things to watch for

- **`MAX_UPLOAD_BYTES` in `slack.ts` is a memory cap, not a Slack limit.**
  `downloadAndSaveFile()` reads the whole attachment into memory with
  `arrayBuffer()`. It does not stream the download to disk. Slack itself
  already accepted the upload before this code runs — the cap exists so
  one large attachment cannot exhaust the memory of a container that may
  share its host with other tenants. The value is 100MB, raised from an
  earlier 20MB limit after confirming real attachments (rulebook PDFs)
  need the higher cap. Raising this value further increases the
  worst-case memory used per attachment; do not raise it without also
  moving the download to a streaming write.
- **This is a fork, not the upstream package.** `add-rpc-mode-support.md`
  is the design document behind the RPC-mode support now built into
  `index.ts` (`isRpcMode`, `emitEvent`) and `ui/main-menu.ts` (the
  RPC-mode help text instead of the blocking interactive menu). Upstream
  `tintinweb/pi-messenger-bridge` may not have this behavior.
- **`CONTRIBUTING.md` is out of date.** It shows a `git clone` URL for the
  upstream repo, not this fork, and its "Project Structure" section lists
  only `telegram.ts` and `status-widget.ts` — it predates the Slack,
  Discord, WhatsApp, and Matrix transports, and the `auth`/`config`/
  `formatting`/`lock` files. Do not rely on it for current file layout;
  use section 3 of this document instead.
- **`ctx` can go stale mid-session.** `pi` can replace or reload a
  session while background work (a transport reconnect, an async send) is
  still in flight. A stale `ctx.ui` call throws. `safeNotify()` and
  `emitEvent()` in `index.ts` both catch this on purpose — do not remove
  the try/catch when touching this code.
- **RPC mode has no blocking UI.** Any new interactive prompt
  (`select`/`input`/`confirm`) added to `main-menu.ts` must check
  `isRpcMode` first, or it will hang forever against an RPC client that
  never answers `extension_ui_response`.
