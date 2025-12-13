/**
 * Abstract ticker client interface for real-time market data streaming
 * Allows different broker ticker implementations to be used interchangeably
 */

export interface TickerSubscription {
    exchange: string;
    symbolToken: string;
    symbol: string;
}

export interface TickerClient {
    /**
     * Connect to the ticker WebSocket
     */
    connect(): Promise<void>;

    /**
     * Disconnect from the ticker WebSocket
     */
    disconnect(): Promise<void>;

    /**
     * Check if the ticker is currently connected
     */
    isConnected(): boolean;

    /**
     * Subscribe to real-time updates for a symbol
     */
    subscribe(subscription: TickerSubscription): void;

    /**
     * Unsubscribe from updates for a symbol
     */
    unsubscribe(exchange: string, symbolToken: string): void;
}

export default TickerClient;
