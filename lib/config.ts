export const config = {
  fetchInterval: parseInt(process.env.FETCH_INTERVAL_MS || "20000"),
  minProfit: parseFloat(process.env.MIN_PROFIT_PCT || "0.5"),
  totalStake: parseFloat(process.env.TOTAL_STAKE || "100"),
  providers: {
    pslive: {
      // Token captured via browser automation (betjili → pslive)
      // Credentials in BETJILI_* env vars, token stored in pslive-token.json
      baseUrl: "https://www.ps388win.com",
      daysAhead: parseInt(process.env.PSLIVE_DAYS_AHEAD || "2"),
      pageSize: parseInt(process.env.PSLIVE_PAGE_SIZE || "1000"),
    },
    ninewickets: {
      baseUrl: process.env.NINEWICKETS_BASE_URL || "",
      apiKey: process.env.NINEWICKETS_API_KEY || "",
    },
  },
};
