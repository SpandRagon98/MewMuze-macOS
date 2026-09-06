import { describe, expect, it } from "vitest";
import { resolveUserIdle } from "../interaction/cursorTracker";

describe("combined mouse and keyboard inactivity", () => {
  it("keeps the cat awake while keyboard input is recent even if the cursor is still", () => {
    expect(resolveUserIdle(250, 90)).toEqual({ idle: false, idleSeconds: 0.25 });
  });

  it("allows sleep only after the combined Windows input timer is idle", () => {
    expect(resolveUserIdle(25_000, 0)).toEqual({ idle: true, idleSeconds: 25 });
  });

  it("uses cursor inactivity only when the native aggregate is unavailable", () => {
    expect(resolveUserIdle(null, 19)).toEqual({ idle: true, idleSeconds: 19 });
  });
});
