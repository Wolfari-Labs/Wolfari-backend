# Price Watch Core và Worker H1–H2

## Phạm vi

H1 hiện thực API133–139 cho việc cấu hình và quản lý theo dõi giá. H2 chạy scheduler và adapter `MOCK_FLIGHT` xác định để sinh observation thử nghiệm. Hệ thống chưa gọi hãng/nhà cung cấp thật và chưa gửi cảnh báo.

## Luồng và quyền

1. Gateway xác thực bearer session rồi gọi `AutomationService` qua loopback gRPC bằng secret riêng và correlation ID.
2. Automation gọi `Trip.GetAccessContext` trước mỗi thao tác. Member hiện tại được tạo, list và đọc lịch sử. Chỉ membership đã tạo watch được sửa, pause hoặc resume. Creator hoặc current Owner được stop.
3. Read vẫn hợp lệ với Trip archived nếu caller còn membership. Mọi write bị chặn khi Trip archived, deleted, caller đã rời Trip hoặc dependency không xác định được quyền.
4. `owner_membership_id` giữ danh tính membership lúc tạo. Một user rời rồi rejoin không tiếp quản watch cũ chỉ vì có cùng `user_id`.
5. Lời gọi Trip nằm ngoài transaction Automation. Transaction DB chỉ mở sau khi có access context; callback trên row đã khóa kiểm tra lại user và membership identity trước mutation.

## Dữ liệu và chống lặp

Create bắt buộc `Idempotency-Key` UUID. Unique `(user_id, client_request_id)` được tuần tự hóa bằng advisory lock. Replay cùng trip, membership và request hash trả watch cũ; dùng lại key với intent khác trả `IDEMPOTENCY_CONFLICT`.

Truy vấn được chuẩn hóa thành JSON có thứ tự cố định và SHA-256. Khóa gồm provider, loại vận chuyển, origin/destination, ngày đi/về, journey type, đầy đủ passenger mix, cabin, VND và `departure_at`. Khóa không chứa user, Trip hoặc ngưỡng giá. Vì vậy nhiều watch có thể dùng chung `price_query_groups`; PATCH đổi truy vấn chỉ chuyển watch đang sửa sang group khác.

Provider H1 chỉ cho `MOCK_FLIGHT`; route dùng mã IATA ba chữ cái, origin khác destination. ONE_WAY không có ngày về; ROUND_TRIP bắt buộc ngày về không trước ngày đi. Adults 1–9, tổng hành khách tối đa 9 và infants không vượt adults. Currency chỉ VND, threshold là bigint dương, departure instant phải ở tương lai.

Update, pause, resume và stop bắt buộc `expected_version`. Nếu version khác, API trả `VERSION_CONFLICT` kèm `current_version`. PATCH không làm thay đổi dữ liệu giữ nguyên version. Đổi threshold bật lại `alert_armed`, đồng thời giữ `last_alert_price` và `last_alert_at`. STOPPED và EXPIRED là terminal; resume chỉ từ PAUSED và trước departure.

## Đọc trang và riêng tư

Watch sắp theo `created_at DESC, id DESC`; observation sắp theo `observed_at DESC, id DESC`. Cursor được HMAC và ràng buộc với loại collection cùng Trip/watch cha, nên không thể tái dùng chéo Trip hoặc sửa nội dung.

Observation được đọc từ query group hiện tại của watch. Response không lộ watch/user/Trip khác dùng chung group. `fare_metadata` chỉ giữ bốn key an toàn: `provider_fare_id`, `carrier_code`, `fare_class`, `baggage_summary`.

## Migration và vận hành

Automation V002 thêm `owner_membership_id uuid NOT NULL` và index `(trip_id, owner_membership_id, status)`. Migration dừng bằng `PRICE_WATCH_MEMBERSHIP_BACKFILL_REQUIRED` nếu đã có watch legacy; không đoán membership từ `user_id`.

Automation V003 thêm `price_query_attempts.next_attempt_at` và index claim cho attempt `PENDING/RUNNING`. `next_attempt_at` là thời điểm đủ điều kiện retry; `claim_until` chỉ là hạn lease. Readiness Automation yêu cầu V001–V003. V001/V002 và checksum cũ không bị sửa.

Gateway và Automation dùng `GATEWAY_AUTOMATION_SECRET`; cursor dùng `AUTOMATION_CURSOR_SECRET`. Cả hai secret tối thiểu 32 byte và được `env:init` phân phối đúng endpoint. gRPC chỉ bind loopback ở local/test; production hiện fail closed cho đến khi có TLS.

## Scheduler, attempt và lease H2

UTC được chia thành các slot `00:00`, `06:00`, `12:00`, `18:00`. Scheduler dùng `FOR UPDATE SKIP LOCKED`, unique `(query_group_id, scheduled_slot)` và không tạo backlog cho các slot đã bỏ lỡ. Group chỉ được chạy khi còn ít nhất một watch `ACTIVE` chưa hết hạn. Create/resume/chuyển query đánh thức group; pause/stop/chuyển khỏi group tắt group khi không còn watch active. Watch đến `expires_at` được chuyển `EXPIRED` và tăng version.

Attempt được claim với `claim_owner`, `claim_until` và `attempt_count`. Finalize luôn kiểm tra cả owner và generation `attempt_count`, nên kết quả từ worker đã mất lease không thể ghi đè worker mới. Provider chạy ngoài transaction. Crash trước finalize được reclaim sau lease; crash ở lượt provider cuối được chuyển `FAILED/LEASE_EXHAUSTED` mà không gọi vượt giới hạn.

Một attempt có lần gọi đầu và tối đa năm retry sau 10 giây, 30 giây, 2 phút, 5 phút và 15 phút. Success ghi observation cùng transaction với trạng thái `SUCCEEDED`; `NO_RESULT` không ghi observation; lỗi tạm thời giữ cùng attempt ở `PENDING`; lỗi vĩnh viễn hoặc hết lượt thành `FAILED`. Slot mới vẫn được phép chạy sau một slot lỗi. `last_error` chỉ lưu mã an toàn và lịch sử giá cũ không bị xóa.

Adapter H2 chỉ hỗ trợ `MOCK_FLIGHT`, không gọi mạng. Giá, fare ID và metadata được sinh xác định từ canonical key + scheduled slot. Metadata lưu và trả ra chỉ gồm whitelist đã nêu ở trên. Worker mặc định tắt, được bật rõ ràng trong test/demo; production không được bật mock.

## Các mốc sau

- H3: rule threshold, re-arm/cooldown, notification delivery và xử lý lifecycle/current-recipient.
- Provider thật chỉ thêm sau khi chốt điều khoản, rate limit, dữ liệu giá và cách đánh dấu nguồn; không dùng mock để tuyên bố giá thực.
