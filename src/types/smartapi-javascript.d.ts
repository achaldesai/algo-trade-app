declare module "smartapi-javascript" {
  interface SmartAPIConfig {
    api_key: string;
    access_token?: string;
    refresh_token?: string;
    feed_token?: string;
  }

  interface SmartAPIResponse<T = unknown> {
    status: boolean;
    data?: T;
    message?: string;
  }

  type AngelOneTransactionType = "BUY" | "SELL";
  type AngelOneOrderType =
    | "MARKET"
    | "LIMIT"
    | "STOPLOSS_LIMIT"
    | "STOPLOSS_MARKET";

  interface OrderParams {
    variety: string;
    tradingsymbol: string;
    symboltoken: string;
    transactiontype: AngelOneTransactionType;
    exchange: string;
    ordertype: AngelOneOrderType;
    producttype: string;
    duration: string;
    price: string;
    triggerprice?: string;
    quantity: string;
    disclosedquantity?: string;
    tag?: string;
  }

  interface AngelOnePosition {
    netqty: string;
    netprice?: string;
    avgnetprice?: string;
    tradingsymbol: string;
    symboltoken?: string;
  }

  interface AngelOneOrderBookEntry {
    orderid: string;
    status?: string;
    filledshares?: string;
    quantity?: string;
    averageprice?: string;
    updatetime?: string;
  }

  interface AngelOneQuoteDepthEntry {
    price?: number;
    quantity?: number;
    orders?: number;
  }

  interface AngelOneQuote {
    ltp: number;
    depth?: {
      buy?: AngelOneQuoteDepthEntry[];
      sell?: AngelOneQuoteDepthEntry[];
    };
  }

  interface SessionTokens {
    jwtToken: string;
    feedToken?: string;
    refreshToken?: string;
  }

  type SmartApiCandleTuple = [string, number, number, number, number, number];

  class SmartAPI {
    constructor(config: SmartAPIConfig);

    generateSession(
      clientId: string,
      password: string,
      totp?: string
    ): Promise<SmartAPIResponse<SessionTokens>>;

    setAccessToken(token: string): void;

    logOut(): Promise<SmartAPIResponse>;

    getPosition(): Promise<SmartAPIResponse<AngelOnePosition[]>>;

    getQuote(params: {
      mode: string;
      exchangeTokens: Record<string, string[]>;
    }): Promise<SmartAPIResponse<{ fetched: AngelOneQuote[] }>>;

    placeOrder(params: OrderParams): Promise<SmartAPIResponse<{ orderid: string }>>;

    cancelOrder(params: {
      variety: string;
      orderid: string;
    }): Promise<SmartAPIResponse>;

    getOrderBook(): Promise<SmartAPIResponse<AngelOneOrderBookEntry[]>>;

    getCandleData(params: {
      exchange: string;
      symboltoken: string;
      interval: string;
      fromdate: string;
      todate: string;
    }): Promise<SmartAPIResponse<SmartApiCandleTuple[]>>;

    generateToken(refreshToken: string): Promise<SmartAPIResponse<SessionTokens>>;
  }

  interface WebSocketV2Params {
    clientcode: string;
    jwttoken: string;
    apikey: string;
    feedtype: string;
  }

  type WebSocketV2Action = 0 | 1;
  type WebSocketV2Mode = 1 | 2 | 3 | 4;

  interface WebSocketV2FetchRequest {
    correlationID?: string;
    action: WebSocketV2Action;
    mode: WebSocketV2Mode;
    exchangeType: number;
    tokens: string[];
  }

  interface WebSocketV2QuoteTick {
    subscription_mode: string;
    exchange_type: string;
    token: string;
    sequence_number: string;
    exchange_timestamp: string;
    last_traded_price: string;
    last_traded_quantity: string;
    avg_traded_price: string;
    vol_traded: string;
    total_buy_quantity: number;
    total_sell_quantity: number;
    open_price_day: string;
    high_price_day: string;
    low_price_day: string;
    close_price: string;
  }

  type WebSocketV2Tick = WebSocketV2QuoteTick | Record<string, unknown> | string;

  class WebSocketV2 {
    constructor(params: WebSocketV2Params);
    connect(): Promise<void>;
    fetchData(req: WebSocketV2FetchRequest): void;
    on(event: "tick" | "connect", cb: (data: WebSocketV2Tick) => void): void;
    close(): void;
    customError(): void;
    reconnection(type: "simple", delayMs: number): void;
    reconnection(type: "exponential", delayMs: number, multiplier: number): void;
  }

  export {
    SmartAPI,
    AngelOneOrderBookEntry,
    AngelOnePosition,
    OrderParams,
    SmartApiCandleTuple,
    WebSocketV2,
    WebSocketV2FetchRequest,
    WebSocketV2QuoteTick,
    WebSocketV2Tick,
  };

  export default SmartAPI;
}
