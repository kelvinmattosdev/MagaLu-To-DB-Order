# Validação — 2026-11-17

Diretório: `/home/sandbox/MagaLu-To-DB-Order`. Base Git `f1233db`, mais alterações locais desta entrega e alterações preexistentes de dependências do usuário. HTTP simulado; nenhuma evidência de integração ou funcionamento operacional real.

| Critério | Método executado | Resultado real | Estado |
| --- | --- | --- | --- |
| R001 — configuração sem banco de tokens | `bun --no-env-file test`, teste de configuração em subprocesso sem DB_TOKENS; revisão da remoção do pool/query | Configuração aceita JP_API_KEY e banco de pedidos; nenhum pool de tokens no código | PASS local |
| R002 — seleção inequívoca | Mesma suíte, fixtures de provedor, ausência e duplicidade | Seleciona Magalu por empresa; falha antes de ler tokens se seleção ambígua | PASS local |
| R003 — renovação controlada | Mesma suíte: versões, renewed/already_updated/reused, 202, token antigo, 429, concorrência, erros e transporte | Esperas capturadas por função simulada, requisições contadas, um POST nos cenários concorrentes/incertos | PASS local |
| R004 — consulta/persistência | Testes do cliente verificam rota, paginação, Bearer atualizado, 403 e limite de 401; revisão do diff do banco | Rota preservada, 403 sem refresh, persistência mantida além da remoção do acesso a tokens | PASS local; banco não executado |
| R005 — testes | `/home/kelvin/.bun/bin/bun --no-env-file test` | Exit 0; 31 pass, 0 fail, 94 asserções, 3 arquivos | PASS |
| Tipos | `/home/kelvin/.bun/bin/bun --no-env-file node_modules/typescript/bin/tsc --noEmit` | Exit 0, sem diagnósticos | PASS |
| Build | `PATH=/home/kelvin/.bun/bin:$PATH bun --no-env-file run build` | Exit 0; 50 módulos, `build/index.js` 119,58 KB | PASS |
| Formatação do diff | `git diff --check` | Exit 0, sem erros | PASS |
| API real, whitelist e credenciais | Não executado | Requer configuração do ambiente e execução real pelo operador | NÃO EXECUTADO |

O build foi gerado apenas para validar e removido ao final (artefato próprio), pois a base Git registra remoção dos builds do versionamento. Para execução compilada, gerar com `bun run build`.

SHA-256 da versão anterior da migração (índice e teste de pedidos substituídos pela otimização D003 abaixo):

```text
4ce7e134a117bcd97ba659af72b5de9e569a830a0daa5361418883d48b590062  src/config/config.ts
db564770197747f4e68b1f72c0915edd6f1e41556874a942676e41d555bb6577  src/index.ts
66c07ba3d98ed89dd9aabaff95f0998a3f216cd58b27f80d6e8305bebb784a24  src/services/database.service.ts
8678ce80278284a9c3c10f95e18ae42e2c2aad93f49ee169dded35bde1e7ddd0  src/services/token-manager.service.ts
2546cfdf502b0c99882b4b0ba0f776e9f9286159d8dcb6da92318258bde33929  src/services/magalu-orders.service.ts
e1386404ee546bfc4959d1f4dae0cf18f38df738425a96fac52f7ca7f4a1b744  tests/config.test.ts
08e64a5ae27ed840917f9cb9d13a98e8199a6ad26dbbdf71bfd2521b0e81dbd1  tests/magalu-orders.test.ts
3a3d8ece5d015939d2caeb6ae22793cfe771ba5e403e1739a11716fe4ffe46e3  tests/token-manager.test.ts
```


## Otimização D003 — 2026-11-17 (estado atual)

| Critério | Método executado | Resultado real | Estado |
| --- | --- | --- | --- |
| R006 — últimos sete dias por atualização | Testes de createSyncWindow: padrão7dias, janela2dias na virada do ano, relógio preservado | Limites UTC corretos, sem filtro de compra/status | PASS local |
| R007 — configuração e full explícito | Testes de janela inválida, modo inválido e modo full | Inválidos rejeitados; full sem filtros de data | PASS local |
| R008 — parâmetros por página/retentativa | HTTP simulado com 401, recuperação e próxima página | Mesmos limites nas três chamadas; offset avança; nenhum filtro de compra/status | PASS local |
| Suíte completa | `/home/kelvin/.bun/bin/bun --no-env-file test` | Exit 0; 45 pass, 0 fail, 126 asserções, 4 arquivos | PASS |
| Tipos finais | `/home/kelvin/.bun/bin/bun --no-env-file node_modules/typescript/bin/tsc --noEmit` | Exit 0 após correção do mapeamento de ProcessEnv | PASS |
| Build final | `PATH=/home/kelvin/.bun/bin:$PATH bun --no-env-file run build` | Exit 0; 51 módulos, 120,50 KB | PASS |
| Filtragem real e ganho de desempenho | Não executado; sem conexão real nesta tarefa | Redução esperada por recorte no servidor, não medida | NÃO EXECUTADO |

Versão atual dos arquivos alterados nesta fatia (demais fontes permanecem nos hashes da migração):

```text
4f57191542d63856e0fd77c503b5cdf7b1889f8230a4e6a605540c128404f820  src/config/sync-window.ts
26032f8341548ac14c64e58484dcc680d46180ae5765593cbb18bfcd29adff1a  src/index.ts
73e729df17baa52522d4dad146b26eef24f9b410938151b0f2d233eb0f25a02d  tests/sync-window.test.ts
0b9ecc67c8321fa91812fafdb73726ef4d1eb638b0c4da26f1e298d6a9594698  tests/magalu-orders.test.ts
```
