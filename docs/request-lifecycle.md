# Vòng đời request `batchCustomLink`

Ghi nhận ngày 2026-09-28 từ trang `affiliate.shopee.vn/offer/custom_link`, bundle `app.62c3c8af.js` và `chunk-vendors.03fbad24.js`. Tên bundle/SDK có thể đổi khi Shopee deploy.

## Payload nghiệp vụ

Ứng dụng gọi:

```text
POST /api/v3/gql?q=batchCustomLink
operationName: batchGetCustomLink
sourceCaller: CUSTOM_LINK_CALLER
```

Mỗi `linkParams` gồm `originalLink` và `advancedLinkParams`. Đây là phần có thể tạo ổn định trong Node.js.

## Dữ liệu do phiên Chrome quản lý

| Dữ liệu | Nguồn | Đặc tính |
|---|---|---|
| Cookie `SPC_*`, `_sapid`, `csrftoken`, ... | Phiên đăng nhập và response của Shopee | Có thể bị rotate/hết hạn; Chrome phải nhận `Set-Cookie` mới |
| `csrf-token` | Bootstrap/config của phiên Affiliate | Gắn với phiên; không nên suy ra từ payload |
| `af-ac-enc-dat` | Anti-crawler SDK | Nonce 8 byte, mã hóa thành 16 ký tự hex |
| `af-ac-enc-sz-token` | Device Fingerprint SDK (`getClientCheckData`) | Phụ thuộc browser/device/runtime |
| `x-sz-sdk-version` | Anti-crawler SDK | Phiên bản SDK quan sát được: `1.12.21` |
| `x-sap-ri`, `x-sap-sec` | SAP protection hook | Chữ ký động phụ thuộc request, phiên và runtime |

## Thứ tự tạo request

1. Trang Affiliate bootstrap và đăng ký `/api/v3/gql` trong danh sách anti-crawler policy.
2. Device Fingerprint SDK khởi tạo trong môi trường Chrome.
3. Khi người dùng bấm **Lấy link**, ứng dụng tạo GraphQL payload bằng Axios.
4. Hook XHR/fetch của anti-crawler SDK thêm `af-ac-enc-dat`, `af-ac-enc-sz-token` và `x-sz-sdk-version`.
5. SAP hook thêm `x-sap-ri` và `x-sap-sec`.
6. Chrome gắn cookie hiện hành; ứng dụng gắn CSRF token của phiên.
7. Response có thể cập nhật cookie. Chrome profile và `storage-state.json` giữ trạng thái này cho lần chạy sau.

Vì các bước 2, 4 và 5 cần runtime trình duyệt cùng mã SDK hiện hành, sao chép thuật toán sang Node sẽ dễ hỏng mỗi lần Shopee cập nhật và có nguy cơ bị coi là request giả mạo. Browser mode chạy đúng mã phía Shopee nên bền hơn.

## Chiến lược triển khai

- Lần đầu: đăng nhập thủ công hoặc bootstrap cookie từ một cURL còn hiệu lực.
- Những lần sau: khởi động Chrome profile riêng, tải lại trang để SDK được khởi tạo mới, thao tác qua giao diện, chờ response GraphQL rồi lưu lại storage state.
- Nếu Shopee yêu cầu CAPTCHA/xác minh: người dùng xử lý trong cửa sổ Chrome; script không tự vượt xác minh.
- Không log giá trị cookie, CSRF hoặc chữ ký. `--debug` chỉ hiển thị chúng dưới dạng `<redacted>`.

