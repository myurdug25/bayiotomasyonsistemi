export async function sendLedgerRecords(records, options) {
  const batchSize = positiveInteger(options.batchSize, 1000);
  let sent = 0;

  for (let index = 0; index < records.length; index += batchSize) {
    const chunk = records.slice(index, index + batchSize);
    sent += await sendBatchWithSplit(chunk, options);
  }

  return sent;
}

async function sendBatchWithSplit(records, options) {
  try {
    await sendBatchWithRetry(records, options);
    return records.length;
  } catch (error) {
    if (!isRetryableError(error) || records.length <= positiveInteger(options.minBatchSize, 1)) {
      throw error;
    }

    const midpoint = Math.ceil(records.length / 2);
    options.log?.(
      `[eryaz-ledger-sync] splitting retryable batch size=${records.length} into ${midpoint}+${records.length - midpoint}: ${error.message}`
    );

    const left = await sendBatchWithSplit(records.slice(0, midpoint), options);
    const right = await sendBatchWithSplit(records.slice(midpoint), options);
    return left + right;
  }
}

async function sendBatchWithRetry(records, options) {
  const retryMax = nonNegativeInteger(options.retryMax, 2);
  const retryBaseDelayMs = positiveInteger(options.retryBaseDelayMs, 2000);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await postBatch(records, options);
      return;
    } catch (error) {
      if (!isRetryableError(error) || attempt >= retryMax) {
        throw error;
      }

      const delayMs = retryBaseDelayMs * 2 ** attempt;
      options.log?.(
        `[eryaz-ledger-sync] retrying batch size=${records.length} status=${error.httpStatus ?? "n/a"} retry=${attempt + 1}/${retryMax} delay_ms=${delayMs}`
      );
      await (options.sleep ?? sleep)(delayMs);
    }
  }
}

async function postBatch(records, options) {
  if (records.length === 0) return;

  const response = await (options.fetchImpl ?? fetch)(options.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-integration-key": options.key,
    },
    body: JSON.stringify({
      dealer_id: options.dealerId,
      dealer_code: options.dealerCode,
      records,
    }),
  });

  if (!response.ok) {
    const error = new Error(`endpoint returned ${response.status}: ${await response.text()}`);
    error.httpStatus = response.status;
    throw error;
  }
}

function isRetryableError(error) {
  const status = Number(error?.httpStatus);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;

  const codes = [
    String(error?.code ?? "").toUpperCase(),
    String(error?.cause?.code ?? "").toUpperCase(),
  ].filter(Boolean);

  if (codes.some((code) => (
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(code)
      || code.startsWith("UND_ERR_")
  ))) {
    return true;
  }

  return String(error?.message ?? "").toLowerCase().includes("fetch failed");
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
