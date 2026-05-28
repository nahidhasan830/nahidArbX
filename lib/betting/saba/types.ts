export interface SabaSession {
  username: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExp: number;
  gameUrl: string;
  capturedAt: string;
}
