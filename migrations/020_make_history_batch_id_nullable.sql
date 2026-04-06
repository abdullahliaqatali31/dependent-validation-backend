-- Make batch_id nullable in download_history for global/cross-batch exports
ALTER TABLE download_history 
ALTER COLUMN batch_id DROP NOT NULL;
