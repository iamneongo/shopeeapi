import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { chromium } from "playwright";

import {
  CaptchaRequiredError,
  submitCustomLinks,
  submitWithCaptchaRecovery,
  waitForCaptchaResolution,
} from "../src/shopee-browser-custom-link.mjs";

const PAGE_URL = "https://affiliate.shopee.vn/offer/custom_link";
const API_URL = "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink";

let browser;

before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  await browser?.close();
});

function fixtureHtml({ showOldModal = false, submitRequest = true } = {}) {
  const modal = showOldModal
    ? '<div id="old-modal"><button type="button" class="ant-modal-close">Đóng</button></div>'
    : "";

  return `<!doctype html>
    <html lang="vi">
      <head><meta charset="utf-8"><title>Shopee fixture</title></head>
      <body>
        ${modal}
        <textarea class="ant-input" placeholder="Link"></textarea>
        <input id="customLink_sub_id1">
        <input id="customLink_sub_id2">
        <input id="customLink_sub_id3">
        <input id="customLink_sub_id4">
        <input id="customLink_sub_id5">
        <button type="button" id="submit">Lấy link</button>
        <script>
          document.querySelector('.ant-modal-close')?.addEventListener('click', () => {
            document.querySelector('#old-modal')?.remove();
          });
          document.querySelector('#submit').addEventListener('click', () => {
            const links = document.querySelector('textarea').value.split('\\n').filter(Boolean);
            const advancedLinkParams = {};
            for (let index = 1; index <= 5; index += 1) {
              const value = document.querySelector('#customLink_sub_id' + index).value;
              if (value) advancedLinkParams['subId' + index] = value;
            }
            ${submitRequest ? "fetch('/api/v3/gql?q=batchCustomLink', {" : "void ({"}
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                operationName: 'batchGetCustomLink',
                variables: {
                  linkParams: links.map((originalLink) => ({ originalLink, advancedLinkParams })),
                  sourceCaller: 'CUSTOM_LINK_CALLER',
                },
              }),
            })${submitRequest ? ".catch(() => {})" : ""};
          });
        </script>
      </body>
    </html>`;
}

function jsonResponse(body, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function createFixture({ responses, showOldModal = false, submitRequest = true } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  let requestIndex = 0;

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();

    if (url === API_URL) {
      requests.push(JSON.parse(request.postData() ?? "{}"));
      const response = typeof responses === "function"
        ? responses(requestIndex++)
        : responses?.[requestIndex++] ?? jsonResponse({ data: { batchCustomLink: [] } });
      await route.fulfill(response);
      return;
    }

    if (url === PAGE_URL) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fixtureHtml({ showOldModal, submitRequest }),
      });
      return;
    }

    await route.abort();
  });

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  const linkInput = page.locator("textarea.ant-input:not([disabled])").first();
  await linkInput.waitFor({ state: "visible" });
  return { context, page, linkInput, requests };
}

function successFor(links) {
  return jsonResponse({
    data: {
      batchCustomLink: links.map((link, index) => ({
        shortLink: `https://s.shopee.vn/mock${index + 1}`,
        longLink: link,
        failCode: 0,
      })),
    },
  });
}

test("browser flow: một link không Sub ID", async () => {
  const input = "https://s.shopee.vn/one";
  const fixture = await createFixture({ responses: [successFor([input])] });
  try {
    const results = await submitCustomLinks(fixture.page, fixture.linkInput, {
      links: [input],
      subIds: [],
      debug: false,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].shortLink, "https://s.shopee.vn/mock1");
    assert.deepEqual(fixture.requests[0].variables.linkParams, [
      { originalLink: input, advancedLinkParams: {} },
    ]);
  } finally {
    await fixture.context.close();
  }
});

test("browser flow: batch tối đa 5 link và đủ 5 Sub ID", async () => {
  const links = Array.from({ length: 5 }, (_, index) => `https://shopee.vn/product-${index + 1}`);
  const fixture = await createFixture({ responses: [successFor(links)] });
  try {
    const results = await submitCustomLinks(fixture.page, fixture.linkInput, {
      links,
      subIds: ["facebook", "feed42", "sale99", "group1", "post5"],
      debug: false,
    });

    assert.equal(results.length, 5);
    assert.deepEqual(fixture.requests[0].variables.linkParams[4], {
      originalLink: links[4],
      advancedLinkParams: {
        subId1: "facebook",
        subId2: "feed42",
        subId3: "sale99",
        subId4: "group1",
        subId5: "post5",
      },
    });
  } finally {
    await fixture.context.close();
  }
});

test("browser flow: đóng modal kết quả cũ trước khi gửi", async () => {
  const input = "https://shopee.vn/old-modal";
  const fixture = await createFixture({ responses: [successFor([input])], showOldModal: true });
  try {
    await submitCustomLinks(fixture.page, fixture.linkInput, {
      links: [input],
      subIds: [],
      debug: false,
    });
    assert.equal(await fixture.page.locator("#old-modal").count(), 0);
  } finally {
    await fixture.context.close();
  }
});

test("browser flow: CAPTCHA lần đầu, reload và retry thành công", async () => {
  const input = "https://shopee.vn/captcha-once";
  const fixture = await createFixture({
    responses: (index) => index === 0
      ? jsonResponse({ error: "captcha required" }, 403)
      : successFor([input]),
  });
  try {
    const results = await submitWithCaptchaRecovery(fixture.page, fixture.linkInput, {
      links: [input],
      subIds: [],
      debug: false,
    });
    assert.equal(results[0].failCode, 0);
    assert.equal(fixture.requests.length, 2);
  } finally {
    await fixture.context.close();
  }
});

test("browser flow: CAPTCHA hai lần thì dừng, không retry vô hạn", async () => {
  const input = "https://shopee.vn/captcha-twice";
  const fixture = await createFixture({
    responses: () => jsonResponse({ error: "captcha required" }, 403),
  });
  try {
    await assert.rejects(
      () => submitWithCaptchaRecovery(fixture.page, fixture.linkInput, {
        links: [input],
        subIds: [],
        debug: false,
      }),
      CaptchaRequiredError,
    );
    assert.equal(fixture.requests.length, 2);
  } finally {
    await fixture.context.close();
  }
});

test("browser flow: CAPTCHA hết thời gian dừng ngay với hướng dẫn", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent("<h1>Lỗi hết thời gian</h1><p>Xác minh đã hết thời gian. Hãy thử lại sau.</p>");
    await assert.rejects(
      () => waitForCaptchaResolution(page),
      /CAPTCHA đã hết thời gian.*chạy lại lệnh/,
    );
  } finally {
    await context.close();
  }
});

test("browser flow: báo lỗi GraphQL rõ ràng", async () => {
  const fixture = await createFixture({
    responses: [jsonResponse({ errors: [{ message: "invalid link" }] })],
  });
  try {
    await assert.rejects(
      () => submitCustomLinks(fixture.page, fixture.linkInput, {
        links: ["https://shopee.vn/invalid"],
        subIds: [],
        debug: false,
      }),
      /GraphQL lỗi.*invalid link/,
    );
  } finally {
    await fixture.context.close();
  }
});

test("browser flow: từ chối HTML và JSON hỏng", async (t) => {
  await t.test("HTML", async () => {
    const fixture = await createFixture({
      responses: [{ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }],
    });
    try {
      await assert.rejects(
        () => submitCustomLinks(fixture.page, fixture.linkInput, {
          links: ["https://shopee.vn/html-error"], subIds: [], debug: false,
        }),
        /không phải JSON/,
      );
    } finally {
      await fixture.context.close();
    }
  });

  await t.test("JSON hỏng", async () => {
    const fixture = await createFixture({
      responses: [{ status: 200, contentType: "application/json", body: "{broken" }],
    });
    try {
      await assert.rejects(
        () => submitCustomLinks(fixture.page, fixture.linkInput, {
          links: ["https://shopee.vn/broken-json"], subIds: [], debug: false,
        }),
        /JSON không hợp lệ/,
      );
    } finally {
      await fixture.context.close();
    }
  });
});

test("browser flow: phát hiện response thiếu data.batchCustomLink", async () => {
  const fixture = await createFixture({ responses: [jsonResponse({ data: {} })] });
  try {
    await assert.rejects(
      () => submitCustomLinks(fixture.page, fixture.linkInput, {
        links: ["https://shopee.vn/missing-data"], subIds: [], debug: false,
      }),
      /không có data\.batchCustomLink/,
    );
  } finally {
    await fixture.context.close();
  }
});

test("browser flow: response HTTP lỗi chỉ in summary an toàn", async () => {
  const fixture = await createFixture({
    responses: [jsonResponse({ error: "upstream_failure", nested: { token: "must-not-leak" } }, 500)],
  });
  try {
    await assert.rejects(
      () => submitCustomLinks(fixture.page, fixture.linkInput, {
        links: ["https://shopee.vn/http-500"], subIds: [], debug: false,
      }),
      (error) => {
        assert.match(error.message, /HTTP 500/);
        assert.doesNotMatch(error.message, /must-not-leak/);
        return true;
      },
    );
  } finally {
    await fixture.context.close();
  }
});

test("browser flow: timeout khi nút không tạo request", async () => {
  const fixture = await createFixture({ submitRequest: false });
  try {
    await assert.rejects(
      () => submitCustomLinks(fixture.page, fixture.linkInput, {
        links: ["https://shopee.vn/no-request"],
        subIds: [],
        debug: false,
        responseTimeoutMs: 150,
      }),
      /Không nhận được response batchCustomLink trong 150ms/,
    );
  } finally {
    await fixture.context.close();
  }
});

test("browser flow: giữ kết quả thành công và thất bại từng phần", async () => {
  const links = ["https://shopee.vn/good", "https://example.com/not-supported"];
  const fixture = await createFixture({
    responses: [jsonResponse({
      data: {
        batchCustomLink: [
          { shortLink: "https://s.shopee.vn/good", longLink: links[0], failCode: 0 },
          { shortLink: "", longLink: links[1], failCode: 1001 },
        ],
      },
    })],
  });
  try {
    const results = await submitCustomLinks(fixture.page, fixture.linkInput, {
      links, subIds: [], debug: false,
    });
    assert.deepEqual(results.map((result) => result.failCode), [0, 1001]);
    assert.equal(results[0].shortLink, "https://s.shopee.vn/good");
    assert.equal(results[1].shortLink, "");
  } finally {
    await fixture.context.close();
  }
});
