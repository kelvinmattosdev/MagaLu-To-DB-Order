import chalk from "chalk";

function captureEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(chalk.bgRed.bold(`Variável "${name}" não foi localizada dentro do arquivo .env\n   Por favor, preencha o .env com todas as variáveis necessárias.    `));
        console.warn(chalk.yellowBright.underline(`\nDB_TOKENS_URL=postgresql://user:password@host:port/database
DB_TOKENS_SCHEMA=your_schema
DB_TOKENS_TABLE=your_table

DB_MAGALU_URL=postgresql://user:password@host:port/database
DB_MAGALU_SCHEMA=your_schema\n\n`));
        process.exit(1); //? FINALIZA COM ERRO
    }
    return value;
}

export const dbTokensConfig = {
    url: captureEnv("DB_TOKENS_URL"),
    schema: captureEnv("DB_TOKENS_SCHEMA"),
    table: captureEnv("DB_TOKENS_TABLE")
} as const;

export const dbMagaluConfig = {
    url: captureEnv("DB_MAGALU_URL"),
    schema: captureEnv("DB_MAGALU_SCHEMA")
} as const;