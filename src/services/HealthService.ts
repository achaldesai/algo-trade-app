import { getPortfolioRepository } from "../persistence";
import { TradingLoopService } from "./TradingLoopService";
import { MarketDataService } from "./MarketDataService";
import type { TickerClient } from "./TickerClient";
import type BrokerClient from "../brokers/BrokerClient";
import type { StopLossMonitor } from "./StopLossMonitor";
import logger from "../utils/logger";

/**
 * Health status for a single component
 */
export interface ComponentHealth {
    name: string;
    status: "healthy" | "degraded" | "unhealthy";
    message?: string;
    lastUpdated?: Date;
}

/**
 * Overall system health status
 */
export interface SystemHealth {
    status: "healthy" | "degraded" | "unhealthy";
    timestamp: Date;
    uptime: number; // seconds
    memory: {
        used: number; // MB
        total: number; // MB
        percentUsed: number;
    };
    components: ComponentHealth[];
    lastTick?: {
        symbol: string;
        price: number;
        ageSeconds: number;
    };
}

export interface HealthServiceDependencies {
    brokerClient: BrokerClient;
    tickerClient?: TickerClient;
    marketDataService: MarketDataService;
    stopLossMonitor?: StopLossMonitor;
}

// Track server start time for uptime calculation
const serverStartTime = Date.now();

/**
 * Service for aggregating health status from all components
 */
export class HealthService {
    private readonly dependencies: HealthServiceDependencies;

    constructor(dependencies: HealthServiceDependencies) {
        this.dependencies = dependencies;
    }

    /**
     * Get comprehensive system health status
     */
    async getHealth(): Promise<SystemHealth> {
        const components: ComponentHealth[] = [];

        // Check broker health
        components.push(this.checkBrokerHealth());

        // Check ticker health
        components.push(this.checkTickerHealth());

        // Check database health
        components.push(await this.checkDatabaseHealth());

        // Check trading loop health
        components.push(this.checkTradingLoopHealth());

        // Check stop-loss monitor health
        components.push(this.checkStopLossHealth());

        // Determine overall status
        const overallStatus = this.determineOverallStatus(components);

        // Get memory usage
        const memoryUsage = process.memoryUsage();
        const usedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
        const totalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);

        // Get last tick info
        const lastTick = this.getLastTickInfo();

        return {
            status: overallStatus,
            timestamp: new Date(),
            uptime: Math.floor((Date.now() - serverStartTime) / 1000),
            memory: {
                used: usedMB,
                total: totalMB,
                percentUsed: Math.round((usedMB / totalMB) * 100 * 10) / 10,
            },
            components,
            lastTick,
        };
    }

    /**
     * Check broker connection health
     */
    private checkBrokerHealth(): ComponentHealth {
        try {
            const broker = this.dependencies.brokerClient;
            const isConnected = broker.isConnected();

            return {
                name: "broker",
                status: isConnected ? "healthy" : "degraded",
                message: isConnected
                    ? `Connected (${broker.name})`
                    : `Disconnected (${broker.name})`,
                lastUpdated: new Date(),
            };
        } catch (error) {
            logger.error({ err: error }, "Failed to check broker status");
            return {
                name: "broker",
                status: "unhealthy",
                message: "Failed to check broker status",
                lastUpdated: new Date(),
            };
        }
    }

    /**
     * Check WebSocket ticker health
     */
    private checkTickerHealth(): ComponentHealth {
        try {
            const ticker = this.dependencies.tickerClient;

            if (!ticker) {
                return {
                    name: "ticker",
                    status: "degraded",
                    message: "Ticker not configured",
                    lastUpdated: new Date(),
                };
            }

            const isConnected = ticker.isConnected();
            const lastTick = this.getLastTickInfo();
            const ageMessage = lastTick
                ? ` (last tick ${lastTick.ageSeconds}s ago)`
                : "";

            // Consider unhealthy if no tick in >60 seconds during market hours
            let status: ComponentHealth["status"] = isConnected ? "healthy" : "unhealthy";
            if (isConnected && lastTick && lastTick.ageSeconds > 60) {
                status = "degraded";
            }

            return {
                name: "ticker",
                status,
                message: isConnected ? `Connected${ageMessage}` : "Disconnected",
                lastUpdated: new Date(),
            };
        } catch (error) {
            logger.error({ err: error }, "Failed to check ticker status");
            return {
                name: "ticker",
                status: "unhealthy",
                message: "Failed to check ticker status",
                lastUpdated: new Date(),
            };
        }
    }

    /**
     * Check database health with a quick read test
     */
    private async checkDatabaseHealth(): Promise<ComponentHealth> {
        try {
            const repo = await getPortfolioRepository();
            // Quick read test
            await repo.listStocks();

            return {
                name: "database",
                status: "healthy",
                message: "LMDB operational",
                lastUpdated: new Date(),
            };
        } catch (error) {
            logger.error({ err: error }, "Database health check failed");
            return {
                name: "database",
                status: "unhealthy",
                message: "Database read failed",
                lastUpdated: new Date(),
            };
        }
    }

    /**
     * Check trading loop health
     */
    private checkTradingLoopHealth(): ComponentHealth {
        try {
            const loopService = TradingLoopService.getInstance();
            const status = loopService.getStatus();

            return {
                name: "tradingLoop",
                status: "healthy", // Not running is still healthy, just not active
                message: status.running
                    ? `Running (${status.mode} mode)`
                    : "Stopped",
                lastUpdated: new Date(),
            };
        } catch {
            // Service not initialized yet
            return {
                name: "tradingLoop",
                status: "healthy",
                message: "Not initialized",
                lastUpdated: new Date(),
            };
        }
    }

    /**
     * Check stop-loss monitor health
     */
    private checkStopLossHealth(): ComponentHealth {
        try {
            const monitor = this.dependencies.stopLossMonitor;

            if (!monitor) {
                return {
                    name: "stopLoss",
                    status: "healthy",
                    message: "Not configured",
                    lastUpdated: new Date(),
                };
            }

            const status = monitor.getStatus();

            return {
                name: "stopLoss",
                status: "healthy",
                message: status.monitoring
                    ? `Monitoring ${status.activeStopLosses} positions`
                    : "Stopped",
                lastUpdated: new Date(),
            };
        } catch {
            return {
                name: "stopLoss",
                status: "healthy",
                message: "Not initialized",
                lastUpdated: new Date(),
            };
        }
    }

    /**
     * Get info about the most recent market tick
     */
    private getLastTickInfo(): SystemHealth["lastTick"] {
        try {
            const marketData = this.dependencies.marketDataService;
            const snapshot = marketData.getSnapshot();

            if (!snapshot.ticks || snapshot.ticks.length === 0) {
                return undefined;
            }

            // Find the most recent tick
            const latestTick = snapshot.ticks.reduce((latest, tick) => {
                return tick.timestamp > latest.timestamp ? tick : latest;
            });

            const ageSeconds = Math.floor(
                (Date.now() - latestTick.timestamp.getTime()) / 1000
            );

            return {
                symbol: latestTick.symbol,
                price: latestTick.price,
                ageSeconds,
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Determine overall health status from component statuses
     */
    private determineOverallStatus(
        components: ComponentHealth[]
    ): SystemHealth["status"] {
        const hasUnhealthy = components.some((c) => c.status === "unhealthy");
        const hasDegraded = components.some((c) => c.status === "degraded");

        if (hasUnhealthy) {
            return "unhealthy";
        }
        if (hasDegraded) {
            return "degraded";
        }
        return "healthy";
    }

    /**
     * Get server uptime in seconds
     */
    getUptime(): number {
        return Math.floor((Date.now() - serverStartTime) / 1000);
    }
}

export default HealthService;
