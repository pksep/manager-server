-- Выполняет администратор в базе manager. Роли логина и их секреты создаются отдельно.
-- psql -v runtime_role=manager_runtime -v migration_role=manager_migrator -f config/database-permissions.sql
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"runtime_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role";
REVOKE INSERT, UPDATE, DELETE ON manager_schema_migrations FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"runtime_role";
COMMIT;
