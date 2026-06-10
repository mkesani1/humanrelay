-- Relay traces can carry attached content (a camera frame, a document) alongside
-- the question. Content rides into every binary task payload so workers see it.
-- Content-bearing traces bypass the answer cache: the question text alone no
-- longer identifies the case.
alter table relay_traces add column if not exists content jsonb;
