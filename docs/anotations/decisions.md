# Decisões

## D001 — 2026-11-17 — APROVADA: tokens via API

Origem: pedido do usuário e documentação anexada nesta sessão (API de consumidores do JP Token Manager). Substituir apenas a leitura de credenciais do PostgreSQL; preservar a persistência dos pedidos e as três empresas atuais. O serviço exige IP autorizado e Bearer de consumidor com `integrations:read`, `tokens:read` e `tokens:refresh`.

Usar IDs da listagem, provedor `magalu` e correspondência exata de empresa. Ausência ou duplicidade deve impedir a execução para evitar usar a conta errada. Não selecionar silenciosamente ambiente ou integração entre duplicatas.

Refresh envia a versão recebida; respostas 200 exigem nova leitura, 202 exige espera de Retry-After e consulta, 429 exige espera compartilhada. Falhas incertas de escrita não autorizam repetir POST automaticamente. Tokens e chave do gerenciador não devem aparecer nos logs.

## D002 — 2026-11-17 — decisão técnica no escopo autorizado

A versão instalada de `@refigure/magalu-api` renova em 401 e 403 e foi configurada com até 500 falhas. A listagem de pedidos será feita por um cliente local pequeno, preservando rota, parâmetros e tipos da dependência, com no máximo uma recuperação por 401. Um 403 encerra a chamada sem refresh. Motivo: respeitar o contrato fornecido e evitar tempestade de renovações. Não alterar a dependência nem suas instalações locais.

## Escopo e critérios

- R001: não exigir `DB_TOKENS_*` nem abrir conexão com banco de tokens.
- R002: resolver todas as empresas exigidas sem ambiguidades antes de ler os tokens.
- R003: renovar por versão, reler tokens, compartilhar refresh local, respeitar Retry-After e limitar esperas/tentativas.
- R004: preservar consulta e persistência dos pedidos; não renovar automaticamente em 403.
- R005: documentar configuração e validar com HTTP simulado, tipos e build, sem executar a sincronização real.

Mudanças preexistentes em `package.json` e `bun.lock` são do usuário (`bun add .`) e serão preservadas. Não há autorização para deploy, reinício, acesso a banco real ou uso de credenciais reais em testes.

## D003 — 2026-11-17 — APROVADA: pedidos atualizados nos últimos sete dias

Origem: usuário relatou alto volume de requisições e anexou execução com JAUPESCA chegando ao offset 8050, com 48 itens nessa página. Isso confirma execução relatada pelo usuário, não teste real do agente. Após comparar hoje, sete dias e não despachados, o usuário selecionou explicitamente: “Atualizados nos últimos 7 dias (recomendado)”.

Decisão: filtrar no servidor por `updated_at__gte` e `updated_at__lte`; janela móvel de 7 × 24h, final capturado uma vez no início da execução e compartilhado entre empresas, páginas e retentativas. Incluir qualquer status: compra antiga com atualização recente também precisa sincronizar cancelamentos, expedições e finalizações. Não substituir por filtro de data de compra ou por `status=approved`, que não significa exclusivamente não despachado (tipos locais incluem shipped/delivered nesse grupo).

Configuração: `SYNC_MODE=recent` (padrão), `SYNC_LOOKBACK_DAYS=7` (inteiro positivo configurável). `SYNC_MODE=full` recupera a busca histórica, explicitamente selecionada. Configuração inválida deve interromper antes das chamadas externas. Não adicionar checkpoint, migrations, webhook ou busca por status nesta fatia.

Fontes verificadas: tipos locais de `@refigure/magalu-api@1.2.0`, `GetListPedidosQueryParameters` (updated_at__gte/lte); README do autor https://github.com/kelvinmattosdev/MagaLu-API confirma filtros. Portal oficial https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-get-order-list/index.html confirma a rota, mas a extração consultada não expôs o schema dos parâmetros; não atribuir a ela validação runtime dos filtros.

Critérios: R006 — padrão últimos7 dias por atualização, mesmo intervalo por execução/página; R007 — configuração inválida sem fallback para busca completa e modo full explícito; R008 — preservar autenticação, paginação e persistência; verificar query serializada em HTTP simulado.

Limitação: janela móvel não garante recuperação se a rotina ficar mais dias sem executar do que a janela configurada. Ampliar janela ou executar full nesses casos. Atualizações enquanto a paginação ocorre não formam snapshot isolado da API; sobreposição nas próximas execuções reduz lacunas, sem promessa de consistência transacional externa.


## D004 — 2026-11-17 — SUBSTITUÍDA por D005: interpretação incorreta do exemplo PM2

O agente interpretou incorretamente o `pm2 show 11` de exemplo como sendo do servidor alvo e tratou como autorização para preservar os caminhos. O usuário corrigiu essa interpretação em D005. Registro histórico da interpretação anterior: solicitou trocar a agenda `0 8,10,14,18 * * *` por cada duas horas. Preservados nome Magalu-To-DB-Orders, caminhos /home/desenvolvedor, interpreter bun e política de falhas. Alterado apenas cron_restart para `0 */2 * * *` no ecosystem local; README documenta aplicação em processo existente via `pm2 restart 11 --cron-restart "0 */2 * * *"`, persistência com pm2 save e verificação com pm2 show 11. Cron corresponde às horas pares no minuto zero; não é contagem de duas horas desde a última execução. Comando de restart inicia execução imediata. Nenhuma ação no servidor foi executada pelo agente.


## D005 — 2026-11-17 — APROVADA: servidor KVM8 e caminhos reais

Correção explícita do usuário: o pm2 show 11 era apenas exemplo de outro servidor; o alvo é kelvin@KVM8, raiz /home/sandbox/MagaLu-To-DB-Order. Esta decisão substitui D004 quanto ao alvo e ao uso do ID11. Mantida agenda a cada duas horas (0 */2 * * *).

Ecosystem corrigido: cwd da raiz real, script build/index.js dessa raiz, interpreter absoluto /home/kelvin/.bun/bin/bun (arquivo conferido localmente). Removidos caminhos de logs /home/desenvolvedor; PM2 usará os padrões do usuário que iniciar o processo. Nome Magalu-To-DB-Orders e política de falhas preservados. Orientação para primeira execução: bun run build, pm2 start ecosystem.config.cjs, pm2 save. Não usar ID de outro servidor. Nenhum processo PM2 iniciado ou reiniciado pelo agente.
