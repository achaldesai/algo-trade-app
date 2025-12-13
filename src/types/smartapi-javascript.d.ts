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

  export {
    SmartAPI,
    AngelOneOrderBookEntry,
    AngelOnePosition,
    OrderParams,
    SmartApiCandleTuple,
  };

  export default SmartAPI;
}
