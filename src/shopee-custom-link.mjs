import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { isCaptchaSignal, summarizeShopeeResponse } from "./shopee-response.mjs";

const ENDPOINT = "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink";

export const QUERY = `
    query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){
      batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){
        shortLink
        longLink
        failCode
      }
    }
    `;

function decodeAnsiCQuoted(value) {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const next = value[++index];
    if (next === undefined) {
      decoded += "\\";
      break;
    }

    const simpleEscapes = {
      "\\": "\\",
      "'": "'",
      '"': '"',
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
    };

    if (Object.hasOwn(simpleEscapes, next)) {
      decoded += simpleEscapes[next];
      continue;
    }

    if (next === "u" || next === "U") {
      const length = next === "u" ? 4 : 8;
      const hexadecimal = value.slice(index + 1, index + 1 + length);
      if (new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hexadecimal)) {
        decoded += String.fromCodePoint(Number.parseInt(hexadecimal, 16));
        index += length;
        continue;
      }
    }

    decoded += `\\${next}`;
  }

  return decoded;
}

export function parseCurl(curlText) {
  const urlMatch = curlText.match(/--url\s+'([^']+)'/);
  const url = urlMatch?.[1] ?? curlText.match(/curl\s+'([^']+)'/)?.[1];
  if (!url) throw new Error("Không tìm thấy URL trong nội dung cURL.");

  const headers = {};
  for (const match of curlText.matchAll(/(?:^|\n)\s*-H\s+'([^']*)'/g)) {
    const separator = match[1].indexOf(":");
    if (separator < 1) continue;
    const name = match[1].slice(0, separator).trim().toLowerCase();
    const value = match[1].slice(separator + 1).trim();
    headers[name] = value;
  }

  const cookie = curlText.match(/(?:^|\n)\s*-b\s+'([^']*)'/)?.[1];
  if (cookie) headers.cookie = cookie;

  const bodyMatch = curlText.match(/--data(?:-raw)?\s+(\$)?'([\s\S]*)'\s*$/);
  if (!bodyMatch) throw new Error("Không tìm thấy --data-raw trong nội dung cURL.");
  const bodyText = bodyMatch[1] ? decodeAnsiCQuoted(bodyMatch[2]) : bodyMatch[2];

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`Payload trong cURL không phải JSON hợp lệ: ${error.message}`);
  }

  return { url, headers, body };
}

export function createPayload(links, subIds = []) {
  const advancedLinkParams = Object.fromEntries(
    subIds
      .map((value, index) => [index + 1, value])
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([index, value]) => [`subId${index}`, value]),
  );

  return {
    operationName: "batchGetCustomLink",
    query: QUERY,
    variables: {
      linkParams: links.map((originalLink) => ({
        originalLink,
        advancedLinkParams,
      })),
      sourceCaller: "CUSTOM_LINK_CALLER",
    },
  };
}

export function parseArguments(argv) {
  const options = { links: [], subIds: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    const requiredValue = () => {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Thiếu giá trị cho ${argument}.`);
      }
      return value;
    };

    if (argument === "--curl-file") {
      options.curlFile = requiredValue();
      index += 1;
    } else if (argument === "--link") {
      options.links.push(requiredValue().trim());
      index += 1;
    } else if (/^--sub-id[1-5]$/.test(argument)) {
      const subIdIndex = Number(argument.at(-1)) - 1;
      options.subIds[subIdIndex] = requiredValue().trim();
      index += 1;
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

function printHelp() {
  console.log(`Cách dùng:
  node src/shopee-custom-link.mjs --curl-file <file> --link <url> [--link <url>] [--sub-id1 <value>] ... [--debug]

Biến môi trường thay thế:
  SHOPEE_CURL_FILE   Đường dẫn file Copy as cURL

Ví dụ:
  npm run custom-link -- --curl-file .shopee-request.curl.txt --link https://s.shopee.vn/3B7gM2EwwS`);
}

export function validateReplay(parsed) {
  if (new URL(parsed.url).origin !== "https://affiliate.shopee.vn") {
    throw new Error("Từ chối gửi cookie: URL cURL không thuộc affiliate.shopee.vn.");
  }
  if (!parsed.url.includes("/api/v3/gql?q=batchCustomLink")) {
    throw new Error("cURL không phải request batchCustomLink dự kiến.");
  }

  const required = ["cookie", "csrf-token", "x-sap-ri", "x-sap-sec"];
  const missing = required.filter((name) => !parsed.headers[name]);
  if (missing.length > 0) {
    throw new Error(`cURL thiếu header phiên: ${missing.join(", ")}. Hãy Copy as cURL lại từ DevTools.`);
  }
}

export async function replayCustomLink({ curlFile, links, subIds = [], debug = false, fetchImpl = fetch }) {
  const parsed = parseCurl(await readFile(curlFile, "utf8"));
  validateReplay(parsed);

  const headers = { ...parsed.headers };
  for (const forbidden of ["content-length", "host", "connection"]) delete headers[forbidden];

  // Node/undici tự quản lý các header này. Các sec-* chỉ là browser client hints,
  // không phải phần xác thực cốt lõi, nhưng vẫn được giữ nếu fetch cho phép.
  const payload = createPayload(links, subIds);

  if (debug) {
    console.error(
      JSON.stringify(
        {
          endpoint: ENDPOINT,
          headerNames: Object.keys(headers).sort(),
          linkCount: links.length,
          // Không in giá trị cookie, CSRF hoặc chữ ký.
        },
        null,
        2,
      ),
    );
  }

  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    redirect: "manual",
  });

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    throw new Error(`Shopee trả về HTTP ${response.status}, không phải JSON: ${responseText.slice(0, 300)}`);
  }

  if (isCaptchaSignal({
    status: response.status,
    url: response.url,
    bodyText: responseText,
    body: responseBody,
  })) {
    const summary = summarizeShopeeResponse(responseBody);
    throw new Error(
      `Shopee yêu cầu CAPTCHA/xác minh${summary.errorCode ? ` (mã ${summary.errorCode})` : ""}. `
      + "Hãy dùng browser mode để Chrome tạo chữ ký mới và xử lý xác minh thủ công.",
    );
  }

  if (!response.ok) {
    throw new Error(`Shopee trả về HTTP ${response.status}: ${JSON.stringify(summarizeShopeeResponse(responseBody))}`);
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
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const curlFile = options.curlFile ?? process.env.SHOPEE_CURL_FILE;
  if (!curlFile) throw new Error("Thiếu --curl-file hoặc SHOPEE_CURL_FILE.");
  if (options.links.length === 0) throw new Error("Cần ít nhất một --link.");

  const results = await replayCustomLink({ ...options, curlFile });
  console.log(JSON.stringify(results, null, 2));
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Lỗi: ${error.message}`);
    process.exitCode = 1;
  });
}
