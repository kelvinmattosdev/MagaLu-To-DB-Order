import { expect, test } from "bun:test";
import { MagaluOrdersClient } from "../src/services/magalu-orders.service";
import { createSyncWindow } from "../src/config/sync-window";
import { TokenManager, TokenManagerError } from "../src/services/token-manager.service";

function fixture(statuses: number[], refreshError?: Error) {
    let value = "old";
    let refreshes = 0;
    const calls: {url: string; init: RequestInit}[] = [];
    const tokens = {
        getToken: () => value,
        refresh: async (company: string, rejected: string) => {
            expect(company).toBe("jaupesca");
            expect(rejected).toBe("old");
            refreshes++;
            if (refreshError) throw refreshError;
            value = "new";
            return value;
        },
    } as unknown as TokenManager;
    const client = new MagaluOrdersClient(tokens, "jaupesca", async (url, init) => {
        calls.push({url, init});
        const status = statuses.shift();
        if (status === undefined) throw new Error("Unexpected call");
        return new Response(JSON.stringify(status === 200 ? {meta: {links: {self: ""}, page: {count: 0, limit: 50, max_limit: 50, offset: 150}}, results: []} : {error: "sensitive-provider-body"}), {status});
    });
    return {client, calls, refreshes: () => refreshes};
}

test("preserves orders endpoint and pagination, retries once with refreshed bearer on 401", async () => {
    const f = fixture([401, 200]);
    expect(await f.client.getListPedidos({_limit: 50, _offset: 150, _sort: "purchased_at:asc"})).toEqual({meta: {links: {self: ""}, page: {count: 0, limit: 50, max_limit: 50, offset: 150}}, results: []});
    const url = new URL(f.calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.magalu.com/seller/v1/orders");
    expect(url.searchParams.get("_offset")).toBe("150");
    expect(url.searchParams.get("_limit")).toBe("50");
    expect(url.searchParams.get("_sort")).toBe("purchased_at:asc");
    expect(new Headers(f.calls[1]!.init.headers).get("Authorization")).toBe("Bearer new");
    expect(f.refreshes()).toBe(1);
});

test.each([403, 429, 500])("HTTP %i does not refresh or expose response body", async status => {
    const f = fixture([status]);
    await expect(f.client.getListPedidos({})).rejects.toThrow(`failed with status ${status}`);
    expect(f.refreshes()).toBe(0);
    expect(f.calls).toHaveLength(1);
});

test("persistent 401 stops after one recovery", async () => {
    const f = fixture([401, 401]);
    await expect(f.client.getListPedidos({})).rejects.toThrow("status 401");
    expect(f.refreshes()).toBe(1);
    expect(f.calls).toHaveLength(2);
});

test("manager permission failure stops the orders request", async () => {
    const f = fixture([401], new TokenManagerError(403));
    await expect(f.client.getListPedidos({})).rejects.toBeInstanceOf(TokenManagerError);
    expect(f.calls).toHaveLength(1);
});


test("serializes the same update window on each page and after 401 recovery", async () => {
    const f = fixture([401, 200, 200]);
    const {filters} = createSyncWindow({}, new Date("2026-11-17T18:45:00.000Z"));
    await f.client.getListPedidos({...filters, _limit: 50, _offset: 0, _sort: "purchased_at:asc"});
    await f.client.getListPedidos({...filters, _limit: 50, _offset: 50, _sort: "purchased_at:asc"});
    for (const call of f.calls) {
        const url = new URL(call.url);
        expect(url.searchParams.get("updated_at__gte")).toBe("2026-11-10T18:45:00.000Z");
        expect(url.searchParams.get("updated_at__lte")).toBe("2026-11-17T18:45:00.000Z");
        expect(url.searchParams.has("status")).toBe(false);
        expect(url.searchParams.has("purchased_at__gte")).toBe(false);
    }
    expect(new URL(f.calls[2]!.url).searchParams.get("_offset")).toBe("50");
});
