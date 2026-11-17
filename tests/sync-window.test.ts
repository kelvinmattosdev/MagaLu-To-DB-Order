import { expect, test } from "bun:test";
import { createSyncWindow } from "../src/config/sync-window";

const now = new Date("2026-11-17T18:45:00.000Z");

test("defaults to the last seven complete 24h periods by update, any status", () => {
    const window = createSyncWindow({}, now);
    expect(window.mode).toBe("recent");
    expect(window.filters).toEqual({
        updated_at__gte: "2026-11-10T18:45:00.000Z",
        updated_at__lte: "2026-11-17T18:45:00.000Z",
    });
    expect(window.filters).not.toHaveProperty("purchased_at__gte");
    expect(window.filters).not.toHaveProperty("status");
});

test("supports a custom rolling lookback across month/year boundaries", () => {
    const window = createSyncWindow({SYNC_LOOKBACK_DAYS: "2"}, new Date("2026-01-01T01:00:00.000Z"));
    expect(window.filters.updated_at__gte).toBe("2025-12-30T01:00:00.000Z");
});

test("full mode is explicit and sends no date filters", () => {
    expect(createSyncWindow({SYNC_MODE: "full"}, now)).toEqual({mode: "full", filters: {}});
});

test.each(["0", "-1", "1.5", "seven", "Infinity", "1e2", "", "999999999999999999"])("rejects invalid lookback %j", value => {
    expect(() => createSyncWindow({SYNC_LOOKBACK_DAYS: value}, now)).toThrow("SYNC_LOOKBACK_DAYS");
});

test("rejects unknown modes instead of accidentally fetching the full history", () => {
    expect(() => createSyncWindow({SYNC_MODE: "recnet"}, now)).toThrow("SYNC_MODE");
});

test("does not mutate the execution start date or reuse a later clock reading", () => {
    const original = now.toISOString();
    const window = createSyncWindow({}, now);
    expect(now.toISOString()).toBe(original);
    expect(window.filters.updated_at__lte).toBe(original);
});
