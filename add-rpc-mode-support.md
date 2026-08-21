# Add RPC-Mode Awareness to pi-messenger-bridge

## Context

`pi-messenger-bridge` is a pi extension that bridges messaging platforms (Slack, Telegram, Discord, WhatsApp, Matrix) into a pi coding agent session. It is installed as a pi package and loaded via the extension system.

Currently, the extension works well in TUI mode but has gaps when pi runs in `--mode rpc`. The extension uses interactive UI methods (`select`, `input`, `confirm`) that block in RPC mode until an `extension_ui_response` is received from the RPC client. Without a UI-capable RPC client, these flows hang.

## Goal

Make `pi-messenger-bridge` fully functional and well-behaved when pi is running in RPC mode, without breaking any existing TUI behavior.

## Specific Requirements

### 1. Detect RPC Mode

Use the existing `ExtensionContext.mode` field (value will be `"rpc"` or `"tui"`) to branch behavior where needed. Also respect `ctx.hasUI`.

### 2. Make the Interactive Menu RPC-Safe

In `src/ui/main-menu.ts`, the `openMainMenu()` function uses blocking dialog methods (`select`, `input`, `confirm`).

- **If `ctx.mode === "rpc"`:** Skip the interactive menu entirely. Instead, emit a single `notify` message explaining that the interactive menu is not available in RPC mode, and list the direct subcommands the user can invoke (e.g., `/msg-bridge connect`, `/msg-bridge configure slack <bot-token> <app-token>`, etc.).
- **If `ctx.mode === "tui"`:** Keep the existing interactive behavior unchanged.

### 3. Make Configuration Flows Non-Blocking in RPC Mode

The `/msg-bridge configure` command handler in `src/index.ts` already supports passing arguments directly (e.g., `/msg-bridge configure slack <token> <token>`). However, if a user runs `/msg-bridge configure` without arguments in RPC mode:

- Detect RPC mode.
- Do **not** attempt to open the interactive platform selector.
- Respond with a help message showing the direct syntax for all platforms.

### 4. Emit Structured Status Events for RPC Clients

RPC clients cannot see the TUI status widget. Add an opt-in mechanism to emit connection status and auth events as structured pi events that an RPC client can listen to.

In `src/index.ts`, when `ctx.mode === "rpc"` and a meaningful state change occurs (transport connects, disconnects, user is authorized, challenge code generated), emit a custom extension event using the pi event system if available, or at minimum log structured JSON to stdout so an RPC client can parse it.

If pi's ExtensionAPI has a way to emit custom events (`pi.emit()` or similar), use it. Otherwise, write structured log lines with a prefix like `[msg-bridge:event]` containing JSON.

Event types to emit:
- `transport_connected` — `{ transport: "slack" | "telegram" | ... }`
- `transport_disconnected` — `{ transport: "..." }`
- `challenge_issued` — `{ userId, username, code }`
- `user_authenticated` — `{ userId, username, transport }`
- `message_received` — `{ transport, chatId, username, contentPreview }`
- `reply_sent` — `{ transport, chatId, length }`

### 5. Handle `ctx.ui.setWidget` Gracefully

The status widget (`updateWidget()` in `src/index.ts`) calls `ctx.ui.setWidget()`. In RPC mode this works as fire-and-forget, but widget content is invisible to most RPC clients. 

- Keep calling it (it does no harm), but also emit the equivalent status as a structured event when in RPC mode.

### 6. Update Documentation

In the package's `README.md`, add a section: **"RPC Mode"** explaining:
- That the bridge works in RPC mode.
- That interactive configuration menus are disabled in RPC mode; use direct subcommands instead.
- That RPC clients can observe bridge state via structured events.
- Which UI methods are degraded in RPC mode (reference the existing pi docs on this).

## Files to Modify

1. `src/index.ts` — add mode checks, structured event emission, RPC-safe command handlers
2. `src/ui/main-menu.ts` — add early return for RPC mode with helpful message
3. `README.md` — document RPC mode behavior

## Constraints

- Do **not** break TUI mode behavior. All existing TUI users should see zero change.
- Do **not** introduce new dependencies unless absolutely necessary.
- Follow the existing code style (biome formatting, TypeScript strict mode).
- The extension must remain backward-compatible with existing pi versions.

## Acceptance Criteria

- [ ] Running `/msg-bridge` in RPC mode shows a help message instead of hanging on a menu
- [ ] Running `/msg-bridge configure` without args in RPC mode shows syntax help
- [ ] Transport connect/disconnect and auth events are observable by an RPC client
- [ ] TUI mode behaves exactly as before
- [ ] README includes RPC mode documentation
