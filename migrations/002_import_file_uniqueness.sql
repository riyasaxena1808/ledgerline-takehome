CREATE UNIQUE INDEX imports_file_sha256_unique
    ON imports (file_sha256)
    WHERE file_sha256 IS NOT NULL;
