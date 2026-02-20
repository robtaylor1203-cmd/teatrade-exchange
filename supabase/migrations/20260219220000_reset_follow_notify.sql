-- Reset any follows stuck with notify=false back to true (default)
UPDATE follows SET notify = true WHERE notify = false;
