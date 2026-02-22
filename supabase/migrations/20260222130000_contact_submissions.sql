CREATE TABLE IF NOT EXISTS contact_submissions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    subject    TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE contact_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON contact_submissions;
CREATE POLICY "service_role_all" ON contact_submissions FOR ALL USING (true) WITH CHECK (true);
