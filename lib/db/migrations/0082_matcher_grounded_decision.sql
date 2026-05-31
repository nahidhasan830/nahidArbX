ALTER TABLE "matcher_decisions"
  ADD COLUMN IF NOT EXISTS "grounded_decision" text,
  ADD COLUMN IF NOT EXISTS "grounded_confidence" real;

UPDATE "matcher_decisions"
SET
  "grounded_decision" = CASE
    WHEN "reason_code" = 'grounded_llm_same_match' THEN 'SAME'
    WHEN "reason_code" = 'grounded_llm_different_match' THEN 'DIFFERENT'
    WHEN "reason_code" IN ('llm_uncertain', 'llm_evidence_conflict')
      AND lower("reason_summary") ~ '(teams? .*differ|different (fixture|match)|distinct clubs|not evidenced|no .*match)'
      THEN 'DIFFERENT'
    WHEN "reason_code" IN ('llm_uncertain', 'llm_evidence_conflict')
      AND lower("reason_summary") ~ '(same (fixture|match)|one fixture|same event)'
      THEN 'SAME'
    WHEN "reason_code" IN ('llm_uncertain', 'llm_evidence_conflict') THEN 'UNCERTAIN'
    ELSE "grounded_decision"
  END,
  "grounded_confidence" = CASE
    WHEN "reason_code" IN (
      'grounded_llm_same_match',
      'grounded_llm_different_match',
      'llm_uncertain',
      'llm_evidence_conflict'
    )
      THEN "confidence"
    ELSE "grounded_confidence"
  END
WHERE "grounded_decision" IS NULL;
