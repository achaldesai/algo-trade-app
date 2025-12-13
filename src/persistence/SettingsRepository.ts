import type { RiskLimits } from "../services/RiskManager";
import { EventEmitter } from "events";

export interface SettingsRepository extends EventEmitter {
    initialize(): Promise<void>;
    getRiskLimits(): RiskLimits;
    saveRiskLimits(limits: RiskLimits): Promise<void>;
    resetToDefaults(): Promise<RiskLimits>;
    close(): Promise<void>;
}
