import type { Request } from "express";
import type { AppContainer } from "../container";

/**
 * Extract the `AppContainer` from an Express request.
 * The container is set on `app.locals.container` by the lifecycle orchestrator
 * during the "container" startup phase.
 */
export function getContainer(req: Request): AppContainer {
    const container = req.app.locals.container as AppContainer | undefined;
    if (!container) {
        throw new Error(
            "AppContainer not initialized. Server may still be starting up."
        );
    }
    return container;
}
