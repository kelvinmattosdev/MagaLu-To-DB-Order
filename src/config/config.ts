import chalk from "chalk";

function captureEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(chalk.bgRed.bold(`Variável "${name}" não foi localizada dentro do arquivo .env\n   Por favor, preencha o .env com todas as variáveis necessárias.    `));
        console.warn(chalk.yellowBright.underline(`\nJP_BASE_URL=https://jp-token-manager-api.jaupesca.com.br
JP_API_KEY=your_consumer_api_key

DB_MAGALU_URL=postgresql://user:password@host:port/database
DB_MAGALU_SCHEMA=your_schema\n\n`));
        process.exit(1); //? FINALIZA COM ERRO
    }
    return value;
}

export const tokenManagerConfig = {
    baseUrl: process.env.JP_BASE_URL?.trim() || "https://jp-token-manager-api.jaupesca.com.br",
    apiKey: captureEnv("JP_API_KEY")
} as const;

export const dbMagaluConfig = {
    url: captureEnv("DB_MAGALU_URL"),
    schema: captureEnv("DB_MAGALU_SCHEMA")
} as const;