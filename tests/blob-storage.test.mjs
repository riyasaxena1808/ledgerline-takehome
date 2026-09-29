import assert from "node:assert/strict";
import test from "node:test";

import { deleteCsvBlob, saveCsvBlob } from "../node_modules/.cache/ledgerline-tests/blob-storage.js";

test("CSV blob persistence is optional for the database-only local development setup", async () => {
  delete process.env.STORAGE_CONNECTION_STRING;
  delete process.env.STORAGE_CONNECTION_STRING_FILE;
  delete process.env.AZURE_STORAGE_ACCOUNT_URL;
  assert.equal(await saveCsvBlob("imports/local.csv", "example"), false);
  await assert.doesNotReject(deleteCsvBlob("imports/local.csv"));
});
