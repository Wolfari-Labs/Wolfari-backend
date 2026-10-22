# Kết quả kiểm tra Price Watch H1–H3

Ngày chạy local: **22/10/2026**. Phần H1 là bằng chứng của commit `d1c52c8`, H2 của commit `1bf6039`; H3 là working tree `feature/price-watch-alerts`. CI remote và PR H3 chưa chạy.

## Trạng thái H3 hiện tại

- Full unit PASS 46 file/733 test; riêng alert domain/service PASS 14 test. Ma trận unit có strict threshold, re-arm, giảm đúng 5%, cooldown đúng 24 giờ, bigint, Trip outage/retry, archive, mất quyền và rejoin khác membership.
- Workspace build và Automation build PASS; ESLint toàn workspace PASS.
- Contract lint/check PASS, 5 file/36 contract test PASS và breaking check so với `HEAD` PASS. Topology tách năm lifecycle event sang queue Price Watch chuyên biệt mà vẫn giữ đủ 19 event.
- Checksum Automation V004 khớp manifest. `git diff --check` không có lỗi whitespace; cảnh báo LF/CRLF không phải textual diff.
- `db:test` PASS 26 nhóm trên PostgreSQL thật: 56 bảng mô hình + 5 lịch sử, 49 FK, V004/readiness và PriceAlertRepository đều PASS.
- `price-watch:test` PASS 12 nhóm qua Gateway → Identity → Trip → Automation → PostgreSQL/RabbitMQ: shared query tạo alert riêng theo watch, notification `AVAILABLE`, archive pause, reopen không tự resume và creator resume thành công.
- Regression `trip:members:test` PASS 19 nhóm và `trip:invitations:test` PASS 19 nhóm. Tất cả Compose project/container/volume/network của các lượt cuối đã được dọn.

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

Lượt H3 đầu phát hiện chế độ `--price-watch` chưa bật RabbitMQ trong Compose dù lifecycle E2E dùng broker thật. Sau khi bật broker, test phát hiện race: worker có thể ghi observation của slot sau watch đầu nhưng trước watch thứ hai, nên watch thứ hai hợp lệ phải chờ slot kế tiếp và fixture timeout. Harness đã tạo hai watch chung query đồng thời trước poll đầu và dùng poll một giây; lượt đầy đủ sau đó PASS 12 nhóm. Cửa sổ chờ alert là 30 giây để bao phủ retry 10 giây và khi lỗi trả trạng thái candidate/watch an toàn, không in dữ liệu riêng tư.

Lượt `db:test` H2 đầu tiên không được quyền truy cập Docker pipe trong sandbox, nên không được tính là lỗi code hay PASS. Khi chạy đúng quyền, fixture đầu dùng mốc thời gian tương lai so với clock PostgreSQL nên attempt chưa đủ điều kiện claim; fixture đã được sửa để đưa `next_attempt_at` về clock DB trước khi kiểm tra. Lượt tiếp theo phát hiện PostgreSQL suy cùng tham số trạng thái thành `text` và `varchar`; câu finalize đã thêm cast tường minh. Lượt đầy đủ cuối PASS 25 nhóm.

## Giới hạn

H3 vẫn chỉ dùng adapter xác định `MOCK_FLIGHT`, không gọi mạng và không chứng minh tích hợp giá thật. Worker mặc định tắt ngoài test/demo. H3 tạo notification in-app `AVAILABLE` để bàn giao, chưa gửi push/email và chưa kiểm tra preference của người nhận. Kiểm tra quyền hiện tại dựa trên Trip access/membership; chưa mở rộng Identity để kiểm tra trạng thái tài khoản tại thời điểm gửi. Chưa có CI remote hoặc kiểm thử provider thật.
