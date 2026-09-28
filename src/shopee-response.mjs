const CAPTCHA_ERROR_CODES = new Set([90309999]);
const CAPTCHA_URL_PATTERN = /(?:\/verify\/traffic|captcha|challenge)/i;
const CAPTCHA_TEXT_PATTERN = /(?:captcha\s+(?:required|needed|challenge)|verify\/traffic|verification required|human verification|anti.?crawler|risk.?control)/i;

export function isCaptchaSignal({ status = 0, url = "", bodyText = "", body } = {}) {
  const errorCode = Number(body?.error ?? body?.code ?? body?.errorCode);
  return CAPTCHA_URL_PATTERN.test(url)
    || CAPTCHA_TEXT_PATTERN.test(bodyText)
    || CAPTCHA_ERROR_CODES.has(errorCode)
    || status === 403
    || status === 429;
}

export function summarizeShopeeResponse(body) {
  if (body === null || typeof body !== "object") return { type: typeof body };

  const summary = { keys: Object.keys(body).slice(0, 20) };
  const errorCode = body.error ?? body.code ?? body.errorCode;
  if (["string", "number"].includes(typeof errorCode)) summary.errorCode = errorCode;
  if (Array.isArray(body.errors)) {
    summary.graphqlErrors = body.errors.slice(0, 10).map((error) => ({
      message: typeof error?.message === "string" ? error.message.slice(0, 300) : "Unknown GraphQL error",
      code: error?.extensions?.code,
    }));
  }
  return summary;
}

export function isCaptchaExpiredText(text = "") {
  return /(?:xác minh đã hết thời gian|lỗi hết thời gian|verification (?:has )?expired|challenge expired|timed out)/i
    .test(text);
}
