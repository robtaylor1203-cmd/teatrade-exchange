-- Seed bot users with realistic badge distributions

-- Stephen Kwon (rank 1, high performer) -- elite trader
UPDATE profiles SET badges = '["WHALE","SNIPER","DIAMOND_HANDS","IRON_CLAD","SHEPHERD"]'::JSONB
WHERE username = 'Stephen Kwon';

-- Benjamin Scott (rank 2) -- volume king + survivor
UPDATE profiles SET badges = '["WHALE","TEN_BAGGER","SURVIVOR","DIAMOND_HANDS"]'::JSONB
WHERE username = 'Benjamin Scott';

-- Lucas Andersen (rank 3) -- disciplined
UPDATE profiles SET badges = '["SNIPER","IRON_CLAD","DIAMOND_HANDS"]'::JSONB
WHERE username = 'Lucas Andersen';

-- Amara Traore -- social trader
UPDATE profiles SET badges = '["SHEPHERD","WHALE","PHOENIX"]'::JSONB
WHERE username = 'Amara Traore';

-- Marcus Chen -- big bet guy
UPDATE profiles SET badges = '["TEN_BAGGER","WHALE"]'::JSONB
WHERE username = 'Marcus Chen';

-- Oliver Bennett -- consistent
UPDATE profiles SET badges = '["SNIPER","IRON_CLAD"]'::JSONB
WHERE username = 'Oliver Bennett';

-- Ryan Campbell -- bottom fisher
UPDATE profiles SET badges = '["BOTTOM_CATCHER","SURVIVOR"]'::JSONB
WHERE username = 'Ryan Campbell';

-- David Singh -- volume trader
UPDATE profiles SET badges = '["WHALE","DIAMOND_HANDS"]'::JSONB
WHERE username = 'David Singh';

-- Mei Lin Wu -- precise
UPDATE profiles SET badges = '["SNIPER","BOTTOM_CATCHER"]'::JSONB
WHERE username = 'Mei Lin Wu';

-- Patrick O'Brien -- comeback story
UPDATE profiles SET badges = '["PHOENIX","SURVIVOR","TEN_BAGGER"]'::JSONB
WHERE username = 'Patrick O''Brien';

-- Zara Hussain -- patient trader
UPDATE profiles SET badges = '["DIAMOND_HANDS"]'::JSONB
WHERE username = 'Zara Hussain';

-- Daniel Njoroge -- iron discipline
UPDATE profiles SET badges = '["IRON_CLAD","SNIPER"]'::JSONB
WHERE username = 'Daniel Njoroge';

-- Raj Malhotra -- whale
UPDATE profiles SET badges = '["WHALE"]'::JSONB
WHERE username = 'Raj Malhotra';

-- Ananya Reddy -- survivor
UPDATE profiles SET badges = '["SURVIVOR","PHOENIX"]'::JSONB
WHERE username = 'Ananya Reddy';

-- Sarah Patel -- new but promising
UPDATE profiles SET badges = '["BOTTOM_CATCHER"]'::JSONB
WHERE username = 'Sarah Patel';
