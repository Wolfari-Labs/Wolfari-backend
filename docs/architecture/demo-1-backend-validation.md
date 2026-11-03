# Demo 1 — kiểm chứng Backend

Ngày: **28/10/2026, Asia/Saigon**. Repository `Wolfari-backend`. Nhánh `feat/demo-1-backend`; base/HEAD trước commit `1154c740b6c04b455b551d70eeb0dec4e2da3388`, working tree có thay đổi triển khai **chưa commit/push**. Không thay Web/Mobile/audit gốc.

## 1. Kết luận theo phạm vi

Backend đủ để Web bắt đầu tích hợp demo1 **core + quỹ đóng góp thủ công** với contract mới. Chưa thể kết luận toàn bộ sản phẩm Web demo đã hoàn thành: timeline/day-only, policy, quỹ, commands/polling và các hành động false-success phải được tích hợp/nghiệm thu bên Web.

Triển khai bổ sung: Trip V003/day-only Activity, Owner policy GET, tên thành viên enrichment Identity, diagnostics tách core/dependency, read-only demo:accounts, seed fail-safe khi password journal không còn dùng được, recovery CLI --demo, OpenAPI Plan/Fund và gate inventory. [Phụ lục](demo-1-addendum-v1.0.md) mô tả thay đổi tài liệu/contract; [handoff](demo-1-web-handoff.md) map đủ34 tác vụ bắt buộc và15 nhóm hoãn.

## 2. Môi trường và mức bằng chứng

Windows PowerShell; Node24.19.0, pnpm10.34.5; Docker Desktop Linux engine, PostgreSQL/MinIO/RabbitMQ/Mailpit theo Compose repo. Mọi integration dùng project/port/volume thử nghiệm riêng, không apply migration/reset trên DB demo người dùng. Harness tự dọn tài nguyên của chính nó sau mỗi lần chạy; không xóa volume development/demo.

Hai phần làm việc trong cùng ngày: các suite nền chạy từ khoảng00:00–00:30; sau phiên bị ngắt, kiểm tra cuối build/unit/contract/demo/Price Watch chạy lại khoảng09:40 trở đi. Lần Price Watch bị mất session không được tính PASS; đã chạy lại và thu exit0. Docker đã dừng sau phiên ngắt nên được mở lại; không dùng trạng thái container/health thay bằng chứng nghiệp vụ.

Unit/mock, HTTP contract và service integration được phân biệt dưới đây. “Nhóm” là bộ assertions nghiệp vụ do harness báo, không phải số unit test và không cộng gộp thành một số test.

## 3. Commands và kết quả

Các command thực sự đã chạy trong repository này; trước integration là build thành công cùng source. Script pnpm tương ứng tự build nếu người dùng chạy lại.

| Command                                                                               | Kết quả mới                              | Loại bằng chứng / phạm vi                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm build`                                                                 | PASS                                     | TypeScript toàn workspace (11 project con)                                                                                                                            |
| `corepack pnpm lint`                                                                  | PASS                                     | ESLint; lỗi unused variable ở bản đầu đã sửa và chạy lại                                                                                                              |
| `corepack pnpm test`                                                                  | PASS **113 files / 1.595 tests**         | Unit, parser, fixture, HTTP mock; không thay real integration                                                                                                         |
| `corepack pnpm contracts:lint`                                                        | PASS                                     | Protobuf lint                                                                                                                                                         |
| `corepack pnpm contracts:check`                                                       | PASS                                     | Catalog112 RPC, generated source reproducible, inventory109 method/path entries và19 source fingerprints                                                              |
| `corepack pnpm contracts:breaking --against 1154c740b6c04b455b551d70eeb0dec4e2da3388` | PASS                                     | Protobuf/event compatible với base; không tự bảo đảm Web decoder chịu field mới                                                                                       |
| `node scripts/database-integration.mjs`                                               | PASS **30 nhóm**                         | PostgreSQL thật; upgrade V002→V003/legacyNULL, CHECK rollback, isolation20/20 cross-DB denied, readiness/outage                                                       |
| `node scripts/identity-integration.mjs`                                               | PASS **19 nhóm**                         | Gateway/Identity/Trip/Automation + MinIO/broker/SMTP thật; cookies/CSRF, reset/password/profile/avatar/session, outage recovery                                       |
| `node scripts/trip-integration.mjs`                                                   | PASS **39 nhóm**                         | Trip/Plan thật; auth/version/replay/atomicity/permissions/concurrency                                                                                                 |
| `node scripts/trip-integration.mjs --invitations`                                     | PASS **19 nhóm**                         | EMAIL/LINK thật, Mailpit, event/retry/dedup/rollback/races                                                                                                            |
| `node scripts/trip-integration.mjs --members`                                         | PASS **19 nhóm**                         | Trip/DB/broker thật nhưng **Finance protocol fixture**, không gọi đây là Finance E2E                                                                                  |
| `node scripts/trip-integration.mjs --finance`                                         | PASS **122 nhóm**                        | Trip/Finance/DB/MinIO thật; provider payment mock/test-only; lifecycle obligations thật, exactly-once ledger/rollback/recovery, các module Finance mở rộng regression |
| `node scripts/trip-integration.mjs --notifications`                                   | PASS **7 nhóm**                          | Gateway/Automation/DB thật; preference/device/inbox/read/privacy, không phải push provider                                                                            |
| `node scripts/trip-integration.mjs --price-watch`                                     | PASS **12 nhóm**                         | Real service/DB/worker; **MOCK_FLIGHT**, không chứng minh giá provider thật                                                                                           |
| `node scripts/trip-integration.mjs --demo1`                                           | PASS **9 nhóm**                          | Real Gateway +5 actor, no business SQL seed; kịch bản dưới đây                                                                                                        |
| `corepack pnpm exec vitest run packages/contracts/src/demo1-openapi.test.ts`          | PASS **6 tests** (cũng trong full suite) | Compile/resolution JSON schemas, route6 Plan+8 Fund, actual projection/nullable/int64; chưa phải browser                                                              |

CLI mới `corepack pnpm demo:acceptance` ghép `build` + `node scripts/trip-integration.mjs --demo1` đã chạy tách từng bước ở trên. CI thêm job demo1-acceptance trong `.github/workflows/contracts.yml`, nhưng **GitHub Actions sau push: NOT RUN** (không push).

## 4. Kịch bản API demo1 đã chạy thật

Nguồn executable: `scripts/demo1-acceptance.mjs` và harness `scripts/trip-integration.mjs`.

1. Tạo5 account mới Owner/Holder/Editor/Member/outsider; xác minh qua RabbitMQ→Automation→Mailpit, không cập nhật verification bằng SQL.
2. Owner tạo Trip, EMAIL invite Holder và LINK invite Editor/Member; accept. Danh sách trả tên qua Identity; policy selected đọc được bởi Owner, Member403/outsider404.
3. Editor tạo ngày chưa giờ, title-only kiểu client cũ giữ ngày; chuyển sang23:00→01:00 hôm sau, rồi day-only. Dates ngoài Trip/không có thật bị400; Member không có edit bị403; completion/reopen theo quyền; bốn actor cùng thấy dữ liệu.
4. Replay create receipt sau nhiều chỉnh sửa không ghi đè dữ liệu hiện tại. Explicit null clear; conflict day+time bị400 và không tăng version. Boundary qua năm, DST NewYork23h và Apia skipped-day được test bằng API thật.
5. Owner khác Holder bật quỹVND với đích TEST, ngân sách1000000 nhưng balance0. Holder xác nhận đích. Đợt thu Editor200000+Member300000; report không tăng tiền, reject rồi report lại, Holder confirm. Retry cùngkey không cộng lần hai. Balance500000 và hai dòng ledger; kiểm paging và SQL **read-only** exact amounts.
6. Restart Trip vẫn giữ Activity/balance. Member settled leave qua Trip→Finance thật, operation terminal SUCCEEDED, sau đó đọc Trip404 và tiền không đổi.
7. Dừng Finance trong harness: core readiness200, dependency endpoint503/finance=down, Fund read503 (không fake empty), Plan vẫn đọc được.
8. Harness kết thúc tự dọn project riêng. Không dùng browser fixture hoặc sửa SQL nghiệp vụ để hoàn tất các bước trên.

Chín nhóm gồm hai nhóm startup/hạ tầng cộng bảy nhóm nghiệp vụ/chịu lỗi. Finance suite122 còn kiểm TRANSFER_REPORTED/active payment/refund/Holder chặn leave, waiver pending, COMMITTED recovery, races và rollback; demo mới không thay thế các suite sâu này.

## 5. Phạm vi chưa chạy / còn phải nghiệm thu

- **Web browser thật, hai tab phối hợp refresh, responsive/keyboard, reload UI và cache khi đổi tài khoản: NOT RUN** trong nhánh Backend. Identity HTTP đã test cookie/reuse; không coi đó là browser coordination.
- **Mobile: NOT RUN**, không sửa. Protobuf additive pass; strict JSON decoder vẫn cần tích hợp.
- **Production/domain/TLS/Docker app image: NOT RUN**; chưa nằm trong scope, guard production giữ nguyên.
- **GitHub CI: NOT RUN**; job đã thêm nhưng chưa commit/push.
- **demo:start/demo:seed/demo:accounts trên DB demo của người dùng: NOT RUN** để giữ dữ liệu/session. Unit kiểm journal/schema/no-secret/read-only; real API harness chứng minh backend, không tuyên bố password hiện tại của người dùng đã được kiểm tra.
- **CLI retry --demo --execute trên dữ liệu thật: NOT RUN**. Cơ chế retry/dry-run đã regression tại service trong membership/Finance harness; không tự lên lịch retry operation của người dùng.
- Mermaid đã đối chiếu migrations, chưa render hình. Ba DOCX giữ nguyên; phụ lục phải hợp nhất khi phát hành baseline mới.
- Finance relay, Reminder/push/provider thật, Travel/DSS, Export/Share/Admin và15 nhóm hoãn chưa hoàn tất; không dùng các test mock/provider test-only để tuyên bố chúng chạy production.

## 6. An toàn bàn giao

Kiểm tra cuối: `git diff --check` PASS;180 liên kết cục bộ trong12 Markdown thay đổi đều tồn tại;10 checksum DOCX/forward migrations khớp (bao gồm V003 mới). Working tree Web/Mobile sạch khi kiểm tra. Không còn container có tên project test của các harness; không dừng/xóa tài nguyên ứng dụng khác. `contracts:rest` chạy lại sau chỉnh validation OpenAPI, PASS6 tests và inventory109 entries.

Không commit/push; không thay main. Không sửa migrations đã áp dụng, chỉ thêm Trip V003 + forward checksum. Không sửa ba DOCX/checksum baseline. Không sửa Web/Mobile hoặc file audit gốc. Không có credential/token/seed journal trong danh sách thay đổi Git.

Bước tiếp theo: triển khai Web theo [handoff](demo-1-web-handoff.md), sau đó chạy nghiệm thu UI đầy đủ. Backend API đã đủ cho phạm vi này; chưa đánh dấu toàn bộ34 tác vụ audit là hoàn thành vì nhiều tác vụ thuộc Web.
