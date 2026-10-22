# Kết quả kiểm tra Price Watch H1–H2

Ngày chạy local: **22/10/2026**. Phần H1 là bằng chứng của commit `d1c52c8`; phần H2 là working tree `feature/price-watch-worker`. CI remote và PR H2 chưa chạy.

## Kết quả

- Workspace build PASS; ESLint PASS; full unit 44 file/719 test PASS.
- Contract lint/check PASS; 5 file/36 contract test và breaking check so với `HEAD` PASS. Automation có 7 RPC mới, tổng catalog 49 RPC.
- `db:test` PASS 25 nhóm. Automation V002/V003, readiness, WatchRepository và WorkerRepository chạy trên PostgreSQL thật. Hai scheduler đồng thời chỉ tạo một attempt cho group/slot; fixture cũng kiểm tra reclaim/stale completion, retry, terminal result, lease hết lượt và expiry.
- `price-watch:test` PASS 10 nhóm qua Gateway → Identity session → Automation gRPC/worker → Trip access → PostgreSQL. API139 nhận đúng một observation `MOCK_FLIGHT` cho shared query group trong slot hiện tại.
- `identity:test` PASS 19 nhóm, `trip:test` PASS 39 nhóm, `trip:invitations:test` PASS 19 nhóm. Mỗi harness dùng Compose project riêng và đã dọn container/volume/network.
- `env:init` PASS và xác nhận đủ năm biến Price Watch worker trong `.env` local/ignored mà không in giá trị.
- Prettier check PASS cho toàn bộ file H2 mới, source đã định dạng và tài liệu thay đổi. Năm file compact kế thừa (`database-integration`, `foundation.test`, `price-watch-integration`, H1 repository integration và database package) vẫn theo format lịch sử để tránh khuếch đại diff; ESLint toàn workspace PASS.

## Lỗi tìm thấy trong lúc kiểm tra

Lần `db:test` đầu phát hiện PostgreSQL `jsonb` đổi thứ tự key, làm kiểm tra chống va chạm dùng `JSON.stringify` từ chối nhầm dữ liệu đúng. Repository đã chuyển sang canonical JSON sắp key; lần chạy lại PASS.

Lần `price-watch:test` đầu phát hiện Automation target/secret được đặt nhầm trong biến của Trip harness thay vì Gateway. Cấu hình đã chuyển vào đúng tiến trình; lần chạy lại PASS 10 nhóm.

Lượt `db:test` H2 đầu tiên không được quyền truy cập Docker pipe trong sandbox, nên không được tính là lỗi code hay PASS. Khi chạy đúng quyền, fixture đầu dùng mốc thời gian tương lai so với clock PostgreSQL nên attempt chưa đủ điều kiện claim; fixture đã được sửa để đưa `next_attempt_at` về clock DB trước khi kiểm tra. Lượt tiếp theo phát hiện PostgreSQL suy cùng tham số trạng thái thành `text` và `varchar`; câu finalize đã thêm cast tường minh. Lượt đầy đủ cuối PASS 25 nhóm.

## Giới hạn

H2 chỉ có adapter xác định `MOCK_FLIGHT`, không gọi mạng và không chứng minh tích hợp giá thật. Worker mặc định tắt ngoài test/demo. H3 chưa làm rule threshold, re-arm theo giá trở lại, giảm thêm 5%, cooldown 24 giờ, notification delivery và current-recipient/lifecycle effects. Chưa có CI remote hoặc kiểm thử provider thật.
