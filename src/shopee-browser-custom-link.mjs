import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { parseCurl } from "./shopee-custom-link.mjs";
import {
  isCaptchaSignal,
  summarizeShopeeResponse,
} from "./shopee-response.mjs";

export { isCaptchaSignal } from "./shopee-response.mjs";

const CUSTOM_LINK_PAGE = "https://affiliate.shopee.vn/offer/custom_link";
const BATCH_CUSTOM_LINK_PATH = "/api/v3/gql?q=batchCustomLink";
const DEFAULT_PROFILE_DIR = resolve(".shopee-browser-profile");
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CAPTCHA_TIMEOUT_MS = 10 * 60 * 1000;
const CAPTCHA_URL_PATTERN = /(?:\/verify\/traffic|captcha|challenge)/i;

export class CaptchaRequiredError extends Error {
  constructor(message, { simulated = false } = {}) {
    super(message);
    this.name = "CaptchaRequiredError";
    this.simulated = simulated;
  }
}

export function parseBrowserArguments(argv) {
  const options = {
    links: [],
    subIds: [],
    profileDir: process.env.SHOPEE_BROWSER_PROFILE ?? DEFAULT_PROFILE_DIR,
    setup: false,
    debug: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    const requiredValue = () => {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Thiếu giá trị cho ${argument}.`);
      }
      return value;
    };

    if (argument === "--link") {
      options.links.push(requiredValue().trim());
      index += 1;
    } else if (/^--sub-id[1-5]$/.test(argument)) {
      options.subIds[Number(argument.at(-1)) - 1] = requiredValue().trim();
      index += 1;
    } else if (argument === "--profile-dir") {
      options.profileDir = resolve(requiredValue());
      index += 1;
    } else if (argument === "--bootstrap-curl") {
      options.bootstrapCurl = resolve(requiredValue());
      index += 1;
    } else if (argument === "--setup") {
      options.setup = true;
    } else if (argument === "--debug") {
      options.debug = true;
    } else if (argument === "--simulate-captcha") {
      options.simulateCaptcha = true;
    } else if (argument === "--captcha-demo") {
      options.captchaDemo = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Tham số không được hỗ trợ: ${argument}`);
    }
  }

  return options;
}

export function validateBrowserInput(options) {
  if (options.setup || options.captchaDemo) return;
  if (options.links.length === 0) throw new Error("Cần ít nhất một --link.");
  if (options.links.length > 5) throw new Error("Giao diện Shopee chỉ hỗ trợ tối đa 5 link mỗi lần.");

  for (const link of options.links) {
    if (!link) throw new Error("Link không được để trống.");
    let url;
    try {
      url = new URL(link);
    } catch {
      throw new Error(`Link không hợp lệ: ${link}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Chỉ chấp nhận link HTTP(S): ${link}`);
    }
  }

  for (const subId of options.subIds.filter(Boolean)) {
    if (!/^[a-zA-Z0-9]+$/.test(subId)) {
      throw new Error(`Sub ID chỉ được chứa a-z, A-Z và 0-9: ${subId}`);
    }
  }
}

function printHelp() {
  console.log(`Chế độ Chrome bền vững (SDK Shopee tự sinh header mới):

  npm run browser:setup
  npm run browser:custom-link -- --link <url> [--link <url>] [--sub-id1 <value>] ...

Tùy chọn:
  --profile-dir <dir>  Hồ sơ Chrome riêng được tái sử dụng
  --bootstrap-curl <file>
                       Nhập cookie phiên một lần từ Copy as cURL; không nhập chữ ký cũ
  --debug              In metadata request đã che giá trị nhạy cảm
  --simulate-captcha   Tái hiện nhánh chờ CAPTCHA bằng overlay giả, tự đóng sau 2 giây
  --captcha-demo       Chạy riêng bài demo CAPTCHA, không cần đăng nhập và không gọi Shopee
  --setup              Chỉ mở Chrome để đăng nhập/lưu phiên

Biến môi trường:
  SHOPEE_BROWSER_PROFILE  Thư mục profile, mặc định .shopee-browser-profile`);
}

async function findOrCreateAffiliatePage(context) {
  const existing = context.pages().find((page) => page.url().startsWith("https://affiliate.shopee.vn/"));
  return existing ?? context.pages()[0] ?? context.newPage();
}

async function waitForAuthenticatedPage(page) {
  const linkInput = page.locator("textarea.ant-input:not([disabled])").first();

  try {
    await linkInput.waitFor({ state: "visible", timeout: 15_000 });
    return linkInput;
  } catch {
  }

  console.error("Chrome đang chờ bạn đăng nhập Shopee Affiliate. Script sẽ tiếp tục tự động sau khi trang Custom Link xuất hiện.");
  await linkInput.waitFor({ state: "visible", timeout: LOGIN_TIMEOUT_MS });
  return linkInput;
}

export function redactRequest(request) {
  const headers = request.headers();
  const sensitiveNames = new Set([
    "cookie",
    "csrf-token",
    "x-sap-ri",
    "x-sap-sec",
    "af-ac-enc-dat",
    "af-ac-enc-sz-token",
  ]);

  return {
    method: request.method(),
    url: request.url(),
    headers: Object.fromEntries(
      Object.entries(headers)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, sensitiveNames.has(name.toLowerCase()) ? "<redacted>" : value]),
    ),
  };
}

export function parseCookieHeader(cookieHeader) {
  if (!cookieHeader) return [];

  const cookies = new Map();
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }

  return [...cookies].map(([name, value]) => ({
    name,
    value,
    url: "https://affiliate.shopee.vn/",
    secure: true,
  }));
}

async function bootstrapCookiesFromCurl(context, curlFile) {
  const parsed = parseCurl(await readFile(curlFile, "utf8"));
  if (new URL(parsed.url).origin !== "https://affiliate.shopee.vn") {
    throw new Error("Từ chối nhập cookie: cURL không thuộc affiliate.shopee.vn.");
  }

  const cookies = parseCookieHeader(parsed.headers.cookie);
  if (cookies.length === 0) throw new Error("cURL không có cookie để nhập vào Chrome profile.");
  await context.addCookies(cookies);
  console.error(`Đã nhập ${cookies.length} cookie vào Chrome profile; các header anti-bot cũ đã được bỏ qua.`);
}

async function restoreSessionCookies(context, profileDir) {
  const stateFile = join(profileDir, "storage-state.json");
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    if (cookies.length > 0) await context.addCookies(cookies);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Không đọc được trạng thái Chrome đã lưu: ${error.message}`);
    }
  }
}

async function closeResultModalIfPresent(page) {
  const closeButton = page.locator("button.ant-modal-close").first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
  }
}

async function showCaptchaSimulation(page) {
  await page.evaluate(() => {
    document.querySelector("#__shopee_captcha_simulation__")?.remove();
    window.__shopeeCaptchaSimulationResolved = false;

    const overlay = document.createElement("div");
    overlay.id = "__shopee_captcha_simulation__";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Mô phỏng CAPTCHA");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:grid",
      "place-items:center",
      "background:rgba(0,0,0,.72)",
      "color:#111",
      "font-family:Arial,sans-serif",
    ].join(";");
    overlay.innerHTML = `
      <div style="width:min(520px,90vw);padding:32px;border-radius:16px;background:white;box-shadow:0 20px 60px rgba(0,0,0,.35)">
        <h2 style="margin:0 0 12px">Mô phỏng CAPTCHA</h2>
        <p style="margin:0">Đây không phải CAPTCHA thật. Script đang kiểm tra cơ chế dừng, chờ xác minh và tiếp tục.</p>
        <p style="margin:16px 0 0;color:#666">Mô phỏng sẽ tự hoàn tất sau 2 giây.</p>
      </div>`;
    document.body.append(overlay);

    setTimeout(() => {
      overlay.remove();
      window.__shopeeCaptchaSimulationResolved = true;
    }, 2_000);
  });
}

export async function waitForCaptchaResolution(page, { simulated = false } = {}) {
  await page.bringToFront();

  if (simulated) {
    console.error("[CAPTCHA mô phỏng] Đã phát hiện. Đang kiểm tra cơ chế chờ xác minh...");
    await page.waitForFunction(
      () => window.__shopeeCaptchaSimulationResolved === true,
      undefined,
      { timeout: 15_000 },
    );
    console.error("[CAPTCHA mô phỏng] Đã hoàn tất; tiếp tục request.");
    return;
  }

  console.error(
    "Shopee yêu cầu CAPTCHA/xác minh. Hãy hoàn tất thủ công trong cửa sổ Chrome; "
    + "script sẽ tự tiếp tục khi trang xác minh đóng. Không đóng cửa sổ Chrome.",
  );

  const verificationStateHandle = await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText ?? "";
      if (/(?:xác minh đã hết thời gian|lỗi hết thời gian|verification (?:has )?expired|challenge expired|timed out)/i.test(bodyText)) {
        return "expired";
      }
      const captchaUrl = /(?:\/verify\/traffic|captcha|challenge)/i.test(location.href);
      const candidates = document.querySelectorAll(
        'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [data-testid*="captcha" i]',
      );
      const visibleCaptcha = [...candidates].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      return !captchaUrl && !visibleCaptcha ? "resolved" : false;
    },
    undefined,
    { timeout: CAPTCHA_TIMEOUT_MS },
  );
  const verificationState = await verificationStateHandle.jsonValue();
  if (verificationState === "expired") {
    throw new Error(
      "CAPTCHA đã hết thời gian. Hãy quay lại trang Custom Link và chạy lại lệnh để nhận thử thách mới.",
    );
  }

  if (!page.url().startsWith(CUSTOM_LINK_PAGE)) {
    await page.goto(CUSTOM_LINK_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  console.error("Xác minh đã hoàn tất; trang được tải lại để SDK sinh chữ ký mới.");
}

export async function submitCustomLinks(page, linkInput, options) {
  await closeResultModalIfPresent(page);
  await linkInput.fill(options.links.join("\n"));

  for (let index = 0; index < 5; index += 1) {
    const subIdInput = page.locator(`#customLink_sub_id${index + 1}`);
    await subIdInput.fill(options.subIds[index] ?? "");
  }

  let capturedRequest;
  const requestListener = (request) => {
    if (request.url().includes(BATCH_CUSTOM_LINK_PATH)) capturedRequest = request;
  };
  page.on("request", requestListener);

  try {
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(BATCH_CUSTOM_LINK_PATH),
      { timeout: options.responseTimeoutMs ?? 60_000 },
    );

    await page.getByRole("button", { name: "Lấy link", exact: true }).click();
    let response;
    try {
      response = await responsePromise;
    } catch (error) {
      if (CAPTCHA_URL_PATTERN.test(page.url())) {
        throw new CaptchaRequiredError("Shopee chuyển sang trang xác minh trước khi API phản hồi.");
      }
      throw new Error(
        `Không nhận được response batchCustomLink trong ${options.responseTimeoutMs ?? 60_000}ms. `
        + "Giao diện hoặc API Shopee có thể đã thay đổi.",
        { cause: error },
      );
    }

    if (options.debug && capturedRequest) {
      console.error(JSON.stringify(redactRequest(capturedRequest), null, 2));
    }

    const contentType = response.headers()["content-type"] ?? "";
    let responseText;
    try {
      responseText = await response.text();
    } catch (error) {
      if (CAPTCHA_URL_PATTERN.test(page.url()) || response.status() === 403 || response.status() === 429) {
        throw new CaptchaRequiredError(`Shopee yêu cầu xác minh (HTTP ${response.status()}).`);
      }
      throw error;
    }
    let parsedResponseBody;
    if (contentType.includes("application/json")) {
      try {
        parsedResponseBody = JSON.parse(responseText);
      } catch {
        // Báo lỗi JSON cụ thể ở nhánh dưới nếu đây không phải CAPTCHA.
      }
    }

    if (isCaptchaSignal({
      status: response.status(),
      url: `${response.url()} ${page.url()}`,
      bodyText: responseText,
      body: parsedResponseBody,
    })) {
      const summary = summarizeShopeeResponse(parsedResponseBody);
      throw new CaptchaRequiredError(
        `Shopee yêu cầu xác minh (HTTP ${response.status()}${summary.errorCode ? `, mã ${summary.errorCode}` : ""}).`,
      );
    }

    if (!contentType.includes("application/json")) {
      throw new Error(`Shopee trả về HTTP ${response.status()} không phải JSON: ${responseText.slice(0, 300)}`);
    }

    const responseBody = parsedResponseBody;
    if (responseBody === undefined) {
      throw new Error(`Shopee trả về JSON không hợp lệ: ${responseText.slice(0, 300)}`);
    }
    if (!response.ok()) {
      throw new Error(
        `Shopee trả về HTTP ${response.status()}: ${JSON.stringify(summarizeShopeeResponse(responseBody))}`,
      );
    }
    if (responseBody.errors?.length) {
      throw new Error(`GraphQL lỗi: ${JSON.stringify(summarizeShopeeResponse(responseBody).graphqlErrors)}`);
    }

    const results = responseBody?.data?.batchCustomLink;
    if (!Array.isArray(results)) {
      throw new Error(
        `Phản hồi không có data.batchCustomLink: ${JSON.stringify(summarizeShopeeResponse(responseBody))}`,
      );
    }
    return results;
  } finally {
    page.off("request", requestListener);
  }
}

export async function submitWithCaptchaRecovery(page, linkInput, options) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (options.simulateCaptcha && attempt === 0) {
        await showCaptchaSimulation(page);
        throw new CaptchaRequiredError("CAPTCHA mô phỏng.", { simulated: true });
      }
      return await submitCustomLinks(page, linkInput, options);
    } catch (error) {
      if (!(error instanceof CaptchaRequiredError) || attempt > 0) throw error;
      await waitForCaptchaResolution(page, { simulated: error.simulated });
      linkInput = await waitForAuthenticatedPage(page);
    }
  }

  throw new Error("Không thể tiếp tục sau bước xác minh.");
}

async function runCaptchaDemo(context) {
  const page = await context.newPage();
  await page.setContent(`<!doctype html>
    <html lang="vi">
      <head><meta charset="utf-8"><title>CAPTCHA handling demo</title></head>
      <body style="font-family:Arial,sans-serif;padding:40px">
        <h1>Kiểm thử xử lý CAPTCHA</h1>
        <p>Trang cục bộ này không gửi dữ liệu và không phải CAPTCHA thật.</p>
      </body>
    </html>`);

  await showCaptchaSimulation(page);
  const detected = await page.locator("#__shopee_captcha_simulation__").isVisible();
  if (!detected) throw new Error("Demo không tạo được trạng thái CAPTCHA mô phỏng.");

  await waitForCaptchaResolution(page, { simulated: true });
  const cleared = !(await page.locator("#__shopee_captcha_simulation__").isVisible().catch(() => false));
  if (!cleared) throw new Error("Demo không thoát khỏi trạng thái chờ CAPTCHA.");

  return {
    captchaDetected: detected,
    pausedForVerification: true,
    resumedAfterVerification: true,
    externalRequestSent: false,
  };
}

export async function runBrowserCustomLink(options) {
  validateBrowserInput(options);
  await mkdir(options.profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(options.profileDir, {
    channel: "chrome",
    headless: false,
    locale: "vi-VN",
    viewport: null,
    args: ["--start-maximized"],
  });

  const stateFile = join(options.profileDir, "storage-state.json");
  try {
    if (options.captchaDemo) return await runCaptchaDemo(context);

    await restoreSessionCookies(context, options.profileDir);
    if (options.bootstrapCurl) {
      await bootstrapCookiesFromCurl(context, options.bootstrapCurl);
    }

    const page = await findOrCreateAffiliatePage(context);
    if (!page.url().startsWith(CUSTOM_LINK_PAGE)) {
      await page.goto(CUSTOM_LINK_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    const linkInput = await waitForAuthenticatedPage(page);
    if (options.setup) {
      console.log(`Đã lưu phiên Shopee Affiliate tại: ${options.profileDir}`);
      return null;
    }

    return await submitWithCaptchaRecovery(page, linkInput, options);
  } finally {
    // Chrome thường xóa session cookie khi đóng sạch. storageState giữ chúng trong
    // profile riêng để lần chạy kế tiếp tiếp tục phiên và để Shopee tự refresh.
    await context.storageState({ path: stateFile }).catch(() => {});
    await context.close();
  }
}

async function main() {
  const options = parseBrowserArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const results = await runBrowserCustomLink(options);
  if (results) console.log(JSON.stringify(results, null, 2));
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Lỗi: ${error.message}`);
    process.exitCode = 1;
  });
}
