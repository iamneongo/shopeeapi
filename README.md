# Shopee Affiliate Custom Link — Node.js replay

Script này tái hiện request `batchCustomLink` lấy từ Chrome DevTools mà không ghi cookie, CSRF token hoặc chữ ký chống bot vào repository.

Phân tích chi tiết vòng đời và nguồn từng header nằm tại [docs/request-lifecycle.md](docs/request-lifecycle.md).
Ma trận kiểm thử và phạm vi đã xác minh nằm tại [docs/test-matrix.md](docs/test-matrix.md).

Có hai chế độ:

- **Browser mode — khuyến nghị:** Node điều khiển một Chrome profile riêng. Trang Shopee và SDK chính chủ tự sinh chữ ký mới cho từng request, nên không phụ thuộc cURL cũ.
- **cURL replay:** tiện để debug một request đã capture, nhưng cookie/chữ ký sẽ hết hạn.

## Request hoạt động thế nào

- Trang gửi `POST https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink`.
- Payload là GraphQL operation `batchGetCustomLink`; mỗi phần tử có `originalLink` và `advancedLinkParams`.
- Cookie đăng nhập và `csrf-token` xác định phiên Affiliate.
- Shopee khởi tạo anti-crawler SDK cho `/api/v3/gql`. SDK hook `fetch`/XHR và thêm các header động như `af-ac-enc-dat`, `af-ac-enc-sz-token`, `x-sz-sdk-version`; lớp bảo vệ SAP bổ sung `x-sap-ri` và `x-sap-sec`.
- Vì các giá trị trên gắn với phiên/trình duyệt và có thể hết hạn, một script Node thuần không thể tự tính chúng một cách ổn định chỉ từ GraphQL payload.

Từ bundle JavaScript đang chạy trên trang có thể xác nhận:

- `af-ac-enc-dat` là nonce 8 byte được biểu diễn thành 16 ký tự hex.
- `af-ac-enc-sz-token` đến từ Device Fingerprint SDK (`getClientCheckData`).
- `x-sz-sdk-version` mô tả phiên bản SDK.
- `/api/v3/gql` nằm trong danh sách policy của anti-crawler SDK; hook XHR/fetch sẽ gắn dữ liệu mới trước khi gửi.
- `x-sap-ri` và `x-sap-sec` do SAP protection hook bổ sung. Chúng phụ thuộc request, phiên và runtime nên không nên tự đóng giả hoặc lưu dài hạn.

## Browser mode — không phụ thuộc token capture

Cài dependency:

```powershell
npm install
```

Lần đầu, mở Chrome profile riêng và đăng nhập thủ công:

```powershell
npm run browser:setup
```

Hoặc nhập cookie đăng nhập một lần từ file cURL đã capture. Script chỉ nhập cookie và cố ý bỏ qua toàn bộ chữ ký chống bot cũ:

```powershell
npm run browser:custom-link -- `
  --bootstrap-curl "C:\path\request.curl.txt" `
  --link https://s.shopee.vn/3B7gM2EwwS
```

Sau khi trang Custom Link xuất hiện, phiên được lưu trong `.shopee-browser-profile` và Chrome tự đóng. Script lưu cả session cookie vào `storage-state.json` trong profile riêng, vì Chrome có thể xóa loại cookie này khi đóng sạch. Thư mục đã được `.gitignore`. Từ lần sau:

```powershell
npm run browser:custom-link -- `
  --link https://s.shopee.vn/3B7gM2EwwS `
  --sub-id1 facebook `
  --sub-id2 post42
```

Chế độ này đi qua đúng giao diện Shopee. Cookie được Chrome cập nhật bình thường và anti-crawler SDK tạo lại `af-ac-enc-*`/`x-sap-*` ngay trước request. Nếu Shopee yêu cầu đăng nhập hoặc xác minh lại, chạy `npm run browser:setup`; script không cố vượt CAPTCHA.

Chrome được chạy có giao diện theo chủ ý. Thử nghiệm headless bị Shopee đưa ra khỏi phiên, vì vậy script không cung cấp chế độ headless dễ lỗi.

> `.shopee-browser-profile` chứa phiên đăng nhập đang hoạt động. Không chia sẻ, upload hoặc commit thư mục này.

### CAPTCHA/xác minh

Khi response hoặc URL có tín hiệu CAPTCHA, `verify/traffic`, anti-crawler hoặc rate limit, script sẽ:

1. Dừng request và đưa cửa sổ Chrome ra trước.
2. Chờ người dùng hoàn tất xác minh thủ công, tối đa 10 phút.
3. Tải lại trang Custom Link để SDK tạo chữ ký mới.
4. Gửi lại request đúng một lần. Nếu vẫn bị yêu cầu xác minh, script dừng và báo lỗi thay vì lặp vô hạn.

Không có mã tự giải hay vượt CAPTCHA. Có thể kiểm tra nhánh xử lý bằng overlay giả, tự hoàn tất sau 2 giây:

```powershell
npm run captcha:demo
```

Demo này chạy trên trang cục bộ, không cần đăng nhập và không gửi request ra ngoài. Để mô phỏng ngay trước request Shopee sau khi profile đã đăng nhập:

```powershell
npm run browser:custom-link -- `
  --simulate-captcha `
  --link https://s.shopee.vn/3B7gM2EwwS
```

## cURL replay — phục vụ debug

### Lấy request mới bằng Chrome DevTools

1. Mở trang `https://affiliate.shopee.vn/offer/custom_link` và đăng nhập.
2. Nhấn `F12`, chọn **Network**, bật **Preserve log** nếu cần.
3. Tạo một Custom Link trên giao diện.
4. Lọc `batchCustomLink`, bấm phải request → **Copy** → **Copy as cURL (bash)**.
5. Dán nguyên nội dung vào `.shopee-request.curl.txt` ở thư mục dự án. File này đã nằm trong `.gitignore`.

Không gửi file cURL cho người khác: nó chứa cookie/token có thể cho phép truy cập phiên của bạn.

### Chạy

Yêu cầu Node.js 20 trở lên. Đây cũng là phiên bản tối thiểu của Playwright hiện tại.

```powershell
npm run custom-link -- --curl-file .shopee-request.curl.txt --link https://s.shopee.vn/3B7gM2EwwS
```

Nhiều link và Sub ID:

```powershell
npm run custom-link -- `
  --curl-file .shopee-request.curl.txt `
  --link https://s.shopee.vn/3B7gM2EwwS `
  --link https://shopee.vn/example `
  --sub-id1 facebook `
  --sub-id2 post42
```

Kết quả được in dạng JSON. `--debug` chỉ in tên header, không in cookie/token.

### Khi request hết hạn

Nếu nhận `401`, `403`, phản hồi anti-crawler, hoặc GraphQL báo lỗi phiên, hãy lặp lại thao tác **Copy as cURL**. Không nên cố định lâu dài `x-sap-*`, `af-ac-enc-*`, `csrf-token` hay cookie trong mã nguồn.
