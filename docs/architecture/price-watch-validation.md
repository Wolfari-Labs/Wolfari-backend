# Kết quả kiểm tra Price Watch Core H1

Ngày chạy local: **22/10/2026**. Đây là bằng chứng của working tree `feature/price-watch-core`; CI remote và PR chưa chạy.

## Kết quả

- Workspace build PASS; ESLint PASS; full unit 41 file/704 test PASS.
- Contract lint/check PASS; 5 file/36 contract test và breaking check so với `HEAD` PASS. Automation có 7 RPC mới, tổng catalog 49 RPC.
- `db:test` PASS 24 nhóm. Automation V002 preflight, readiness và PriceWatchRepository chạy trên PostgreSQL thật.
- `price-watch:test` PASS 10 nhóm qua Gateway → Identity session → Automation gRPC → Trip access → PostgreSQL.
- `identity:test` PASS 19 nhóm, `trip:test` PASS 39 nhóm, `trip:invitations:test` PASS 19 nhóm. Mỗi harness dùng Compose project riêng và đã dọn container/volume/network.

## Lỗi tìm thấy trong lúc kiểm tra

Lần `db:test` đầu phát hiện PostgreSQL `jsonb` đổi thứ tự key, làm kiểm tra chống va chạm dùng `JSON.stringify` từ chối nhầm dữ liệu đúng. Repository đã chuyển sang canonical JSON sắp key; lần chạy lại PASS.

Lần `price-watch:test` đầu phát hiện Automation target/secret được đặt nhầm trong biến của Trip harness thay vì Gateway. Cấu hình đã chuyển vào đúng tiến trình; lần chạy lại PASS 10 nhóm.

## Giới hạn

H1 không gọi provider, không có scheduler/lease/attempt runtime, không sinh observation và không phát alert. Observation endpoint trả rỗng trong E2E H1. H2/H3 phải có kiểm thử riêng cho polling, retry, dữ liệu provider, threshold, cooldown, notification và lifecycle effects.
