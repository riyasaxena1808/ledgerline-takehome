import { readFile } from "node:fs/promises";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

let serviceClient: BlobServiceClient | null | undefined;
const containerName = process.env.BLOB_CONTAINER_NAME ?? "ledgerline-csv";

async function getServiceClient(): Promise<BlobServiceClient | null> {
  if (serviceClient !== undefined) return serviceClient;
  const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  if (accountUrl) {
    serviceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
    return serviceClient;
  }
  const configuredConnectionString = process.env.STORAGE_CONNECTION_STRING;
  const filePath = process.env.STORAGE_CONNECTION_STRING_FILE;
  const connectionString = configuredConnectionString || (filePath ? (await readFile(filePath, "utf8")).trim() : "");
  serviceClient = connectionString ? BlobServiceClient.fromConnectionString(connectionString) : null;
  return serviceClient;
}

async function getContainer() {
  const client = await getServiceClient();
  if (!client) return null;
  const container = client.getContainerClient(containerName);
  await container.createIfNotExists();
  return container;
}

export async function saveCsvBlob(key: string, bytes: Buffer | string): Promise<boolean> {
  const container = await getContainer();
  if (!container) return false;
  await container.getBlockBlobClient(key).uploadData(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), {
    blobHTTPHeaders: { blobContentType: "text/csv; charset=utf-8" },
  });
  return true;
}

export async function deleteCsvBlob(key: string): Promise<void> {
  try {
    const container = await getContainer();
    if (container) await container.deleteBlob(key, { deleteSnapshots: "include" });
  } catch {
    // Blob cleanup is best effort; a later lifecycle policy can remove orphans.
  }
}
