import test from "node:test";
import assert from "node:assert/strict";

import {
  parseBrowserArguments,
  parseCookieHeader,
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
  ]);

  assert.deepEqual(options.links, ["https://s.shopee.vn/one", "https://shopee.vn/two"]);
  assert.equal(options.subIds[0], "facebook");
  assert.equal(options.subIds[1], undefined);
  assert.equal(options.subIds[2], "post42");
  assert.match(options.profileDir, /tmp-profile$/);
  assert.equal(options.debug, true);
});

test("parseCookieHeader giữ dấu bằng trong value và loại cookie trùng", () => {
  assert.deepEqual(parseCookieHeader("a=one; token=abc==; a=latest"), [
    { name: "a", value: "latest", url: "https://affiliate.shopee.vn/", secure: true },
    { name: "token", value: "abc==", url: "https://affiliate.shopee.vn/", secure: true },
  ]);
});

test("validateBrowserInput chặn quá 5 link và Sub ID sai định dạng", () => {
  assert.throws(
    () => validateBrowserInput({ links: Array(6).fill("https://shopee.vn/a"), subIds: [], setup: false }),
    /tối đa 5 link/,
  );
  assert.throws(
    () => validateBrowserInput({ links: ["https://shopee.vn/a"], subIds: ["has-dash"], setup: false }),
    /chỉ được chứa/,
  );
});
