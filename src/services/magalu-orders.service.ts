import type { GetListPedidosQueryParameters, GetListPedidosResponse } from "@refigure/magalu-api";
import type { TokenManager } from "./token-manager.service";

/** Mantém rota e tipos da biblioteca; 403 não solicita refresh. */
export class MagaluOrdersClient {
    constructor(private readonly tokens: TokenManager, private readonly company: string,
        private readonly transport: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)) {}

    async getListPedidos(parameters: GetListPedidosQueryParameters): Promise<GetListPedidosResponse> {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(parameters)) if (value !== undefined) query.set(key, String(value));
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = this.tokens.getToken(this.company);
            let response: Response;
            try {
                response = await this.transport(`https://api.magalu.com/seller/v1/orders?${query}`, {
                    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                    signal: AbortSignal.timeout(30_000), redirect: "error",
                });
            } catch { throw new Error("Magalu: falha de transporte ou timeout."); }
            if (response.ok) {
                try { return await response.json() as GetListPedidosResponse; }
                catch { throw new Error("Magalu: resposta JSON inválida."); }
            }
            await response.body?.cancel();
            if (response.status === 401 && attempt === 0) {
                await this.tokens.refresh(this.company, token);
                continue;
            }
            throw new Error(`Magalu: request failed with status ${response.status}`);
        }
        throw new Error("Magalu: falha de autenticação após recuperação do token.");
    }
}
