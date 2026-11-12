-- Dropping the search column in 0043 dropped its index, which the generated migration does not recreate.
CREATE INDEX IF NOT EXISTS "entries_search_idx" ON "entries" USING gin ("search");
