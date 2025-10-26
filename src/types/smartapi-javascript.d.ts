/**
 * Type declarations for smartapi-javascript
 * Angel One SmartAPI SDK for Node.js
 */

declare module "smartapi-javascript" {
  export interface SmartAPIConfig {
    api_key: string;
  }

  export interface SessionResponse {
    status: boolean;
    message?: string;
    data?: {
      jwtToken: string;
      refreshToken: string;
      feedToken: string;
    };
  }

  export interface TokenRefreshResponse {
    status: boolean;
    message?: string;
    data?: {
      jwtToken: string;
      refreshToken: string;
      feedToken: string;
    };
  }

  export interface CandleDataParams {
    exchange: string;
    symboltoken: string;
    interval: string;
    fromdate: string;
    todate: string;
  }

  export interface CandleDataResponse {
    status: boolean;
    message?: string;
    data?: any[];
  }

  export interface OrderParams {
    variety: string;
    tradingsymbol: string;
    symboltoken: string;
    transactiontype: string;
    exchange: string;
    ordertype: string;
    producttype: string;
    duration: string;
    price: string;
    quantity: string;
    tag?: string;
  }

  export interface OrderResponse {
    status: boolean;
    message?: string;
    data?: {
      orderid: string;
    };
  }

  export interface CancelOrderParams {
    variety: string;
    orderid: string;
  }

  export interface QuoteParams {
    mode: string;
    exchangeTokens: Record<string, string[]>;
  }

  export interface QuoteResponse {
    status: boolean;
    message?: string;
    data?: {
      fetched: any[];
    };
  }

  export interface PositionResponse {
    status: boolean;
    message?: string;
    data?: any[];
  }

  export interface OrderBookResponse {
    status: boolean;
    message?: string;
    data?: any[];
  }

  export class SmartAPI {
    constructor(config: SmartAPIConfig);

    generateSession(
      clientId: string,
      password: string,
      totp?: string
    ): Promise<SessionResponse>;

    setAccessToken(token: string): void;

    getCandleData(params: CandleDataParams): Promise<CandleDataResponse>;

    placeOrder(params: OrderParams): Promise<OrderResponse>;

    cancelOrder(params: CancelOrderParams): Promise<OrderResponse>;

    getQuote(params: QuoteParams): Promise<QuoteResponse>;

    getPosition(): Promise<PositionResponse>;

    getOrderBook(): Promise<OrderBookResponse>;

    generateToken(refreshToken: string): Promise<TokenRefreshResponse>;

    logOut(): Promise<any>;
  }
}
