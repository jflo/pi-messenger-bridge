import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { loadConfig, saveConfig } from "./config.js";
import { extractTextFromMessage, formatToolCalls, hasToolCalls, splitMessage } from "./formatting.js";
import { acquireLock, releaseLock } from "./lock.js";
import { DiscordProvider } from "./transports/discord.js";
import { TransportManager } from "./transports/manager.js";
import { MatrixProvider } from "./transports/matrix.js";
import { SlackProvider } from "./transports/slack.js";
import { TelegramProvider } from "./transports/telegram.js";
import { WhatsAppProvider } from "./transports/whatsapp.js";
import type { PendingRemoteChat, TransportStatus } from "./types.js";
import { openMainMenu } from "./ui/main-menu.js";
import { createStatusWidget } from "./ui/status-widget.js";

// Mirrors @earendil-works/pi-coding-agent's fixed ToolName union — not re-exported from the
// package root, so kept here rather than deep-importing an internal module path. This is only
// pi's own built-in tool set; a project's own custom tools (registered via pi.registerTool() in
// its .pi/extensions/) are handled separately below, via getCustomToolNames() — see
// applyToolAccess()'s call sites and the `safeTools` config field in types.ts.
const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/**
 * The installed @earendil-works/pi-coding-agent (0.74) doesn't expose a `mode` field on
 * ExtensionContext — only `hasUI: boolean` (false in print/RPC mode). Newer pi releases may add
 * ctx.mode ("rpc" | "tui"); read it defensively via an optional field so this keeps working
 * whether or not it exists, falling back to !hasUI as the RPC-like signal (no blocking dialogs).
 *
 * Narrowed to just the fields this reads (rather than the full ExtensionContext) so callers —
 * including tests — don't need to fabricate an entire ExtensionContext to use it.
 */
type ContextWithOptionalMode = Pick<ExtensionContext, "hasUI"> & { mode?: "rpc" | "tui" };

export function isRpcMode(context: ContextWithOptionalMode): boolean {
  if (context.mode === "rpc") return true;
  if (context.mode === "tui") return false;
  return !context.hasUI;
}

type MsgBridgeEventType =
  | "transport_connected"
  | "transport_disconnected"
  | "challenge_issued"
  | "user_authenticated"
  | "message_received"
  | "reply_sent";

const CONFIGURE_SYNTAX_HELP = [
  "Usage: /msg-bridge configure <platform> [args]",
  "",
  "  /msg-bridge configure telegram <bot-token>",
  "  /msg-bridge configure whatsapp [auth-path]",
  "  /msg-bridge configure slack <bot-token> <app-token>",
  "  /msg-bridge configure discord <bot-token>",
  "  /msg-bridge configure matrix <homeserver-url> <access-token>",
].join("\n");

/**
 * pi-remote-pilot extension
 * Bridges messenger apps (Telegram, WhatsApp, Slack, Discord) into pi
 */
export default function (pi: ExtensionAPI): void {
  const transportManager = new TransportManager();
  let pendingRemoteChat: PendingRemoteChat | null = null;
  let auth: ChallengeAuth;
  let ctx: ExtensionContext;
  const lastTransportConnected = new Map<string, boolean>();

  /**
   * ctx is captured once per session_start and reused by async work (transport
   * init, background reconnects, message-send error handling) that can still
   * be in flight when pi replaces/reloads the session — at which point ctx.ui
   * throws "extension ctx is stale after session replacement or reload"
   * instead of returning. That throw is uncaught in these deferred contexts
   * and crashes the whole process (confirmed: this is why the bot's tmux
   * session was dying every few minutes in production). A lost notification
   * is harmless; a crashed bot is not — so swallow staleness here rather
   * than propagate it.
   */
  function safeNotify(message: string, level?: "info" | "warning" | "error"): void {
    try {
      ctx.ui.notify(message, level);
    } catch (err) {
      console.error(`[msg-bridge] dropped notification (stale ctx?): ${message}`, err);
    }
  }

  /**
   * Emit a structured event for RPC clients on meaningful state changes (transport
   * connect/disconnect, auth, message activity). No-op outside RPC mode.
   *
   * pi's ExtensionAPI has no pi.emit()-style custom event channel to RPC clients (checked
   * against the installed @earendil-works/pi-coding-agent types). In RPC mode, process.stdout
   * is pi's own strict-JSONL protocol stream to the client (see modes/rpc/{rpc-mode,jsonl}.js) —
   * writing anything else there would corrupt it. So this goes to stderr instead, one JSON
   * object per line, which an RPC client can tail independently of the stdout protocol stream.
   * Same stale-ctx crash risk as safeNotify applies here (reads ctx.hasUI/ctx.mode).
   */
  function emitEvent(type: MsgBridgeEventType, data: Record<string, unknown>): void {
    try {
      if (!ctx || !isRpcMode(ctx)) return;
      const payload = { type, ...data, timestamp: new Date().toISOString() };
      console.error(`[msg-bridge:event] ${JSON.stringify(payload)}`);
    } catch (err) {
      console.error(`[msg-bridge] failed to emit ${type} event (stale ctx?):`, err);
    }
  }

  /**
   * Diff transport connection state against the last-known snapshot and emit
   * transport_connected/transport_disconnected for anything that changed. Called from
   * updateWidget() since every connect/disconnect path already calls it.
   */
  function emitTransportDiffEvents(): void {
    for (const s of transportManager.getStatus()) {
      const prev = lastTransportConnected.get(s.type);
      if (prev !== s.connected) {
        emitEvent(s.connected ? "transport_connected" : "transport_disconnected", { transport: s.type });
      }
      lastTransportConnected.set(s.type, s.connected);
    }
  }

  /**
   * Restrict or restore the agent's active tools, skipping redundant calls (each call rebuilds
   * the system prompt). Used to put non-admin remote users into a read-only tool set for the
   * duration of their message, then restore full access once the turn completes.
   */
  function applyToolAccess(desired: string[]): void {
    const current = pi.getActiveTools();
    const same = current.length === desired.length && current.every((t) => desired.includes(t));
    if (!same) {
      pi.setActiveTools(desired);
    }
  }

  /**
   * Every tool name beyond pi's own fixed built-ins (ALL_TOOLS/READ_ONLY_TOOLS) — i.e. whatever
   * the current project registered itself, via pi.registerTool() in its own .pi/extensions/.
   *
   * pi.getAllTools() returns every tool configured for this session regardless of what's
   * currently active, each tagged with sourceInfo.source: "builtin" for pi's own fixed tools,
   * anything else ("local" for a project's own extension file, "sdk" for one registered
   * programmatically) for a tool the project added on purpose. Filtering out "builtin" is how
   * this stays correct across pi versions without hardcoding a project's tool names here — this
   * file has no way to know what any given downstream project registers.
   *
   * Fixes gorgors-notebook#14's discovery (see pi-messenger-bridge#10): previously,
   * applyToolAccess(ALL_TOOLS) / applyToolAccess(READ_ONLY_TOOLS) — both hardcoded to pi's 7
   * built-in names — completely replaced the active tool set via pi.setActiveTools() on every
   * bridge-driven turn, silently excluding every custom tool for admin and non-admin alike.
   */
  function getCustomToolNames(): string[] {
    return pi.getAllTools()
      .filter((tool) => tool.sourceInfo.source !== "builtin")
      .map((tool) => tool.name);
  }

  /**
   * The tool set a given caller should have for the duration of one bridge-driven message:
   * pi's built-ins (ALL_TOOLS for admins, READ_ONLY_TOOLS otherwise) plus custom tools. Admins
   * always get every custom tool the project registered — matching ALL_TOOLS' original "full
   * access" intent. Non-admins only get the subset explicitly opted in via the project's
   * `safeTools` config (see types.ts) — defaults to none, so this is additive-only and never
   * widens a non-admin's access unless a project asks for it.
   */
  function resolveToolAccess(isAdmin: boolean): string[] {
    const customTools = getCustomToolNames();
    if (isAdmin) {
      return [...ALL_TOOLS, ...customTools];
    }
    const safeTools = loadConfig().safeTools ?? [];
    return [...READ_ONLY_TOOLS, ...customTools.filter((name) => safeTools.includes(name))];
  }

  /**
   * Update status widget
   */
  function updateWidget(): void {
    // See safeNotify's comment — same stale-ctx crash risk applies to
    // ctx.ui.setWidget when called from deferred/background work.
    try {
      emitTransportDiffEvents();
      const config = loadConfig();

      if (config.showWidget === false) {
        ctx.ui.setWidget("msg-bridge-status", undefined);
        return;
      }

      const stats = auth.getStats();
      const transports: TransportStatus[] = transportManager
        .getStatus()
        .map((s) => ({
          type: s.type,
          connected: s.connected,
        }));

      const widget = createStatusWidget(transports, stats.usersByTransport);
      if (widget) {
        ctx.ui.setWidget("msg-bridge-status", [widget]);
      } else {
        ctx.ui.setWidget("msg-bridge-status", undefined);
      }
    } catch (err) {
      console.error("[msg-bridge] failed to update status widget (stale ctx?):", err);
    }
  }

  /**
   * Save auth state to config
   */
  function saveAuthState(): void {
    const config = loadConfig();
    config.auth = auth.exportConfig();
    saveConfig(config);
  }

  /**
   * Initialize extension
   */
  pi.on("session_start", async (_event, context) => {
    ctx = context;

    const config = loadConfig();

    auth = new ChallengeAuth(
      (code, username) => {
        safeNotify(`🔐 Challenge code for @${username}: ${code}`, "info");
      },
      (message, level) => {
        safeNotify(message, level);
      },
      async (_chatId, _message) => {
        // Challenge notifications are sent via the transport's sendMessage
      },
      saveAuthState,
      (type, data) => emitEvent(type, data)
    );

    if (config.auth) {
      auth.loadFromConfig(config.auth);
    }

    // Initialize transports in the background (non-blocking)
    (async () => {
      const transportPromises: Promise<void>[] = [];

      if (config.telegram?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const telegramProvider = new TelegramProvider(config.telegram!.token, auth);
            transportManager.addTransport(telegramProvider);
          })
        );
      }

      if (config.whatsapp) {
        const whatsappAuthPath = config.whatsapp.authPath || path.join(
          os.homedir(),
          ".pi",
          "msg-bridge-whatsapp-auth"
        );

        const credsPath = path.join(whatsappAuthPath, "creds.json");
        if (fs.existsSync(credsPath)) {
          transportPromises.push(
            Promise.resolve().then(() => {
              const whatsappConfig = { ...config.whatsapp!, debug: config.debug };
              const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
              transportManager.addTransport(whatsappProvider);
            })
          );
        } else {
          delete config.whatsapp;
          saveConfig(config);
        }
      }

      if (config.slack?.botToken && config.slack?.appToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const slackProvider = new SlackProvider(config.slack!, auth, ctx.cwd);
            transportManager.addTransport(slackProvider);
          })
        );
      }

      if (config.discord?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const discordProvider = new DiscordProvider(config.discord!, auth);
            transportManager.addTransport(discordProvider);
          })
        );
      }

      if (config.matrix?.homeserverUrl && config.matrix?.accessToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const matrixProvider = new MatrixProvider(config.matrix!, auth);
            transportManager.addTransport(matrixProvider);
          })
        );
      }

      await Promise.all(transportPromises);

      // Auto-connect if configured
      const transports = transportManager.getAllTransports();
      if (transports.length > 0 && config.autoConnect !== false) {
        if (!acquireLock()) {
          safeNotify("ℹ️ msg-bridge: another instance is already connected — skipping auto-connect", "info");
        } else {
          try {
            await transportManager.connectAll();
            updateWidget();
          } catch (err) {
            releaseLock();
            safeNotify(`⚠️ Some transports failed to connect: ${(err as Error).message}`, "warning");
          }
        }
      }
    })().catch(err => {
      console.error("Transport initialization error:", err);
      safeNotify(`❌ Transport initialization failed: ${err.message}`, "error");
    });

    transportManager.onMessage((msg) => {
      pendingRemoteChat = {
        chatId: msg.chatId,
        transport: msg.transport,
        username: msg.username,
        messageId: msg.messageId,
        threadTs: msg.threadTs,
      };

      emitEvent("message_received", {
        transport: msg.transport,
        chatId: msg.chatId,
        username: msg.username,
        contentPreview: msg.content.length > 200 ? `${msg.content.slice(0, 200)}…` : msg.content,
      });

      const namespacedUserId = `${msg.transport}:${msg.userId}`;
      const isAdmin = (loadConfig().admins ?? []).includes(namespacedUserId);
      applyToolAccess(resolveToolAccess(isAdmin));

      const taggedMessage = `[📱 @${msg.username} via ${msg.transport}]: ${msg.content}`;
      pi.sendUserMessage(taggedMessage, { deliverAs: "followUp" });
    });

    transportManager.onError((err, transport) => {
      safeNotify(`❌ ${transport} error: ${err.message}`, "error");
    });

    updateWidget();
  });

  /**
   * Handle turn start - send typing indicator
   */
  pi.on("turn_start", async (_event, _context) => {
    if (pendingRemoteChat) {
      try {
        await transportManager.sendTyping(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport,
          pendingRemoteChat.messageId
        );
      } catch (_err) {
        // Ignore typing indicator errors
      }
    }
  });

  /**
   * Handle turn end - send response back to messenger
   */
  pi.on("turn_end", async (event, _context) => {
    if (!pendingRemoteChat) return;

    try {
      const message = event.message as AssistantMessage;
      const responseText = extractTextFromMessage(message);
      const toolCallsText = formatToolCalls(message);
      const hasPendingTools = hasToolCalls(message);
      const config = loadConfig();

      const parts: string[] = [];
      const trimmedResponse = responseText.trim();
      if (trimmedResponse) parts.push(trimmedResponse);
      if (toolCallsText && !config.hideToolCalls) parts.push(toolCallsText);

      if (parts.length === 0) {
        // Nothing to send this turn — don't touch pendingRemoteChat;
        // a future turn_end may have the actual response text.
        return;
      }

      const fullText = parts.join("\n\n");

      // Split long messages for Telegram's 4096 char limit
      const chunks = splitMessage(fullText, 4000);
      const mirrorThreads = config.slackMirrorThreads !== false;
      const sendOptions = { threadTs: mirrorThreads ? pendingRemoteChat.threadTs : undefined };
      for (const chunk of chunks) {
        await transportManager.sendMessage(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport,
          chunk,
          sendOptions
        );
      }

      emitEvent("reply_sent", {
        transport: pendingRemoteChat.transport,
        chatId: pendingRemoteChat.chatId,
        length: fullText.length,
      });

      if (!hasPendingTools) {
        await transportManager.clearTyping(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport,
          pendingRemoteChat.messageId
        );
        applyToolAccess(resolveToolAccess(true));
        pendingRemoteChat = null;
      }
    } catch (err) {
      const transport = pendingRemoteChat?.transport ?? "unknown";
      safeNotify(
        `Failed to send response to ${transport}: ${(err as Error).message}`,
        "error"
      );
      if (pendingRemoteChat) {
        try {
          await transportManager.clearTyping(
            pendingRemoteChat.chatId,
            pendingRemoteChat.transport,
            pendingRemoteChat.messageId
          );
        } catch (_clearErr) {
          // Ignore — best-effort cleanup
        }
      }
      applyToolAccess(resolveToolAccess(true));
      pendingRemoteChat = null;
    }
  });

  /**
   * Cleanup on session exit — release lock and disconnect transports
   */
  pi.on("session_shutdown", async (_event, _context) => {
    await transportManager.disconnectAll();
    emitTransportDiffEvents();
    releaseLock();
  });

  /**
   * Tool: let the agent post an existing local file into the active remote Slack chat.
   */
  pi.registerTool({
    name: "slack_upload_file",
    label: "Upload file to Slack",
    description:
      "Upload an existing local file to the Slack conversation currently in progress (e.g. a screenshot, " +
      "or a file the user attached earlier in this conversation and was saved locally). Only works while " +
      "replying to a remote Slack message.",
    promptSnippet: "slack_upload_file — post a local file to the active Slack chat",
    parameters: Type.Object({
      filePath: Type.String({ description: "Absolute or relative path to an existing local file to upload." }),
      comment: Type.Optional(Type.String({ description: "Optional caption to post alongside the file." })),
    }),
    execute: async (_toolCallId, params) => {
      if (!pendingRemoteChat || pendingRemoteChat.transport !== "slack") {
        return {
          content: [{ type: "text", text: "No active Slack conversation to upload to." }],
          details: undefined,
          isError: true,
        };
      }

      const slack = transportManager.getTransport("slack") as SlackProvider | undefined;
      if (!slack) {
        return {
          content: [{ type: "text", text: "Slack transport is not available." }],
          details: undefined,
          isError: true,
        };
      }

      try {
        const config = loadConfig();
        const mirrorThreads = config.slackMirrorThreads !== false;
        await slack.uploadFile(pendingRemoteChat.chatId, params.filePath, {
          comment: params.comment,
          threadTs: mirrorThreads ? pendingRemoteChat.threadTs : undefined,
        });
        return {
          content: [{ type: "text", text: `Uploaded ${params.filePath} to Slack.` }],
          details: undefined,
          isError: false,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to upload file: ${(err as Error).message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });

  /**
   * /msg-bridge command - show status or manage connections
   */
  pi.registerCommand("msg-bridge", {
    description: "Manage remote messenger connections (help|status|connect|disconnect|configure|widget)",
    handler: async (args: string, context) => {
      const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
      const subcommand = parts[0] || "";

    // No subcommand → open interactive menu (or, in RPC mode, a help notify — see openMainMenu)
    if (!subcommand || subcommand === "menu") {
      await openMainMenu({
        ui: context.ui,
        transportManager,
        auth,
        updateWidget,
        cwd: context.cwd,
        isRpcMode: isRpcMode(context),
      });
      return;
    }

    switch (subcommand) {
      case "help": {
        const helpText = [
          "━━━ Message Bridge Commands ━━━",
          "",
          "/msg-bridge                   Open interactive menu",
          "/msg-bridge help              Show this help",
          "/msg-bridge status            Show connection and user status",
          "/msg-bridge connect           Connect to all transports",
          "/msg-bridge disconnect        Disconnect from all transports",
          "/msg-bridge configure telegram <token>",
          "                              Configure Telegram bot",
          "/msg-bridge configure whatsapp",
          "                              Configure WhatsApp (scan QR)",
          "/msg-bridge configure matrix <homeserver-url> <access-token>",
          "                              Configure Matrix (Element X, etc)",
          "/msg-bridge widget            Toggle status widget on/off",
          "/msg-bridge toggletools       Toggle tool call visibility",
          "/msg-bridge togglethreads     Toggle Slack thread-reply mirroring",
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ];
        context.ui.notify(helpText.join("\n"), "info");
        break;
      }
      case "connect":
        if (!acquireLock()) {
          context.ui.notify("⚠️ Another msg-bridge instance is already connected. Run /msg-bridge disconnect there first.", "warning");
          break;
        }
        try {
          await transportManager.connectAll();
          const cfg = loadConfig();
          cfg.autoConnect = true;
          saveConfig(cfg);
          context.ui.notify("✅ Connected to all configured transports", "info");
          updateWidget();
        } catch (err) {
          releaseLock();
          context.ui.notify(
            `❌ Connection failed: ${(err as Error).message}`,
            "error"
          );
        }
        break;

      case "disconnect": {
        await transportManager.disconnectAll();
        releaseLock();
        const cfg = loadConfig();
        cfg.autoConnect = false;
        saveConfig(cfg);
        context.ui.notify("🔌 Disconnected from all transports", "info");
        updateWidget();
        break;
      }

      case "configure": {
        const platform = parts[1];
        const token = parts.slice(2).join(" ");

        if (!platform) {
          if (isRpcMode(context)) {
            // No interactive platform selector in RPC mode — show the direct syntax instead.
            context.ui.notify(CONFIGURE_SYNTAX_HELP, "info");
          } else {
            context.ui.notify("Usage: /msg-bridge configure <platform> [token/path]", "error");
          }
          return;
        }

        const config = loadConfig();

        switch (platform.toLowerCase()) {
          case "telegram": {
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure telegram <bot-token>", "error");
              return;
            }
            config.telegram = { token };
            saveConfig(config);
            const telegramProvider = new TelegramProvider(token, auth);
            transportManager.addTransport(telegramProvider);
            if (acquireLock()) {
              try {
                await telegramProvider.connect();
                context.ui.notify("✅ Telegram configured and connected", "info");
              } catch (_err) {
                releaseLock();
                context.ui.notify("✅ Telegram configured (run /msg-bridge connect to activate)", "info");
              }
            } else {
              context.ui.notify("✅ Telegram configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "whatsapp": {
            config.whatsapp = token ? { authPath: token } : {};
            saveConfig(config);
            const whatsappConfig = { ...config.whatsapp, debug: config.debug };
            const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
            transportManager.addTransport(whatsappProvider);
            if (acquireLock()) {
              try {
                await whatsappProvider.connect(true);
                context.ui.notify("✅ WhatsApp configured and connecting (scan QR code in terminal)...", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ WhatsApp setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ WhatsApp configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "slack": {
            const parts2 = token.split(/\s+/);
            const botToken = parts2[0];
            const appToken = parts2[1];

            if (!botToken || !appToken) {
              context.ui.notify("Usage: /msg-bridge configure slack <bot-token> <app-token>", "error");
              return;
            }

            config.slack = { botToken, appToken };
            saveConfig(config);
            const slackProvider = new SlackProvider(config.slack, auth, context.cwd);
            transportManager.addTransport(slackProvider);
            if (acquireLock()) {
              try {
                await slackProvider.connect();
                context.ui.notify("✅ Slack configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Slack configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "discord": {
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure discord <bot-token>", "error");
              return;
            }

            config.discord = { token };
            saveConfig(config);
            const discordProvider = new DiscordProvider(config.discord, auth);
            transportManager.addTransport(discordProvider);
            if (acquireLock()) {
              try {
                await discordProvider.connect();
                context.ui.notify("✅ Discord configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Discord setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Discord configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "matrix": {
            const matrixParts = token.split(/\s+/);
            const homeserverUrl = matrixParts[0];
            const matrixAccessToken = matrixParts.slice(1).join(" ");
            if (!homeserverUrl || !matrixAccessToken) {
              context.ui.notify("Usage: /msg-bridge configure matrix <homeserver-url> <access-token>", "error");
              return;
            }

            config.matrix = { homeserverUrl, accessToken: matrixAccessToken };
            saveConfig(config);
            const matrixProvider = new MatrixProvider(config.matrix, auth);
            transportManager.addTransport(matrixProvider);
            if (acquireLock()) {
              try {
                await matrixProvider.connect();
                context.ui.notify("✅ Matrix configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Matrix setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Matrix configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          default:
            context.ui.notify(`❌ Unknown platform: ${platform}`, "error");
        }
        break;
      }

      case "widget": {
        const cfg2 = loadConfig();
        cfg2.showWidget = cfg2.showWidget === false;
        saveConfig(cfg2);
        const widgetState = cfg2.showWidget !== false ? "shown" : "hidden";
        context.ui.notify(`📊 Status widget ${widgetState}`, "info");
        updateWidget();
        break;
      }

      case "status": {
        const stats = auth.getStats();
        const status = transportManager.getStatus();
        const lines = [
          "━━━ Message Bridge Status ━━━",
          "",
          "Transports:",
          ...status.map(
            (s) => `  ${s.connected ? "●" : "○"} ${s.type}`
          ),
          "",
          `Trusted Users: ${stats.trustedUsers}`,
        ];

        if (stats.trustedUsers > 0) {
          for (const [transport, userIds] of Object.entries(stats.usersByTransport)) {
            if (userIds.length > 0) {
              lines.push(`  └─ ${transport}: ${userIds.join(", ")}`);
            }
          }
        }

        lines.push("");
        lines.push(`Channels: ${stats.channels}`);
        lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        context.ui.notify(lines.join("\n"), "info");
        break;
      }

      case "toggletools": {
        const cfg3 = loadConfig();
        cfg3.hideToolCalls = !cfg3.hideToolCalls;
        saveConfig(cfg3);
        const toolState = cfg3.hideToolCalls ? "hidden" : "shown";
        context.ui.notify(`🔧 Tool calls ${toolState} in remote messages`, "info");
        break;
      }
      case "togglethreads": {
        const cfg4 = loadConfig();
        cfg4.slackMirrorThreads = !(cfg4.slackMirrorThreads ?? true);
        saveConfig(cfg4);
        const threadState = cfg4.slackMirrorThreads !== false ? "on" : "off";
        context.ui.notify(`🧵 Slack thread mirroring ${threadState}`, "info");
        break;
      }
      default:
        context.ui.notify(`Unknown subcommand: ${subcommand}. Run /msg-bridge help`, "warning");
        break;
    }
    },
  });
}
