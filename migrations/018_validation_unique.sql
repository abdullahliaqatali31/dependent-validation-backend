-- Remove duplicate validation_results rows, keeping the lowest id per master_id
DELETE FROM validation_results a USING validation_results b
WHERE a.master_id = b.master_id AND a.id > b.id;

-- Enforce uniqueness on master_id to prevent double inserts
CREATE UNIQUE INDEX IF NOT EXISTS ux_validation_master ON validation_results(master_id);
