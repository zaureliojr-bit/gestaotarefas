ALTER TABLE tarefas_acessos ADD COLUMN senha_hash TEXT;
ALTER TABLE tarefas_acessos ADD COLUMN senha_salt TEXT;
ALTER TABLE tarefas_acessos ADD COLUMN sessao_versao INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tarefas_acessos ADD COLUMN senha_token TEXT;
ALTER TABLE tarefas_acessos ADD COLUMN senha_token_expira INTEGER;

CREATE TABLE tarefas_sessoes (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  versao INTEGER NOT NULL,
  expira INTEGER NOT NULL
);
CREATE INDEX tarefas_sessoes_expira ON tarefas_sessoes (expira);

CREATE TABLE tarefas_login_limites (
  chave TEXT PRIMARY KEY,
  expira INTEGER NOT NULL,
  tentativas INTEGER NOT NULL
);
CREATE INDEX tarefas_login_limites_expira ON tarefas_login_limites (expira);
