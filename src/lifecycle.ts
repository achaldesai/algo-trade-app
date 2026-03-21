import http from "http";
import type { Express } from "express";
import env from "./config/env";
import validateEnvironment from "./config/validateEnv";
import logger from "./utils/logger";
import { DatabaseManager } from "./db/DatabaseManager";
import type { AppContainer } from "./container";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LifecyclePhase {
    name: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
}

interface LifecycleState {
    dbManager: DatabaseManager;
    container: AppContainer | null;
    server: http.Server | null;
    backupInterval: NodeJS.Timeout | null;
    phases: LifecyclePhase[];
    isShuttingDown: boolean;
}

// ─── State ───────────────────────────────────────────────────────────────────

const state: LifecycleState = {
    dbManager: new DatabaseManager(env.portfolioStorePath),
    container: null,
    server: null,
    backupInterval: null,
    phases: [],
    isShuttingDown: false,
};

// ─── Phase Definitions ──────────────────────────────────────────────────────

function buildPhases(app: Express): LifecyclePhase[] {
    return [
        // Phase 1: Environment Validation
        {
            name: "environment",
            start: async () => {
                await validateEnvironment(env);
            },
            stop: async () => {
                // Nothing to tear down
            },
        },

        // Phase 2: Database
        {
            name: "database",
            start: async () => {
                await state.dbManager.open();

                // Populate caches in repos that need them
                // (done by container creation, not here — container reads from DB after open)
            },
            stop: async () => {
                await state.dbManager.close();
            },
        },

        // Phase 3: Container (services, repos, engine)
        {
            name: "container",
            start: async () => {
                const { createContainer } = await import("./container");
                state.container = createContainer(state.dbManager);

                // Expose container on Express app for route handlers
                app.locals.container = state.container;
            },
            stop: async () => {
                // Container itself has no stop — individual services are stopped elsewhere
                state.container = null;
            },
        },

        // Phase 3.5: Optional Stores (PostgreSQL + Redis)
        {
            name: "optionalStores",
            start: async () => {
                if (!state.container) return;
                const { initOptionalStores } = await import("./container");
                await initOptionalStores(state.container);
            },
            stop: async () => {
                if (!state.container) return;
                const { closeOptionalStores } = await import("./container");
                await closeOptionalStores(state.container);
            },
        },

        // Phase 4: Auth & Token Migration
        {
            name: "auth",
            start: async () => {
                if (!state.container) return;

                // Migrate tokens from file-based storage (one-time)
                const { TokenMigrationService } = await import(
                    "./services/TokenMigrationService"
                );
                const migrationService = new TokenMigrationService();
                await migrationService.migrate(env.portfolioStorePath);
            },
            stop: async () => {
                // Stop token refresh scheduler
                try {
                    const { TokenRefreshService } = await import(
                        "./services/TokenRefreshService"
                    );
                    const refreshService = TokenRefreshService.getInstance();
                    refreshService.stop();
                } catch {
                    // Service may not be initialized
                }
            },
        },

        // Phase 5: Broker Connection
        {
            name: "broker",
            start: async () => {
                if (env.brokerProvider === "paper") return;
                if (!state.container) return;

                const broker = state.container.brokerClient;
                await broker.connect();

                if (!broker.isConnected()) {
                    throw new Error(
                        `Broker not authenticated for provider: ${env.brokerProvider}. Run authentication first.`
                    );
                }
                logger.info(
                    { broker: broker.name },
                    "Broker authentication verified"
                );
            },
            stop: async () => {
                if (!state.container) return;
                try {
                    await state.container.brokerClient.disconnect();
                } catch (err) {
                    logger.error({ err }, "Error disconnecting broker");
                }
            },
        },

        // Phase 6: Market Data (Ticker WebSocket)
        {
            name: "marketData",
            start: async () => {
                if (!state.container) return;
                const tickerClient = state.container.tickerClient;
                if (!tickerClient) return;

                // Validate Angel One tokens before connecting ticker
                if (env.dataProvider === "angelone") {
                    const tokenRepo = state.container.tokenRepo;
                    let tokens = tokenRepo.getAngelOneToken("SYSTEM_DEFAULT");

                    if (!tokens && env.angelOneTotpSecret) {
                        logger.info(
                            "Angel One tokens missing/expired. Attempting automatic re-auth..."
                        );
                        try {
                            const { TokenRefreshService } = await import(
                                "./services/TokenRefreshService"
                            );
                            const refreshService = TokenRefreshService.getInstance();
                            await refreshService.refreshToken("SYSTEM_DEFAULT");
                            tokens = tokenRepo.getAngelOneToken("SYSTEM_DEFAULT");
                        } catch (error) {
                            logger.warn(
                                { err: error },
                                "Automatic Angel One re-authentication failed"
                            );
                        }
                    }

                    if (!tokens) {
                        logger.warn(
                            "Angel One tokens not found. Ticker will not start."
                        );
                        return;
                    }

                    if (new Date(tokens.expiresAt) < new Date()) {
                        logger.warn("Angel One tokens expired. Ticker will not start.");
                        return;
                    }
                }

                // Load instrument master
                if (
                    env.brokerProvider === "angelone" ||
                    env.dataProvider === "angelone"
                ) {
                    try {
                        const { getInstrumentMasterService } = await import(
                            "./services/InstrumentMasterService"
                        );
                        const instrumentService = getInstrumentMasterService();
                        await instrumentService.loadInstrumentMaster();
                    } catch (error) {
                        logger.warn(
                            { err: error },
                            "Failed to load instrument master (will retry on first API call)"
                        );
                    }
                }

                // Connect ticker
                tickerClient.connect().catch((err) => {
                    logger.error({ err }, "Failed to connect ticker on startup");
                });
                logger.info("Ticker service initialized");

                // Subscribe to watchlist
                if (env.watchlist.length > 0) {
                    const { getInstrumentMasterService } = await import(
                        "./services/InstrumentMasterService"
                    );
                    const instrumentService = getInstrumentMasterService();
                    if (!instrumentService.isReady()) {
                        await instrumentService.loadInstrumentMaster();
                    }

                    const exchange = env.angelOneDefaultExchange;
                    let subscribedCount = 0;

                    for (const symbol of env.watchlist) {
                        const token = instrumentService.getToken(symbol, exchange);
                        if (token) {
                            tickerClient.subscribe({
                                exchange,
                                symbol,
                                symbolToken: token,
                            });
                            subscribedCount++;
                        } else {
                            logger.warn(
                                { symbol, exchange },
                                "Skipping watchlist subscription: Instrument token not found"
                            );
                        }
                    }

                    if (subscribedCount > 0) {
                        logger.info(
                            { count: subscribedCount, symbols: env.watchlist },
                            "Subscribed to watchlist symbols"
                        );
                    }
                }
            },
            stop: async () => {
                if (!state.container?.tickerClient) return;
                try {
                    await state.container.tickerClient.disconnect();
                } catch (err) {
                    logger.error({ err }, "Error disconnecting ticker");
                }
            },
        },

        // Phase 7: Services (trading loop, stop-loss, auto-trade, scheduler)
        {
            name: "services",
            start: async () => {
                if (!state.container) return;

                // Start token refresh scheduler
                const { TokenRefreshService } = await import(
                    "./services/TokenRefreshService"
                );
                const tokenRefreshService = TokenRefreshService.getInstance();
                tokenRefreshService.start();

                // Reconcile positions on startup
                try {
                    const result =
                        await state.container.reconciliationService.reconcileOnStartup();
                    if (result.hasDiscrepancies) {
                        logger.warn(
                            {
                                discrepancies: result.discrepancies.length,
                                synced: result.syncedSymbols.length,
                            },
                            "Position discrepancies found on startup"
                        );
                    }
                } catch (err) {
                    logger.error({ err }, "Position reconciliation failed on startup");
                }

                // Initialize trading loop (but don't start — controlled via API)
                logger.info("Trading loop service initialized");

                // Start auto-trading service
                state.container.autoTradingService.start();
                logger.info("Auto-trading service started");

                // Schedule backups
                const backupIntervalHours =
                    Number(process.env.BACKUP_INTERVAL_HOURS) || 24;
                const backupIntervalMs = backupIntervalHours * 60 * 60 * 1000;

                // Initial backup
                try {
                    const backupPath = await state.dbManager.createBackup();
                    logger.info({ backupPath }, "Initial backup created");
                } catch (error) {
                    logger.error({ err: error }, "Failed to create initial backup");
                }

                state.backupInterval = setInterval(async () => {
                    try {
                        await state.dbManager.createBackup();
                    } catch (error) {
                        logger.error({ err: error }, "Failed to create scheduled backup");
                    }
                }, backupIntervalMs);

                logger.info(
                    { intervalHours: backupIntervalHours },
                    "Automatic backups scheduled"
                );

                // Start Discord bot
                void state.container.discordBotService.start();
            },
            stop: async () => {
                // Clear backup timer
                if (state.backupInterval) {
                    clearInterval(state.backupInterval);
                    state.backupInterval = null;
                }

                if (!state.container) return;

                // Stop auto-trading
                state.container.autoTradingService.stop();

                // Stop trading loop
                state.container.tradingLoopService.stop();

                // Stop stop-loss monitor
                state.container.stopLossMonitor.stop();
            },
        },

        // Phase 8: HTTP Server
        {
            name: "httpServer",
            start: async () => {
                state.server = http.createServer(app);

                return new Promise<void>((resolve, reject) => {
                    state.server!.on("error", reject);
                    state.server!.listen(env.port, () => {
                        logger.info({ port: env.port }, "HTTP server is listening");
                        resolve();
                    });
                });
            },
            stop: async () => {
                if (!state.server) return;
                return new Promise<void>((resolve) => {
                    state.server!.close((error) => {
                        if (error) {
                            logger.error({ err: error }, "Error closing HTTP server");
                        }
                        logger.info("HTTP server closed");
                        resolve();
                    });
                });
            },
        },
    ];
}

// ─── Startup ─────────────────────────────────────────────────────────────────

const PHASE_TIMEOUT_MS = 30_000;

export async function startApplication(): Promise<void> {
    const { default: app } = await import("./app");
    state.phases = buildPhases(app);

    for (const phase of state.phases) {
        try {
            logger.info({ phase: phase.name }, "Starting phase...");
            await Promise.race([
                phase.start(),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error(`Phase "${phase.name}" timed out after ${PHASE_TIMEOUT_MS}ms`)),
                        PHASE_TIMEOUT_MS
                    )
                ),
            ]);
            logger.info({ phase: phase.name }, "Phase started");
        } catch (error) {
            logger.error(
                { err: error, phase: phase.name },
                "Phase failed during startup"
            );
            throw error;
        }
    }
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

export async function stopApplication(): Promise<void> {
    if (state.isShuttingDown) return;
    state.isShuttingDown = true;

    try {
        // Stop phases in reverse order
        const reversedPhases = [...state.phases].reverse();

        for (const phase of reversedPhases) {
            try {
                logger.info({ phase: phase.name }, "Stopping phase...");
                await Promise.race([
                    phase.stop(),
                    new Promise<never>((_, reject) =>
                        setTimeout(
                            () => reject(new Error(`Phase "${phase.name}" stop timed out`)),
                            10_000
                        )
                    ),
                ]);
                logger.info({ phase: phase.name }, "Phase stopped");
            } catch (error) {
                logger.error(
                    { err: error, phase: phase.name },
                    "Error stopping phase (continuing shutdown)"
                );
                // Continue — don't let one phase failure block others
            }
        }
    } finally {
        state.isShuttingDown = false;
    }
}

// ─── Accessors ───────────────────────────────────────────────────────────────

export function getDbManager(): DatabaseManager {
    return state.dbManager;
}

export function getContainer(): AppContainer | null {
    return state.container;
}
