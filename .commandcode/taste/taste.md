# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# code-style
- Fix root causes rather than applying caps/band-aids to suppress symptoms. When data quality issues arise (e.g., phantom 5.00 odds), trace back to the source (e.g., Pinnacle raw data staleness indicators) instead of adding upper limits on EV or odds ratios. Confidence: 0.85
- Verify diagnoses with real data before implementing fixes. Do not assume — test against actual raw data (e.g., randomly sample real API responses or DB records) to confirm root cause analysis before writing code. Confidence: 0.65

# debugging
- Write inline diagnostic scripts (npx tsx scripts/verify-*.ts) that query live APIs and DBs to validate assumptions. Compare multiple scenarios (e.g., LIVE vs pre-match, goals vs corners vs bookings) and present evidence in tabular form before proposing fixes. Debug and iterate when scripts fail — do not abandon the approach on first error. Confidence: 0.70

# odds-pipeline
- Prefer false positives (phantom bets) over missing genuine value opportunities. Do not add data quality filters or caps on soft provider odds at ingestion (e.g., rejecting 5.00 as a sentinel value) because large odds jumps can be natural and legitimate. Instead, fix root causes on the sharp provider side (e.g., Pinnacle market presence tracking). Confidence: 0.80
- When a provider removes a market from its feed entirely (not just suspends it temporarily), remove the market from the odds store rather than marking it suspended. The suspended flag is semantically reserved for markets that are temporarily unavailable at the bookmaker level (e.g., in-play price freeze). Confidence: 0.70

