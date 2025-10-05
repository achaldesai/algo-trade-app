import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "production" ? undefined : {
    target: "pino-pretty",
    options: {
      translateTime: "SYS:standard",
      singleLine: true,
    },
  },
});

export default logger;
