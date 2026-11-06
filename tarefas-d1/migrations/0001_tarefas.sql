CREATE TABLE IF NOT EXISTS tarefas_rede (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revisao INTEGER NOT NULL DEFAULT 0,
  dados TEXT NOT NULL
);

INSERT OR IGNORE INTO tarefas_rede (id, dados)
VALUES (1, '{"departments":[],"people":[],"tasks":[],"cashRoutines":[],"cashDepartmentId":null}');

CREATE TABLE IF NOT EXISTS tarefas_acessos (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  perfil TEXT NOT NULL CHECK (perfil IN ('office', 'manager', 'employee')),
  unidade TEXT,
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  CHECK (
    (perfil = 'office' AND unidade IS NULL) OR
    (perfil <> 'office' AND unidade IS NOT NULL AND
      unidade IN ('vila-sao-pedro', 'parque-sao-bernardo', 'escritorio'))
  )
);
