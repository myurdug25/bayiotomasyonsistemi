const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

export async function postCampaignSync({
  endpoint,
  apiKey,
  campaigns,
  timeoutMs,
  fetchImpl = fetch,
  sleepImpl = sleep,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  onRetry = () => {},
}) {
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(apiKey ? { "X-Integration-Key": apiKey } : {}),
      },
      body: JSON.stringify({ campaigns }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      return response.json();
    }

    const body = await response.text().catch(() => "(body okunamadı)");
    lastFailure = new Error(
      `API yanıtı başarısız: HTTP ${response.status} — ${body}`
    );

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      throw lastFailure;
    }

    const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
    const exponentialDelayMs = Math.min(
      maxDelayMs,
      baseDelayMs * 2 ** (attempt - 1)
    );
    const delayMs = retryAfterMs ?? exponentialDelayMs;

    onRetry({ attempt, maxAttempts, delayMs, status: response.status });
    await sleepImpl(delayMs);
  }

  throw lastFailure ?? new Error("Kampanya senkron isteği tamamlanamadı.");
}

function parseRetryAfterMs(value) {
  const normalized = String(value ?? "").trim();
  if (normalized === "") return null;

  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(DEFAULT_MAX_DELAY_MS, Math.ceil(seconds * 1_000));
  }

  const dateMs = Date.parse(normalized);
  if (Number.isNaN(dateMs)) return null;

  return Math.min(DEFAULT_MAX_DELAY_MS, Math.max(0, dateMs - Date.now()));
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
