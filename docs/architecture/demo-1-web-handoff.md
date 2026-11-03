# Demo 1 — bàn giao Backend → Web

28/10/2026, nhánh Backend `feat/demo-1-backend`, chưa commit/push. Đây là danh sách tích hợp tiếp theo, **không phải báo cáo Web đã hoàn thành**. Audit gốc tại thư mục cha vẫn giữ nguyên.

Nguồn hiện hành: [phụ lục v1.0](demo-1-addendum-v1.0.md), [Plan](../api/plan.openapi.json), [Trip/policy](../api/trip-core.openapi.yaml), [members](../api/trip-member-lifecycle.openapi.json), [Fund/ledger](../api/finance-fund.openapi.json), [contributions](../api/finance-contributions.openapi.json). Bằng chứng Backend: [validation](demo-1-backend-validation.md).

## 1. Mapping 34 tác vụ bắt buộc của audit

“Backend sẵn có/đã bổ sung” chỉ đóng phần Backend của tác vụ. Các hàng Web-only không cần phát minh API/schema. Ma trận ảnh hưởng tài liệu cho thay đổi Backend ở phụ lục; ma trận chi tiết audit vẫn áp dụng cho phần Web.

| ID      | Phần Backend trong đợt này                                       | Việc Web còn phải làm / gate                                                                      |
| ------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| INF-01  | Launcher, forward migration, volumes bền; thêm acceptance cô lập | Chạy UI thật với Gateway; restart/reload giữ dữ liệu                                              |
| INF-02  | Thêm dependency diagnostics; core readiness độc lập Finance      | Hiển thị lỗi theo module, không suy diễn health thành nghiệp vụ PASS                              |
| INF-03  | Runbook operation; retry CLI có --demo                           | Giữ intent/key, poll202, không báo thành công sớm                                                 |
| INF-04  | demo:accounts read-only; seed không reset password ngầm          | Dùng tài khoản journal thật; không hardcode password                                              |
| AUTH-01 | Identity regression thật giữ nguyên API                          | Nghiệm thu register/verify/reset/profile/avatar/sessions qua UI                                   |
| AUTH-02 | Server đã test rotation/reuse và logout; không nới guard         | Single-flight refresh giữa tab; phối hợp logout, tránh token-family reuse                         |
| AUTH-03 | Không cần Backend/schema                                         | Xóa/cách ly draft/cache khi đổi user/logout                                                       |
| HOME-01 | Trip list có runtime                                             | Entry point tới Trips, empty/error state; không vào module unavailable                            |
| TRIP-01 | Create chỉ nhận trường đã đặc tả                                 | Loại/khóa field chỉ local; không báo đã lưu                                                       |
| TRIP-02 | Interval/timezone đã chốt; ngày chỉ lịch bổ sung cho Activity    | Đổi date form sang instant theo IANA đúng; end-exclusive                                          |
| TRIP-03 | Projection contract có sẵn                                       | Decoder runtime nghiêm, không ép cast/default dữ liệu lỗi                                         |
| TRIP-04 | Receipt/hash giữ nguyên intent; regression replay                | Persist body/key, retry cùng intent sau timeout                                                   |
| TRIP-05 | Trip/Plan/members/Fund có reads độc lập                          | Overview dùng dữ liệu server, lỗi từng phần, không fake stats                                     |
| PLAN-01 | API039–044 đầy đủ, thêm OpenAPI                                  | Hợp nhất timeline/drawer/bảng thao tác vào server state                                           |
| PLAN-02 | Timed/overnight runtime; regression                              | Form date/time/timezone đúng, end ngày sau không bị chặn                                          |
| PLAN-03 | V003 + scheduled_date REST/RPC/service/constraint                | Thêm day-only vào model/decoder/adapter/UI; không đặt00:00 giả                                    |
| PLAN-04 | Reorder nguyên tử giữ API hiện có                                | PUT thứ tự toàn bộ đúng contract; khóa cascade giờ chưa hỗ trợ                                    |
| PLAN-05 | Quyền/version/receipt/rollback đã regression                     | Reload khi409; chỉ đổi UI sau save; hai phiên cộng tác                                            |
| MEM-01  | display_name nullable qua Identity RPC, fail-soft                | Tên + fallback user ID ngắn, không dùng email giả/đặt tên suy đoán                                |
| MEM-02  | GET Owner-only policy + selected assignments                     | Load/edit selected; expected_membership_revision mới; quyền theo server                           |
| MEM-03  | EMAIL/LINK acceptance tài khoản mới qua Mailpit                  | Accept/decline/error/expiry qua giao diện thật; không consume khi preview                         |
| MEM-04  | Leave/remove operation + Finance obligation thật                 | Nối nút, cảnh báo đúng, poll và invalidate quyền; Owner/Holder guard                              |
| FIN-01  | GET Fund/destination/request/contribution/ledger                 | Nối read adapter; phân biệt chưa có Fund với503/403                                               |
| FIN-02  | Setup/budget/destination/Holder confirm; OpenAPI mới             | Form đúng role; ngân sách không phải balance; đích TEST rõ ràng                                   |
| FIN-03  | Đợt thu CRUD/waive/cancel đã có và regression                    | Nối management UI/version; bảo toàn destination snapshot                                          |
| FIN-04  | Self report, Holder reject/confirm; exactly-once ledger          | Hoàn thiện vòng UI ba actor; hiển thị lý do, cấm Owner override Holder                            |
| FIN-05  | Ledger int64 string/cursor, balance thật                         | Money không dùng Number tùy tiện; reload/reconcile, không cộng local                              |
| FIN-06  | Operation protocol đã có, không thêm route                       | Command wrapper chung202/503/unknown outcome, polling và replay                                   |
| SAFE-01 | Packing chưa có public writer; không thêm ngoài scope            | Khóa/ghi rõ preview, bỏ toast “đã lưu” khi chỉ React state                                        |
| SAFE-02 | Không cần Backend mới                                            | Bỏ fake price/map/stats, nút không có tác dụng phải ẩn/disabled có lý do                          |
| UX-01   | Error envelope/version/correlation có sẵn                        | Desktop/narrow/keyboard/focus/overlay; lỗi dễ hiểu, không lộ stack                                |
| QA-01   | Acceptance API thật5actor + regression                           | Browser E2E mới từ tài khoản mới, reload/user khác/two tabs; không dùng fixture để nghiệm thu     |
| DOC-01  | Addendum, README/runtime/ERD synced; giữ DOCX                    | Cập nhật integration matrix/README Web đúng endpoint và giới hạn; Mobile chỉ đánh giá tương thích |
| DOC-02  | OpenAPI Plan/Fund, policy/members + inventory/projection tests   | Dùng decoder tương ứng; không cộng base /api/v1 hai lần                                           |

## 2. Quy tắc tích hợp không được bỏ qua

| Thao tác                       | Quyền / version / kết quả                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Trip create/update             | Owner; create client_request_id=key nếu header có; update expected_plan_version và expected_export_revision |
| Plan structural edit           | Owner hoặc editor có hiệu lực; expected_plan_version; completion theo actor attribution riêng               |
| Policy get/put                 | Owner; GET không tăng revision; PUT expected_membership_revision                                            |
| Member list                    | Active member; display_name có thể null; policy không suy ra chỉ từ role MEMBER                             |
| Fund enable/budget/destination | Owner cấu hình; Holder xác nhận; tiền chuỗi nguyên VND; expected_finance_version theo OpenAPI               |
| Report transfer                | Self contribution; expected_version và expected_finance_version; không tăng balance                         |
| Reject/confirm received        | Holder hiện tại; confirm mới ghi ledger; gửi lại cùng key không cộng tiền lần hai                           |
| Leave/remove                   | Member tự leave/Owner remove; Finance có thể chặn hoặc waive PENDING; mất quyền chỉ khi terminal success    |

Không cache dữ liệu quyền qua logout/user khác. Không dùng mutation receipt cũ làm toàn bộ state hiện tại: sau replay phải GET lại. Event không phải kênh cập nhật tiền tin cậy cho demo1. Web client không gọi RPC nội bộ hoặc giữ service secret.

Trường day-only là calendar string, không phải Date UTC. Khi đổi timed→day-only gửi null hai timestamp; đổi day-only→timed gửi pair timestamps. UI dùng Trip.timezone để render. Legacy client bỏ field trong PATCH thì giữ ngày; decoder nghiêm của Web/Mobile phải nhận field response mới.

API errors: 400 validation;401 session;403 role;404 inaccessible/missing;409 version/state/idempotency;503 dependency retryable. Đọc unavailable không trả fake empty, ghi unknown không đổi key. Token/link invitation/refresh/password tuyệt đối không ghi trace/HAR công khai.

## 3. Thứ tự Web và tiêu chí nghiệm thu

1. P0 trung thực dữ liệu: draft theo user, field tạo Trip, day/time projection, Packing/placeholder.
2. Core: auth/session, navigation/Trip/overview, timeline server, policy/members/invites.
3. Quỹ: reads → setup/destination → đợt thu → manual commands/operations → balance/ledger.
4. Narrow viewport/accessibility, lỗi/version conflict/retry, regression hai phiên.
5. Demo từ tài khoản mới: Owner tạo Trip; EMAIL invite Holder, LINK invite Editor/Member; chọn editor; day-only+overnight; tài khoản khác đọc; Owner bật Fund, Holder confirm đích TEST; Editor báo200000, bị reject rồi báo lại, Holder confirm; Member báo300000, Holder confirm. Tổng500000, đúng hai ledger IN; reload/restart không mất. Member settled leave được; outsider không đọc; Holder/Member còn nghĩa vụ bị chặn đúng trường hợp.

`demo:acceptance` là Backend API E2E và tự dọn dữ liệu kiểm thử; không thay Browser E2E. Toàn bộ Web/mobile/browser/production/CI sau push trong đợt Backend này là **NOT RUN**.

## 4. 15 nhóm vẫn hoãn, không đánh dấu hoàn thành

- LATER-TRIP: date-change preview/KEEP/SHIFT, duplicate, transfer Owner, lifecycle Trip đầy đủ.
- LATER-ID: OAuth, đổi email, xóa account/retention.
- LATER-FIN1: expense/receipt/note Web; Backend có runtime không đồng nghĩa UI hoàn tất.
- LATER-FIN2: reversal/refund/closure Web.
- LATER-PAY: provider thanh toán thực/production.
- LATER-AUTO1: Finance outbox relay và delivery.
- LATER-AUTO2: Notification/Price Watch Web/provider-delivery truthfulness.
- LATER-AUTO3: Reminder scheduler/context.
- LATER-MAP: Locations CRUD và liên kết Map.
- LATER-PACK: Packing CRUD/assignment/completion server.
- LATER-DRESS: Dress Code writer theo scope.
- LATER-DSS: Travel providers/DSS Preview-Apply.
- LATER-EX: Export immutable snapshot/Public Share; cần thêm lịch ngày chưa giờ vào snapshot lúc triển khai.
- LATER-ADMIN: portal/audit/support workflow.
- LATER-INF: Docker app image, service DNS/TLS/secrets/backup/production-domain.

Chỉ mở lại khi có scope/contract/acceptance riêng; không tắt authorization, constraint hay production guard để làm màn hình có vẻ chạy.
