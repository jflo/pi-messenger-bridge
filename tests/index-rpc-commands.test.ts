import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Integration-style coverage for the actual /msg-bridge command handler registered by the
 * extension's default export, proving the RPC-mode behavior end to end rather than just at the
 * isRpcMode()/openMainMenu() unit level.
 */
describe("msg-bridge command RPC routing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "msg-bridge-index-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeUi() {
    return {
      notify: vi.fn(),
      setWidget: vi.fn(),
      select: vi.fn().mockResolvedValue(undefined),
      input: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue(false),
    };
  }

  async function setupExtension() {
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });
    const { default: extensionFactory } = await import("../src/index");

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const fakePi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        commands.set(name, opts),
    };

    // biome-ignore lint/suspicious/noExplicitAny: minimal fake covering only what index.ts calls
    (extensionFactory as any)(fakePi as any);

    const sessionUi = makeUi();
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake ExtensionContext
    await (handlers.get("session_start") as any)({}, { ui: sessionUi, cwd: tmpDir, hasUI: true });

    return commands;
  }

  it("RPC mode: /msg-bridge with no subcommand shows help instead of opening the menu", async () => {
    const commands = await setupExtension();
    const ui = makeUi();

    await commands.get("msg-bridge")!.handler("", { ui, cwd: tmpDir, hasUI: false });

    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(ui.notify.mock.calls[0][0]).toContain("/msg-bridge connect");
  });

  it("TUI mode: /msg-bridge with no subcommand still opens the interactive menu (regression guard)", async () => {
    const commands = await setupExtension();
    const ui = makeUi();

    await commands.get("msg-bridge")!.handler("", { ui, cwd: tmpDir, hasUI: true });

    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("RPC mode: /msg-bridge configure with no platform shows full syntax help for every platform", async () => {
    const commands = await setupExtension();
    const ui = makeUi();

    await commands.get("msg-bridge")!.handler("configure", { ui, cwd: tmpDir, hasUI: false });

    expect(ui.notify).toHaveBeenCalledTimes(1);
    const [message, level] = ui.notify.mock.calls[0];
    expect(message).toContain("/msg-bridge configure telegram <bot-token>");
    expect(message).toContain("/msg-bridge configure whatsapp");
    expect(message).toContain("/msg-bridge configure slack <bot-token> <app-token>");
    expect(message).toContain("/msg-bridge configure discord <bot-token>");
    expect(message).toContain("/msg-bridge configure matrix <homeserver-url> <access-token>");
    expect(level).toBe("info");
  });

  it("TUI mode: /msg-bridge configure with no platform shows the original short usage error (unchanged)", async () => {
    const commands = await setupExtension();
    const ui = makeUi();

    await commands.get("msg-bridge")!.handler("configure", { ui, cwd: tmpDir, hasUI: true });

    expect(ui.notify).toHaveBeenCalledWith("Usage: /msg-bridge configure <platform> [token/path]", "error");
  });
});
