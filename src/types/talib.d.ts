/**
 * Type definitions for TA-Lib Node.js bindings
 */

declare module "talib" {
    export interface TALibExplainResult {
        name: string;
        group: string;
        hint: string;
        inputs: TALibInput[];
        optInputs: TALibOptInput[];
        outputs: TALibOutput[];
    }

    export interface TALibInput {
        name: string;
        type: string;
    }

    export interface TALibOptInput {
        name: string;
        displayName: string;
        defaultValue: number;
        hint: string;
        type: string;
    }

    export interface TALibOutput {
        name: string;
        type: string;
        flags: Record<string, boolean>;
    }

    export interface TALibExecuteParams {
        name: string;
        startIdx: number;
        endIdx: number;
        inReal?: number[];
        inRealHigh?: number[];
        inRealLow?: number[];
        inRealClose?: number[];
        inRealOpen?: number[];
        inRealVolume?: number[];
        optInTimePeriod?: number;
        optInFastPeriod?: number;
        optInSlowPeriod?: number;
        optInSignalPeriod?: number;
        optInNbDevUp?: number;
        optInNbDevDn?: number;
        optInMAType?: number;
    }

    export interface TALibResult {
        begIndex: number;
        nbElement: number;
        result: {
            outReal?: number[];
            outRealUpperBand?: number[];
            outRealMiddleBand?: number[];
            outRealLowerBand?: number[];
            outMACD?: number[];
            outMACDSignal?: number[];
            outMACDHist?: number[];
        };
    }

    /**
     * Execute a TA-Lib function
     */
    export function execute(params: TALibExecuteParams): TALibResult;

    /**
     * Get information about a TA-Lib function
     */
    export function explain(funcName: string): TALibExplainResult;

    /**
     * Get list of all available function groups
     */
    export function functionGroups(): string[];

    /**
     * Get list of all functions in a group
     */
    export function functions(): string[];
}
