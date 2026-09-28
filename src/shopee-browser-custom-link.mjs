import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { parseCurl } from "./shopee-custom-link.mjs";

const CUSTOM_LINK_PAGE = "https://affiliate.shopee.vn/offer/custom_link";
const BATCH_CUSTOM_LINK_PATH = "/api/v3/gql?q=batchCustomLink";
const DEFAULT_PROFILE_DIR = resolve(".shopee-browser-profile");
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

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

    if (argument === "--link") {
      options.links.push(value);
      index += 1;
    } else if (/^--sub-id[1-5]$/.test(argument)) {
      options.subIds[Number(argument.at(-1)) - 1] = value;
      index += 1;
    } else if (argument === "--profile-dir") {
      options.profileDir = resolve(value);
      index += 1;
    } else if (argument === "--bootstrap-curl") {
      options.bootstrapCurl = resolve(value);
      index += 1;
    } else if (argument === "--setup") {
      options.setup = true;
    } else if (argument === "--debug") {
      options.debug = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Tham số không được hỗ trợ: ${argument}`);
    }
  }

  return options;
}

export function validateBrowserInput(options) {
  if (options.setup) return;
  if (options.links.length === 0) throw new Error("Cần ít nhất một --link.");
  if (options.links.length > 5) throw new Error("Giao diện Shopee chỉ hỗ trợ tối đa 5 link mỗi lần.");

  for (const link of options.links) {
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

function redactRequest(request) {
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

async function submitCustomLinks(page, linkInput, options) {
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
      { timeout: 60_000 },
    );

    await page.getByRole("button", { name: "Lấy link", exact: true }).click();
    const response = await responsePromise;

    if (options.debug && capturedRequest) {
      console.error(JSON.stringify(redactRequest(capturedRequest), null, 2));
    }

    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      const responseText = await response.text();
      throw new Error(`Shopee trả về HTTP ${response.status()} không phải JSON: ${responseText.slice(0, 300)}`);
    }

    const responseBody = await response.json();
    if (!response.ok()) {
      throw new Error(`Shopee trả về HTTP ${response.status()}: ${JSON.stringify(responseBody)}`);
    }
    if (responseBody.errors?.length) {
      throw new Error(`GraphQL lỗi: ${JSON.stringify(responseBody.errors)}`);
    }

    const results = responseBody?.data?.batchCustomLink;
    if (!Array.isArray(results)) {
      throw new Error(`Phản hồi không có data.batchCustomLink: ${JSON.stringify(responseBody)}`);
    }
    return results;
  } finally {
    page.off("request", requestListener);
  }
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

    return await submitCustomLinks(page, linkInput, options);
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
