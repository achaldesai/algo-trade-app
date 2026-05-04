/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { InstrumentMasterService } from "./InstrumentMasterService";

describe("InstrumentMasterService", () => {
  let service: InstrumentMasterService;

  beforeEach(() => {
    // Use a direct instance instead of the singleton for test isolation
    service = new InstrumentMasterService();
  });

  describe("getToken", () => {
    it("should return null when not loaded", () => {
      const token = service.getToken("RELIANCE", "NSE");
      assert.equal(token, null);
    });

    it("should return token with exchange prefix lookup", () => {
      // Populate maps directly for testing
      (service as any).isLoaded = true;
      (service as any).instruments.set("NSE:RELIANCE-EQ", { token: "2885", symbol: "RELIANCE-EQ", name: "Reliance Industries" });
      (service as any).symbolToTokenMap.set("NSE:RELIANCE-EQ", "2885");

      const token = service.getToken("RELIANCE-EQ", "NSE");
      assert.equal(token, "2885");
    });

    it("should try -EQ suffix for NSE when exact match not found", () => {
      (service as any).isLoaded = true;
      (service as any).symbolToTokenMap.set("NSE:TCS-EQ", "11536");

      const token = service.getToken("TCS", "NSE");
      assert.equal(token, "11536");
    });

    it("should fallback to symbol-only lookup", () => {
      (service as any).isLoaded = true;
      (service as any).symbolToTokenMap.set("INFY-EQ", "1594");

      const token = service.getToken("INFY-EQ");
      assert.equal(token, "1594");
    });

    it("should try -EQ suffix even without exchange param", () => {
      (service as any).isLoaded = true;
      (service as any).symbolToTokenMap.set("HDFCBANK-EQ", "1333");

      const token = service.getToken("HDFCBANK");
      assert.equal(token, "1333");
    });

    it("should return null when symbol not found", () => {
      (service as any).isLoaded = true;

      const token = service.getToken("NONEXISTENT", "NSE");
      assert.equal(token, null);
    });
  });

  describe("getInstrument", () => {
    it("should return null when not loaded", () => {
      assert.equal(service.getInstrument("RELIANCE", "NSE"), null);
    });

    it("should return instrument by exchange:symbol key", () => {
      const instrument = { token: "2885", symbol: "RELIANCE-EQ", name: "Reliance Industries", expiry: "", strike: "0", lotsize: "1", instrumenttype: "", exch_seg: "NSE", tick_size: "0.05" };
      (service as any).isLoaded = true;
      (service as any).instruments.set("NSE:RELIANCE-EQ", instrument);

      const result = service.getInstrument("RELIANCE-EQ", "NSE");
      assert.deepEqual(result, instrument);
    });
  });

  describe("isReady", () => {
    it("should return false when not loaded", () => {
      assert.equal(service.isReady(), false);
    });

    it("should return true when loaded", () => {
      (service as any).isLoaded = true;
      assert.equal(service.isReady(), true);
    });
  });

  describe("getInstrumentCount", () => {
    it("should return 0 when empty", () => {
      assert.equal(service.getInstrumentCount(), 0);
    });

    it("should return correct count when populated", () => {
      (service as any).isLoaded = true;
      (service as any).instruments.set("NSE:A", { token: "1" });
      (service as any).instruments.set("NSE:B", { token: "2" });
      (service as any).instruments.set("BSE:C", { token: "3" });

      assert.equal(service.getInstrumentCount(), 3);
    });
  });

  describe("searchInstruments", () => {
    it("should return empty array when not loaded", () => {
      const results = service.searchInstruments("RELIANCE");
      assert.deepEqual(results, []);
    });

    it("should find instruments by symbol pattern", () => {
      (service as any).isLoaded = true;
      const reliance = { token: "2885", symbol: "RELIANCE-EQ", name: "Reliance Industries", exch_seg: "NSE" };
      const tcs = { token: "11536", symbol: "TCS-EQ", name: "Tata Consultancy Services", exch_seg: "NSE" };
      (service as any).instruments.set("NSE:RELIANCE-EQ", reliance);
      (service as any).instruments.set("NSE:TCS-EQ", tcs);

      const results = service.searchInstruments("RELI", 10);
      assert.equal(results.length, 1);
      assert.equal(results[0].symbol, "RELIANCE-EQ");
    });

    it("should find instruments by name pattern", () => {
      (service as any).isLoaded = true;
      const reliance = { token: "2885", symbol: "RELIANCE-EQ", name: "Reliance Industries", exch_seg: "NSE" };
      (service as any).instruments.set("NSE:RELIANCE-EQ", reliance);

      const results = service.searchInstruments("Tata", 10);
      assert.equal(results.length, 0);

      const results2 = service.searchInstruments("Reliance", 10);
      assert.equal(results2.length, 1);
    });

    it("should respect the limit parameter", () => {
      (service as any).isLoaded = true;
      for (let i = 1; i <= 5; i++) {
        (service as any).instruments.set(`NSE:A${i}`, { symbol: `A${i}`, name: "Test" });
      }

      const results = service.searchInstruments("A", 3);
      assert.equal(results.length, 3);
    });
  });
});
