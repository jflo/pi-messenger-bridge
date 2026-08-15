import { describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../auth/challenge-auth.js";
import { TransportManager } from "../transports/manager.js";
import { type MenuContext, openMainMenu } from "./main-menu.js";

function makeMenuContext(overrides: Partial<MenuContext> = {}): MenuContext {
  return {
    ui: {
      select: vi.fn().mockRejectedValue(new Error("select() should not be called")),
      input: vi.fn().mockRejectedValue(new Error("input() should not be called")),
      notify: vi.fn(),
    },
    transportManager: new TransportManager(),
    auth: new ChallengeAuth(vi.fn(), vi.fn()),
    updateWidget: vi.fn(),
    cwd: "/tmp",
    isRpcMode: false,
    ...overrides,
  };
}

describe("openMainMenu", () => {
  it("RPC mode: never opens a blocking dialog, notifies with direct subcommands instead", async () => {
    const mctx = makeMenuContext({ isRpcMode: true });

    await openMainMenu(mctx);

    expect(mctx.ui.select).not.toHaveBeenCalled();
    expect(mctx.ui.input).not.toHaveBeenCalled();
    expect(mctx.ui.notify).toHaveBeenCalledTimes(1);
    const [message, level] = (mctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toContain("/msg-bridge connect");
    expect(message).toContain("/msg-bridge configure slack <bot-token> <app-token>");
    expect(message).toContain("RPC mode");
    expect(level).toBe("info");
  });

  it("TUI mode: still opens the interactive selector (regression guard)", async () => {
    const select = vi.fn().mockResolvedValue(undefined); // user cancels immediately
    const mctx = makeMenuContext({
      isRpcMode: false,
      ui: { select, input: vi.fn(), notify: vi.fn() },
    });

    await openMainMenu(mctx);

    expect(select).toHaveBeenCalledTimes(1);
    const [title] = select.mock.calls[0];
    expect(title).toContain("Message Bridge");
  });
});
