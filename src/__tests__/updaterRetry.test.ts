import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../licensing/updater";

// delayMs 0 throughout: the backoff itself is not under test, and real sleeps
// would make this suite slow for no added confidence.
describe("update retry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(withRetry(fn, 3, 0)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("recovers from a transient failure, which is the whole point", async () => {
    // The CDN drops the first handshake, then works — exactly what made people
    // click "Check now" several times.
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("handshake dropped");
      return "update.json";
    });
    await expect(withRetry(fn, 3, 0)).resolves.toBe("update.json");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("still down");
    });
    await expect(withRetry(fn, 3, 0)).rejects.toThrow("still down");
    // Exactly 3 — not 4, and not an endless loop.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("honours a single-attempt configuration", async () => {
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(withRetry(fn, 1, 0)).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not sleep after the final attempt", async () => {
    // A trailing sleep would delay the error the user sees for no reason.
    const sleeps: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((cb: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      return realSetTimeout(cb, 0);
    }) as typeof setTimeout);

    const fn = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(withRetry(fn, 3, 50)).rejects.toThrow("down");
    vi.unstubAllGlobals();

    // 3 attempts => 2 gaps, and the backoff grows.
    expect(sleeps).toEqual([50, 100]);
  });
});
