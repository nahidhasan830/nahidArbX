WITH bad_saba_snapshots AS (
  SELECT id
  FROM provider_event_snapshots
  WHERE provider = 'saba-sportsbook'
    AND (
      competition_raw ~* '^\s*fantasy match\s*$'
      OR home_team_raw ~ '\s\+\s'
      OR away_team_raw ~ '\s\+\s'
      OR home_team_raw ~* '(^|[[:space:]-])vs($|[[:space:]-])'
      OR away_team_raw ~* '(^|[[:space:]-])vs($|[[:space:]-])'
    )
)
DELETE FROM provider_event_snapshots
WHERE id IN (SELECT id FROM bad_saba_snapshots);

DELETE FROM canonical_events ce
WHERE NOT EXISTS (
  SELECT 1
  FROM canonical_event_members cem
  WHERE cem.canonical_event_id = ce.id
);
