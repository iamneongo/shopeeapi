import test from "node:test";
import assert from "node:assert/strict";

import { createPayload, parseArguments, parseCurl } from "../src/shopee-custom-link.mjs";

test("parseCurl đọc URL, header, cookie và ANSI-C quoted JSON", () => {
  const curl = String.raw`curl --url 'https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink' \
  -H 'content-type: application/json' \
  -H 'x-sap-ri: signature' \
  -b 'session=secret' \
  --data-raw $'{"query":"line 1\\nline 2","value":"\\u0021"}'`;

  assert.deepEqual(parseCurl(curl), {
    url: "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink",
    headers: {
      "content-type": "application/json",
      "x-sap-ri": "signature",
      cookie: "session=secret",
    },
    body: { query: "line 1\nline 2", value: "!" },
  });
});

test("createPayload tạo đúng batch GraphQL và Sub ID", () => {
  const payload = createPayload(
    ["https://s.shopee.vn/one", "https://s.shopee.vn/two"],
    ["campaignA", undefined, "post3"],
  );

  assert.equal(payload.operationName, "batchGetCustomLink");
  assert.equal(payload.variables.sourceCaller, "CUSTOM_LINK_CALLER");
  assert.deepEqual(payload.variables.linkParams, [
    {
      originalLink: "https://s.shopee.vn/one",
      advancedLinkParams: { subId1: "campaignA", subId3: "post3" },
    },
    {
      originalLink: "https://s.shopee.vn/two",
      advancedLinkParams: { subId1: "campaignA", subId3: "post3" },
    },
  ]);
});

test("parseArguments trim input và từ chối flag thiếu value", () => {
  const options = parseArguments([
    "--curl-file", "request.txt",
    "--link", " https://shopee.vn/one ",
    "--sub-id2", " Feed02 ",
  ]);
  assert.deepEqual(options.links, ["https://shopee.vn/one"]);
  assert.equal(options.subIds[1], "Feed02");
  assert.throws(() => parseArguments(["--curl-file", "--link"]), /Thiếu giá trị cho --curl-file/);
  assert.throws(() => parseArguments(["--sub-id1"]), /Thiếu giá trị cho --sub-id1/);
});
