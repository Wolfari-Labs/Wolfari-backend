# Wolfari demo local — Windows, Docker infrastructure và Node apps

> **Readiness 02/11/2026:** chạy cặp Web `feat/demo-1-readiness-web` + Backend `feat/demo-1-readiness-backend` (Backend đã ghép `origin/main`). Runbook này chỉ dành localhost trên Windows. Cặp SHA, PASS/FAIL/NOT_RUN và bằng chứng hiện hành nằm trong [báo cáo readiness Web](../../../Wolfari-web/docs/demo-readiness-validation.md). Không xem lệnh local là CI/reviewer/main verification.

> Backend demo1: [phụ lục v1.0](demo-1-addendum-v1.0.md), [validation](demo-1-backend-validation.md), [handoff Web](demo-1-web-handoff.md). Nâng demo cũ: dừng demo, chạy lại `demo:init` để thêm cấu hình thiếu mà giữ secrets, rồi `demo:start` áp dụng **Trip V003**. Không reset dữ liệu. Gateway `/health/ready` chỉ kiểm core Identity/Trip; `/health/dependencies` thêm Finance/Automation. `demo:check` còn kiểm broker/SMTP với retry15 giây, không thay acceptance.

`corepack pnpm demo:accounts` đọc email thực tế trong journal và trạng thái Identity bằng READ ONLY, không in mật khẩu/tạo session. Không giả định journal cũ dùng email cố định. Mật khẩu tại `.local/demo/seed.json` có thể cũ nếu đã đổi trong UI; dùng password reset qua Mailpit, không chạy seed để ép password. Account đã tồn tại nhưng không đăng nhập bằng journal được sẽ báo `DEMO_CREDENTIALS_UNUSABLE`, không reset ngầm.

`corepack pnpm demo:acceptance` build và kiểm thử API5 actor bằng hạ tầng riêng, tự dọn tài nguyên test; không cần demo đang chạy. Operation202/timeout/NEEDS_REVIEW xử lý theo [runbook](demo-1-addendum-v1.0.md#6-seedaccount-và-operation-recovery); retry CLI phải dùng `--demo` để tránh chọn development.

`FINANCE_OUTBOX_ENABLED=false` và `AUTOMATION_FINANCE_NOTIFICATION_ENABLED=false` là mặc định an toàn của demo cá nhân. Acceptance harness có thể bật riêng hai cờ sau khi tạo đúng RabbitMQ bindings và kiểm tra consumer; không bật trên volume trình diễn chỉ để làm notification xuất hiện. Nếu đổi runtime/config, phải chạy lại live acceptance và ghi cặp SHA mới. Price Watch worker dùng provider `MOCK_FLIGHT`, không phải giá vé/provider thật.

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
corepack pnpm demo:accounts
```

`demo:check` đợi health tối đa90 giây sau kiểm tra hạ tầng, rồi broker/SMTP tối đa15 giây. Mọi service dùng V001; Trip thêm V002–V003, Finance thêm V002; Automation thêm V002–V005. Readiness không thay thế nghiệm thu liên service. Không chạy `db:migrate` thông thường để migrate demo: lệnh đó vẫn phục vụ development.

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

## Demo kiểm thử Quỹ và Price Watch bằng Backend

Chạy từ thư mục backend với Node 24, Corepack và Docker Desktop Linux. Trên máy mới cài dependencies bằng `corepack pnpm install --frozen-lockfile`. Terminal thứ nhất giữ backend chạy.

```powershell
corepack pnpm demo:init
corepack pnpm demo:start
```

Mở terminal thứ hai cùng thư mục. Cài Newman một lần vào thư mục công cụ riêng của demo.

```powershell
npm install --prefix .local/demo/tools --ignore-scripts --no-audit --no-fund newman@6.2.1
corepack pnpm demo:finance-price-watch
corepack pnpm demo:postman
```

Mỗi lượt `demo:finance-price-watch` dùng lại tài khoản TEST, tạo Trip và quỹ riêng. Bốn vai trò gồm Owner, Holder, Member và người ngoài Trip. Owner cũng có một khoản đóng riêng. Quỹ bắt đầu từ 0 VND và đích nhận TEST do Holder xác nhận. Chạy lại là đủ để có dữ liệu mới cho buổi trình bày.

| Ca | Thao tác và bằng chứng cần mở |
| --- | --- |
| API01–03 | Owner lập đợt thu 200.000 và 300.000 VND. Member báo khoản đầu. Khi Holder từ chối, lý do được lưu, khoản trở về PENDING, sổ quỹ vẫn trống. |
| VietQR API086 | Trước khi báo chuyển, Member đọc hướng dẫn TEST cho khoản 200.000 VND của mình. Demo đối chiếu số tiền, mã tham chiếu và URL QuickLink ngay trên máy, kiểm tra người khác bị 404, số dư và sổ quỹ giữ nguyên. Sau khi báo chuyển, yêu cầu cấp hướng dẫn mới bị 409. Ảnh QR ngoài hệ thống và camera Android cần kiểm riêng. |
| API04–07 | Member báo lại, Holder xác nhận. Gửi lại cùng khóa phải giữ nguyên dòng thu. Owner tự xác nhận thay Holder bị 403. Với khoản thứ hai, hai yêu cầu xác nhận đồng thời trả 200 và 409. Sổ quỹ kết thúc ở 500.000 VND với hai dòng IN. |
| API08–09 | Member và Owner cùng theo dõi DAD → HAN, cùng chuyến bay sau 30 ngày. Ngưỡng 9.000.000 và 1 VND giúp giá MOCK_FLIGHT luôn nằm giữa hai ngưỡng. Đọc cùng observation qua hai watch và đối soát PostgreSQL theo đúng nhóm/kỳ. Một attempt thành công, một observation và một thông báo PRICE_ALERT trong ứng dụng cho watch ngưỡng cao. |
| API10–12 | Watch ngưỡng thấp đi qua PAUSED, ACTIVE, STOPPED. Resume sau stop và sửa bằng phiên bản cũ trả 409. Người ngoài Trip đọc danh sách watch nhận 404. |

Mở `.local/demo/reports/finance-price-watch-latest.json` để xem số dư, hai dòng ledger, hai watch ID, query group, giá và thời điểm quan sát. Lệnh Newman đọc lại Trip vừa chạy bằng 5 HTTP request và 10 assertion. Mở `.local/demo/reports/postman-latest.json` để xem kết quả cùng `sourceRunId`. Khi đưa vào OneDrive, lấy hai bản mang run ID trong cùng thư mục để giữ đúng cặp bằng chứng. Tài khoản nằm trong journal riêng của demo. Chỉ chia sẻ các báo cáo.

Để trình chiếu trong Postman Desktop, import [collection kiểm chứng](../api/finance-price-watch.postman_collection.json), đặt `tripId` bằng `resources.tripId` trong báo cáo và `accessToken` bằng bearer token local của Owner demo. Dùng Collection Runner chạy theo thứ tự. Lệnh `demo:postman` tự đăng nhập lại trong bộ nhớ khi chạy bằng CLI. Để kết thúc buổi demo dùng `corepack pnpm demo:stop`, dữ liệu được giữ để xem lại.

Để kiểm tra quy tắc tiền, khóa truy vấn, ngưỡng, giảm 5% và cooldown 24 giờ ở mức Unit, chạy sau khi build.

```powershell
corepack pnpm build
corepack pnpm demo:unit
```

Vitest xuất `.local/demo/reports/finance-price-watch-unit.xml` theo định dạng JUnit. Lưu bản này cùng hai báo cáo JSON của lượt trình diễn vào thư mục bằng chứng của nhóm.

Hai bộ hồi quy sâu chạy riêng bằng `corepack pnpm finance:test` và `corepack pnpm price-watch:test`. Demo dùng đóng góp thủ công TEST, worker thật, nguồn giá MOCK_FLIGHT và thông báo trong ứng dụng. Web, Android, camera, thanh toán ngoài hệ thống và benchmark NFR-P01 cần bằng chứng ở lượt kiểm thử tương ứng.

## Đo PERF01 và PERF02 bằng JMeter

Mạnh chạy trên Gateway demo ở 127.0.0.1:13000, với PostgreSQL demo đang hoạt động. Cài Java 17 hoặc 21 và [Apache JMeter 5.6.3](https://jmeter.apache.org/download_jmeter.cgi). Đặt `JMETER_HOME` trỏ vào thư mục JMeter đã giải nén hoặc giải nén vào `.local/demo/tools/apache-jmeter-5.6.3`. Nếu cần chọn Java khác với PATH, đặt `JMETER_JAVA` bằng đường dẫn tuyệt đối tới java.exe. Từ gốc backend, chạy lần lượt `corepack pnpm demo:perf:smoke` và `corepack pnpm demo:perf:load`.

Fixture TD06 được tạo và dùng lại trong instance demo. Có 50 tài khoản giả lập, 100 Trip, mỗi Trip 6 thành viên và 4 ngày × 10 Activity. Mỗi quỹ có một khoản thu 200.000 VND và mỗi Trip có một watch dùng MOCK_FLIGHT. Mỗi người dùng đăng nhập riêng và luân phiên hai Trip được phân quyền. JMeter chỉ đo ba request GET đọc Plan, sổ quỹ và danh sách watch. Mỗi request có thời gian nghỉ 1 giây. Chi phí đăng nhập, tạo dữ liệu và gọi provider được tách khỏi lượt đo.

PERF01 dùng 5 người, tăng tải 5 giây, làm nóng thêm 10 giây rồi đo 30 giây. PERF02 dùng 50 người, tăng tải 10 giây, làm nóng thêm 60 giây rồi đo 600 giây. Condition của NFR-P01 là p95 từng API dưới 2.000 ms. Runner cũng kiểm tra đủ người dùng suốt cửa sổ đo, HTTP 200 và nội dung đúng bộ TD06. Kết quả riêng từng endpoint gồm p95 (ms), throughput (request/giây) và tỷ lệ lỗi. Chỉ sao chép `summary.json` và `samples.csv` từ thư mục PERF tương ứng trong `.local/demo/reports`. Report ghi commit checkout và cờ dirty. Sau khi đổi code, khởi động lại backend demo đúng bản build trước khi đo.

## Chạy AND04–AND05 trên Android thật

Quyên dùng bản native Wolfari Mobile có package `com.tanthanh_67.Wolfarimobile`, tài khoản TEST, vào Chuyến đi → Tiện ích → Quỹ nhóm. Kiểm tra `adb devices -l` hiển thị đúng điện thoại. Mỗi flow bắt đầu ở nút “Quét QR thanh toán”, khi bảng quét còn đóng. Chuẩn bị quyền camera ở trạng thái có thể hỏi lần đầu cho AND04. Nếu Android đang nhớ lựa chọn, mở cài đặt quyền ứng dụng và đặt lại quyền trước khi mở Wolfari. Không cần xóa dữ liệu ứng dụng.

1. Chạy `maestro test scripts/android/AND04.yaml`. Flow yêu cầu quyền camera, chọn từ chối tại hộp thoại Android, mở cách dán, đọc vector TEST và đối chiếu màn hình kiểm tra với **180.000 ₫**. Để nghiệm thu thao tác dán của hệ điều hành, sao chép đúng vector trong YAML vào clipboard điện thoại và lặp lại bằng nhấn giữ → Dán. Lệnh [pasteText của Maestro](https://docs.maestro.dev/reference/commands-available/pastetext) dùng clipboard nội bộ của công cụ.
2. Đóng bảng quét, giữ camera bị từ chối, chạy `maestro test scripts/android/AND05.yaml`. Chuỗi chỉ khác ký tự CRC cuối (E → F). Ứng dụng phải hiện “Mã kiểm tra QR không khớp” và không hiển thị màn hình số tiền.
3. Trước và sau mỗi ca, đối chiếu cùng số dư và sổ quỹ trên tài khoản TEST, ghi commit mobile, model máy, phiên bản Android, ngày và bằng chứng của lượt chạy. Luồng này chỉ đọc mã. Không mở ứng dụng ngân hàng hay thực hiện chuyển tiền. Chỉ điền Round sau khi chạy thật.

## Cổng và cách ly

| Thành phần           | Development      | Demo             |
| -------------------- | ---------------- | ---------------- |
| Web                  | `127.0.0.1:5173` | `localhost:5273` |
| Gateway HTTP         | 3000             | 13000            |
| Identity HTTP/gRPC   | 3101/3201        | 13101/13201      |
| Trip HTTP/gRPC       | 3102/3202        | 13102/13202      |
| Travel HTTP          | 3103             | 13103            |
| Finance HTTP/gRPC    | 3104/3204        | 13104/13204      |
| Automation HTTP/gRPC | 3105/3205        | 13105/13205      |
| Export HTTP          | 3106             | 13106            |
| PostgreSQL           | 5432             | 15432            |
| RabbitMQ AMQP/UI     | 5672/15672       | 25672/25673      |
| MinIO API/UI         | 9000/9001        | 19000/19001      |
| Mailpit SMTP/UI      | 1025/8025        | 11025/18025      |

Các cổng đều chỉ phục vụ loopback. Trình duyệt demo dùng `localhost`, development dùng `127.0.0.1`: cookie không cách ly theo cổng nên phải giữ hai hostname khác nhau. Không đổi tùy tiện URL Web demo về `127.0.0.1`. App native dùng `127.0.0.1:<host-port>`; tên `postgres/rabbitmq/minio` chỉ dành cho container cùng Docker network trong phương án container hóa sau này.

Compose dùng chung `infrastructure/docker-compose.yml`; overlay sinh ra chỉ bổ sung nhãn nhận diện. Volumes: `wolfari-demo_postgres_data`, `wolfari-demo_rabbitmq_data`, `wolfari-demo_minio_data`. Image `wolfari-minio:local` được dùng lại giữa các project; chia sẻ image không chia sẻ dữ liệu. Khi thay Dockerfile MinIO, chủ động build lại image trước lần start tiếp theo.

Backend demo đặt `WOLFARI_ISOLATED_ENV=1` để không nạp `.env` development, `NODE_ENV=development`. Web build vẫn là bundle tối ưu production nhưng backend local không phải runtime production. Secrets được lọc theo app. `.local/demo/public.json` chỉ có URL/cổng/đường dẫn nhận diện; Web không nạp `.env` chứa secrets vào bundle.

## Tài khoản và dữ liệu

Seed tạo bốn email `demo-owner@wolfari.test`, `demo-holder@wolfari.test`, `demo-member@wolfari.test`, `demo-outsider@wolfari.test`. Mật khẩu sinh ngẫu nhiên trong `.local/demo/seed.json`; đọc cục bộ, không đưa vào Git/log/screenshot công khai. Holder là người giữ quỹ, không phải system role.

Seed dùng Gateway thật, xác minh email từ Mailpit, chấp nhận lời mời thật, tạo Trip/Activity/Fund/contribution/note/Price Watch và avatar private. Dữ liệu ngân hàng `TEST` chỉ để minh họa, không chuyển tiền thật. Notification từ sự kiện invitation/member và Price Watch, không chèn SQL để giả luồng thành công.

Journal lưu request, idempotency key và kết quả từng bước trước/sau ghi. Chạy lại không lặp nghiệp vụ đã hoàn tất. Tài khoản/ảnh được đối chiếu trạng thái trước khi tạo. Nếu request không xác định kết quả thì báo lỗi, không thay key để tạo trùng. Journal có link/token nên được xem là file nhạy cảm dù chỉ local.

`demo:seed` chỉ dùng khi chủ động tạo bộ mẫu lần đầu và chưa có journal; không mặc định chạy trong checklist hằng ngày. Seed không hoàn tác thay đổi người dùng. Ngày Trip/Price Watch tính từ thời điểm tạo seed; khi hết phù hợp, tạo Trip TEST mới bằng UI/API hợp lệ và giữ bộ cũ. `demo:api` tạo Trip/journal riêng nhưng vẫn ghi vào instance demo; không chạy fault hoặc legacy live test vào bộ dữ liệu đang trình diễn. Nếu journal cũ còn mà tài khoản `MISSING`, giữ backup/journal, đăng ký email TEST mới; password reset không khôi phục database đã mất.

## Kiểm tra chức năng

```powershell
# Backend demo đang chạy
corepack pnpm demo:api

# Web; kiểm thử riêng, không dùng dataset trình diễn
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e:demo1 --runtime=dev
corepack pnpm test:e2e:demo1 --runtime=preview
```

`demo:api` nghiệm thu chuỗi Auth/Trip/invitations/Activity, quỹ + đóng góp thủ công, notification preferences/devices/read và Price Watch observation. Finance inbox delivery từ outbox được chứng minh riêng bằng `finance:notification:test` trong stack cô lập; không suy ra demo cá nhân đã bật bindings. Các tình huống Finance chuyên sâu tiếp tục dùng harness có sẵn thay vì thêm Postman/Bruno:

```powershell
corepack pnpm build
corepack pnpm lint
corepack pnpm test --maxWorkers=2
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
corepack pnpm demo:acceptance
corepack pnpm finance:outbox:test
corepack pnpm finance:notification:test
```

Các harness tạo project test riêng, có thể seed SQL/fault injection rồi tự dọn tài nguyên của chính chúng. `trip:members:test` có Finance protocol fixture; `finance:test`/`finance:lifecycle:test` dùng Trip và Finance thật. Không mô tả fixture thành tích hợp thật.

Web Gateway hiện có leave/remove, selected editors, quỹ TEST, inbox/read/preferences và Price Watch. Map/Dress/Packing chỉ đọc, Admin là placeholder; không suy có Web expense/refund/closure/payment writer. Price Watch chạy service/DB/worker thật nhưng provider `MOCK_FLIGHT`. MoMo mock chỉ được phép trong `NODE_ENV=test`; demo thường giữ `MOMO_SANDBOX_MODE=disabled`, không nới guard này. Finance outbox/inbox đã có implementation và suite riêng; shared deployment, push/FCM, Reminder, provider giá thật và Travel/Export vẫn ngoài nghiệm thu này.

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

| Hiện tượng                        | Xử lý                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Thiếu `.local/demo`               | Chạy `demo:init` ở Backend                                                                         |
| `PORT_IN_USE`                     | Dừng đúng phiên demo cũ; nếu app khác chiếm cổng thì dừng và xử lý thủ công, không kill tự động    |
| `DEMO_*_MISMATCH`                 | Kiểm tra file cấu hình/manifest được nêu; không sao chép credentials development                   |
| Docker Hub DNS lỗi                | Sửa DNS/mạng Docker Desktop; image MinIO đã build được dùng lại, lần build mới vẫn cần mạng        |
| Chưa ready trong lúc build/reload | Đợi terminal backend build xong rồi `demo:check`; không seed giữa một lần restart                  |
| 403 Auth/refresh/logout           | Kiểm tra URL `localhost:5273`, WEB_ORIGIN, cookie và CSRF; không tắt CSRF                          |
| 429                               | Giới hạn demo tăng có chặn 1–20, không vô hiệu limiter; xem số lần thao tác và chờ cửa sổ giới hạn |
| Mail chưa đến                     | Xem Mailpit 18025, Identity/Automation `/health/dependencies`, Automation `/health/invitations`    |
| Seed/API lỗi                      | Xem báo cáo redacted và journal cục bộ; không đổi idempotency key để thử lại mù quáng              |

Để container hóa sau cần Dockerfile app, service DNS thay loopback, transport TLS/mTLS, cấu hình secrets, reverse proxy/HTTPS, readiness/dependency và persistent storage phù hợp. Các guard hiện tại cố ý chặn internal plaintext production; không gỡ guard chỉ để deploy domain. Demo1 không đổi ownership/kiến trúc; Trip V003 và contract additive được ghi ở phụ lục, không sửa migration baseline hoặc DOCX đã chốt. API additive `session_id` và hai cấu hình link Identity được ghi trong tài liệu runtime.
