# Drogalink Tarefas

Módulo online de tarefas da Drogaria Mais Barato. O navegador consulta o Worker,
que usa um binding D1 e verifica a sessão do Cloudflare Access a cada chamada de
API. A senha compartilhada do painel de pedidos segue no fluxo de pedidos.

| Perfil | Acesso no módulo |
|---|---|
| `office` | Cadastra unidades, funcionários e departamentos, administra tarefas, rotinas e backup da rede |
| `manager` | Acompanha e atualiza o status e os checklists da unidade autorizada |
| `employee` | Atualiza o status e os checklists das tarefas atribuídas a si na unidade autorizada |

O cadastro de funcionário liga a tarefa ao e-mail do login. O perfil no cadastro
descreve o funcionário. A autorização é concedida separadamente em
`tarefas_acessos` e na política do Access. Use contas de e-mail individuais e
revogue as duas concessões quando alguém deixar a equipe.

## Validação local

Use Node.js 24 e execute `node teste.mjs` nesta pasta. O teste usa SQLite em
memória, chaves de teste e requisições HTTP ao Worker. Nenhum dado real é usado.

## Publicar para o piloto

1. No Zero Trust, configure uma aplicação Access do tipo **Self-hosted** para o
   hostname exclusivo do módulo, por exemplo `tarefas.drogalink.com.br`. Inclua
   apenas os e-mails autorizados na política Allow e configure o login por
   código enviado ao e-mail. Copie o domínio da equipe Access e o AUD da
   aplicação. [Configurar a aplicação Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
2. Preencha `ACCESS_TEAM_URL` e `ACCESS_AUD` no Wrangler. Use o URL
   `https://<equipe>.cloudflareaccess.com` sem barra final. Configure
   `database_name` e `database_id` para o D1 escolhido no painel. A migração
   cria apenas tabelas prefixadas com `tarefas_` e tem uma tabela de controle
   separada. Use um D1 de teste para a primeira validação com contas reais.
3. Com a CLI autenticada na conta Cloudflare, execute nesta pasta
   `npx wrangler d1 migrations apply DB --remote`. No D1, conceda acesso
   ao e-mail inicial do escritório com a instrução abaixo, substituindo o
   exemplo. Para cada gestor ou colaborador, use `manager` ou `employee` e
   o código exibido na tela **Unidades** em vez de `NULL`. As unidades
   iniciais preservam os códigos do painel local para a migração do backup.

   ```sql
   INSERT INTO tarefas_acessos (email, perfil, unidade)
   VALUES ('administrador@example.com', 'office', NULL);
   ```

4. Adicione `"routes": [{ "pattern": "<hostname>", "custom_domain": true }]`
   ao Wrangler e publique com `npx wrangler deploy`. Use o mesmo hostname da
   aplicação Access. O módulo tem endereço próprio. O menu do painel de pedidos
   pode receber o link depois da validação em ambiente publicado.
5. Entre em três sessões, uma por perfil. Verifique que a loja recebe a tarefa
   criada pelo escritório, que o escritório vê a conclusão e que a conta de
   outra unidade não tem acesso à tarefa. Use o botão **Sincronizar** para
   atualizar imediatamente. Em uma aba visível, a consulta automática ocorre
   a cada 15 segundos, exceto durante uma edição.

## Cadastrar unidades

Entre como escritório e abra **Unidades → Nova unidade**. Escolha **Loja**
para habilitar a rotina de fechamento diário ou **Administrativa** para
setores como o escritório. A unidade aparece nos filtros e no formulário
de tarefa após salvar. É possível editar o nome mantendo o código e os
vínculos existentes. A concessão de acesso por e-mail continua no D1 e no
Cloudflare Access.

Se a migração inicial já foi aplicada, execute novamente
`npx wrangler d1 migrations apply DB --remote` antes de publicar esta versão.
A migração de unidades mantém as permissões já cadastradas.

## Migrar os dados locais

No painel antigo, exporte o JSON. No novo, abra **Importar backup** com uma conta
do escritório. A importação está disponível enquanto os cadastros e tarefas
estiverem vazios. Confira os e-mails e atribua unidade às tarefas antigas que
ainda estão em **Sem unidade**. O arquivo exportado pode conter registros de
exemplo se vier de uma instalação que ainda não foi configurada.

## Escopo do piloto

Os dados da rede são gravados juntos em um registro D1 limitado a 512 KiB.
Cada gravação compara a revisão para evitar sobrescrever outra edição. Em caso
de conflito, feche o formulário, sincronize, confira a alteração e repita.
A geração do fechamento diário ocorre na primeira consulta ou gravação que
processar o dia, usando o fuso de São Paulo. O módulo precisa de conexão para
operar e não mantém dados da equipe no armazenamento local do navegador.
