import test from "node:test";
import assert from "node:assert/strict";

import {
  isCaptchaExpiredText,
  isCaptchaSignal,
  summarizeShopeeResponse,
} from "../src/shopee-response.mjs";

test("nhận diện mã anti-crawler 90309999 mà không phụ thuộc HTTP status", () => {
  assert.equal(isCaptchaSignal({ status: 200, body: { error: 90309999 } }), true);
});

test("tóm tắt response không làm lộ payload/token lồng nhau", () => {
  const summary = summarizeShopeeResponse({
    0: 3,
    6: { token: "secret-value" },
    error: 90309999,
  });
  assert.deepEqual(summary, { keys: ["0", "6", "error"], errorCode: 90309999 });
  assert.doesNotMatch(JSON.stringify(summary), /secret-value/);
});

test("nhận diện CAPTCHA hết thời gian bằng tiếng Việt và tiếng Anh", () => {
  assert.equal(isCaptchaExpiredText("Lỗi hết thời gian\nXác minh đã hết thời gian."), true);
  assert.equal(isCaptchaExpiredText("Verification has expired"), true);
  assert.equal(isCaptchaExpiredText("Please complete verification"), false);
});
