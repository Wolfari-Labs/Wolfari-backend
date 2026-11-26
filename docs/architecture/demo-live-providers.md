# Nguồn thật cho demo — giá vé, đường đi, tiền về

Ba nguồn bên ngoài đều tắt mặc định; mỗi nguồn bật bằng biến môi trường của đúng một app. Đặt giá trị trong
`.local/demo/apps/<app>/.env`, hoặc export trong terminal chạy `corepack pnpm demo:start` (chỉ ở chế độ
demo, chỉ các khóa dưới đây, không ghi ra đĩa). Không đưa token/khóa vào Git.

| Nguồn | App | Biến | Cần đăng ký |
| --- | --- | --- | --- |
| Giá vé Google Flights qua SearchApi.io | `automation-service` | `PRICE_WATCH_PROVIDER=SEARCHAPI_GOOGLE_FLIGHTS`, `SEARCHAPI_API_KEY` | Tài khoản SearchApi.io |
| Giá vé Travelpayouts (cache Aviasales) | `automation-service` | `PRICE_WATCH_PROVIDER=TRAVELPAYOUTS_CACHE`, `TRAVELPAYOUTS_TOKEN`, `TRAVELPAYOUTS_VND_VERIFIED=true` | Tài khoản Travelpayouts đã kết nối chương trình Aviasales |
| Đường đi OSRM | `travel-intelligence-service` | `OSRM_URL`, `OSRM_WALKING_URL`, `OSRM_CYCLING_URL`, hoặc `OSRM_PUBLIC_DEMO=true`; tùy chọn `OSRM_USER_AGENT` | Không |
| Tiền về SePay | `api-gateway` | `BANK_WEBHOOK_SEPAY_API_KEY` (hoặc `BANK_WEBHOOK_SEPAY_SECRET`) | Tài khoản SePay (gói FREE 50 giao dịch/tháng), liên kết tài khoản ngân hàng của Thủ quỹ |

## Giá vé thật (Price Watch)

### Google Flights qua SearchApi.io

SearchApi.io cung cấp 100 lượt thử miễn phí khi đăng ký. Form đăng ký nhận tên, email và mật khẩu. [Gói dùng thử Google Flights](https://www.searchapi.io/google-flights-api) · [Đăng ký](https://www.searchapi.io/users/sign_up)

Khi chạy local, chạy `corepack pnpm env:init`, điền `SEARCHAPI_API_KEY` trong `apps/automation-service/.env` rồi chạy `corepack pnpm price-watch:setup`. Lệnh chọn nguồn và bật worker trên máy đó.

Khi chạy demo, đặt ba biến sau trong `.local/demo/apps/automation-service/.env`:

```dotenv
PRICE_WATCH_PROVIDER=SEARCHAPI_GOOGLE_FLIGHTS
SEARCHAPI_API_KEY=<key từ tài khoản SearchApi.io>
PRICE_WATCH_WORKER_ENABLED=true
```

Để thử một lần, chạy `corepack pnpm price-watch:live-check` ở thư mục gốc. Lệnh lấy cấu hình từ file Automation local hoặc terminal. Nếu chạy demo tách biệt, đặt key và provider trong terminal chạy lệnh kiểm tra. Sau khi cấu hình, khởi động lại Automation và tạo lượt theo dõi. Theo lịch sáu giờ, một nhóm truy vấn hoạt động liên tục dùng khoảng bốn lượt mỗi ngày nếu mỗi lần kiểm tra thành công.

Backend yêu cầu giá VND cho một người lớn, vé một chiều hạng phổ thông. Worker chọn giá thấp nhất trong các hành trình khớp sân bay và ngày đi. Lịch sử giữ tên nguồn `SEARCHAPI_GOOGLE_FLIGHTS`; cảnh báo dùng thời điểm SearchApi thực hiện tìm kiếm. [API và cấu trúc kết quả](https://www.searchapi.io/docs/google-flights-api)

### Cache Aviasales qua Travelpayouts

- Worker gọi `GET https://api.travelpayouts.com/aviasales/v3/get_latest_prices` cho đúng một ngày bay
  (`period_type=day`, một chiều, phổ thông, `currency=vnd`, `show_to_affiliates=false`), tối đa 1 lần/giây
  (giới hạn công bố 300 lần/phút). Đây là **giá tham khảo** người dùng Aviasales tìm thấy, lưu tối đa 7 ngày;
  không phải giá đặt vé trực tiếp. Chỉ giá có `found_at` trong 48 giờ mới được phép tạo cảnh báo.
- Nguồn này chỉ nhận chiều đi một người lớn hạng phổ thông. Yêu cầu khác trả
  `400 VALIDATION_FAILED` với `error.details.reason = PROVIDER_QUERY_UNSUPPORTED`.
- Client có thể bỏ `provider` khi tạo watch: server dùng nguồn đang cấu hình
  (`TRAVELPAYOUTS_CACHE` khi có token, nếu không thì `MOCK_FLIGHT` ngoài production). Watch trả về
  `normalized_query.provider`; observation có `provider` và `fare_metadata.source_freshness`.
  Chọn Travelpayouts mà thiếu token/worker/xác nhận VND thì trả
  `503 SERVICE_UNAVAILABLE`, `details.reason = PRICE_PROVIDER_NOT_CONFIGURED`, `retryable=false`.
- Đặt `TRAVELPAYOUTS_TOKEN` trong `apps/automation-service/.env` khi chạy local, hoặc đặt trong terminal khi chạy demo. Lệnh kiểm tra ưu tiên token trong terminal, sau đó đọc token của Automation local. Chạy lệnh để thử một chuyến SGN → HAN bằng một request.

```powershell
corepack pnpm price-watch:live-check
# tùy chọn: $env:PRICE_CHECK_ORIGIN="HAN"; $env:PRICE_CHECK_DESTINATION="DAD"; $env:PRICE_CHECK_DATE="2026-12-20"
```

Khi lệnh trả `OK` và `response_currency` là `VND`, đặt `TRAVELPAYOUTS_VND_VERIFIED=true` và `PRICE_WATCH_WORKER_ENABLED=true` trong cấu hình Automation rồi khởi động lại service. Để dùng Aviasales trong production hoặc thay thế một nguồn đã cấu hình, đặt `PRICE_WATCH_PROVIDER=TRAVELPAYOUTS_CACHE`.

`NO_CACHED_PRICE` nghĩa là cache chưa có giá cho chặng và ngày đã chọn. `CURRENCY_UNCONFIRMED` nghĩa là có giá nhưng phản hồi chưa xác nhận đơn vị tiền. Xác minh VND với nhà cung cấp trước khi bật worker.

Tạo lượt theo dõi qua `POST /api/v1/trips/{trip_id}/price-watches` và bỏ trường `provider` để dùng cấu hình server. Kiểm tra `normalized_query.provider` trong kết quả. Sau khi worker thu được giá, đọc lịch sử qua `GET /api/v1/price-watches/{watch_id}/observations`. [OpenAPI Price Watch](../api/price-watch.openapi.yaml)

## Đường đi thật (OSRM)

- `POST /api/v1/travel/route` nhận `mode` = `DRIVING` (mặc định), `WALKING`, `CYCLING`. Mỗi chế độ dùng máy
  chủ OSRM của chính nó; không bao giờ trả đường đi bộ/xe đạp bằng hồ sơ ô tô. Kết quả cache 7 ngày theo
  chế độ + tọa độ; khóa cache ô tô giữ nguyên như trước.
- `OSRM_PUBLIC_DEMO=true` (bị bỏ qua khi `NODE_ENV=production`) dùng `router.project-osrm.org` (ô tô) và
  `routing.openstreetmap.de/routed-foot|routed-bike`. Chính sách của hai máy chủ (kiểm 23/11/2026): dùng hợp
  lý, phi thương mại, tối đa 1 request/giây, User-Agent hợp lệ, hiển thị ghi công OpenStreetMap và liên kết
  sửa bản đồ. Service giãn cách 1,1 giây mỗi host và từ chối xếp hàng quá 1,5 giây
  (`PROVIDER_RATE_LIMITED`, 503 retryable).
- `meta.attribution` luôn có `© OpenStreetMap contributors` và "Góp ý sửa bản đồ"; client phải hiển thị cạnh
  đường đi. Chỉ `DRIVING` có cảnh báo `ESTIMATED_BY_CAR_PROFILE` (không có giao thông thời gian thực).

## Tiền về thật (SePay qua đường hầm)

SePay cần một URL HTTPS công khai. `corepack pnpm demo:tunnel` (sau `demo:start`) mở relay cục bộ chỉ chuyển
`POST /api/v1/webhooks/bank/sepay` tới Gateway demo, rồi mở Cloudflare quick tunnel (không cần tài khoản) tới
relay đó; mọi API khác trả 404 qua đường hầm. Lệnh in URL webhook và các bước điền trên my.sepay.vn
(Webhooks → Thêm webhook → sự kiện "Có tiền vào" → tài khoản Thủ quỹ → Bảo mật API Key). Chưa có
`cloudflared` thì lệnh chỉ in cách cài (`winget install --id Cloudflare.cloudflared -e`), không tự cài.
URL quick tunnel đổi mỗi lần chạy; cập nhật lại trên SePay. Dùng "Giả lập giao dịch" của SePay để thử trước
khi chuyển tiền thật. Quy tắc tự xác nhận xem [finance-bank-transfers.md](finance-bank-transfers.md).
