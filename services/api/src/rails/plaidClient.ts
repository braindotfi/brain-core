/**
 * Factory for the live Plaid Transfer client used by AchPlaidRail at boot.
 *
 * Adapts PlaidApi (the official SDK) to the minimal PlaidTransferClient
 * interface the rail depends on. Keeping this in the boot binary means
 * @brain/execution never imports the SDK — it stays unit-testable with a mock.
 *
 * Env: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (default "sandbox").
 */

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import type {
  TransferAuthorizationCreateRequest,
  TransferCreateRequest,
} from "plaid";
import type {
  PlaidTransferClient,
  PlaidAuthorizationResponse,
  PlaidTransferResponse,
} from "@brain/execution";

export function buildPlaidTransferClient(opts: {
  clientId: string;
  secret: string;
  env: "sandbox" | "development" | "production";
}): PlaidTransferClient {
  const api = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[opts.env] ?? "https://sandbox.plaid.com",
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": opts.clientId,
          "PLAID-SECRET": opts.secret,
        },
      },
    }),
  );

  return {
    async transferAuthorizationCreate(req): Promise<PlaidAuthorizationResponse> {
      const res = await api.transferAuthorizationCreate(
        req as unknown as TransferAuthorizationCreateRequest,
      );
      return res.data as unknown as PlaidAuthorizationResponse;
    },
    async transferCreate(req): Promise<PlaidTransferResponse> {
      const res = await api.transferCreate(req as unknown as TransferCreateRequest);
      return res.data as unknown as PlaidTransferResponse;
    },
  };
}
