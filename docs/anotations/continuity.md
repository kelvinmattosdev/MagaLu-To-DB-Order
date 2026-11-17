# Continuidade — 2026-11-17

Estado atual: migração de tokens para JP Token Manager e otimização por atualização concluídas localmente. Usuário relatou que a migração funciona e enviou log com pedidos persistidos; não houve execução real pelo agente. Última escolha explícita do usuário: pedidos atualizados nos últimos sete dias (D003 em decisions.md).

Leia README, decisions.md e validation.md. A execução agora usa por padrão `SYNC_MODE=recent`, `SYNC_LOOKBACK_DAYS=7`, mesmo sem essas variáveis no ambiente. Janela móvel de 7 × 24h por updated_at, com limite superior capturado no início, compartilhada entre empresas, páginas e retentativas. Inclui todos os status. `SYNC_MODE=full bun run dev` restaura a consulta histórica. Não é uma fila exclusivamente de não despachados.

Próxima ação: operador executar `bun run dev`, verificar intervalo UTC no primeiro log e comparar volume/tempo real. Se a primeira carga histórica não terminou ou o processo ficou parado mais do que a janela, usar full ou ampliar SYNC_LOOKBACK_DAYS. Sem checkpoint persistido ou snapshot isolado da API. Não afirmar que pedidos pendentes sem alteração recente serão capturados.

Autenticação: JP_API_KEY obrigatória; JP_BASE_URL opcional com padrão público do gerenciador. Mantidos DB_MAGALU_URL/SCHEMA e as três empresas jaupesca, ltsports, jaufishing. DB_TOKENS_* não utilizados. .env real preservado, sem leitura de segredos. package.json e bun.lock têm alterações preexistentes do usuário, preservadas.

Validação atual: 45 testes HTTP simulados passaram, checagem de tipos e build final passaram; hashes em validation.md. Build de validação removido; gerar de novo para executar start/PM2. Sem medição de ganho ou validação do filtro contra API real nesta tarefa. Revisor separado avaliou apenas código/integração enviados por mensagem, sem ferramentas para leitura do diff; arquivos e evidências autoavaliados pelo agente principal.

Não há serviços/jobs próprios ativos, nem commit, push, deploy ou reinício. Não repetir POST refresh incerto para recuperar contexto; conferir primeiro o estado no gerenciador.


Última correção operacional (D005, prevalece sobre D004): usuário confirmou KVM8, /home/sandbox/MagaLu-To-DB-Order. O exemplo ID11 e /home/desenvolvedor era de outro servidor. Ecosystem local corrigido para cwd/script desta raiz, Bun /home/kelvin/.bun/bin/bun, logs padrão do usuário e cron 0 */2 * * *. Nome Magalu-To-DB-Orders. Próxima ação do operador: bun run build, pm2 start ecosystem.config.cjs, pm2 save; se já existe com esse nome no alvo, reaplicar via pm2 restart ecosystem.config.cjs --only Magalu-To-DB-Orders. Nenhum PM2 iniciado pelo agente. Não reutilizar ID11 do exemplo.
