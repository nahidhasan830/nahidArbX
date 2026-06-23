
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
