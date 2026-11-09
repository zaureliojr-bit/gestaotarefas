CREATE TABLE tarefas_acessos_v3 (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  perfil TEXT NOT NULL CHECK (perfil IN ('office', 'network_manager', 'manager', 'employee')),
  unidade TEXT,
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  CHECK (
    (perfil IN ('office', 'network_manager') AND unidade IS NULL) OR
    (perfil IN ('manager', 'employee') AND unidade IS NOT NULL AND length(trim(unidade)) > 0)
  )
);

INSERT INTO tarefas_acessos_v3 (email, perfil, unidade, ativo)
SELECT email, perfil, unidade, ativo FROM tarefas_acessos;

DROP TABLE tarefas_acessos;
ALTER TABLE tarefas_acessos_v3 RENAME TO tarefas_acessos;
