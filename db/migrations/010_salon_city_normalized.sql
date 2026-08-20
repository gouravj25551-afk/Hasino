-- 010_salon_city_normalized.sql — city-exact salon discovery.
--
-- Idempotent: safe to re-run. Apply after 009_unique_verify_codes.sql.
--
-- Why a second city index
-- -----------------------
-- salons_city_idx (004) is on the raw `city` column, which is what the admin
-- panel filters by: the operator picks a value out of a list the operator
-- typed. Customer discovery cannot assume that. The city on a salon row came
-- from an owner's onboarding form, the city on a customer's request came from
-- a geocoder, and "Jind" and "jind" are the same town spelled by two
-- different people. Discovery therefore compares lower(trim(city)) on both
-- sides, and an index on `city` cannot serve that predicate — the planner
-- would sequential-scan every active salon on every home-page load.
--
-- Deliberately an equality index and not a trigram one: discovery matches a
-- whole city name or nothing. A LIKE 'jind%' would quietly start matching
-- neighbouring names, and showing a customer a salon in a town they are not
-- in is the exact failure this filter exists to prevent.

BEGIN;

CREATE INDEX IF NOT EXISTS salons_city_norm_idx
  ON salons (lower(regexp_replace(btrim(city), '\s+', ' ', 'g')), status);

COMMIT;
