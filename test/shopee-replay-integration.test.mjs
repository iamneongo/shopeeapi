import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { replayCustomLink } from "../src/shopee-custom-link.mjs";

const ENDPOINT = "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink";

function buildCurl({
  url = ENDPOINT,
  includeCookie = true,
  includeCsrf = true,
  includeSapRi = true,
  includeSapSec = true,
} = {}) {
  const lines = [`curl --url '${url}' \\`, "  -H 'content-type: application/json' \\"];
  if (includeCsrf) lines.push("  -H 'csrf-token: test-csrf' \\");
  if (includeSapRi) lines.push("  -H 'x-sap-ri: test-ri' \\");
  if (includeSapSec) lines.push("  -H 'x-sap-sec: test-sec' \\");
  if (includeCookie) lines.push("  -b 'SPC_ST=test-session; csrftoken=test-cookie' \\");
  lines.push(`  --data-raw $'{"operationName":"batchGetCustomLink","variables":{"linkParams":[]}}'`);
  return lines.join("\n");
}

async function withCurlFile(curlText, callback) {
  const directory = await mkdtemp(join(tmpdir(), "shopee-replay-test-"));
  const file = join(directory, "request.curl.txt");
  try {
    await writeFile(file, curlText, "utf8");
    return await callback(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function response(body, { status = 200, contentType = "application/json" } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

test("cURL replay: thay payload cũ bằng batch và Sub ID mới", async () => {
  const calls = [];
  const links = ["https://shopee.vn/one", "https://shopee.vn/two"];
  const results = await withCurlFile(buildCurl(), (curlFile) => replayCustomLink({
    curlFile,
    links,
    subIds: ["facebook", "post42"],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        data: {
          batchCustomLink: links.map((link, index) => ({
            shortLink: `https://s.shopee.vn/replay${index}`,
            longLink: link,
            failCode: 0,
          })),
        },
      });
    },
  }));

  assert.equal(results.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.cookie, "SPC_ST=test-session; csrftoken=test-cookie");
  const sentBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(sentBody.variables.linkParams[1], {
    originalLink: links[1],
    advancedLinkParams: { subId1: "facebook", subId2: "post42" },
  });
});

test("cURL replay: chặn sai origin và endpoint trước khi truyền cookie", async (t) => {
  for (const [name, url, pattern] of [
    ["origin", "https://evil.example/api/v3/gql?q=batchCustomLink", /không thuộc affiliate\.shopee\.vn/],
    ["endpoint", "https://affiliate.shopee.vn/api/v3/gql?q=other", /không phải request batchCustomLink/],
  ]) {
    await t.test(name, async () => {
      let fetchCalled = false;
      await assert.rejects(
        () => withCurlFile(buildCurl({ url }), (curlFile) => replayCustomLink({
          curlFile,
          links: ["https://shopee.vn/one"],
          fetchImpl: async () => {
            fetchCalled = true;
            return response({});
          },
        })),
        pattern,
      );
      assert.equal(fetchCalled, false);
    });
  }
});

test("cURL replay: báo đủ header phiên bị thiếu", async () => {
  await assert.rejects(
    () => withCurlFile(
      buildCurl({ includeCookie: false, includeCsrf: false, includeSapRi: false, includeSapSec: false }),
      (curlFile) => replayCustomLink({ curlFile, links: ["https://shopee.vn/one"] }),
    ),
    /cookie, csrf-token, x-sap-ri, x-sap-sec/,
  );
});

test("cURL replay: anti-crawler 90309999 không làm lộ token", async () => {
  await assert.rejects(
    () => withCurlFile(buildCurl(), (curlFile) => replayCustomLink({
      curlFile,
      links: ["https://shopee.vn/one"],
      fetchImpl: async () => response({
        0: 3,
        6: { token: "must-not-leak" },
        error: 90309999,
      }),
    })),
    (error) => {
      assert.match(error.message, /CAPTCHA\/xác minh.*90309999/);
      assert.doesNotMatch(error.message, /must-not-leak/);
      return true;
    },
  );
});

test("cURL replay: xử lý non-JSON, GraphQL error và sai schema", async (t) => {
  const cases = [
    ["non-json", response("<h1>Bad gateway</h1>", { status: 502, contentType: "text/html" }), /không phải JSON/],
    ["graphql", response({ errors: [{ message: "invalid link" }] }), /GraphQL lỗi.*invalid link/],
    ["schema", response({ data: {} }), /không có data\.batchCustomLink/],
  ];

  for (const [name, fakeResponse, pattern] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () => withCurlFile(buildCurl(), (curlFile) => replayCustomLink({
          curlFile,
          links: ["https://shopee.vn/one"],
          fetchImpl: async () => fakeResponse,
        })),
        pattern,
      );
    });
  }
});

