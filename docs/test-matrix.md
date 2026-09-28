# Ma trận kiểm thử

Chạy toàn bộ:

```powershell
npm test
```

Runtime đã xác minh: Node.js 22.19.0. Manifest yêu cầu Node.js 20 trở lên theo yêu cầu của Playwright 1.63.

Chỉ chạy các case Chrome end-to-end trên Shopee fixture:

```powershell
npm run test:browser
```

## Các case tự động

| Nhóm | Case | Kỳ vọng |
|---|---|---|
| Input | Không có `--link` | Từ chối với lỗi rõ ràng |
| Input | URL sai định dạng hoặc không phải HTTP(S) | Từ chối trước khi mở Chrome |
| Input | 1 link | Tạo đúng một `linkParams` |
| Input | 5 link | Gửi đủ batch tối đa |
| Input | 6 link | Từ chối vì vượt giới hạn giao diện |
| Sub ID | 5 giá trị chữ/số | Gắn đủ `subId1`–`subId5` vào mọi link |
| Sub ID | Có dấu gạch/ký tự đặc biệt | Từ chối trước khi gửi |
| UI | Modal kết quả cũ còn mở | Đóng modal trước khi submit |
| API | Response thành công | Trả `shortLink`, `longLink`, `failCode` |
| API | Thành công một phần | Giữ nguyên kết quả từng link và `failCode` |
| API | GraphQL errors | Báo lỗi ngắn gọn |
| API | HTTP 500 | Báo status và summary, không log token lồng nhau |
| API | HTML thay vì JSON | Báo response không phải JSON |
| API | JSON hỏng | Báo JSON không hợp lệ |
| API | Thiếu `data.batchCustomLink` | Báo sai schema |
| API | Không phát sinh request | Timeout với thông báo UI/API có thể đã đổi |
| CAPTCHA | HTTP 403/429, `verify/traffic`, error `90309999` | Chuyển sang nhánh xác minh |
| CAPTCHA | Lần đầu lỗi, lần hai thành công | Reload SDK và retry một lần |
| CAPTCHA | Hai lần liên tiếp | Dừng sau hai request, không lặp vô hạn |
| CAPTCHA | Thử thách hết thời gian | Dừng ngay với hướng dẫn chạy lại, không treo đủ timeout |
| Bảo mật | Response anti-crawler chứa token | Không đưa token vào error/log |

## Kiểm thử live

- Request cURL cũ đã được xác nhận trả anti-crawler error `90309999`; script nhận diện đúng và không còn in payload/token nhạy cảm.
- Batch live trên phiên Chrome chính đã kích hoạt trang xác minh `verify/traffic`. Đây là bằng chứng nhánh CAPTCHA thực tế hoạt động, nhưng việc hoàn tất CAPTCHA phải do người dùng thực hiện.
- CAPTCHA live đã hết thời gian khi chưa được người dùng xử lý; script nay có test riêng để dừng ngay và hướng dẫn chạy lại.
- Sau khi người dùng xác minh thử thách mới, cần chạy lại batch live để xác nhận các loại link thật và Sub ID đều trả `failCode: 0`.
