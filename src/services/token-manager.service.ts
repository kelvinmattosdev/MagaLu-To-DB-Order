type Integration = { id: string; empresa: string; provedor: string; version: number };
type Credential = { id: string; access_token: string; version: number };
type Transport = (url: string, init: RequestInit) => Promise<Response>;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const validVersion = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

export class TokenManagerError extends Error {
    constructor(public readonly status: number, public readonly code: string = "request_failed") {
        super(`Token Manager: HTTP ${status} (${code}). Verifique chave, whitelist, permissões e estado da integração.`);
    }
}

export class TokenManager {
    private readonly baseUrl: string;
    private readonly transport: Transport;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly integrations = new Map<string, Integration>();
    private readonly credentials = new Map<string, Credential>();
    private readonly inFlight = new Map<string, Promise<string>>();
    private queue: Promise<unknown> = Promise.resolve();
    private nextRequestAt = 0;
    private nextRefreshAt = 0;

    constructor(private readonly config: { baseUrl: string; apiKey: string }, dependencies: { fetch?: Transport; sleep?: (ms: number) => Promise<void> } = {}) {
        const url = new URL(config.baseUrl);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
            throw new Error("JP_BASE_URL deve ser uma origem HTTPS, sem credenciais, caminho ou parâmetros.");
        }
        if (!config.apiKey.trim()) throw new Error("JP_API_KEY é obrigatória.");
        this.baseUrl = url.origin;
        this.transport = dependencies.fetch ?? ((url, init) => fetch(url, init));
        this.sleep = dependencies.sleep ?? pause;
    }

    private retryDelay(response: Response): number {
        const value = response.headers.get("Retry-After");
        const seconds = value === null ? NaN : Number(value);
        const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value ?? "") - Date.now();
        const delay = Number.isFinite(ms) ? Math.max(0, ms) : 2000;
        if (delay > 120_000) throw new Error("Token Manager: Retry-After excede a espera máxima de 120s; tente em outra execução.");
        return delay;
    }

    private request(path: string, version?: number): Promise<{ response: Response; body: any }> {
        // Uma fila por instância compartilha o limite entre empresas, leituras e refresh.
        const task = this.queue.then(async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                const wait = Math.max(this.nextRequestAt, version === undefined ? 0 : this.nextRefreshAt) - Date.now();
                if (wait > 0) await this.sleep(wait);
                this.nextRequestAt = Date.now() + 510; // abaixo de 120 chamadas/minuto
                if (version !== undefined) this.nextRefreshAt = Date.now() + 6100; // abaixo de 10 refresh/minuto
                let response: Response;
                try {
                    response = await this.transport(`${this.baseUrl}${path}`, {
                        method: version === undefined ? "GET" : "POST",
                        headers: {
                            Authorization: `Bearer ${this.config.apiKey}`,
                            Accept: "application/json",
                            ...(version === undefined ? {} : { "Content-Type": "application/json" }),
                        },
                        ...(version === undefined ? {} : { body: JSON.stringify({ expected_version: version }) }),
                        redirect: "error",
                        signal: AbortSignal.timeout(15_000),
                        cache: "no-store",
                    });
                } catch {
                    // Não repetir POST após resultado incerto, nem expor erro que contenha credenciais.
                    throw new Error("Token Manager: falha de transporte ou timeout; estado da operação não confirmado.");
                }
                if (response.status === 429) {
                    const delay = this.retryDelay(response);
                    this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + delay);
                    await response.body?.cancel();
                    if (attempt === 2) throw new TokenManagerError(429, "rate_limit");
                    await this.sleep(delay);
                    continue;
                }
                let body: any;
                try { body = await response.json(); }
                catch { throw new TokenManagerError(response.status, "invalid_response"); }
                if (!response.ok) {
                    // Apenas códigos conhecidos são propagados; nunca o corpo de erro recebido.
                    const code = body?.error === "token_refresh_required" ? "token_refresh_required" : "request_failed";
                    throw new TokenManagerError(response.status, code);
                }
                return { response, body };
            }
            throw new TokenManagerError(429, "rate_limit");
        });
        this.queue = task.catch(() => undefined);
        return task;
    }

    async initialize(companies: readonly string[]): Promise<void> {
        const { body } = await this.request("/api/v1/integrations");
        if (!Array.isArray(body?.data)) throw new Error("Token Manager: listagem inválida.");
        const selected = companies.map(company => {
            const matches = body.data.filter((i: any) => i?.provedor === "magalu" && i?.empresa === company);
            if (matches.length !== 1) throw new Error(`Token Manager: esperada exatamente uma integração Magalu para ${company}; encontradas ${matches.length}. Revise as integrações permitidas da chave.`);
            const entry = matches[0];
            if (typeof entry.id !== "string" || !entry.id || !validVersion(entry.version)) throw new Error("Token Manager: integração inválida.");
            return [company, entry] as const;
        });
        for (const [company, entry] of selected) this.integrations.set(company, entry);
        for (const [company] of selected) {
            try { await this.read(company); }
            catch (error) {
                if (!this.needsRefresh(error)) throw error;
                await this.refresh(company);
            }
        }
    }

    getToken(company: string): string {
        const credential = this.credentials.get(company);
        if (!credential) throw new Error(`Token Manager: token não carregado para ${company}.`);
        return credential.access_token;
    }

    private integration(company: string): Integration {
        const integration = this.integrations.get(company);
        if (!integration) throw new Error(`Token Manager: integração não carregada para ${company}.`);
        return integration;
    }

    private needsRefresh(error: unknown): boolean {
        return error instanceof TokenManagerError && error.status === 409 && error.code === "token_refresh_required";
    }

    private async read(company: string): Promise<string> {
        const integration = this.integration(company);
        const { body } = await this.request(`/api/v1/integrations/${encodeURIComponent(integration.id)}/access-token`);
        if (body?.id !== integration.id || typeof body?.access_token !== "string" || !body.access_token.trim() || !validVersion(body.version)) {
            throw new Error("Token Manager: credencial inválida.");
        }
        this.credentials.set(company, body);
        integration.version = body.version;
        return body.access_token;
    }

    refresh(company: string, rejectedToken?: string): Promise<string> {
        const active = this.inFlight.get(company);
        if (active) return active;
        const credential = this.credentials.get(company);
        if (rejectedToken && credential && credential.access_token !== rejectedToken) return Promise.resolve(credential.access_token);
        const task = this.refreshOnce(company, rejectedToken).finally(() => this.inFlight.delete(company));
        this.inFlight.set(company, task);
        return task;
    }

    private async refreshOnce(company: string, rejectedToken?: string): Promise<string> {
        const integration = this.integration(company);
        const { response, body } = await this.request(`/api/v1/integrations/${encodeURIComponent(integration.id)}/refresh`, integration.version);
        const pending = response.status === 202 && body?.result === "in_progress";
        if (!pending && (response.status !== 200 || !["renewed", "already_updated", "reused"].includes(body?.result))) {
            throw new Error("Token Manager: resposta de refresh inválida.");
        }
        let delay = pending ? this.retryDelay(response) : 0;
        for (let attempt = 0; attempt < 5; attempt++) {
            if (delay > 0) await this.sleep(delay);
            try {
                const token = await this.read(company);
                if (!pending || !rejectedToken || token !== rejectedToken) return token;
                // Durante 202 o endpoint pode ainda entregar a credencial rejeitada.
                delay = Math.max(delay, 2000);
            }
            catch (error) {
                if (!pending || !this.needsRefresh(error)) throw error;
                delay = Math.max(delay, 2000);
            }
        }
        throw new Error("Token Manager: renovação ainda em andamento após cinco consultas; tente em outra execução.");
    }
}
