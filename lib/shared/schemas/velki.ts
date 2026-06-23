
import { z } from "zod";


export const VelkiLoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const VelkiLoginResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    token: z.string().min(1),
  }),
  errcode: z.string(),
});


export const VelkiGameLaunchResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z
    .object({
      gameUrl: z.string().url(),
    })
    .nullable(),
  errcode: z.string(),
});


const VelkiProfileWalletSchema = z.object({
  wallet_id: z.string(),
  credit_balance: z.string(),
  available_credit_balance: z.string(),
  coin_balance: z.string(),
  exposure: z.string(),
});

export const VelkiProfileResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    user: z.object({
      username: z.string(),
      referral_code: z.string(),
      email: z.string(),
      wallet: VelkiProfileWalletSchema,
      social_contact: z.string().nullable(),
      upline_social_contact: z.string().nullable(),
      upline_bank_book: z.array(z.unknown()),
      contact: z.string().nullable(),
      first_name: z.string(),
      last_name: z.string(),
    }),
    user_jwt_live_chat: z.string(),
    user_status: z.object({
      Locked: z.boolean(),
      Suspend: z.boolean(),
    }),
  }),
  errcode: z.string(),
});


const VelkiWalletBlockSchema = z.object({
  credit_balance: z.number(),
  available_credit_balance: z.number(),
  coin_balance: z.number(),
  exposure_limit: z.number(),
});

export const VelkiWalletResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    wallet: VelkiWalletBlockSchema,
    user_status: z.object({
      Locked: z.boolean(),
      Suspend: z.boolean(),
    }),
  }),
  errcode: z.string(),
});


export const VelkiTurnoverEntrySchema = z.object({
  user: z.string(),
  name: z.string(),
  title: z.string(),
  ref_id: z.string(),
  base_amount: z.string(),
  required_turnover_amount: z.string(),
  complete_turnover_amount: z.string(),
  turnover_achieved: z.string(),
  completed: z.boolean(),
  end_at: z.string(),
  created_at: z.string(),
});

export const VelkiTurnoverListResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    tunovers: z.array(VelkiTurnoverEntrySchema),
  }),
  errcode: z.string(),
});


export const VelkiPlayerInfoResponseSchema = z
  .object({
    creditAllocated: z.number(),
    betCredit: z.number(),
    coinPreference: z.string(),
    accountSuspended: z.union([z.literal(0), z.literal(1)]),
    accountSysSuspended: z.union([z.literal(0), z.literal(1)]),
    minBet: z.number(),
    totalExposure: z.number(),
    vendorQuantity: z.number(),
    customizeStake: z.unknown().nullable().optional(),
    oneClickBetStake: z.unknown().nullable().optional(),
    userCoin: z.number().optional(),
    enableForecastWithCommission: z
      .union([z.literal(0), z.literal(1)])
      .optional(),
    s: z.number().optional(),
  })
  .passthrough();


export const VelkiMainErrorEnvelopeSchema = z.object({
  success: z.literal(false),
  message: z.string(),
  errcode: z.string(),
});

export const VelkiProviderErrorEnvelopeSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  desc: z.string().optional(),
});
