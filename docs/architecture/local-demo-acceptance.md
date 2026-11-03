# Nghiệm thu demo local

## Mốc Backend demo1 — 28/10/2026

[Bằng chứng mới](demo-1-backend-validation.md), [phụ lục](demo-1-addendum-v1.0.md) và [gate Web còn lại](demo-1-web-handoff.md) dành cho nhánh `feat/demo-1-backend`. `corepack pnpm demo:acceptance` build rồi tạo hạ tầng cô lập, dùng5 tài khoản mới xác minh email, EMAIL/LINK invitation, selected Editor, ngày-only/overnight và quỹ Owner–Holder tách biệt/ledger500000. Không seed nghiệp vụ bằng SQL; tự dọn tài nguyên test, không xóa dữ liệu `wolfari-demo`. Đây là API E2E, không phải Browser E2E.

## Lịch sử nghiệm thu Web — 27/10/2026

Các mục sau giữ bằng chứng lịch sử theo ngày/SHA của chúng, không dùng làm nghiệm thu HEAD mới.

## Kết luận và mốc kiểm tra

Đủ để trình diễn local các phần Web đã kết nối: Identity, Profile/Sessions, Trip, Members read/policy, Invitations và Activity. Không phải nghiệm thu toàn bộ MVP hoặc production. Docker chạy hạ tầng; Backend/Web vẫn chạy native Node, chưa có bộ Docker image cho toàn bộ ứng dụng.

- Backend HEAD: `7931541fdf4781feb08240670fbd8b24420f6e20`.
- Web HEAD: `3a0c2bec5283a20e386d0d95e0e7f66002763753`.
- Kết quả áp dụng cho **HEAD cộng working tree chưa commit** trong đợt này, không phải hai commit gốc độc lập. Không commit/push hoặc chạy lại GitHub CI.
- Máy kiểm tra: Windows/PowerShell, Node `24.19.0`, pnpm `10.34.5`, Docker Engine `29.7.2`, Compose `5.3.1`.
- Ngày địa phương: 27/10/2026, Asia/Saigon. JSON ghi UTC nên các lần chạy lúc gần 03:00 có ngày `2026-10-26`.
- Môi trường `wolfari-demo`, Gateway `13000`, Web `localhost:5273`, Mailpit `18025`; xem [runbook](local-demo.md) để biết toàn bộ cổng và cách chạy.

## 1. Thành công và đã kiểm thử

### Build và kiểm tra mã

Mỗi lệnh dưới đây chạy tại repository được nêu, với tiền tố `corepack pnpm`.

| Repository | Lệnh                                | Kết quả                                                                               |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| Backend    | `build`                             | PASS, toàn bộ workspace có build script                                               |
| Backend    | `lint`                              | PASS                                                                                  |
| Backend    | `test`                              | PASS: 111 files, **1.565 tests**, gồm regression chờ launcher dừng trước khi xác nhận |
| Backend    | `contracts:lint`, `contracts:check` | PASS; generated contract sources tái lập được                                         |
| Web        | `lint`, `typecheck`                 | PASS                                                                                  |
| Web        | `test`                              | PASS: 37 files, **484 tests**                                                         |
| Web        | `build`                             | PASS: bundle Gateway thông thường                                                     |
| Web        | `test:e2e --workers=1`              | PASS: **164 tests**, fixture UI; không chứng minh tích hợp Backend                    |
| Web        | `test:e2e:gateway --workers=1`      | PASS: **33 tests**; HTTP bị mock, không phải Backend thật                             |
| Web        | `test:e2e:live`                     | PASS: **4 dev + 4 build/preview**; không mock API                                     |

Live suite tự build `dist-demo/` rồi chạy hai runtime tuần tự. Browser dùng đúng Origin/CSRF/refresh cookie; dữ liệu đi qua Gateway, service và database thật. Mailpit là SMTP local, không phải email delivery ra Internet. Avatar dùng MinIO private thật.

### Hạ tầng và chuỗi API demo

| Lệnh Backend                                     | Kết quả                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `demo:init`                                      | PASS; chạy lại giữ cấu hình/secrets demo                                                                       |
| `demo:start`, `demo:check`                       | PASS; Compose, migration, credential từng database, RabbitMQ, private MinIO, Mailpit và 7 application liveness |
| `demo:seed` hai lần sau reset                    | PASS; lần hai tái sử dụng journal, không lặp các bước nghiệp vụ đã hoàn tất                                    |
| `demo:api`                                       | PASS: **11 nhóm kiểm tra**, qua Gateway/service thật                                                           |
| `demo:stop` khi Backend và Web preview cùng chạy | PASS; hai launcher thoát code 0 trước khi Compose down; giữ cả ba demo volumes                                 |
| `demo:reset -- --confirm wolfari-demo`           | PASS; chỉ xóa 3 volume demo đã xác minh ownership và seed manifest; sau đó start/seed lại thành công           |

Seed/API kiểm tra: bốn tài khoản và xác minh email; tạo Trip; EMAIL invitation acceptance và EMAIL/LINK đang chờ; Activity; Profile/avatar; Fund/Holder/destination; contribution report/confirm và ledger balance; financial note; Price Watch observation; notification từ sự kiện Trip thật. API bổ sung pause/resume/stop Price Watch, preferences/device/read, từ chối truy cập khác Trip và Member rời Trip qua Trip–Finance sau khi hoàn tất đóng góp.

Các assertion được gộp theo hành trình; 11 nhóm API không đồng nghĩa chỉ có 11 endpoint hoặc bao phủ toàn bộ endpoint.

### Browser thật

1. Register → Mailpit verification → login → cập nhật profile/avatar → reload/refresh → logout → recovery/reset → thu hồi phiên khác → đổi mật khẩu. Kiểm tra không lưu token vào localStorage/sessionStorage.
2. Owner gửi/gửi lại/thu hồi EMAIL invitation; tạo LINK; khách login rồi decline hoặc accept; Member không có quyền sửa Plan bị ẩn nút ghi.
3. Tạo Trip từ UI, sửa metadata, reload; Activity create/update/delete/order/completion và kiểm tra lưu bền qua reload.
4. EMAIL invitation qua Mailpit, Member accept, danh sách thành viên và policy `ALL_MEMBERS`; Member được phép tạo Activity sau policy update.

### Bằng chứng lưu cục bộ

- `.local/demo/reports/seed-latest.json`: 8 nhóm PASS; lần seed replay sau reset bắt đầu `2026-10-26T19:59:40.855Z`.
- `.local/demo/reports/api-latest.json`: 11 nhóm PASS; run ID `e08d50d9-bd5a-4ac8-934e-921200c82eb5`, bắt đầu `2026-10-26T19:59:43.819Z`.
- Web `test-results/live-dev/results.json`, `test-results/live-preview/results.json`: báo cáo Playwright, không trace/HAR/video/screenshot.
- Các báo cáo latest bị cập nhật khi chạy lại. Backend còn giữ báo cáo theo run ID. Đây là bằng chứng local, không phải CI hay benchmark tải.

### Harness đã chạy trong đợt triển khai

Các kết quả dưới đây được ghi nhận trong đợt triển khai; Identity (19 nhóm) và Notification (7 nhóm) được chạy lại sau sửa launcher và tiếp tục PASS. Các harness còn lại là kết quả trước vòng kiểm tra launcher cuối. Không suy ra rằng tất cả harness là browser E2E. Harness tạo project/database test riêng, có thể seed SQL hoặc fault injection; cuối mỗi lần chạy tự xóa dữ liệu test riêng, không giữ để phục hồi.

| Lệnh Backend            | Kết quả đã ghi nhận | Giới hạn                                                                  |
| ----------------------- | ------------------- | ------------------------------------------------------------------------- |
| `db:test`               | 28 nhóm PASS        | Migration/role/isolation trên database test                               |
| `identity:test`         | 19 nhóm PASS        | Gateway/Identity/Trip/Automation, SMTP local                              |
| `trip:test`             | 39 nhóm PASS        | Trip integration harness                                                  |
| `trip:invitations:test` | 19 nhóm PASS        | Invitation integration harness                                            |
| `trip:members:test`     | 19 nhóm PASS        | Có Finance protocol fixture; không gọi là Finance E2E đầy đủ              |
| `finance:test`          | 122 nhóm PASS       | Trip–Finance thật; các provider/mock và fault injection vẫn thuộc harness |
| `notification:test`     | 7 nhóm PASS         | Self management/event integration; không chứng minh push delivery         |
| `price-watch:test`      | 12 nhóm PASS        | Worker thật, provider `MOCK_FLIGHT`                                       |

## 2. Backend chạy nhưng Web chưa tích hợp

- **Finance/Fund:** API đã chạy được; Web adapter vẫn unavailable. Demo đóng góp thủ công không chuyển tiền ngân hàng thật.
- **Notification:** preferences/devices/inbox/read ở Backend; Web chưa nối và chưa có push sender.
- **Price Watch:** API/DB/worker/lifecycle chạy được, Web chưa nối; `MOCK_FLIGHT` không phải giá vé trực tiếp.
- **Membership leave/remove:** Backend có lifecycle; `demo:api` chứng minh leave qua Trip–Finance thật. Web chưa nối nút leave/remove; remove không nằm trong live browser suite.

Không mở rộng UI các module này trong đợt fix nhẹ. Phần Packing/Dress Code/Map hoặc lịch nháp trên thiết bị không được coi là dữ liệu đã lưu Backend.

## 3. Đã triển khai nhưng từng kiểm thử thất bại

Các lỗi dưới đây đã xử lý và kiểm thử lại; không còn là blocker của chuỗi demo đã nghiệm thu:

- Launcher demo trước đây dùng watcher development: contract generation/test chạm các file được watch, gây rebuild/restart giữa request và có lần trả `503 SERVICE_UNAVAILABLE`. Demo hiện không hot reload; development vẫn giữ watcher. Đã chạy build/contracts khi demo hoạt động rồi tiếp tục nghiệm thu browser thành công.
- `demo:api` từng gọi GET chi tiết và DELETE Price Watch không có trong route contract. Đổi script sang list theo Trip và POST `pause/resume/stop`, không thêm API; chuỗi API pass lại sau reset.
- Notification preferences `{ group_overrides: {} }` bị từ chối khi protobuf bỏ repeated field rỗng. Chuẩn hóa absence thành danh sách rỗng, thêm regression test; vẫn từ chối input sai kiểu.
- Control channel cũ báo nhận lệnh trước khi launcher thoát. Nay chỉ trả thành công sau khi child dừng; có unit regression, không kill toàn bộ Node trên máy.

Nếu vòng kiểm tra mới thất bại, phải cập nhật báo cáo này; các lần PASS ở trên không miễn trừ regression tương lai.

## 4. Chưa hoàn thiện hoặc chưa xác minh

- Mobile build/integration, deploy domain, TLS/mTLS, reverse proxy production, Dockerfile toàn bộ app, CI remote và cài mới từ máy không cache: **NOT RUN**.
- Production internal transport vẫn có guard chặn plaintext; không tắt guard để đưa demo lên domain.
- Provider giá thật, FCM/push, Reminder, Travel/Export và Finance notification delivery: chưa hoàn thành trong scope này.
- MoMo demo giữ `MOMO_SANDBOX_MODE=disabled`; mock chỉ trong test harness. Không nghiệm thu MoMo live/sandbox bên ngoài hoặc thanh toán thật.
- `SELECTED_MEMBERS` vẫn giới hạn phía Web; chưa có acceptance toàn bộ policy editor.
- Không kiểm thử tải dài ngày, nhiều máy, backup/restore hoặc toàn bộ kịch bản phân tán lỗi mạng.
- Không đổi SRS v2.3, ERD v1.2 hoặc migration/schema baseline. Chỉ cập nhật tài liệu vận hành và API additive `session_id`/link configuration đúng thay đổi thực tế.

## An toàn dữ liệu và bàn giao

Reset chỉ xóa `wolfari-demo_postgres_data`, `wolfari-demo_rabbitmq_data`, `wolfari-demo_minio_data` của instance đã kiểm tra. Dữ liệu demo cũ mất nếu không có backup; đã tái tạo bộ seed mới. Không chạy prune hoặc development `down -v`.

Sau reset, ba volume `wolfari_postgres_data`, `wolfari_rabbitmq_data`, `wolfari_minio_data` vẫn tồn tại với project label `wolfari` và `CreatedAt=2026-09-23T09:29:22Z`. Đây là kiểm tra metadata/đúng target, không phải so sánh byte-level snapshot toàn bộ dữ liệu.

`.local/demo/`, `.env`, `dist-demo/` và browser test artifacts được Git ignore. Kiểm tra nội dung các file thay đổi/untracked không phát hiện mật khẩu seed, control token hoặc root secrets demo sinh ra. Không đưa journal/tài khoản/token vào tài liệu. Chưa commit/push; người dùng review diff trước khi lưu lịch sử.

Trạng thái bàn giao: demo đã dừng an toàn, bộ dữ liệu seed mới và demo volumes được giữ. Để mở lại chạy Backend `demo:start`, terminal khác `demo:check`, rồi Web `demo:preview` (đã có `dist-demo/`) hoặc `demo:dev`; không cần reset/seed lại nếu dữ liệu chưa bị sửa.
