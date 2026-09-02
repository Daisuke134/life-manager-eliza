import { Alpaca, type marketData } from "@alpacahq/alpaca-trade-api";
import {
  readLocalAlpacaApiCredentials,
  type AlpacaLocalAdapterOptions,
} from "./alpaca-local-adapter.js";

export interface AlpacaReadOnlyMarketData {
  readOptionChain(
    request: Omit<marketData.OptionChainRequest, "pageToken">,
  ): Promise<Readonly<Record<string, marketData.OptionSnapshot>>>;
  readCryptoSnapshots(
    symbols: readonly string[],
  ): Promise<Readonly<Record<string, marketData.CryptoSnapshot>>>;
  readStockSnapshots(
    symbols: readonly string[],
  ): Promise<Readonly<Record<string, marketData.StockSnapshot>>>;
}

function symbolList(symbols: readonly string[]): string {
  const normalized = symbols.map((symbol) => symbol.trim()).filter(Boolean);
  if (normalized.length === 0) throw new Error("At least one symbol is required");
  return [...new Set(normalized)].join(",");
}

/**
 * Read-only bulk market-data plane. Orders, positions, and account mutations
 * intentionally remain inaccessible here; the pinned Alpaca CLI owns them.
 */
export function createAlpacaReadOnlyMarketData(
  options: Pick<AlpacaLocalAdapterOptions, "credentialsPath"> = {},
): AlpacaReadOnlyMarketData {
  const credentials = readLocalAlpacaApiCredentials(options);
  const marketDataClient = new Alpaca({ ...credentials, paper: true }).marketData;

  return Object.freeze({
    async readOptionChain(
      request: Omit<marketData.OptionChainRequest, "pageToken">,
    ) {
      return marketDataClient.collectOptionChainBySymbol(request);
    },
    async readCryptoSnapshots(symbols: readonly string[]) {
      const response = await marketDataClient.crypto.cryptoSnapshots({
        loc: "us",
        symbols: symbolList(symbols),
      });
      return response.snapshots;
    },
    async readStockSnapshots(symbols: readonly string[]) {
      return marketDataClient.stocks.stockSnapshots({
        symbols: symbolList(symbols),
      });
    },
  });
}
