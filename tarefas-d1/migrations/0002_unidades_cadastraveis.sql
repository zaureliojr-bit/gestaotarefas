CREATE TABLE tarefas_acessos_v2 (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  perfil TEXT NOT NULL CHECK (perfil IN ('office', 'manager', 'employee')),
  unidade TEXT,
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  CHECK (
    (perfil = 'office' AND unidade IS NULL) OR
    (perfil <> 'office' AND unidade IS NOT NULL AND length(trim(unidade)) > 0)
  )
);

INSERT INTO tarefas_acessos_v2 (email, perfil, unidade, ativo)
SELECT email, perfil, unidade, ativo FROM tarefas_acessos;

DROP TABLE tarefas_acessos;
ALTER TABLE tarefas_acessos_v2 RENAME TO tarefas_acessos;
