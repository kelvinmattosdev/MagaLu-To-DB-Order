# Magalu To DB

Integração em TypeScript que consulta pedidos da API do Magalu e os sincroniza com PostgreSQL. Executada com Bun, suporta múltiplas empresas, consultas paginadas em paralelo e retentativas automáticas para falhas temporárias.

## Funcionalidades

- Consulta de pedidos por empresa, ordenados pela data de compra.
- Leitura dos tokens de acesso em um banco PostgreSQL.
- Persistência de vendedores, pedidos, pagamentos, entregas, itens e devoluções, conforme os dados retornados pela API.
- Inserção e atualização de registros com `ON CONFLICT`, com transação por pedido.
- Reconciliação de pedidos com o mesmo código e identificadores diferentes.
- Armazenamento do payload original de pedidos e entregas em `raw_json`, com identificação da empresa no campo `_company`.
- Execução manual ou gerenciamento com PM2.

## Requisitos

- Bun instalado e disponível no `PATH`.
- Acesso à API do Magalu e tokens válidos para as empresas configuradas.
- PostgreSQL para leitura dos tokens e gravação dos pedidos; as duas conexões podem apontar para a mesma instância.
- Schemas e tabelas previamente criados, compatíveis com as consultas de `src/services/database.service.ts`.
- PM2, caso utilize a configuração de execução agendada.

O repositório não inclui migrations nem scripts de criação das tabelas. A aplicação espera encontrar a estrutura pronta no banco.

## Instalação

Na pasta do projeto, instale as dependências:

```bash
bun install
```

## Configuração

### Variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto com as cinco variáveis abaixo. Substitua os valores de exemplo pelos dados do seu ambiente:

```dotenv
DB_TOKENS_URL=postgresql://user:password@localhost:5432/tokens_db
DB_TOKENS_SCHEMA=public
DB_TOKENS_TABLE=integration_tokens

DB_MAGALU_URL=postgresql://user:password@localhost:5432/magalu_db
DB_MAGALU_SCHEMA=magazine_luiza
```

| Variável | Finalidade |
| --- | --- |
| `DB_TOKENS_URL` | String de conexão com o banco que armazena os tokens. |
| `DB_TOKENS_SCHEMA` | Schema da tabela de tokens. |
| `DB_TOKENS_TABLE` | Nome da tabela de tokens. |
| `DB_MAGALU_URL` | String de conexão com o banco de destino dos pedidos. |
| `DB_MAGALU_SCHEMA` | Schema das tabelas de destino. |

Todas as variáveis são obrigatórias. Se alguma estiver ausente ou vazia, a aplicação exibe as instruções de configuração e encerra com código `1`.

O `.env` contém credenciais e está previsto no `.gitignore`. Mantenha os valores reais fora do versionamento, inclusive de exemplos e logs. Configure nomes de schema e tabela apenas a partir de valores confiáveis, pois eles são interpolados nas consultas SQL.

### Empresas e tokens

As empresas exigidas estão definidas em `REQUIRED_COMPANIES`, no arquivo [src/index.ts](src/index.ts):

```ts
const REQUIRED_COMPANIES = ["jaupesca", "ltsports", "jaufishing"] as const;
```

A tabela de tokens deve disponibilizar, no mínimo, as colunas:

| Coluna | Conteúdo esperado |
| --- | --- |
| `company` | Identificador da empresa, igual ao configurado em `REQUIRED_COMPANIES`. |
| `provider` | Valor `magalu`. |
| `access_token` | Token de acesso válido para a empresa. |

A consulta atual seleciona até três registros com `provider = 'magalu'`, sem ordenação. Garanta que os registros retornados incluam um token para cada empresa exigida. Se houver empresas adicionais ou registros duplicados, ajuste a consulta em `getTokensMagalu()` para selecionar os tokens corretos.

Para adicionar ou remover empresas, revise tanto `REQUIRED_COMPANIES` quanto essa consulta. A execução é interrompida se faltar um token obrigatório.

Quando o cliente da API solicita um novo token, a aplicação aguarda 60 segundos e consulta novamente a tabela. A emissão e a atualização dos tokens no banco devem ser realizadas por outro processo.

### Banco de destino

O schema configurado em `DB_MAGALU_SCHEMA` deve conter as seguintes tabelas:

| Tabela | Dados persistidos |
| --- | --- |
| `sellers` | Vendedores. |
| `orders` | Pedidos, clientes, valores e payload original. |
| `order_payments` | Pagamentos associados aos pedidos. |
| `deliveries` | Entregas, destinatários, frete, rastreamento e payload original. |
| `delivery_items` | Itens de cada entrega. |
| `delivery_returns` | Devoluções associadas às entregas. |

As colunas e restrições devem corresponder às instruções SQL de [database.service.ts](src/services/database.service.ts), incluindo as chaves usadas nos conflitos: `seller_id`, `order_id`, `delivery_id` e `(delivery_id, sequencial)`, além da unicidade de `order_code` esperada pela reconciliação.

O usuário do banco de tokens precisa de permissão de leitura. O usuário do banco de destino precisa de permissões de leitura, inserção, atualização e exclusão nas tabelas utilizadas.

## Execução

Para executar diretamente o código TypeScript:

```bash
bun run dev
```

Para gerar e executar o build:

```bash
bun run build
bun run start
```

O build remove a pasta `build/` anterior e gera `build/index.js`, minificado e destinado ao runtime Bun.

| Comando | Ação |
| --- | --- |
| `bun run dev` | Executa `src/index.ts`. |
| `bun run build` | Limpa e gera o build. |
| `bun run start` | Executa `build/index.js`. |
| `bun run clean` | Remove a pasta `build/`. |
| `bunx tsc --noEmit` | Verifica os tipos sem executar a sincronização. |

Os comandos `dev` e `start` consultam a API e gravam no banco configurado. Ao concluir, o processo fecha as conexões e encerra com código `0`; em caso de erro, encerra com código `1`.

## Como funciona a sincronização

1. Lê e valida os tokens de todas as empresas exigidas.
2. Cria um cliente da API do Magalu para cada empresa.
3. Processa uma empresa por vez, consultando pedidos em ordem crescente de `purchased_at`.
4. Busca até quatro páginas simultaneamente, com até 50 pedidos por página.
5. Ordena as páginas pelo offset e persiste os pedidos em transações individuais.
6. Após persistir as páginas não vazias do lote, encerra a consulta da empresa se alguma página estiver vazia.
7. Avança para a próxima empresa e encerra o processo ao concluir todas.

Cada execução começa no offset `0`. Não há checkpoint nem filtro incremental por data; os registros retornados são reprocessados em cada execução.

Durante a persistência, vendedores, pedidos, entregas e itens são inseridos ou atualizados. Os pagamentos de cada pedido e as devoluções de cada entrega são substituídos pelos dados recebidos. Se um pedido falhar, sua transação é desfeita; os pedidos já confirmados permanecem gravados.

### Paginação e retentativas

Os parâmetros abaixo estão definidos em `src/index.ts`:

| Constante | Valor atual | Finalidade |
| --- | --- | --- |
| `PAGE_LIMIT` | `50` | Quantidade solicitada de pedidos por página. |
| `PARALLEL_PAGES` | `4` | Quantidade de páginas consultadas simultaneamente. |
| `MAX_REQUEST_ATTEMPTS` | `4` | Total máximo de tentativas por página, incluindo a inicial. |
| `RETRY_BASE_DELAY_MS` | `2000` | Base da espera exponencial entre tentativas. |

As retentativas abrangem erros HTTP `408`, `429` e `5xx`, quando reconhecidos na mensagem de erro, além de erros sem status reconhecido que não indiquem falha de autenticação. O intervalo cresce exponencialmente e recebe um acréscimo aleatório inferior a um segundo.

## Execução com PM2

O arquivo [ecosystem.config.cjs](ecosystem.config.cjs) define o processo `Magalu-To-DB-Orders`. Antes de utilizá-lo, ajuste os caminhos absolutos de `cwd`, `script`, `out_file` e `error_file` para o ambiente de implantação e confirme que o Bun está disponível para o PM2.

```bash
bun run build
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs Magalu-To-DB-Orders
```

A expressão cron configurada é `0 8,10,14,18 * * *`, correspondente a reinícios diários às **08h, 10h, 14h e 18h**, no fuso horário do ambiente em que o PM2 é executado. O comando `pm2 start` também inicia uma execução imediatamente.

A configuração habilita reinício automático após falhas, com espera progressiva e limite de dez reinícios. Encerramentos com código `0` não provocam reinício automático imediato. Após alterar o código, gere novamente o build antes de reiniciar o processo.

## Estrutura do projeto

```text
.
├── src/
│   ├── config/
│   │   └── config.ts             # Leitura e validação das variáveis de ambiente
│   ├── services/
│   │   └── database.service.ts   # Tokens, normalização e persistência no PostgreSQL
│   └── index.ts                  # Clientes Magalu, paginação e execução
├── build/                        # Saída do build atual
├── build_v1/                     # Build legado
├── ecosystem.config.cjs          # Configuração do PM2
├── package.json                  # Dependências e comandos
├── bun.lock                      # Lockfile das dependências
└── tsconfig.json                 # Configuração do TypeScript
```

## Diagnóstico

| Situação | O que verificar |
| --- | --- |
| Variável de ambiente não localizada | Preencha as cinco variáveis no `.env` ou no ambiente do processo. |
| Tokens não encontrados | Confira os identificadores de empresa, o filtro `provider = 'magalu'` e os registros retornados pelo `LIMIT 3`. |
| Falha de autenticação na API | Verifique a validade dos tokens e o processo externo responsável por atualizá-los. |
| Erro de conexão com PostgreSQL | Confira as URLs de conexão, o acesso de rede e as permissões do usuário. |
| Tabela, coluna ou restrição ausente | Compare a estrutura do banco com as consultas de `database.service.ts`. |
| PM2 não encontra o script ou o Bun | Gere o build, ajuste os caminhos do arquivo de configuração e confira o `PATH` do PM2. |
