UPDATE "matcher_candidates"
SET "reasons" = '[]'::jsonb
WHERE "reasons" <> '[]'::jsonb;

UPDATE "matcher_decisions"
SET "evidence" = "evidence" - 'candidate' - 'scoreDiagnostics'
WHERE "evidence" ? 'candidate'
   OR "evidence" ? 'scoreDiagnostics';
