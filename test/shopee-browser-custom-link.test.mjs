import test from "node:test";
import assert from "node:assert/strict";

import {
  isCaptchaSignal,
  parseBrowserArguments,
  parseCookieHeader,
  redactRequest,
  validateBrowserInput,
} from "../src/shopee-browser-custom-link.mjs";

test("parseBrowserArguments đọc link, Sub ID và profile", () => {
  const options = parseBrowserArguments([
    "--link", "https://s.shopee.vn/one",
    "--link", "https://shopee.vn/two",
    "--sub-id1", "facebook",
    "--sub-id3", "post42",
    "--profile-dir", "./tmp-profile",
    "--debug",
    "--simulate-captcha",
    "--captcha-demo",
  ]);

  assert.deepEqual(options.links, ["https://s.shopee.vn/one", "https://shopee.vn/two"]);
  assert.equal(options.subIds[0], "facebook");
  assert.equal(options.subIds[1], undefined);
  assert.equal(options.subIds[2], "post42");
  assert.match(options.profileDir, /tmp-profile$/);
  assert.equal(options.debug, true);
  assert.equal(options.simulateCaptcha, true);
  assert.equal(options.captchaDemo, true);
});

test("parseBrowserArguments trim giá trị và báo flag thiếu value", () => {
  const options = parseBrowserArguments([
    "--link", "  https://shopee.vn/trimmed  ",
    "--sub-id1", "  Campaign01  ",
  ]);
  assert.deepEqual(options.links, ["https://shopee.vn/trimmed"]);
  assert.equal(options.subIds[0], "Campaign01");
  assert.throws(() => parseBrowserArguments(["--link", "--debug"]), /Thiếu giá trị cho --link/);
  assert.throws(() => parseBrowserArguments(["--profile-dir"]), /Thiếu giá trị cho --profile-dir/);
});

test("isCaptchaSignal nhận diện route, response và rate limit xác minh", () => {
  assert.equal(isCaptchaSignal({ url: "https://affiliate.shopee.vn/verify/traffic" }), true);
  assert.equal(isCaptchaSignal({ status: 403, bodyText: '{"error":"captcha required"}' }), true);
  assert.equal(isCaptchaSignal({ status: 429, bodyText: "too many requests" }), true);
  assert.equal(isCaptchaSignal({ status: 200, bodyText: '{"data":{"batchCustomLink":[]}}' }), false);
  assert.equal(
    isCaptchaSignal({ status: 200, bodyText: '{"longLink":"https://shopee.vn/captcha-product"}' }),
    false,
  );
});

test("parseCookieHeader giữ dấu bằng trong value và loại cookie trùng", () => {
  assert.deepEqual(parseCookieHeader("a=one; token=abc==; a=latest"), [
    { name: "a", value: "latest", url: "https://affiliate.shopee.vn/", secure: true },
    { name: "token", value: "abc==", url: "https://affiliate.shopee.vn/", secure: true },
  ]);
});

test("redactRequest che toàn bộ cookie, CSRF và chữ ký anti-bot", () => {
  const redacted = redactRequest({
    method: () => "POST",
    url: () => "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink",
    headers: () => ({
      cookie: "SPC_ST=secret",
      "csrf-token": "csrf-secret",
      "x-sap-ri": "ri-secret",
      "x-sap-sec": "sec-secret",
      "af-ac-enc-dat": "dat-secret",
      "af-ac-enc-sz-token": "sz-secret",
      "content-type": "application/json",
    }),
  });

  for (const name of [
    "cookie", "csrf-token", "x-sap-ri", "x-sap-sec", "af-ac-enc-dat", "af-ac-enc-sz-token",
  ]) {
    assert.equal(redacted.headers[name], "<redacted>");
  }
  assert.equal(redacted.headers["content-type"], "application/json");
  assert.doesNotMatch(JSON.stringify(redacted), /secret/);
});

test("validateBrowserInput chặn quá 5 link và Sub ID sai định dạng", () => {
  assert.throws(
    () => validateBrowserInput({ links: [], subIds: [], setup: false }),
    /ít nhất một --link/,
  );
  assert.throws(
    () => validateBrowserInput({ links: [""], subIds: [], setup: false }),
    /không được để trống/,
  );
  assert.throws(
    () => validateBrowserInput({ links: Array(6).fill("https://shopee.vn/a"), subIds: [], setup: false }),
    /tối đa 5 link/,
  );
  assert.throws(
    () => validateBrowserInput({ links: ["https://shopee.vn/a"], subIds: ["has-dash"], setup: false }),
    /chỉ được chứa/,
  );
  assert.throws(
    () => validateBrowserInput({ links: ["ftp://shopee.vn/a"], subIds: [], setup: false }),
    /HTTP\(S\)/,
  );
  assert.throws(
    () => validateBrowserInput({ links: ["not a url"], subIds: [], setup: false }),
    /không hợp lệ/,
  );
  assert.doesNotThrow(() => validateBrowserInput({
    links: Array(5).fill("https://shopee.vn/a"),
    subIds: ["aZ019"],
    setup: false,
  }));
});
