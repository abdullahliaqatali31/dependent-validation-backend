CREATE TABLE IF NOT EXISTS free_pool_assignments (
  id BIGSERIAL PRIMARY KEY,
  employee_uuid UUID NOT NULL,
  business_accepted INT DEFAULT 0,
  business_catch_all INT DEFAULT 0,
  personal_accepted INT DEFAULT 0,
  personal_catch_all INT DEFAULT 0,
  total INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_free_pool_assignments_employee ON free_pool_assignments(employee_uuid);

