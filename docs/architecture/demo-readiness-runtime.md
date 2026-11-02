# Phụ lục runtime — nghiệm thu Web + Backend localhost

Mở ngày02/11/2026, chốt chuyển D ngày03/11/2026 theo yêu cầu người dùng. **PHASE_D_DRAFT / NOT_READY_TO_MERGE** cho toàn đợt; không thay thế SRS/ERD/DDL chính thức hoặc sửa báo cáo lịch sử. Chỉ hai repo Web/Backend, Finance TEST và `MOCK_FLIGHT`; không production/Mobile.

## Phiên bản tích hợp

- Backend baseline `feat/demo-1-backend` / `ebd3550d2cc3d5dc96ae25a0b0dbaba10a326be4`.
- Backend `origin/main` đã fetch: `37a4b5786f913f2ce2705204d013076cbcf1bd3a`.
- Merge local trên `feat/demo-1-readiness-backend`: `bec284f6b14e6451fd2e988acde8ae831c307f8a`.
- Web nguồn `draft/demo-ui-ux` / `6a6a7d1b4daa2a9aed892c0418a1461b466627eb`; source candidate `20063c08999caaf129c16195260566088fbfb52f` trên `feat/demo-1-readiness-web`, sau đó thêm docs-only commit. Hash implementation cuối `c0563a73f5906acda31424f6c5d8dc8ca34facc9cdeb6dea9d6142643b221fc3`; xem giới hạn live sau sửa bên dưới.
- Không đưa Backend PR #14–16 vào candidate. Giai đoạn A–C chưa push/create PR/merge remote; người dùng đã yêu cầu chuyển D. [Bàn giao D](../../../Wolfari-web/docs/PHASE_D_HANDOFF.md) ghi gate và quy trình remote.

Hai conflict trong workflow và integration dispatcher đã được giải quyết giữ cả Demo 1 lẫn Finance notification. Automation HTTP endpoint của harness dùng cùng biến cổng với service thực. Catalog hợp nhất **113 RPC**, không bỏ day-only, `rejected_reason` hoặc Finance context. Tái sinh contracts từ source, kiểm tra reproducibility và compatibility với `origin/main`. Không tạo public API, schema/migration nghiệp vụ mới hoặc sửa migration đã áp dụng.

## Gate Backend tại merge `bec284f`

Các lệnh dùng `corepack pnpm`, Node24.19.0/pnpm10.34.5, Windows, Docker Linux. Unit2 workers; integrations chạy tuần tự. Kết quả là local, không CI.

| Lệnh | Kết quả hiện hành |
|---|---|
| install --frozen-lockfile / build / lint | PASS |
| test --maxWorkers=2 | PASS 126 files / 1896 tests |
| contracts:generate / lint / check / rest | PASS; REST109 entries và6 tests |
| contracts:breaking --against origin/main | PASS |
| contracts:test --maxWorkers=2 | PASS15 files /78 tests |
| db:test | PASS30 groups; empty DB, upgrade fixture, constraints, rollback, restart |
| identity:test | PASS27 groups |
| trip:test | PASS39 groups |
| trip:invitations:test | PASS19 groups |
| trip:members:test | PASS19 groups; Finance protocol fixture, không Finance E2E |
| finance:test | PASS122 groups; real Trip/Finance, SQL failure/concurrency fixtures |
| notification:test | PASS7 groups |
| price-watch:test | PASS12 groups; MOCK_FLIGHT |
| demo:acceptance | PASS9 groups; real Gateway/services, không business SQL seed |
| finance:outbox:test | PASS10 groups; broker capture queue, không Automation consumer |
| finance:notification:test | PASS61 groups; real service chain, synthetic failure/concurrency fixtures |
| dev:test trên disposable source replay | PASS7 liveness endpoints, graceful IPC shutdown Windows; không copy cấu hình/dependencies cá nhân |

Raw command/exit/source records nằm trong Web `test-results/readiness/20261102/`; riêng các label `candidate-*`, `merged-*`. Raw logs không đưa vào Git vì có thể có signed URLs hoặc dữ liệu nhạy cảm. Bản tổng hợp đã lọc và kết quả Web/live/manual ở [readiness](../../../Wolfari-web/docs/demo-readiness-validation.md).

## Demo cá nhân và an toàn dữ liệu

Trước test: không có volume `wolfari-demo_*`; còn29 file config/journal cũ. Đã copy và đối chiếu29/29 SHA trong `.local/backups/readiness-20261102/demo`. Đây là backup file, **không phải backup PostgreSQL**. Không reset/reseed hoặc sửa journal để né trạng thái tài khoản thiếu.

Các harness integration dùng project/ports/volumes riêng và chỉ tự dọn tài nguyên test. `db:test` có SQL fixtures để kiểm migration từ V001/V002 và fail-closed với dữ liệu cần backfill; không áp SQL ép trạng thái trên demo người dùng. Rollback code không bảo đảm downgrade schema an toàn.

`demo:init/start/check/accounts/stop` là vận hành instance cá nhân; giữ volumes khi stop. Xem [runbook](local-demo.md). Delivery Finance **không bật mặc định** ở instance này. Acceptance Web bật cặp flags Finance/Automation trong broker riêng cho contribution request và Holder review; không cho phép coi shared bindings/consumer chưa nghiệm thu là hoàn tất. Xem [Finance inbox](finance-notification-inbox.md).

Ngày03/11 đã kiểm chứng chính bộ lệnh trên với Web `demo:build/preview` tại localhost5273, tạo5 TEST accounts bằng UI/Mailpit và đọc lại dữ liệu sau stop/start. Trip smoke có balance500000/ledger2; Trip trình diễn riêng giữ khoản chưa report. Credentials chỉ lưu trong `.local/demo/readiness-20261102.json`; không ghi đè `seed.json` cũ, không reset/reseed. Các bộ cũMISSING không được gọi là tài khoản hiện hành. `demo:stop` đã giữ volumes và dừng sạch Backend/Web.

Live acceptance đạt dev1 + preview2 liên tiếp: runs `20261102172120-6606e567`, `20261102172641-398317aa`, `20261102173053-fb54789f`. Backend implementation hash `3298ef26df465d4d1437c97bcabbf491000a316b86b945aed59ebfdf7b41ee9f`, cùng Web hash `3926bfa939c8f18c0b29dc78b4a9dbec9f2e6d77c273c41bfa01d6c74bde5152`; mỗi run1 scenario/15 steps, exit0, no runner retry. Chỉ docs Backend thay đổi sau các lượt này; Web test workarounds/coverage limits ghi riêng trong readiness.

## Hồ sơ chính thức giữ nguyên

SHA-256 baseline đã ghi nhận; phải đối chiếu lại khi bàn giao:

| DOCX | SHA-256 |
|---|---|
| DDL/API/Event v1.1 | `CD545629188CA2F29CECC2033CE75017637F47104A59EEBC2DC9AD17DD79047C` |
| ERD v1.2 | `93919E301ECF04C5F0ACA729D900A57EE04B5B99F1E8F0FC503E630A218638B8` |
| SRS v2.3 | `9F4A28701E41C32A0635C9AC7F465065781A001BBB2980DD264DE0E3838ABB0E` |

## Còn thiếu để chốt

Trước Web RD-09: full fixture208/208 và Gateway127/127 đạt cả dev/built, live dev1+preview2 và personal launcher/smoke đạt. Source replay mới cũng đạt preview15 steps (`20261102181858-e7d23909`). Sau đó Web sửa chặn mở form quỹ khi authoritative queries chưa xong; focused Finance3/3, unit586 và lint/typecheck/demo build đạt. Live mở rộng cuối FAIL tại Delete/reload Plan; test sequencing đã chỉnh, NOT_RERUN theo yêu cầu chốt. Chuỗi dev1+preview2 trên bản cuối và Edge rehearsal2 lượt +30 phút/native zoom chưa đạt. Backend implementation không đổi sau các gates ghi ở trên.

Chuẩn bị commit/push/Draft PR theo giai đoạn D; CI trên HEAD, reviewer và live cặp Backend main sau merge vẫn bắt buộc. Không gắn nhãnREADY/MAIN_VERIFIED từ PASS Backend. Clone + source overlay không là clean committed checkout/máy sạch hoàn toàn. Dependencies của hai clone đã dọn; source/evidence và ba volumes demo cá nhân được giữ.

Hướng dẫn liên repo: [chạy Web](../../../Wolfari-web/HUONG_DAN_BUILD_VA_CHAY_DEMO_1.md), [demo trực tiếp](../../../Wolfari-web/docs/HUONG_DAN_DEMO_TRUC_TIEP.md), [PR/merge](../../../Wolfari-web/docs/HUONG_DAN_PR_VA_MERGE_MAIN.md).
