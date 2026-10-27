# Wolfari demo local — Windows, Docker infrastructure và Node apps

## Phạm vi

Demo dùng Compose project `wolfari-demo`, credentials, database và volumes riêng. Docker chạy PostgreSQL/RabbitMQ/MinIO/Mailpit; bảy ứng dụng NestJS và Web chạy native Node. Không sửa `.env` hoặc dữ liệu development project `wolfari`. Mobile và production chưa thuộc đợt này.

Sơ đồ luồng thực thi: browser → Web proxy `/api/v1` → Gateway → Identity HTTP/gRPC hoặc Trip/Finance/Automation gRPC. Identity/Trip outbox → RabbitMQ → Automation → Mailpit/notification. Mỗi service chỉ kết nối database do mình sở hữu. Gateway không có credential database.

## Chuẩn bị và khởi động

Node.js 24.x, Corepack, pnpm 10.34.5 và Docker Desktop Linux engine. Clone Backend/Web cạnh nhau; chạy lệnh trong từng repository để Corepack dùng đúng bản pnpm. Lần đầu cần mạng để tải dependencies và Docker images/build MinIO.

Terminal 1 tại `Wolfari-backend`:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm demo:init
corepack pnpm demo:start
```

`demo:init` sinh `.local/demo/` từ các template hiện có, không đọc secrets development. Chạy lại giữ nguyên secrets/config; cấu hình không khớp báo lỗi thay vì tự sửa. `demo:start` kiểm tra ownership/cổng, bật Compose, kiểm tra hạ tầng, áp dụng migration rồi build/chạy launcher **không hot reload**. Terminal giữ mở. Restart demo để nhận thay đổi source. Điều này tránh việc contract generation/unit tests kích hoạt restart giữa kịch bản demo; `pnpm dev` development vẫn có hot reload. Một app thoát bất thường sẽ dừng các app cùng launcher.

Terminal 2 tại Backend:

```powershell
corepack pnpm demo:check
corepack pnpm demo:seed
```

`demo:check` đợi health tối đa 90 giây sau kiểm tra hạ tầng. Mọi service dùng V001; Trip/Finance thêm V002; Automation thêm V002–V005. Readiness không thay thế nghiệm thu liên service. Không chạy `db:migrate` thông thường để migrate demo: lệnh đó vẫn phục vụ development.

Terminal 3 tại `Wolfari-web`:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm demo:dev
```

Mở http://localhost:5273/login?returnTo=%2Ftrips. Khi cần bản build, Ctrl+C Web dev rồi:

```powershell
corepack pnpm demo:build
corepack pnpm demo:preview
```

Không chạy dev và preview đồng thời trên 5273. Web demo luôn dùng Gateway, output `dist-demo/` riêng. `vite preview` chỉ phục vụ nghiệm thu local.

## Cổng và cách ly

| Thành phần | Development | Demo |
| --- | --- | --- |
| Web | `127.0.0.1:5173` | `localhost:5273` |
| Gateway HTTP | 3000 | 13000 |
| Identity HTTP/gRPC | 3101/3201 | 13101/13201 |
| Trip HTTP/gRPC | 3102/3202 | 13102/13202 |
| Travel HTTP | 3103 | 13103 |
| Finance HTTP/gRPC | 3104/3204 | 13104/13204 |
| Automation HTTP/gRPC | 3105/3205 | 13105/13205 |
| Export HTTP | 3106 | 13106 |
| PostgreSQL | 5432 | 15432 |
| RabbitMQ AMQP/UI | 5672/15672 | 25672/25673 |
| MinIO API/UI | 9000/9001 | 19000/19001 |
| Mailpit SMTP/UI | 1025/8025 | 11025/18025 |

Các cổng đều chỉ phục vụ loopback. Trình duyệt demo dùng `localhost`, development dùng `127.0.0.1`: cookie không cách ly theo cổng nên phải giữ hai hostname khác nhau. Không đổi tùy tiện URL Web demo về `127.0.0.1`. App native dùng `127.0.0.1:<host-port>`; tên `postgres/rabbitmq/minio` chỉ dành cho container cùng Docker network trong phương án container hóa sau này.

Compose dùng chung `infrastructure/docker-compose.yml`; overlay sinh ra chỉ bổ sung nhãn nhận diện. Volumes: `wolfari-demo_postgres_data`, `wolfari-demo_rabbitmq_data`, `wolfari-demo_minio_data`. Image `wolfari-minio:local` được dùng lại giữa các project; chia sẻ image không chia sẻ dữ liệu. Khi thay Dockerfile MinIO, chủ động build lại image trước lần start tiếp theo.

Backend demo đặt `WOLFARI_ISOLATED_ENV=1` để không nạp `.env` development, `NODE_ENV=development`. Web build vẫn là bundle tối ưu production nhưng backend local không phải runtime production. Secrets được lọc theo app. `.local/demo/public.json` chỉ có URL/cổng/đường dẫn nhận diện; Web không nạp `.env` chứa secrets vào bundle.

## Tài khoản và dữ liệu

Seed tạo bốn email `demo-owner@wolfari.test`, `demo-holder@wolfari.test`, `demo-member@wolfari.test`, `demo-outsider@wolfari.test`. Mật khẩu sinh ngẫu nhiên trong `.local/demo/seed.json`; đọc cục bộ, không đưa vào Git/log/screenshot công khai. Holder là người giữ quỹ, không phải system role.

Seed dùng Gateway thật, xác minh email từ Mailpit, chấp nhận lời mời thật, tạo Trip/Activity/Fund/contribution/note/Price Watch và avatar private. Dữ liệu ngân hàng `TEST` chỉ để minh họa, không chuyển tiền thật. Notification từ sự kiện invitation/member và Price Watch, không chèn SQL để giả luồng thành công.

Journal lưu request, idempotency key và kết quả từng bước trước/sau ghi. Chạy lại không lặp nghiệp vụ đã hoàn tất. Tài khoản/ảnh được đối chiếu trạng thái trước khi tạo. Nếu request không xác định kết quả thì báo lỗi, không thay key để tạo trùng. Journal có link/token nên được xem là file nhạy cảm dù chỉ local.

Seed không hoàn tác thay đổi của người dùng. Sau khi thao tác làm hết hiệu lực/xóa tài nguyên mẫu, muốn quay về bộ mẫu ban đầu hãy reset demo. Ngày Trip/Price Watch tính từ thời điểm tạo seed; demo lâu ngày cần tái tạo. `demo:api` tạo Trip và journal riêng theo lần chạy; dữ liệu kiểm thử được giữ để xem lại, chỉ reset demo mới dọn toàn bộ.

## Kiểm tra chức năng

```powershell
# Backend demo đang chạy
corepack pnpm demo:api

# Web; phải dừng Web demo thủ công đang chiếm 5273 trước
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e:live
```

`demo:api` nghiệm thu chuỗi Auth/Trip/invitations/Activity, quỹ + đóng góp thủ công, notification preferences/devices/read và Price Watch observation. Các tình huống Finance chuyên sâu tiếp tục dùng harness có sẵn thay vì thêm Postman/Bruno:

```powershell
corepack pnpm build
corepack pnpm lint
corepack pnpm test
corepack pnpm contracts:lint
corepack pnpm contracts:check
corepack pnpm db:test
corepack pnpm identity:test
corepack pnpm trip:test
corepack pnpm trip:invitations:test
corepack pnpm trip:members:test
corepack pnpm finance:test
corepack pnpm notification:test
corepack pnpm price-watch:test
```

Các harness tạo project test riêng, có thể seed SQL/fault injection rồi tự dọn tài nguyên của chính chúng. `trip:members:test` có Finance protocol fixture; `finance:test`/`finance:lifecycle:test` dùng Trip và Finance thật. Không mô tả fixture thành tích hợp thật.

Luồng leave/remove hiện chỉ nghiệm thu Backend: Web chưa nối hai nút này. Price Watch chạy service/DB/worker thật nhưng provider `MOCK_FLIGHT`. MoMo mock chỉ được phép trong `NODE_ENV=test`; demo thường giữ `MOMO_SANDBOX_MODE=disabled`, không nới guard này. Finance outbox delivery, push/FCM, Reminder, provider giá thật, Travel/Export chưa hoàn thành. Finance/Notification/Price Watch chưa có Web tích hợp.

Kết quả máy đọc được: `.local/demo/reports/{seed,api}-latest.json`; Web: `test-results/live-{dev,preview}/results.json`. [Báo cáo nghiệm thu](local-demo-acceptance.md) ghi ngày/SHA, câu lệnh, kết quả và bốn nhóm trạng thái. Log không chứa response auth, cookies hoặc URL token. Không bật browser trace/HAR cho các bài Auth.

## Dừng, chạy lại và reset

Từ Backend:

```powershell
corepack pnpm demo:stop
```

Lệnh dùng kênh điều khiển có token để dừng đúng launcher Backend/Web demo, đợi app thoát, rồi Compose down **không xóa volume**. Không kill tất cả Node hoặc tiến trình lạ theo cổng. Ctrl+C ở từng terminal chỉ dừng ứng dụng terminal đó; dùng `demo:stop` để dừng hạ tầng.

Để xóa riêng dữ liệu demo và tái tạo:

```powershell
corepack pnpm demo:reset -- --confirm wolfari-demo
corepack pnpm demo:start
# terminal Backend khác
corepack pnpm demo:seed
```

Reset xác minh manifest, Compose labels, instance ID, allowlist tên volume và attachment trước khi xóa. Mất dữ liệu demo không thể phục hồi nếu không có backup. Config/secrets và báo cáo vẫn giữ, seed manifest bị xóa. Không dùng `docker volume prune`, `docker system prune` hoặc `down -v` trên development. Nếu ownership không khớp, dừng và kiểm tra; không tự bỏ validation.

Chuyển sang development: dừng demo, dùng các lệnh `env:init/infra:up/db:migrate/dev` hiện có của Backend và `dev` của Web. Lưu ý Web `dev` mặc định fixture. Việc đổi môi trường không copy `.env` và không đổi mật khẩu database. Hai hệ có cổng riêng nhưng cùng checkout/build artifacts; tránh chạy build/hot reload đồng thời trên cùng source nếu cần phiên demo ổn định.

## Troubleshooting và hướng container hóa sau

| Hiện tượng | Xử lý |
| --- | --- |
| Thiếu `.local/demo` | Chạy `demo:init` ở Backend |
| `PORT_IN_USE` | Dừng đúng phiên demo cũ; nếu app khác chiếm cổng thì dừng và xử lý thủ công, không kill tự động |
| `DEMO_*_MISMATCH` | Kiểm tra file cấu hình/manifest được nêu; không sao chép credentials development |
| Docker Hub DNS lỗi | Sửa DNS/mạng Docker Desktop; image MinIO đã build được dùng lại, lần build mới vẫn cần mạng |
| Chưa ready trong lúc build/reload | Đợi terminal backend build xong rồi `demo:check`; không seed giữa một lần restart |
| 403 Auth/refresh/logout | Kiểm tra URL `localhost:5273`, WEB_ORIGIN, cookie và CSRF; không tắt CSRF |
| 429 | Giới hạn demo tăng có chặn 1–20, không vô hiệu limiter; xem số lần thao tác và chờ cửa sổ giới hạn |
| Mail chưa đến | Xem Mailpit 18025, Identity/Automation `/health/dependencies`, Automation `/health/invitations` |
| Seed/API lỗi | Xem báo cáo redacted và journal cục bộ; không đổi idempotency key để thử lại mù quáng |

Để container hóa sau cần Dockerfile app, service DNS thay loopback, transport TLS/mTLS, cấu hình secrets, reverse proxy/HTTPS, readiness/dependency và persistent storage phù hợp. Các guard hiện tại cố ý chặn internal plaintext production; không gỡ guard chỉ để deploy domain. Đợt này chưa thay kiến trúc, SRS, ERD hoặc migration baseline. API additive `session_id` và hai cấu hình link Identity được ghi trong tài liệu runtime.
