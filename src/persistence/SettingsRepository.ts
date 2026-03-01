import type { RiskLimits } from "../services/RiskManager";
import { EventEmitter } from "events";

export interface SettingsRepository extends EventEmitter {
    initialize(): Promise<void>;
    getRiskLimits(userId: string): RiskLimits;
    saveRiskLimits(userId: string, limits: RiskLimits): Promise<void>;
    resetToDefaults(userId: string): Promise<RiskLimits>;
    close(): Promise<void>;
}
