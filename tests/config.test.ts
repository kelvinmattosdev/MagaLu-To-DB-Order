import { expect, test } from "bun:test";

test("configuration requires no DB_TOKENS variables and defaults to the public manager", () => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", 'const {tokenManagerConfig} = await import("./src/config/config.ts"); console.log(tokenManagerConfig.baseUrl);'], {
        cwd: import.meta.dir + "/..",
        env: {JP_API_KEY: "synthetic-key", DB_MAGALU_URL: "postgresql://unused:unused@localhost/unused", DB_MAGALU_SCHEMA: "public"},
        stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("https://jp-token-manager-api.jaupesca.com.br");
});
