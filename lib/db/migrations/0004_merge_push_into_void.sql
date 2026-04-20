-- Merge the "push" outcome into "void". In our atom-settlement model
-- they are financially identical (stake returned) and the distinction
-- was never surfaced to users.
UPDATE "value_bets" SET "outcome" = 'void' WHERE "outcome" = 'push';
