import chalk from "chalk";
import { persistMagaluApiResponse, poolMagalu } from "./services/database.service";
import { TokenManager, TokenManagerError } from "./services/token-manager.service";
import { MagaluOrdersClient } from "./services/magalu-orders.service";
import { tokenManagerConfig } from "./config/config";
import { createSyncWindow } from "./config/sync-window";

const REQUIRED_COMPANIES = ["jaupesca", "ltsports", "jaufishing"] as const;
type RequiredCompany = (typeof REQUIRED_COMPANIES)[number];

export type MagaluTokensByCompany = Record<RequiredCompany, string>;
type MagaluMap = Record<RequiredCompany, MagaluOrdersClient>

function fromEntriesTyped<K extends string, V>(
    entries: readonly (readonly [K, V])[],
): Record<K, V> {
    return Object.fromEntries(entries) as Record<K, V>;
}

function chunk<T>(arr: T[], size: number): T[][] {
    const res: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        const chunk = arr.slice(i, i + size);
        res.push(chunk);
    }
    return res;
}

const PAGE_LIMIT = 50;
const PARALLEL_PAGES = 4;
const MAX_REQUEST_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 2_000;

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function isRetriableMagaluRequestError(error: unknown): boolean {
    if (error instanceof TokenManagerError || (error instanceof Error && error.message.startsWith("Token Manager:"))) return false;
    if (!(error instanceof Error)) return true;

    const statusMatch = error.message.match(/failed with status (\d{3})/i);
    if (!statusMatch) {
        // Falhas de transporte não contêm um status HTTP.
        return !/falha de autentica[cç][aã]o|access token/i.test(error.message);
    }

    const status = Number(statusMatch[1]);
    return status === 408 || status === 429 || status >= 500;
}

async function getOrdersPageWithRetry(
    api: MagaluOrdersClient,
    company: RequiredCompany,
    offset: number,
    filters: ReturnType<typeof createSyncWindow>["filters"],
) {
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
        try {
            return await api.getListPedidos({
                ...filters,
                _limit: PAGE_LIMIT,
                _offset: offset,
                _sort: "purchased_at:asc",
            });
        } catch (error) {
            const isLastAttempt = attempt === MAX_REQUEST_ATTEMPTS;
            if (isLastAttempt || !isRetriableMagaluRequestError(error)) throw error;

            const exponentialDelay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
            const jitter = Math.floor(Math.random() * 1_000);
            const waitMs = exponentialDelay + jitter;
            const reason = error instanceof Error ? error.message : String(error);

            console.warn(
                chalk.yellow(
                    `[${company}] Offset ${offset}: tentativa ${attempt}/${MAX_REQUEST_ATTEMPTS} falhou (${reason}). ` +
                    `Tentando novamente em ${(waitMs / 1_000).toFixed(1)}s.`
                )
            );
            await sleep(waitMs);
        }
    }

    // O loop sempre retorna ou lança; necessário apenas para a análise estática.
    throw new Error("Número máximo de tentativas atingido.");
}

(async () => {
    let exitCode = 0;
    try {
        const syncWindow = createSyncWindow({
            SYNC_MODE: process.env.SYNC_MODE,
            SYNC_LOOKBACK_DAYS: process.env.SYNC_LOOKBACK_DAYS,
        });
        console.log(chalk.blueBright(syncWindow.mode === "full"
            ? "Sincronização completa: todos os pedidos, sem filtro de data."
            : `Sincronização por atualização: ${syncWindow.filters.updated_at__gte} até ${syncWindow.filters.updated_at__lte} (UTC).`));
        const tokenManager = new TokenManager(tokenManagerConfig);
        await tokenManager.initialize(REQUIRED_COMPANIES);
        for (const company of REQUIRED_COMPANIES) console.log(chalk.greenBright(company + ": OK!"));
        const magaluMap: MagaluMap = fromEntriesTyped(
            REQUIRED_COMPANIES.map(company => [company, new MagaluOrdersClient(tokenManager, company)] as const)
        );

        for (const company of REQUIRED_COMPANIES) {
            console.log(chalk.bgBlueBright.bold(`                     EMPRESA: ${company.toUpperCase()}                     `));
            const api = magaluMap[company];
            // console.log(chalk.bgBlueBright('                                   ')); //TODO [DEBUG]
            const STRIDE = PAGE_LIMIT; // offset anda de 50 em 50

            let baseOffset = 0;

            while (true) {
                const offsets = Array.from({ length: PARALLEL_PAGES }, (_, i) => baseOffset + i * STRIDE);

                process.stdout.write(
                    chalk.yellowBright(
                        `\r| Capturando lote... offsets: ${offsets[0]}..${offsets[offsets.length - 1]} (limit ${PAGE_LIMIT}) |`
                    )
                );

                // Limita a concorrência para reduzir pressão sobre a API.
                const batch = await Promise.all(
                    offsets.map(async (offset) => {
                        const res = await getOrdersPageWithRetry(api, company, offset, syncWindow.filters);

                        const results = Array.isArray(res.results) ? res.results : [];
                        return { offset, res, count: results.length };
                    })
                );

                // ordena por offset pra persistir em ordem
                batch.sort((a, b) => a.offset - b.offset);

                // ✅ se qualquer página vier vazia, é sinal de fim (pra offsets maiores)
                const firstEmpty = batch.find((x) => x.count === 0);

                // persiste todas que vieram com itens (>0)
                for (const item of batch) {
                    if (item.count === 0) continue;

                    process.stdout.write(
                        chalk.yellow(
                            `\r| Capturado! Offset: ${item.offset} (${item.count} items) | Atualizando no banco... |`
                        )
                    );

                    await persistMagaluApiResponse(item.res, { company });

                    process.stdout.write(
                        chalk.greenBright(
                            `\r| Capturado! Offset: ${item.offset} (${item.count} items) | Atualizado no banco com sucesso! |\n`
                        )
                    );
                }

                if (firstEmpty) {
                    process.stdout.write(
                        chalk.blueBright(
                            `\r| Fim! Offset: ${firstEmpty.offset} retornou 0 items. Parando.                                |\n`
                        )
                    );
                    break;
                }

                // Próximo lote de páginas.
                baseOffset += PARALLEL_PAGES * STRIDE;
            }
            // await persistMagaluApiResponse(res, { company: company });
            // console.log(chalk.bgBlueBright('                                   ')); //TODO [DEBUG]
        }
    }
    catch (error) {
        console.error(error);
        exitCode = 1;
    }
    finally {
        await Promise.allSettled([poolMagalu.end()]);
        process.exit(exitCode);
    }
})();
