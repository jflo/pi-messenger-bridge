import { describe, expect, it } from "vitest";
import { isRpcMode } from "../src/index";

describe("isRpcMode", () => {
  it("mode: 'rpc' wins over hasUI", () => {
    expect(isRpcMode({ mode: "rpc", hasUI: true })).toBe(true);
  });

  it("mode: 'tui' wins over hasUI", () => {
    expect(isRpcMode({ mode: "tui", hasUI: false })).toBe(false);
  });

  it("falls back to !hasUI when mode is absent (currently-installed pi types)", () => {
    expect(isRpcMode({ hasUI: false })).toBe(true);
    expect(isRpcMode({ hasUI: true })).toBe(false);
  });
});
