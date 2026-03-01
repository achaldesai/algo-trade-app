/**
 * Service to manage authentication sessions and tokens
 */
import { getTokenRepository, type ZerodhaTokenData } from "../persistence/TokenRepository";

/**
 * Service to manage Zerodha authentication state per User
 */
export class AuthService {
  private static instance: AuthService;

  private constructor() { }

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /**
   * Get current token data for a user
   */
  public async getTokenData(userId: string): Promise<ZerodhaTokenData | null> {
    const repo = getTokenRepository();
    return await repo.getZerodhaToken(userId);
  }

  /**
   * Check if token is valid and not expired for a given user
   */
  public async isAuthenticated(userId: string): Promise<boolean> {
    const data = await this.getTokenData(userId);
    if (!data) return false;

    const expiresAt = new Date(data.expiresAt);
    return expiresAt > new Date();
  }

  /**
   * Clear authentication state for a user
   */
  public async clear(userId: string): Promise<void> {
    const repo = getTokenRepository();
    await repo.deleteZerodhaToken(userId);
  }
}

export default AuthService;
