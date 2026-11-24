-- Host requests find their tournament by key hash. Without an index every request scans the whole
-- tournaments table, which only grows (tournaments are never deleted, design AD1), so rows read per
-- request would keep rising. The index is written only when a key is approved, reissued or revoked.
CREATE INDEX tournaments_key_hash ON tournaments (key_hash);
