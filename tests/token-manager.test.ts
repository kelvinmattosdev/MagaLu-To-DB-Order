import { describe, expect, test } from "bun:test";
import { TokenManager, TokenManagerError } from "../src/services/token-manager.service";

const integration = (empresa = "jaupesca", id = "id-1") => ({ id, empresa, provedor: "magalu", version: 7 });
const token = (value = "provider-token", version = 7) => ({ id: "id-1", access_token: value, version });
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
function fixture(responses: Response[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const waits: number[] = [];
    const manager = new TokenManager({ baseUrl: "https://manager.example", apiKey: "consumer-key" }, {
        fetch: async (url, init) => {
            calls.push({ url: String(url), init });
            const response = responses.shift();
            if (!response) throw new Error("Unexpected request");
            return response;
        },
        sleep: async ms => { waits.push(ms); },
    });
    return { manager, calls, waits };
}

describe("Token Manager", () => {
    test("discovers allowed Magalu integrations and authenticates without query secrets", async () => {
        const f = fixture([json({ data: [integration(), { ...integration("extra"), provedor: "tiny" }] }), json(token())]);
        await f.manager.initialize(["jaupesca"]);
        expect(f.manager.getToken("jaupesca")).toBe("provider-token");
        expect(f.calls.map(c => c.url)).toEqual(["https://manager.example/api/v1/integrations", "https://manager.example/api/v1/integrations/id-1/access-token"]);
        expect(new Headers(f.calls[0]!.init?.headers).get("Authorization")).toBe("Bearer consumer-key");
    });
    test.each([{ data: [] }, { data: [integration(), integration("jaupesca", "id-2")] }])("rejects missing or duplicate integration before token reads: %j", async payload => {
        const f = fixture([json(payload)]);
        await expect(f.manager.initialize(["jaupesca"])).rejects.toThrow("jaupesca");
        expect(f.calls).toHaveLength(1);
    });
    test("refreshes required token with version from listing", async () => {
        const f = fixture([json({ data: [integration()] }), json({ error: "token_refresh_required" }, 409), json({ result: "renewed" }), json(token("new", 8))]);
        await f.manager.initialize(["jaupesca"]);
        expect(f.manager.getToken("jaupesca")).toBe("new");
        expect(JSON.parse(String(f.calls[2]!.init?.body))).toEqual({ expected_version: 7 });
    });
    test.each(["renewed", "already_updated", "reused"])("rereads after %s and shares concurrent refresh", async result => {
        const f = fixture([json({ data: [integration()] }), json(token()), json({ result }), json(token("new", 8))]);
        await f.manager.initialize(["jaupesca"]);
        expect(await Promise.all([f.manager.refresh("jaupesca", "provider-token"), f.manager.refresh("jaupesca", "provider-token")])).toEqual(["new", "new"]);
        expect(await f.manager.refresh("jaupesca", "provider-token")).toBe("new");
        expect(f.calls.filter(c => c.init?.method === "POST")).toHaveLength(1);
    });
    test("202 waits and polls token without resubmitting refresh", async () => {
        const f = fixture([json({ data: [integration()] }), json(token()), json({ result: "in_progress" }, 202, { "Retry-After": "2" }), json({ error: "token_refresh_required" }, 409), json(token("new", 8))]);
        await f.manager.initialize(["jaupesca"]);
        expect(await f.manager.refresh("jaupesca", "provider-token")).toBe("new");
        expect(f.waits).toContain(2000);
        expect(f.calls.filter(c => c.init?.method === "POST")).toHaveLength(1);
    });
    test("429 respects Retry-After", async () => {
        const f = fixture([json({ error: "rate_limit" }, 429, { "Retry-After": "3" }), json({ data: [integration()] }), json(token())]);
        await f.manager.initialize(["jaupesca"]);
        expect(f.waits).toContain(3000);
    });
    test.each([401, 403, 404, 409, 500, 502, 503])("does not blindly retry manager error %i or leak its body", async status => {
        const f = fixture([json({ data: [integration()] }), json(token()), json({ error: "consumer-key provider-token" }, status)]);
        await f.manager.initialize(["jaupesca"]);
        try { await f.manager.refresh("jaupesca", "provider-token"); throw new Error("Expected failure"); }
        catch (error) {
            expect(error).toBeInstanceOf(TokenManagerError);
            expect(String(error)).not.toContain("consumer-key");
            expect(String(error)).not.toContain("provider-token");
        }
        expect(f.calls).toHaveLength(3);
    });
    test("limits polling of in-progress refresh", async () => {
        const f = fixture([json({ data: [integration()] }), json(token()), json({ result: "in_progress" }, 202), ...Array.from({length: 10}, () => json({error: "token_refresh_required"}, 409))]);
        await f.manager.initialize(["jaupesca"]);
        await expect(f.manager.refresh("jaupesca", "provider-token")).rejects.toThrow();
        expect(f.calls.length).toBeLessThan(12);
    });
    test("rejects malformed token and redirects", async () => {
        const f = fixture([json({ data: [integration()] }), json({access_token: "", version: -1})]);
        await expect(f.manager.initialize(["jaupesca"])).rejects.toThrow();
        expect(f.calls[0]!.init?.redirect).toBe("error");
    });
});

test("202 keeps polling when the rejected token is still served", async () => {
    const f = fixture([json({data: [integration()]}), json(token()), json({result: "in_progress"}, 202), json(token()), json(token("new", 8))]);
    await f.manager.initialize(["jaupesca"]);
    expect(await f.manager.refresh("jaupesca", "provider-token")).toBe("new");
    expect(f.calls.filter(c => c.init?.method === "POST")).toHaveLength(1);
});

test("refresh uses the version of the latest token, not the initial listing", async () => {
    const f = fixture([json({data: [integration()]}), json(token("initial", 9)), json({result: "renewed"}), json(token("new", 10))]);
    await f.manager.initialize(["jaupesca"]);
    await f.manager.refresh("jaupesca", "initial");
    expect(JSON.parse(String(f.calls[2]!.init?.body))).toEqual({expected_version: 9});
});

test.each(["transport", "invalid_json"])("uncertain refresh %s is not retried", async failure => {
    let calls = 0;
    const manager = new TokenManager({baseUrl: "https://manager.example", apiKey: "secret"}, {
        sleep: async () => {},
        fetch: async () => {
            calls++;
            if (calls === 1) return json({data: [integration()]});
            if (calls === 2) return json(token());
            if (failure === "transport") throw new Error("secret");
            return new Response("secret", {status: 200});
        },
    });
    await manager.initialize(["jaupesca"]);
    await expect(manager.refresh("jaupesca", "provider-token")).rejects.toThrow("Token Manager:");
    expect(calls).toBe(3);
});

test("429 stops after three requests", async () => {
    const f = fixture(Array.from({length: 5}, () => json({}, 429, {"Retry-After": "0"})));
    await expect(f.manager.initialize(["jaupesca"])).rejects.toThrow("HTTP 429");
    expect(f.calls).toHaveLength(3);
});

test("excessive Retry-After stops instead of retrying early", async () => {
    const f = fixture([json({}, 429, {"Retry-After": "121"})]);
    await expect(f.manager.initialize(["jaupesca"])).rejects.toThrow("120s");
    expect(f.calls).toHaveLength(1);
});
