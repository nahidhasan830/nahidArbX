WITH bad_saba_snapshots AS (
  SELECT id
  FROM provider_event_snapshots
  WHERE provider = 'saba-sportsbook'
    AND (
      competition_raw ~* '^[[:space:]]*fantasy match[[:space:]]*$|[[:space:]]-[[:space:]](1st HALF vs 2nd HALF|BOOKING|BOOKINGS|CORNER|CORNERS|EXTRA TIME|FREE KICK|FREE KICKS|GOAL KICK|GOAL KICKS|OFFSIDE|OFFSIDES|OWN GOAL|OWN GOALS|PENALTY|PENALTIES|RED CARD|RED CARDS|SINGLE TEAM OVER/UNDER|SUBSTITUTION|SUBSTITUTIONS|THROW IN|THROW INS|WHICH TEAM WILL ADVANCE TO NEXT ROUND|WINNER|SPECIFIC[[:space:]]+[0-9]+[[:space:]]*MINS([[:space:]]+(NUMBER OF CORNERS|TOTAL BOOKINGS))?|NUMBER OF CORNERS|TOTAL BOOKINGS|TOTAL CORNER[[:space:]]*&[[:space:]]*TOTAL GOAL|TOTAL GOALS?[[:space:]]+MINUTES)$'
      OR home_team_raw ~* '[[:space:]]\+[[:space:]]|(^|[[:space:]-])vs($|[[:space:]-])|[0-9]{1,2}:[0-9]{2}[[:space:]]*-[[:space:]]*[0-9]{1,2}:[0-9]{2}|no\.?[[:space:]]*of[[:space:]]+corners|total[[:space:]]+bookings'
      OR away_team_raw ~* '[[:space:]]\+[[:space:]]|(^|[[:space:]-])vs($|[[:space:]-])|[0-9]{1,2}:[0-9]{2}[[:space:]]*-[[:space:]]*[0-9]{1,2}:[0-9]{2}|no\.?[[:space:]]*of[[:space:]]+corners|total[[:space:]]+bookings'
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
