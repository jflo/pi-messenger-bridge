import { describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "./challenge-auth.js";

describe("ChallengeAuth onAuthEvent", () => {
  it("emits challenge_issued with parsed userId/transport and the shown code", async () => {
    const onShowCode = vi.fn();
    const onAuthEvent = vi.fn();
    const auth = new ChallengeAuth(onShowCode, vi.fn(), undefined, undefined, onAuthEvent);
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const authorized = await auth.checkAuthorization("123", "chat1", "alice", false, false, sendMessage, "telegram");

    expect(authorized).toBe(false); // challenge just issued, not yet validated
    const shownCode = onShowCode.mock.calls[0][0];
    expect(onAuthEvent).toHaveBeenCalledWith("challenge_issued", {
      userId: "123",
      username: "alice",
      transport: "telegram",
      code: shownCode,
    });
  });

  it("emits user_authenticated after the correct code is entered", async () => {
    const onShowCode = vi.fn();
    const onAuthEvent = vi.fn();
    const auth = new ChallengeAuth(onShowCode, vi.fn(), undefined, undefined, onAuthEvent);
    const sendMessage1 = vi.fn().mockResolvedValue(undefined);
    const sendMessage2 = vi.fn().mockResolvedValue(undefined);

    await auth.checkAuthorization("123", "chat1", "alice", false, false, sendMessage1, "telegram");
    const code = onShowCode.mock.calls[0][0];

    const handled = await auth.handleAdminCommand(code, "chat1", "123", sendMessage2, "telegram");

    expect(handled).toBe(true);
    expect(onAuthEvent).toHaveBeenCalledWith("user_authenticated", {
      userId: "123",
      username: "alice",
      transport: "telegram",
    });
  });

  it("splits a Matrix mxid (which itself contains a colon) at the transport boundary only", async () => {
    const onShowCode = vi.fn();
    const onAuthEvent = vi.fn();
    const auth = new ChallengeAuth(onShowCode, vi.fn(), undefined, undefined, onAuthEvent);
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await auth.checkAuthorization("@bob:example.org", "room1", "bob", false, false, sendMessage, "matrix");

    const shownCode = onShowCode.mock.calls[0][0];
    expect(onAuthEvent).toHaveBeenCalledWith("challenge_issued", {
      userId: "@bob:example.org",
      username: "bob",
      transport: "matrix",
      code: shownCode,
    });
  });

  it("works without an onAuthEvent callback (backward compatible construction)", async () => {
    const onShowCode = vi.fn();
    const auth = new ChallengeAuth(onShowCode, vi.fn());
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await auth.checkAuthorization("123", "chat1", "alice", false, false, sendMessage, "telegram");
    const code = onShowCode.mock.calls[0][0];

    await expect(auth.handleAdminCommand(code, "chat1", "123", sendMessage, "telegram")).resolves.toBe(true);
  });
});
