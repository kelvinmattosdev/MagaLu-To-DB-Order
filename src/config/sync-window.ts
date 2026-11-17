import type { GetListPedidosQueryParameters } from "@refigure/magalu-api";

type SyncEnvironment = { SYNC_MODE?: string; SYNC_LOOKBACK_DAYS?: string };
type SyncWindow = {
    mode: "recent" | "full";
    filters: Pick<GetListPedidosQueryParameters, "updated_at__gte" | "updated_at__lte">;
};

/** Captura um único intervalo para todas as empresas, páginas e retentativas. */
export function createSyncWindow(env: SyncEnvironment, now = new Date()): SyncWindow {
    const mode = env.SYNC_MODE?.trim() ?? "recent";
    if (mode !== "recent" && mode !== "full") {
        throw new Error("SYNC_MODE deve ser recent ou full.");
    }
    if (mode === "full") return { mode, filters: {} };

    const rawDays = env.SYNC_LOOKBACK_DAYS?.trim() ?? "7";
    const days = Number(rawDays);
    const endMs = now.getTime();
    const startMs = endMs - days * 24 * 60 * 60 * 1000;
    if (!/^\d+$/.test(rawDays) || !Number.isSafeInteger(days) || days < 1 ||
        !Number.isFinite(endMs) || !Number.isFinite(new Date(startMs).getTime())) {
        throw new Error("SYNC_LOOKBACK_DAYS deve ser um inteiro positivo que resulte em uma data válida.");
    }
    return {
        mode,
        filters: {
            updated_at__gte: new Date(startMs).toISOString(),
            updated_at__lte: now.toISOString(),
        },
    };
}
