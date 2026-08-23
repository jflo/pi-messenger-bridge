import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Regression coverage for pi-messenger-bridge#10: applyToolAccess() used to hardcode
 * pi.setActiveTools() to pi's own 7 built-in tool names (ALL_TOOLS/READ_ONLY_TOOLS) on every
 * bridge-driven message, which *replaces* the whole active tool set — silently excluding every
 * project-registered custom tool (via pi.registerTool()) for admin and non-admin alike, for the
 * whole duration of any bridge-driven turn.
 *
 * These tests drive the real message_received/turn_end handlers registered by the extension's
 * default export (same harness pattern as index-rpc-commands.test.ts), with a stubbed
 * TransportManager so a synthetic inbound message can be injected directly, and assert on what
 * the fake pi.setActiveTools() actually gets called with.
 */
describe("custom tool access across a bridge-driven turn", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "msg-bridge-tool-access-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    const dir = join(tmpDir, ".pi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "msg-bridge.json"), JSON.stringify(config));
  }

  function makeUi() {
    return {
      notify: vi.fn(),
      setWidget: vi.fn(),
      select: vi.fn().mockResolvedValue(undefined),
      input: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue(false),
    };
  }

  // pi's 7 fixed built-in tools, each tagged the way pi.getAllTools() actually tags them
  // (sourceInfo.source: "builtin") — see @earendil-works/pi-coding-agent's agent-session.js.
  const BUILTIN_TOOL_INFOS = ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({
    name,
    sourceInfo: { source: "builtin" },
  }));

  it("admin caller: gets pi's built-ins plus every custom tool the project registered", async () => {
    writeConfig({ admins: ["slack:U_ADMIN"] });
    const { handlers, setActiveTools, getAllTools, triggerMessage } = await setupExtensionWithTrigger();

    getAllTools.mockReturnValue([
      ...BUILTIN_TOOL_INFOS,
      { name: "custom_tool_a", sourceInfo: { source: "local" } },
      { name: "custom_tool_b", sourceInfo: { source: "local" } },
    ]);

    await triggerMessage({ transport: "slack", userId: "U_ADMIN" });

    expect(setActiveTools).toHaveBeenCalledTimes(1);
    const desired = setActiveTools.mock.calls[0][0] as string[];
    expect(new Set(desired)).toEqual(
      new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "custom_tool_a", "custom_tool_b"])
    );
  });

  it("non-admin caller: gets read-only built-ins plus only safeTools-listed custom tools", async () => {
    writeConfig({ admins: ["slack:U_ADMIN"], safeTools: ["custom_tool_a"] });
    const { setActiveTools, getAllTools, triggerMessage } = await setupExtensionWithTrigger();

    getAllTools.mockReturnValue([
      ...BUILTIN_TOOL_INFOS,
      { name: "custom_tool_a", sourceInfo: { source: "local" } },
      { name: "custom_tool_b", sourceInfo: { source: "local" } },
    ]);

    await triggerMessage({ transport: "slack", userId: "U_NONADMIN" });

    expect(setActiveTools).toHaveBeenCalledTimes(1);
    const desired = setActiveTools.mock.calls[0][0] as string[];
    expect(new Set(desired)).toEqual(new Set(["read", "grep", "find", "ls", "custom_tool_a"]));
    expect(desired).not.toContain("custom_tool_b");
    expect(desired).not.toContain("bash");
    expect(desired).not.toContain("write");
  });

  it("non-admin caller with no safeTools configured: gets only pi's read-only built-ins (default-closed)", async () => {
    writeConfig({ admins: ["slack:U_ADMIN"] });
    const { setActiveTools, getAllTools, triggerMessage } = await setupExtensionWithTrigger();

    getAllTools.mockReturnValue([...BUILTIN_TOOL_INFOS, { name: "custom_tool_a", sourceInfo: { source: "local" } }]);

    await triggerMessage({ transport: "slack", userId: "U_NONADMIN" });

    const desired = setActiveTools.mock.calls[0][0] as string[];
    expect(new Set(desired)).toEqual(new Set(["read", "grep", "find", "ls"]));
  });

  it("turn_end restore gives back every custom tool, not just pi's built-ins (matches pre-existing ALL_TOOLS restore intent)", async () => {
    writeConfig({ admins: ["slack:U_ADMIN"], safeTools: ["custom_tool_a"] });
    const { handlers, setActiveTools, getAllTools, triggerMessage } = await setupExtensionWithTrigger();

    getAllTools.mockReturnValue([
      ...BUILTIN_TOOL_INFOS,
      { name: "custom_tool_a", sourceInfo: { source: "local" } },
      { name: "custom_tool_b", sourceInfo: { source: "local" } },
    ]);

    // A non-admin's message narrows to read-only + custom_tool_a only.
    await triggerMessage({ transport: "slack", userId: "U_NONADMIN" });
    expect(new Set(setActiveTools.mock.calls[0][0] as string[])).toEqual(
      new Set(["read", "grep", "find", "ls", "custom_tool_a"])
    );

    // turn_end, with actual response text so the early "nothing to send" return isn't hit.
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake AssistantMessage
    const fakeAssistantMessage: any = { content: [{ type: "text", text: "done" }] };
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake turn_end context
    await (handlers.get("turn_end") as any)({ message: fakeAssistantMessage }, {});

    expect(setActiveTools).toHaveBeenCalledTimes(2);
    const restored = setActiveTools.mock.calls[1][0] as string[];
    expect(new Set(restored)).toEqual(
      new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "custom_tool_a", "custom_tool_b"])
    );
  });

  /**
   * Same setup pattern as index-rpc-commands.test.ts's setupExtension() (mock os.homedir, load
   * the extension's default export against a fake pi, fire session_start), plus a way to
   * actually invoke the message_received handler: it's registered via
   * transportManager.onMessage(), not pi.on(), so it never lands in `handlers` — the stubbed
   * TransportManager module above captures that callback instead, and triggerMessage() invokes
   * it directly with a synthetic ExternalMessage.
   */
  async function setupExtensionWithTrigger() {
    let captured: ((msg: unknown) => void) | undefined;

    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });

    vi.doMock("../src/transports/manager", () => ({
      TransportManager: class {
        onMessage(handler: (msg: unknown) => void) {
          captured = handler;
        }
        onError(_handler: (err: Error, transport: string) => void) {}
        addTransport(_t: unknown) {}
        getAllTransports() {
          return [];
        }
        async connectAll() {}
        async disconnectAll() {}
        async sendMessage() {}
        async sendTyping() {}
        async clearTyping() {}
        getStatus() {
          return [];
        }
      },
    }));

    const { default: extensionFactory } = await import("../src/index");

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const setActiveTools = vi.fn();
    const getAllTools = vi.fn().mockReturnValue(BUILTIN_TOOL_INFOS);
    const fakePi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      sendUserMessage: vi.fn(),
      getActiveTools: () => [] as string[],
      setActiveTools,
      getAllTools,
    };

    // biome-ignore lint/suspicious/noExplicitAny: minimal fake covering only what index.ts calls
    (extensionFactory as any)(fakePi as any);

    const sessionUi = makeUi();
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake ExtensionContext
    await (handlers.get("session_start") as any)({}, { ui: sessionUi, cwd: tmpDir, hasUI: true });

    async function triggerMessage(overrides: { transport: string; userId: string }) {
      if (!captured) throw new Error("transportManager.onMessage() handler was never registered");
      captured({
        chatId: "chat-1",
        transport: overrides.transport,
        content: "hello",
        username: "someone",
        userId: overrides.userId,
        timestamp: new Date(),
        messageId: "msg-1",
        isGroupChat: false,
      });
      // message_received's handler body is synchronous (no await before applyToolAccess), but
      // await a microtask so any incidental promise chains it starts settle before assertions.
      await Promise.resolve();
    }

    return { handlers, setActiveTools, getAllTools, triggerMessage };
  }
});
