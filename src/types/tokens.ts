/**
 * Token data types — re-exported from the DB record types.
 *
 * These match the LMDB-persisted records 1:1, so the same shape is used at
 * route boundaries and inside repositories.
 */

export type {
    ZerodhaTokenRecord as ZerodhaTokenData,
    AngelOneTokenRecord as AngelOneTokenData,
    TokenRecord,
} from "../db/DatabaseManager";
