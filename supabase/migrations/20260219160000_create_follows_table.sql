-- Social follows table: who follows whom
CREATE TABLE IF NOT EXISTS follows (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    follower_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    following_id  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (follower_id, following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

ALTER TABLE follows ENABLE ROW LEVEL SECURITY;

-- Users can read all follow relationships (needed for follower counts)
DROP POLICY IF EXISTS "follows_select" ON follows;
CREATE POLICY "follows_select" ON follows FOR SELECT TO authenticated USING (true);

-- Users can only insert/delete their own follows
DROP POLICY IF EXISTS "follows_insert" ON follows;
CREATE POLICY "follows_insert" ON follows FOR INSERT TO authenticated
    WITH CHECK (follower_id = auth.uid());

DROP POLICY IF EXISTS "follows_delete" ON follows;
CREATE POLICY "follows_delete" ON follows FOR DELETE TO authenticated
    USING (follower_id = auth.uid());

-- Materialised follower/following counts on profiles for fast reads
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS follower_count  INT NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS following_count INT NOT NULL DEFAULT 0;

-- Trigger to keep counts in sync
CREATE OR REPLACE FUNCTION update_follow_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE profiles SET follower_count  = follower_count  + 1 WHERE id = NEW.following_id;
        UPDATE profiles SET following_count = following_count + 1 WHERE id = NEW.follower_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE profiles SET follower_count  = GREATEST(0, follower_count  - 1) WHERE id = OLD.following_id;
        UPDATE profiles SET following_count = GREATEST(0, following_count - 1) WHERE id = OLD.follower_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_follow_counts ON follows;
CREATE TRIGGER trg_follow_counts
    AFTER INSERT OR DELETE ON follows
    FOR EACH ROW
    EXECUTE FUNCTION update_follow_counts();
