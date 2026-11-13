CREATE TABLE IF NOT EXISTS tarefas_preferencias (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  tema TEXT NOT NULL CHECK (tema IN ('light', 'dark'))
);

CREATE TABLE IF NOT EXISTS tarefas_notas (
  id INTEGER PRIMARY KEY,
  autor TEXT NOT NULL,
  titulo TEXT NOT NULL,
  conteudo TEXT NOT NULL,
  criada_em INTEGER NOT NULL
);
