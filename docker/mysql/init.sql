-- =============================================================================
-- docker/mysql/init.sql
-- Executed ONCE when the MariaDB container first starts (empty volume).
-- The database + user are already created by docker-compose environment vars;
-- this file sets character set defaults and grants fine-grained privileges.
-- =============================================================================

-- Ensure database uses utf8mb4 (already created by MARIADB_DATABASE env var)
ALTER DATABASE ocrdatabasedb
    CHARACTER SET  = utf8mb4
    COLLATE        = utf8mb4_unicode_ci;

-- Grant full access to the app user on the OCR database only
GRANT ALL PRIVILEGES ON ocrdatabasedb.* TO 'ocruser'@'%';
FLUSH PRIVILEGES;

