
export interface VelkiSession {
  username: string;
  token: string;
  jsessionid: string;
  capturedAt: string;
}


export interface VelkiLoginRequest {
  username: string;
  password: string;
}

export interface VelkiLoginResponse {
  success: boolean;
  message: string;
  data: { token: string };
  errcode: string;
}


export interface VelkiGameLaunchResponse {
  success: boolean;
  message: string;
  data: {
    gameUrl: string;
  };
  errcode: string;
}


export interface VelkiProfileResponse {
  success: boolean;
  message: string;
  data: {
    user: {
      username: string;
      referral_code: string;
      email: string;
      wallet: {
        wallet_id: string;
        credit_balance: string;
        available_credit_balance: string;
        coin_balance: string;
        exposure: string;
      };
      social_contact: string | null;
      upline_social_contact: string | null;
      upline_bank_book: unknown[];
      contact: string | null;
      first_name: string;
      last_name: string;
    };
    user_jwt_live_chat: string;
    user_status: {
      Locked: boolean;
      Suspend: boolean;
    };
  };
  errcode: string;
}


export interface VelkiWalletResponse {
  success: boolean;
  message: string;
  data: {
    wallet: {
      credit_balance: number;
      available_credit_balance: number;
      coin_balance: number;
      exposure_limit: number;
    };
    user_status: {
      Locked: boolean;
      Suspend: boolean;
    };
  };
  errcode: string;
}


export interface VelkiTurnoverEntry {
  user: string;
  name: string;
  title: string;
  ref_id: string;
  base_amount: string;
  required_turnover_amount: string;
  complete_turnover_amount: string;
  turnover_achieved: string;
  completed: boolean;
  end_at: string;
  created_at: string;
}

export interface VelkiTurnoverListResponse {
  success: boolean;
  message: string;
  data: {
    tunovers: VelkiTurnoverEntry[];
  };
  errcode: string;
}


export interface VelkiPlayerInfoResponse {
  creditAllocated: number;
  betCredit: number;
  coinPreference: string;
  accountSuspended: 0 | 1;
  accountSysSuspended: 0 | 1;
  minBet: number;
  totalExposure: number;
  vendorQuantity: number;
  customizeStake: unknown | null;
  oneClickBetStake: unknown | null;
  userCoin: number;
  enableForecastWithCommission: 0 | 1;
  s: number;
}


export interface VelkiMainErrorEnvelope {
  success: false;
  message: string;
  errcode: string;
}

export interface VelkiProviderErrorEnvelope {
  status: string;
  message?: string;
  desc?: string;
}
