-- Clients open entry links, enclosures, and site URLs; only http(s) may remain.
UPDATE "entries" SET "link" = NULL WHERE "link" !~* '^https?://';
--> statement-breakpoint
DELETE FROM "enclosures" WHERE "url" !~* '^https?://';
--> statement-breakpoint
UPDATE "feed_sources" SET "site_url" = NULL WHERE "site_url" !~* '^https?://';
