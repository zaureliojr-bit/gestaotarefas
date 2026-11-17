CREATE TABLE IF NOT EXISTS tarefas_chat (
  id INTEGER PRIMARY KEY,
  autor TEXT NOT NULL,
  envio TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  arquivo_nome TEXT,
  arquivo_base64 TEXT,
  criada_em INTEGER NOT NULL,
  UNIQUE (autor, envio)
);
