import logger from "./utils/logger";
import { startApplication, stopApplication } from "./lifecycle";

/**
 * Application entry point.
 *
 * All startup logic lives in lifecycle.ts.
 * This file only wires signal handlers and calls start/stop.
 */
async function main(): Promise<void> {
  try {
    await startApplication();
  } catch (error) {
    logger.error({ err: error }, "Failed to start application");
    process.exit(1);
  }
}

function shutdown(signal: string): void {
  logger.info({ signal }, "Received shutdown signal");

  stopApplication()
    .then(() => {
      logger.info("Shutdown complete");
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ err: error }, "Error during shutdown");
      process.exit(1);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

void main();
