/**
 * Placeholder data for the betting dashboard. Only the demo 9W Exchange
 * account card lives here — real placed-bet rows, KPIs, charts and
 * breakdowns now come from the `placed_bets` Postgres table.
 *
 * Once we add a real 9W Exchange adapter this file can be deleted and
 * the dashboard will fall back to "No account configured".
 */

export interface DemoAccount {
  provider: string;
  providerDisplayName: string;
  username: string;
  currency: string;
  balance: number;
  exposure: number;
  minBet: number;
  suspended: boolean;
}

export const DEMO_ACCOUNT: DemoAccount = {
  provider: "ninewickets-exchange",
  providerDisplayName: "9W Exchange",
  username: "demo_user",
  currency: "BDT",
  balance: 0,
  exposure: 0,
  minBet: 0,
  suspended: false,
};
