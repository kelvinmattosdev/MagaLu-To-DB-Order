import chalk from "chalk";
import { getTokensMagalu, persistMagaluApiResponse, poolMagalu, poolTokens } from "./services/database.service";
import { MagaluAPI } from "@refigure/magalu-api";

const mask = (s: string) => s.slice(0, 6) + "..." + s.slice(-4);

const REQUIRED_COMPANIES = ["jaupesca", "ltsports", "jaufishing"] as const;
type RequiredCompany = (typeof REQUIRED_COMPANIES)[number];

export type MagaluTokensByCompany = Record<RequiredCompany, string>;
type MagaluMap = Record<RequiredCompany, MagaluAPI>

// //TODO [DEBUG]
// type PathStyle = "dot" | "jsonpath";

// type FindKeyOptions = {
//     includeUndefined?: boolean;
//     maxDepth?: number;
//     pathStyle?: PathStyle;

//     // Agora tipado com 3 args (path, value, parent)
//     onMatch?: (path: string, value: unknown, parent: Record<string, unknown> | unknown[] | null) => void;
// };

// const isObjectLike = (v: unknown): v is Record<string, unknown> | unknown[] =>
//     typeof v === "object" && v !== null;

// const isValidIdentifier = (k: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);

// /**
//  * Busca recursivamente por uma chave (ex: "uuid") dentro de qualquer estrutura (obj/array)
//  * e chama onMatch com (path, value, parent).
//  */
// export function findKeyRecursive(
//     root: unknown,
//     targetKey: string,
//     opts: FindKeyOptions = {},
// ): void {
//     const {
//         includeUndefined = false,
//         maxDepth = Number.POSITIVE_INFINITY,
//         pathStyle = "dot",
//         onMatch = (path: string, value: unknown) => {
//             // default: loga como você pediu
//             // eslint-disable-next-line no-console
//             console.log(`${path} : ${String(value)}`);
//         },
//     } = opts;

//     const seen = new WeakSet<object>();

//     const makePath = (base: string, key: string | number): string => {
//         const isIndex = typeof key === "number";

//         if (pathStyle === "jsonpath") {
//             if (isIndex) return `${base}[${key}]`;
//             const kk = String(key);
//             return isValidIdentifier(kk)
//                 ? `${base}.${kk}`
//                 : `${base}['${kk.replaceAll("'", "\\'")}']`;
//         }

//         // dot
//         if (isIndex) return `${base}[${key}]`;
//         const kk = String(key);
//         return isValidIdentifier(kk)
//             ? `${base}.${kk}`
//             : `${base}["${kk.replaceAll('"', '\\"')}"]`;
//     };

//     const walk = (node: unknown, path: string, depth: number): void => {
//         if (depth > maxDepth) return;
//         if (!isObjectLike(node)) return;

//         // evita loop em estruturas com referência circular
//         if (seen.has(node as object)) return;
//         seen.add(node as object);

//         if (Array.isArray(node)) {
//             for (let i = 0; i < node.length; i++) {
//                 walk(node[i], makePath(path, i), depth + 1);
//             }
//             return;
//         }

//         // objeto (Record<string, unknown>)
//         for (const [k, v] of Object.entries(node)) {
//             const nextPath = makePath(path, k);

//             if (k === targetKey) {
//                 if (includeUndefined || v !== undefined) {
//                     onMatch(nextPath, v, node);
//                 }
//             }

//             walk(v, nextPath, depth + 1);
//         }
//     };

//     const start = "$";
//     walk(root, start, 0);
// }

// /* --------- opcional: coletar resultados --------- */
// export function collectKeyPaths(
//     root: unknown,
//     targetKey: string,
//     opts: Omit<FindKeyOptions, "onMatch"> = {},
// ): Array<{ path: string; value: unknown }> {
//     const out: Array<{ path: string; value: unknown }> = [];
//     findKeyRecursive(root, targetKey, {
//         ...opts,
//         onMatch: (path, value) => out.push({ path, value }),
//     });
//     return out;
// }
// //TODO [DEBUG]

function assertAllTokens<K extends string>(
    tokens: Partial<Record<K, string>>,
    required: readonly K[]
): asserts tokens is Record<K, string> {
    const missing: K[] = [];

    for (const key of required) {
        if (!tokens[key]) missing.push(key);
    }

    if (missing.length) {
        throw new Error(`Tokens não encontrados para: ${missing.join(", ")}`);
    }
}

async function captureAccessTokenMagalu(): Promise<MagaluTokensByCompany> {
    const tokensRaw = await getTokensMagalu();

    const tokens = Object.fromEntries(
        tokensRaw
            .filter(
                (t) =>
                    REQUIRED_COMPANIES.includes(t.company as RequiredCompany) &&
                    Boolean(t.access_token)
            )
            .map((t) => [t.company, t.access_token as string])
    ) as Partial<Record<RequiredCompany, string>>;

    assertAllTokens(tokens, REQUIRED_COMPANIES);
    // console.log(chalk.bgBlueBright('                                   ')); //TODO [DEBUG]
    // console.log(chalk.greenBright('Tokens capturados:')); //TODO [DEBUG]
    // console.log( //TODO [DEBUG]
    //     Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, mask(v)])) //TODO [DEBUG]
    // ); //TODO [DEBUG]
    // console.log(chalk.bgBlueBright('                                   ')); //TODO [DEBUG]

    return tokens; // ✅ aqui o TS sabe que é Record<RequiredCompany, string>
}

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
    if (!(error instanceof Error)) return true;

    const statusMatch = error.message.match(/failed with status (\d{3})/i);
    if (!statusMatch) {
        // A biblioteca não encapsula erros de rede do fetch em uma mensagem HTTP.
        return !/falha de autentica[cç][aã]o|access token/i.test(error.message);
    }

    const status = Number(statusMatch[1]);
    return status === 408 || status === 429 || status >= 500;
}

async function getOrdersPageWithRetry(
    api: MagaluAPI,
    company: RequiredCompany,
    offset: number,
) {
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
        try {
            return await api.orders.getListPedidos({
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
        const tokens = await captureAccessTokenMagalu();

        Object.entries(tokens).forEach(([key, value]) => {
            console.log(chalk.greenBright(key + ": OK!")); // mask(value))); //TODO Somente para debug (é só pra aparecer, não é necessário para funcionar)
        });

        const magaluMap: MagaluMap = fromEntriesTyped(
            REQUIRED_COMPANIES.map((c) => [c, new MagaluAPI({ 
                baseUrl: "https://api.magalu.com",
                accessToken: tokens[c],
                refreshTokenFn: async () => {
                    console.log(chalk.red("Access Token Inválido... Buscando outro..."));
                    await new Promise((resolve) => setTimeout(resolve, 60 * 1000)); //? Espera 1 minuto antes de buscar um novo token
                    const tokens: Record<string, string> = await captureAccessTokenMagalu();
                    console.log(chalk.red("Access Token Novo. Tentando novamente..."));
                    return tokens[c]!;
                },
                maxConsecutiveRefreshFails: 500 //? Isso equivale a 10 tentativas antes de dar "ERRO" (porque está em chunks)
            })])
        ) satisfies MagaluMap;

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
                        const res = await getOrdersPageWithRetry(api, company, offset);

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
        await Promise.allSettled([poolMagalu.end(), poolTokens.end()]);
        process.exit(exitCode);
    }
})();
