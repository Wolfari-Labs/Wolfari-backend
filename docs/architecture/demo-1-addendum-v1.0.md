# Demo 1 — phụ lục kỹ thuật Backend v1.0

Ngày triển khai: 28/10/2026. Nhánh: `feat/demo-1-backend`; base `1154c740b6c04b455b551d70eeb0dec4e2da3388`. Thay đổi chưa commit. Phạm vi được duyệt: core + quỹ đóng góp thủ công, chỉ Backend. Đây không phải xác nhận Web đã chạy đủ hoặc production-ready.

## 1. Thứ tự tham chiếu

Giữ nguyên SRS v2.3, ERD v1.2, DDL/API/Event Specification v1.1 và checksum DOCX. Phụ lục này bổ sung đúng các thay đổi additive dưới đây; không thay toàn bộ baseline, không đóng các FR còn thiếu. Với lịch ngày chưa giờ, GET policy và tên thành viên, dùng phụ lục + OpenAPI/Protobuf mới thay mô tả cũ thiếu các trường/route đó. Cần hợp nhất phụ lục vào bản tài liệu chính thức kế tiếp trước khi phát hành baseline mới. Retention 30/90 ngày vẫn chưa được quyết định.

| Hạng mục                          | SRS                                                                                      | ERD/migration                                                                                        | DDL/API/Event                                                       | OpenAPI/Protobuf/event schema                                                                                                 | Runtime/README                                                | Mobile                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| PLAN-03 ngày chưa giờ             | Cần cập nhật tiêu chí FR-PL cho ba chế độ thời gian trong phụ lục này; không tạo giờ giả | Cần cập nhật: Activity.scheduled_date, Trip V003, trip_db.mmd                                        | Cần cập nhật API039–042 và mô tả Activity; event không thêm payload | Cần cập nhật PlanActivity field17, Create field13, Update StringPatch field14; REST nullable date. Không cần đổi event schema | Cần cập nhật: phụ lục, bàn giao, migration/readiness          | Cần xác minh thêm cách client cũ parse field; wire additive, không triển khai Mobile |
| MEM-01 tên thành viên             | Không cần đổi quyền; vẫn active member được đọc danh sách                                | Không cần: không lưu bản sao profile, không FK/SQL xuyên DB                                          | Cần cập nhật projection ListMembers                                 | Cần cập nhật Membership optional display_name=7 và REST list nullable; không đổi Identity RPC/event                           | Cần cập nhật fallback và privacy                              | Cần xác minh thêm decoder; field mới optional                                        |
| MEM-02 đọc policy                 | Không cần đổi quyền sửa; GET mới Owner-only cùng phạm vi quản trị editor hiện có         | Không cần: dùng trip_plan_editors/membership_revision hiện có                                        | Cần cập nhật GET /trips/{trip_id}/plan-policy, RPC GetPlanPolicy    | Cần cập nhật catalog (112 RPC), message request/response; không đổi PUT/event                                                 | Cần cập nhật cách đọc selected/inert assignments              | Không cần thay client đang chỉ gọi PUT; cập nhật khi thêm màn quản trị               |
| INF-01/02/03/04, QA-01            | Không cần đổi nghiệp vụ                                                                  | Không cần, trừ readiness yêu cầu Trip V003 như trên                                                  | Không cần đổi contract nghiệp vụ                                    | Không cần đổi RPC/event; endpoint vận hành /health/dependencies được mô tả tại đây                                            | Cần cập nhật: diagnostics, accounts, retry --demo, acceptance | Không cần; không đưa secrets vận hành vào app                                        |
| DOC-02 Plan/Fund OpenAPI          | Không cần; đặc tả hóa runtime đã có                                                      | Không cần thêm schema Finance                                                                        | Cần cập nhật trạng thái implemented của API039–044/070–077          | Cần cập nhật hai OpenAPI và inventory/test; không đổi Money/event                                                             | Cần cập nhật links, thứ tự tích hợp                           | Cần xác minh thêm nếu sinh client; không đổi các field Finance hiện tại              |
| DOC-01 Mermaid Finance/Automation | Không cần                                                                                | Cần cập nhật hình từ Finance V002 và Automation V002–V005 hiện có; không thêm migration mới cho hình | Không cần đổi hành vi đã triển khai                                 | Không cần                                                                                                                     | Cần cập nhật trạng thái lịch sử và nguồn chuẩn                | Không cần                                                                            |

## 2. Activity: ba chế độ lưu thật

- Chưa xếp lịch: `scheduled_date=null` và hai timestamp null.
- Có ngày, chưa có giờ: `scheduled_date=YYYY-MM-DD`, hai timestamp null.
- Có giờ: timestamp pair theo validation hiện hữu, `scheduled_date=null`.

Ngày tính trong `Trip.timezone`; Trip là khoảng nửa mở `[start_at,end_at)`. Ngày hợp lệ khi khoảng ngày địa phương giao Trip một khoảng có độ dài dương. PostgreSQL dùng timezone/DST thật; ngày bị bỏ qua hoàn toàn (Pacific/Apia 2011-12-30) không hợp lệ. Không dùng UTC substring để phân nhóm ngày; ngày kết thúc lúc 00:00 không tạo thêm một ngày lịch.

PATCH bỏ field = giữ giá trị; null = xóa. Từ day-only sang có giờ: gửi pair timestamps, server tự xóa ngày cùng transaction. Từ timed sang day-only: gửi cả `starts_at:null`, `ends_at:null`, `scheduled_date`. Gửi ngày khác null đồng thời timestamp khác null bị 400. Title-only từ client cũ giữ ngày đã lưu.

`expected_plan_version` và `Idempotency-Key` vẫn bắt buộc. Omission trường mới không thay canonical hash của request cũ. Trong PATCH, null (clear), date và omission là intent khác nhau; trong POST, null và omission đều được Gateway chuẩn hóa thành không truyền optional scalar (chưa xếp ngày), như các trường nullable Create hiện hữu. Replay receipt cũ không suy đoán ngày; projection trả null nếu receipt chưa có field. Replay sau chỉnh sửa trả snapshot receipt cũ và không ghi đè trạng thái hiện tại. Quyền hiện tại vẫn được kiểm tra khi replay. Không đổi field number cũ.

Create/update/delete/reorder/completion dùng lock/receipt/audit/outbox như trước. Sắp lại thứ tự là một PUT list ID nguyên tử, không phải chuỗi PATCH thời gian. Di chuyển nhiều hoạt động kèm tự tính giờ/cascade **chưa mở**. Chưa mở export snapshot runtime; legacy export Activity message không được coi là hỗ trợ day-only cho một tính năng export chưa triển khai.

Ví dụ tạo ngày chưa giờ (giữ nguyên body/key khi retry):

```json
{
  "title": "Khám phá phố cổ",
  "activity_type": "OTHER",
  "position": 0,
  "scheduled_date": "2026-11-01",
  "expected_plan_version": 1
}
```

Mutation Activity trả resource tại `data`, `export_revision` tại `meta`. GET Plan trả `data.export_revision`. Xem [OpenAPI Plan](../api/plan.openapi.json), không suy luận shape từ ví dụ cũ.

## 3. Migration và tương thích

Chỉ thêm `apps/trip-workspace-service/migrations/V003.sql`; V001/V002 không sửa. Cột nullable, CHECK loại trừ timestamp khi có ngày và giới hạn năm 0001–9999. Không backfill/suy đoán ngày từ vị trí hay cache Web. Dữ liệu cũ giữ NULL. Constraint ngày thuộc Trip được kiểm tra trong service transaction khóa Trip, không CHECK xuyên bảng.

Manifest forward thêm SHA256 V003. Readiness Trip yêu cầu V001–V003. Triển khai local: dừng demo đúng cách, chạy `demo:init` để thêm cấu hình thiếu mà giữ secrets, rồi `demo:start` áp dụng forward migration và build. Không reset volume. Development dùng `db:migrate --service trip` với đúng môi trường development. Không dùng lệnh development để sửa nhầm DB demo.

Nâng cấp cũ→mới: test chèn Activity ở V002 rồi áp dụng V003, xác minh NULL và constraint. Rollback app không tự DROP cột: sao lưu và dùng forward repair nếu thật sự cần thay schema; không sửa checksum migration đã áp dụng.

## 4. Membership và policy

`GET /api/v1/trips/{trip_id}/plan-policy` → `{data:{policy,editor_member_ids,membership_revision},meta:{correlation_id}}`. Owner active đọc được; Member 403; outsider/deleted/no membership 404. Read-only repeatable-read snapshot, không tăng revision.

`SELECTED_MEMBERS` PUT thay danh sách. `OWNER_ONLY`/`ALL_MEMBERS` PUT phải gửi list rỗng nhưng giữ assignments cũ ở trạng thái không có hiệu lực. GET trả các assignments còn active để lần sau chọn lại; không đồng nghĩa mọi ID trả về đều có quyền sửa ở policy hiện tại. Web đọc lại revision trước ghi, xử lý409 bằng reload/review, không tự ghi đè.

ListMembers phân trang/kiểm quyền tại Trip trước, kết thúc transaction rồi mới gọi Identity.GetProfiles cho tối đa100 user IDs trong trang. Deadline enrichment tối đa800ms; lọc kết quả chỉ đúng IDs. Thiếu profile/RPC lỗi → `display_name:null`, không fallback email/avatar. Kiểm quyền Trip lại sau RPC để chặn revocation giữa lookup. user_id/member_id vẫn là identity quyết định quyền, tên có thể trùng/đổi.

## 5. Microservice và diagnostics

Không thêm service/database hoặc distributed transaction. Gateway không có credential SQL. Trip giữ Plan/membership; Identity giữ profile; Finance giữ quỹ/ledger/chứng từ; Automation giữ notification/worker.

- Gateway `/health/ready` chỉ kết luận Identity/Trip core sẵn sàng.
- Gateway `/health/dependencies` kiểm Identity/Trip/Finance/Automation qua HTTP readiness, timeout2s song song; 200 `ok` hoặc503 `degraded` với checks/correlation, không trả URL/secret.
- Endpoint này không kiểm chứng một giao dịch gRPC hoặc delivery. `demo:check` thêm broker tại Identity/Trip/Automation và SMTP tại Automation, retry kết nối trong15s; vẫn cần acceptance nghiệp vụ.
- Finance lỗi phải trả503 cho read/write tương ứng, không giả số dư0 hoặc danh sách rỗng; Plan có thể vẫn chạy.
- MinIO private, Mailpit local, RabbitMQ/outbox và dependency theo [local-demo](local-demo.md). Chưa có Finance outbox delivery hoàn chỉnh; không dùng thông báo nhận tiền làm tiêu chí demo.
- Cấu hình Gateway mới: `FINANCE_HTTP_URL`, `AUTOMATION_HTTP_URL`. Chỉ loopback local; không gỡ production/TLS guards để dùng domain.

## 6. Seed/account và operation recovery

`corepack pnpm demo:accounts` chỉ đọc journal đúng instance + Identity bằng transaction READ ONLY. In role/email/status/verified và đường dẫn credentials file, không in mật khẩu/token, không tạo session, không thử đoán password. Email thực tế lấy từ journal, không giả định luôn là `demo-owner@wolfari.test`. Password mới sinh ngẫu nhiên ở `.local/demo/seed.json`; đọc riêng tại máy, không gửi vào issue/log. Nếu đã đổi password trong UI, journal có thể cũ; status ACTIVE không chứng minh password còn đúng.

Seed gặp account đã tồn tại nhưng credentials không dùng được → `DEMO_CREDENTIALS_UNUSABLE` và dừng, không tự reset/reregister. Thiếu journal/mismatch → báo lỗi. Muốn khôi phục password dùng luồng reset tại Mailpit. Reset demo chỉ khi người vận hành chủ động chấp nhận mất toàn bộ dữ liệu demo.

Với ghi Finance hoặc leave/remove:

1. Persist method/path/body/key trước request. Timeout/503/202 không phải bằng chứng chưa ghi.
2. Poll `GET /api/v1/operations/{operation_id}` bằng đúng actor; `PROCESSING/PENDING_RECOVERY` tiếp tục chờ, không gửi intent/key mới.
3. `SUCCEEDED`: retry cùng intent/key để nhận resource (Finance), rồi reload reads. Leave/remove poll vẫn được phép theo historical actor sau mất membership.
4. `FAILED`: hiển thị lỗi/outcome; chỉ tạo intent mới sau xác nhận sửa dữ liệu. `NEEDS_REVIEW`: dừng thao tác liên quan, giữ correlation/operation ID.
5. Khôi phục service/dependency trước. Với NEEDS_REVIEW đã điều tra, operator chạy dry-run rồi mới chủ động --execute. Không xóa receipt, guard hoặc sửa balance bằng SQL.

```powershell
# Các lệnh này mặc định read-only; --demo bắt buộc để chọn đúng môi trường demo.
corepack pnpm trip:retry-finance <operation-id> --demo
corepack pnpm trip:retry-lifecycle <operation-id> --demo
# Chỉ sau khi đã xem dry-run và nguyên nhân, thêm --execute để lên lịch retry cùng ID.
```

Không truyền --demo thì hai CLI dùng development .env như trước. CLI không tự khởi động worker; Trip đang chạy sẽ thực hiện recovery. CLI --demo đã có kiểm tra manifest/config; thao tác --execute trên dữ liệu demo người dùng **không được chạy trong đợt triển khai này**.

## 7. Finance và phần hoãn

API070–089 đã có foundation/runtime cho setup, reads, quản lý đợt thu, manual report/reject/confirm; API077 ledger đọc phân trang, amounts int64 dưới dạng chuỗi. Owner tạo/cấu hình; Holder xác nhận đích và tiền; Self báo chuyển. Report/reject không tăng balance; confirm tạo một ledger IN. Ngân sách khác số dư. Destination account chi tiết chỉ ở projection có quyền.

Expense, receipts, notes, reversal, refunds, closure, payment mock đã có Backend và regression riêng; không gọi chúng “chưa triển khai Backend” vì Web còn thiếu. Không nâng thành phần bắt buộc demo1. Mọi provider tiền thật, provider giá thật, Finance relay, push, Reminder, Travel/DSS, Export/Share, Admin và production còn trong backlog sau demo.

Kết quả kiểm chứng ở [validation](demo-1-backend-validation.md). Việc tiếp theo là [bàn giao Web](demo-1-web-handoff.md), không triển khai Web/Mobile trong nhánh này.
