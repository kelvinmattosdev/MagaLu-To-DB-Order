# Magalu To DB

Integração em TypeScript que consulta pedidos da API do Magalu e os sincroniza com PostgreSQL. Executada com Bun, suporta múltiplas empresas, consultas paginadas em paralelo e retentativas automáticas para falhas temporárias.

## Funcionalidades

- Consulta de pedidos por empresa, com filtro de atualização dos últimos sete dias e ordenação pela data de compra.
- Leitura e renovação dos tokens de acesso pela API de consumidores do JP Token Manager.
- Persistência de vendedores, pedidos, pagamentos, entregas, itens e devoluções, conforme os dados retornados pela API.
- Inserção e atualização de registros com `ON CONFLICT`, com transação por pedido.
- Reconciliação de pedidos com o mesmo código e identificadores diferentes.
- Armazenamento do payload original de pedidos e entregas em `raw_json`, com identificação da empresa no campo `_company`.
- Execução manual ou gerenciamento com PM2.

## Requisitos

- Bun instalado e disponível no `PATH`.
- Acesso à API do Magalu e tokens válidos para as empresas configuradas.
- PostgreSQL para gravação dos pedidos e acesso à API do JP Token Manager a partir de um IP autorizado.
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

Copie `.env.example` para `.env` e preencha os valores reais:

```dotenv
JP_BASE_URL=https://jp-token-manager-api.jaupesca.com.br
JP_API_KEY=SUA_CHAVE_DE_AUTENTICACAO

DB_MAGALU_URL=postgresql://user:password@localhost:5432/magalu_db
DB_MAGALU_SCHEMA=magazine_luiza

SYNC_MODE=recent
SYNC_LOOKBACK_DAYS=7
```

| Variável | Finalidade |
| --- | --- |
| `JP_BASE_URL` | Origem HTTPS do gerenciador; o endereço acima é usado quando omitida. Não aceita caminhos, parâmetros ou credenciais na URL. |
| `JP_API_KEY` | Chave de consumidor emitida pelo administrador, enviada em `Authorization: Bearer`. Obrigatória. |
| `DB_MAGALU_URL` | Conexão com o banco de destino dos pedidos. Obrigatória. |
| `DB_MAGALU_SCHEMA` | Schema das tabelas de destino. Obrigatória. |
| `SYNC_MODE` | `recent` (padrão) filtra atualizações; `full` consulta todo o histórico. |
| `SYNC_LOOKBACK_DAYS` | Quantidade inteira positiva de dias de atualização, padrão `7`. Usada em `recent`. |

`DB_TOKENS_URL`, `DB_TOKENS_SCHEMA` e `DB_TOKENS_TABLE` não são mais utilizadas e podem ser removidas do ambiente. O banco de pedidos continua necessário.

O `.env` existente não é alterado automaticamente. Mantenha credenciais fora do versionamento e dos logs. Configure o schema apenas a partir de valores confiáveis, pois é interpolado nas consultas SQL.

### Empresas, permissões e tokens

As empresas exigidas continuam definidas em `REQUIRED_COMPANIES`, em [src/index.ts](src/index.ts): `jaupesca`, `ltsports` e `jaufishing`.

No gerenciador, o administrador deve autorizar o IP de saída do servidor e emitir uma chave com `integrations:read`, `tokens:read` e `tokens:refresh`, permitindo exatamente uma integração de provedor `magalu` por empresa exigida. A aplicação lista as integrações permitidas e usa seus IDs reais, com correspondência exata de empresa. Integração ausente ou duplicada interrompe a execução antes de ler tokens; revise a seleção da chave, inclusive se houver múltiplos ambientes. Integrações de outros provedores são ignoradas.

A validade da chave do gerenciador é independente da validade dos tokens Magalu. Ao expirar ou revogar a chave do gerenciador, emita outra no painel e substitua `JP_API_KEY` no ambiente da próxima execução. A documentação fornecida não especifica endpoint de rotação dessa chave, portanto o programa não a renova automaticamente.

O fluxo de autenticação é:

1. `GET /api/v1/integrations` resolve as empresas e as versões.
2. `GET /api/v1/integrations/{id}/access-token` obtém a credencial atual.
3. Se a leitura retornar `409 token_refresh_required`, ou se o Magalu retornar `401`, solicita `POST /api/v1/integrations/{id}/refresh` com `expected_version` recebida.
4. Após `200 renewed`, `already_updated` ou `reused`, lê novamente o token. Após `202 in_progress`, aguarda `Retry-After` e consulta o token até cinco vezes, sem repetir o POST.

Um `403` do Magalu encerra a chamada sem refresh. Falhas de chave, permissão, integração indisponível ou nova autorização necessária também encerram a execução; consulte o painel. Falhas de transporte ou `5xx` em refresh não repetem o POST automaticamente, pois seu resultado pode ser incerto.

As chamadas ao gerenciador têm timeout de 15s, fila compartilhada por execução (intervalo mínimo de 510ms entre chamadas e 6,1s entre solicitações de refresh), até três tentativas em `429` e espera de `Retry-After`. Esperas indicadas acima de 120s encerram a execução para uma tentativa posterior. Refresh simultâneo da mesma empresa compartilha uma única operação local. Outros processos que usem a mesma chave também consomem seus limites; evite sobrepor execuções.

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

O usuário do banco de destino precisa de permissões de leitura, inserção, atualização e exclusão nas tabelas utilizadas.

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
| `bun test` | Executa testes locais com HTTP simulado, sem sincronização real. |
| `bunx tsc --noEmit` | Verifica os tipos sem executar a sincronização. |

Os comandos `dev` e `start` consultam a API e gravam no banco configurado. Ao concluir, o processo fecha as conexões e encerra com código `0`; em caso de erro, encerra com código `1`.

## Como funciona a sincronização

1. Lista as integrações permitidas no gerenciador e obtém os tokens de todas as empresas exigidas.
2. Cria um cliente da API do Magalu para cada empresa.
3. Processa uma empresa por vez, filtrando por `updated_at` e ordenando por `purchased_at` crescente.
4. Busca até quatro páginas simultaneamente, com até 50 pedidos por página.
5. Ordena as páginas pelo offset e persiste os pedidos em transações individuais.
6. Após persistir as páginas não vazias do lote, encerra a consulta da empresa se alguma página estiver vazia.
7. Avança para a próxima empresa e encerra o processo ao concluir todas.

Cada execução começa no offset `0` **do conjunto filtrado**. Por padrão, a API recebe `updated_at__gte` (início da execução menos 7 × 24 horas) e `updated_at__lte` (início da execução). O mesmo intervalo é usado para todas as empresas, páginas e retentativas. O log mostra os limites em UTC. Não depende da virada de dia do servidor.

Uma compra antiga atualizada nesse intervalo também é sincronizada. Todos os status são incluídos, para refletir cancelamentos, expedições e finalizações. Filtrar apenas por compra recente poderia perder essas alterações. O filtro é enviado à API; não é aplicado depois de baixar o histórico.

Para mudar a janela ou recuperar o histórico:

```bash
# Últimos 7 dias de atualizações (padrão; basta bun run dev).
SYNC_MODE=recent SYNC_LOOKBACK_DAYS=7 bun run dev

# Últimas 24 horas de atualizações (não significa desde meia-noite).
SYNC_MODE=recent SYNC_LOOKBACK_DAYS=1 bun run dev

# Busca completa, inclusive pedidos antigos sem atualização recente.
SYNC_MODE=full bun run dev
```

Não há checkpoint persistido. Se a rotina ficar mais tempo parada do que a janela configurada, amplie a janela ou execute o modo `full` para recuperar o intervalo. A primeira carga histórica também precisa de `full`. Pedidos antigos que continuam pendentes sem nenhuma atualização recente não são incluídos pelo modo `recent`.

A sobreposição da janela permite reprocessar alterações entre execuções, mas a API não fornece aqui um snapshot transacional: dados podem mudar enquanto as páginas são consultadas. Alterações posteriores ao limite superior ficam para a próxima execução, desde que estejam dentro da próxima janela.

`status=approved` no contrato do SDK também inclui pedidos com entregas expedidas ou entregues, portanto não foi usado como sinônimo de “não despachado”. Uma fila exclusivamente de expedição exigiria tratar o status das entregas e acompanhar os pedidos que saem dessa fila. A escolha aprovada para esta rotina é sincronizar atualizações recentes de qualquer status.

Durante a persistência, vendedores, pedidos, entregas e itens são inseridos ou atualizados. Os pagamentos de cada pedido e as devoluções de cada entrega são substituídos pelos dados recebidos. Se um pedido falhar, sua transação é desfeita; os pedidos já confirmados permanecem gravados.

### Paginação e retentativas

Os parâmetros abaixo estão definidos em `src/index.ts`:

| Constante | Valor atual | Finalidade |
| --- | --- | --- |
| `PAGE_LIMIT` | `50` | Quantidade solicitada de pedidos por página. |
| `PARALLEL_PAGES` | `4` | Quantidade de páginas consultadas simultaneamente. |
| `MAX_REQUEST_ATTEMPTS` | `4` | Total máximo de tentativas por página, incluindo a inicial. |
| `RETRY_BASE_DELAY_MS` | `2000` | Base da espera exponencial entre tentativas. |

As retentativas de páginas abrangem erros HTTP `408`, `429` e `5xx`, quando reconhecidos na mensagem de erro, além de falhas de transporte. Erros do Token Manager e falhas de autenticação não são repetidos por esse loop. Cada consulta Magalu tem timeout de 30s e permite uma recuperação de token por `401`. O intervalo cresce exponencialmente e recebe um acréscimo aleatório inferior a um segundo.

## Execução com PM2

Para iniciar pelo terminal com execução imediata e agenda a cada duas horas:

```bash
cd /home/sandbox/MagaLu-To-DB-Order
bun run build
pm2 start build/index.js --interpreter /home/kelvin/.bun/bin/bun --name Magalu-To-DB-Orders --cwd /home/sandbox/MagaLu-To-DB-Order --no-autorestart --cron-restart "0 */2 * * *" --time
pm2 logs Magalu-To-DB-Orders
```

O caminho do Bun acima foi localizado neste ambiente; adapte em outro servidor. `0 */2 * * *` representa 00h, 02h, 04h, …, 22h, no fuso do agendador PM2. Há também uma execução imediata ao iniciar. `--no-autorestart` evita reexecução contínua ao terminar, inclusive em caso de erro; a próxima tentativa fica para a agenda ou reinício manual. O cron é de reinício: pode interromper uma execução que ainda esteja ativa no próximo horário.

Para salvar a lista de processos, use `pm2 save`. A recuperação após reboot depende de o startup do PM2 já estar configurado. A aplicação continua lendo o `.env` da raiz e usando, por padrão, os últimos sete dias de atualizações.

Referência: [estratégias de reinício do PM2](https://pm2.keymetrics.io/docs/usage/restart-strategies/). Estes comandos foram documentados; não foram executados pelo agente.

### Alternativa com o arquivo ecosystem existente


O arquivo [ecosystem.config.cjs](ecosystem.config.cjs) está configurado para `/home/sandbox/MagaLu-To-DB-Order`, processo `Magalu-To-DB-Orders`, com Bun em `/home/kelvin/.bun/bin/bun`. Os logs usam os caminhos padrão do PM2 do usuário que iniciar o processo. O exemplo de outro servidor com `/home/desenvolvedor` e ID `11` não se aplica a esta instalação.

```bash
bun run build
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs Magalu-To-DB-Orders
```

A expressão cron configurada é `0 */2 * * *`, correspondente a reinícios a cada duas horas, às **00h, 02h, 04h, …, 22h**, no fuso horário do ambiente em que o PM2 é executado. O comando `pm2 start` também inicia uma execução imediatamente.

Para reaplicar o arquivo a um processo desse mesmo nome já existente no servidor correto:

```bash
pm2 restart ecosystem.config.cjs --only Magalu-To-DB-Orders
pm2 save
pm2 show Magalu-To-DB-Orders
```

Para a primeira execução, use `pm2 start ecosystem.config.cjs`, como acima, e `pm2 save` para persistir a lista. Start/restart executam o script imediatamente, além da agenda. Não use o ID `11` do exemplo do outro servidor. Mudanças apenas no ecosystem não exigem rebuild; alterações do código exigem `bun run build`.

A configuração habilita reinício automático após falhas, com espera progressiva e limite de dez reinícios. Encerramentos com código `0` não provocam reinício automático imediato. Após alterar o código, gere novamente o build antes de reiniciar o processo.

## Estrutura do projeto

```text
.
├── src/
│   ├── config/
│   │   └── config.ts             # Leitura e validação das variáveis de ambiente
│   ├── services/
│   │   ├── database.service.ts   # Normalização e persistência dos pedidos no PostgreSQL
│   │   ├── token-manager.service.ts # Integrações, leitura e refresh dos tokens
│   │   └── magalu-orders.service.ts # Consulta de pedidos e recuperação limitada de 401
│   └── index.ts                  # Clientes Magalu, paginação e execução
├── build/                        # Saída do build atual
├── ecosystem.config.cjs          # Configuração do PM2
├── package.json                  # Dependências e comandos
├── bun.lock                      # Lockfile das dependências
└── tsconfig.json                 # Configuração do TypeScript
```

## Diagnóstico

| Situação | O que verificar |
| --- | --- |
| Variável de ambiente não localizada | Preencha `JP_API_KEY`, `DB_MAGALU_URL` e `DB_MAGALU_SCHEMA` no `.env` ou no ambiente do processo. |
| Tokens não encontrados | Confira empresas, provedor `magalu`, integrações permitidas pela chave e ausência de duplicatas. |
| Falha de autenticação na API | Confira whitelist, validade e permissões de `JP_API_KEY` e o estado da integração no gerenciador. |
| Erro de conexão com PostgreSQL | Confira as URLs de conexão, o acesso de rede e as permissões do usuário. |
| Tabela, coluna ou restrição ausente | Compare a estrutura do banco com as consultas de `database.service.ts`. |
| PM2 não encontra o script ou o Bun | Gere o build, ajuste os caminhos do arquivo de configuração e confira o `PATH` do PM2. |

## Contexto para continuidade

Decisões, motivos e evidências desta migração estão em [docs/anotations/README.md](docs/anotations/README.md).
