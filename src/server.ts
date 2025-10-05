import http from "http";
import app from "./app";
import env from "./config/env";
import logger from "./utils/logger";

const server = http.createServer(app);

server.listen(env.port, () => {
  logger.info({ port: env.port }, "HTTP server is listening");
});

const shutdown = (signal: string) => {
  logger.info({ signal }, "Received shutdown signal");
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "Error during shutdown");
      process.exitCode = 1;
    }
    logger.info("Server closed");
    process.exit();
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
