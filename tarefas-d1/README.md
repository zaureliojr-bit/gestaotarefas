# Drogalink Tarefas

Módulo online de tarefas da Drogaria Mais Barato. O navegador consulta o Worker,
que usa um binding D1 e verifica a sessão do Cloudflare Access a cada chamada de
API. A senha compartilhada do painel de pedidos segue no fluxo de pedidos.

| Perfil | Acesso no módulo |
|---|---|
| `office` | Cadastra unidades, funcionários e departamentos, administra tarefas, rotinas e backup da rede |
| `network_manager` | Acompanha e atualiza o status e os checklists de todas as unidades. A gestão de acessos é reservada ao Escritório. |
| `manager` | Acompanha e atualiza o status e os checklists da unidade autorizada |
| `employee` | Atualiza o status e os checklists das tarefas atribuídas a si na unidade autorizada |

O cadastro de funcionário liga a tarefa ao e-mail do login. O perfil no cadastro
descreve o funcionário. Para gerenciar a autorização do aplicativo, entre como
Escritório e abra **Usuários e acessos**. Use **Novo acesso** para cadastrar
o e-mail e selecione perfil, unidade e situação. Em **Editar**, é possível
alterar essas opções ou desativar o acesso sem excluir o cadastro. A própria
conta fica protegida contra alterações nessa tela.

O novo usuário também precisa estar na política do Cloudflare Access com o
mesmo e-mail. Use contas individuais e revogue as duas concessões quando
alguém deixar a equipe. O primeiro acesso de Escritório ainda é criado no D1.

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

## Instalar o aplicativo

Abra o endereço publicado em um navegador comum e entre com sua conta.
No Chrome ou Edge compatível, use **Instalar aplicativo** no menu do Drogalink
ou a opção de instalação do navegador. No iPhone ou iPad, use o Safari e
toque em **Compartilhar → Adicionar à Tela de Início**.

O aplicativo precisa de internet para entrar e trabalhar com as tarefas.
Depois de uma visita online, se o dispositivo estiver sem conexão, o ícone
abre uma tela com **Tentar novamente**. O service worker guarda somente
essa tela no cache. A API, as tarefas e os dados de login seguem online.

## Migrar para login interno

1. Em homologação, use um D1 separado com contas de teste e valide a ativação,
   o login e a atualização de tarefas. Confirme que a derivação de senha
   funciona dentro do limite de CPU do plano do Worker.
2. Em produção, aplique as migrações pendentes a partir de `tarefas-d1` com
   `npx wrangler d1 migrations apply DB --remote` antes do deploy. Publique
   inicialmente com a política do Cloudflare Access ativa e sem `AUTH_MODE`.
3. Em **Usuários e acessos**, use **Gerar link de senha** para uma conta
   ativa de Escritório e outra de Gestor de rede. Entregue os links
   individualmente. Cada link expira em uma hora e é de uso único.
   Ao definir a senha pelo link, o usuário já pode testá-la pelo formulário
   de login. A redefinição invalida as sessões anteriores.
4. Depois de validar as duas contas, configure `AUTH_MODE=internal` no Worker
   e publique. Esse modo exige sessão do Drogalink para todas as rotas
   protegidas. Retire a proteção do Cloudflare Access para o hostname de
   tarefas depois de confirmar que o modo interno está ativo. Mantenha a
   política anterior disponível para recuperação.
5. Teste em janela anônima. Confirme que uma conta sem sessão não acessa a
   API, que Escritório gerencia usuários e que Gestor de rede enxerga todas
   as unidades com a gestão de usuários bloqueada.

Quando alguém esquecer a senha, confirme sua identidade e gere um novo link
em **Usuários e acessos**. O painel exibe o link para entrega individual.
Desativar um acesso invalida a sessão e qualquer link pendente.

Para reverter, reative a proteção do Cloudflare Access antes de retirar
`AUTH_MODE=internal`. Os perfis continuam na mesma tabela do D1.
