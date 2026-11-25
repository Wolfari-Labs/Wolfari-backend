# Ảnh POI (POI-IMAGES)

Chiến lược gốc: bản "Chiến lược bổ sung ảnh cho dataset POI Wolfari (toàn quốc)" ngày 21/11/2026. Tài liệu này ghi phần **đã triển khai** (pha 0 pilot + pha 1 nền tảng), các quyết định đã chọn, chỗ khác với chiến lược và việc còn lại.

## 1. Đã triển khai

| Thành phần | Vị trí | Ghi chú |
|---|---|---|
| Migration travel V006 | `apps/travel-intelligence-service/migrations/V006.sql` | `poi_media`, `poi_entity_links`, `poi_media_batches`. Chỉ thêm. |
| Pipeline | `scripts/poi/images/` (`run.mjs`, `lib.mjs`, `http.mjs`) | `corepack pnpm poi:images <pull\|harvest\|select\|load\|gates\|activate\|all>` |
| Ảnh chọn tay (S1) | `data/poi/image_overrides.csv` | `key,commons_file,note`; luôn thắng nguồn khác |
| Lưu ảnh | MinIO, bucket `wolfari-poi-images` | `poi/<sha256>/{320,640,1280}.webp`, riêng tư như các bucket khác |
| API tìm kiếm | `Place.hero_image` (proto field 24, OpenAPI `PlaceImage`) | Chỉ hero, không kèm gallery (payload nhỏ) |
| Ảnh công khai | `GET /api/v1/travel/poi-images/{sha256}/{320\|640\|1280}.webp` | Không cần phiên; `Cache-Control: public, max-age=31536000, immutable`; ảnh bị gỡ hoặc ngoài batch đang bật trả 404 |
| RPC | `TravelService.GetPoiImage` (chỉ ApiGateway gọi) | Travel đọc MinIO bằng S3 SigV4 tự viết, không thêm SDK |
| Mobile | thẻ địa điểm ở tab Bản đồ | Ảnh 16:9 + dòng ghi công bấm được (mở trang Commons); không ảnh thì giữ icon, không giả ảnh |

## 2. Quyết định đã chọn (mục 9 của chiến lược)

| # | Câu hỏi | Chọn | Lý do |
|---|---|---|---|
| 1 | Allowlist giấy phép | CC0, PD, CC BY, CC BY-SA. Loại NC, ND, GFDL-only, không rõ | An toàn khi thương mại hóa; BY-SA giữ nhãn và link trên mọi biến thể |
| 2 | Flickr | Không | Cần key thương mại được duyệt |
| 3 | Mapillary | Không (pha 4 nếu cần) | Chất lượng thấp, tọa độ POI chưa kiểm |
| 4 | `og:image` | Ngoài phạm vi | Bản quyền thuộc chủ website |
| 5 | Precision hay độ phủ | Precision | Ảnh chỉ khớp khoảng cách không bao giờ làm hero |
| 6 | Tự lưu hay hotlink | Tự lưu | Không phụ thuộc giới hạn thumbnail của Wikimedia |
| 7 | Chọn tay (S1) | Có hỗ trợ, file đang trống | Nhóm điền dần cho điểm golden quan trọng |

Các quyết định này có thể đổi; ngưỡng nằm trong `scripts/poi/images/lib.mjs` (`HERO_THRESHOLD`, `GALLERY_THRESHOLD`, allowlist trong `normalizeLicense`).

## 3. Cách pipeline chọn ảnh

1. **pull**: POI của snapshot đang bật (mặc định chỉ golden; `--tiers all --province <mã>` để chạy Overture), thẻ OSM theo `osm_ref`, mục Wikidata có tọa độ trong các ô 0,1° chứa POI.
2. **harvest**: nối POI ↔ Wikidata (thẻ OSM `wikidata` thắng; còn lại theo khoảng cách theo loại 150 m điểm / 1.500 m khu, tên bỏ dấu ≥ 0,6, P31 không mâu thuẫn, một-một, mơ hồ thì bỏ; `coord_pileup` chỉ nhận tên trùng duy nhất). Ứng viên: P18, ảnh đầu bài Wikipedia vi/en, thành viên Commons category (P373 và thẻ OSM), tệp từ thẻ OSM, tệp Commons có tọa độ gần POI (geosearch theo ô 0,02°, chia nhỏ khi đầy). Lấy `imageinfo` + `extmetadata` theo lô 50.
3. **select**: `final = 0,35·match + 0,25·quality + 0,20·semantic + 0,10·prominence + 0,10·source_prior − penalties`. Hero ≥ 0,6, cạnh ngắn ≥ 800 px, tỉ lệ 0,75–2,0, không phải bản đồ/logo/tài liệu/chân dung; ảnh chỉ khớp khoảng cách không làm hero, chỉ vào gallery nếu ≤ 30 m và là điểm tham quan. Gallery ≤ 7, khử trùng theo SHA-1 của Commons, ≤ 2 ảnh mỗi tác giả.
4. **load**: chỉ tải ảnh đã chọn (thumbnail 1280 của Commons), đổi sang WebP 320/640/1280 (bỏ EXIF), khóa theo SHA-256, ghi `poi_media` + `poi_entity_links` vào một batch; `--activate` để bật.
5. **gates**: báo cáo `.local/poi/reports/images-<batch>.md|json`: độ phủ theo loại, nguồn hero, giấy phép, danh sách hero để người kiểm đánh dấu Đúng/Sai.

Lịch sự với Wikimedia: tối đa 2 request đồng thời, cách nhau ≥ 0,4 s mỗi host, geosearch cách 8 s; tôn trọng `Retry-After`; lỗi "too busy" thử lại; mọi phản hồi thành công được cache ở `.local/poi/images/cache` nên chạy lại không gọi lại. Đặt `POI_IMAGES_USER_AGENT` có liên hệ trước lượt chạy lớn.

## 4. Khác với chiến lược

- **Thêm `poi_media_batches`** (một batch hoạt động tại một thời điểm) và đưa `batch_id` vào các chỉ mục duy nhất, để bật/quay lại cả lô đúng như nguyên tắc 6.
- **JSON thay parquet** cho dữ liệu trung gian của pilot; đủ cho vài nghìn POI. Khi chạy toàn quốc nên chuyển sang parquet + DuckDB như các script POI khác.
- **Chưa có pha 3**: chưa dùng CLIP/SigLIP, pHash, phát hiện mặt người/NSFW, blurhash; điểm `semantic` hiện dựa trên tiêu đề, mô tả, category của Commons. Cột `phash`, `blurhash` để trống.
- **Chưa có ảnh minh họa S8**: API trả `hero_image: null` và app giữ icon theo loại; trường `is_placeholder` đã có sẵn (luôn `false`) để thêm sau khi có bộ minh họa có giấy phép.
- **Chỉ kiểm thử được golden Đà Nẵng**: máy chạy pilot chưa có dữ liệu Overture; đường xử lý GERS id đã có và được unit test.
- **Geosearch Commons bị giới hạn chặt** với client ẩn danh (HTTP 429 liên tục ở `list=geosearch`); toàn quốc cần OAuth/bot hoặc dump.

## 5. Kết quả pilot (22/11/2026, batch `img-pilot-dn1`)

Phạm vi: 49 điểm golden Đà Nẵng (gồm Hội An, Mỹ Sơn, Cù Lao Chàm) của snapshot `golden-danang-20261119-1449`, máy dev có Internet, User-Agent chung (chưa có liên hệ).

| Chỉ số | Kết quả |
|---|---|
| Liên kết Wikidata | 22/49 POI (10 qua thẻ OSM `wikidata`) |
| Ứng viên | 6.222 cặp POI–ảnh, 2.695 tệp; geosearch 2.891 tệp có tọa độ |
| Có hero | **28/49 (57%)** |
| Gallery | 142 ảnh đã lưu (2 ảnh bỏ vì `upload.wikimedia.org` trả 429) |
| Tệp lưu | 161 tệp × 3 biến thể WebP; ảnh 640 px ~10–40 KB |
| Giấy phép hero | CC BY-SA 4.0 ×6, 3.0 ×6, 2.0 ×3; CC BY 4.0 ×5, 2.0 ×3; CC0 ×4; PD ×1. 100% có tác giả/giấy phép/link |
| Nguồn hero | geosearch có bằng chứng tên ×14, P18 ×11, Commons category ×2, ảnh đầu bài Wikipedia ×1 |
| Precision (tự kiểm 28 hero) | 27 đúng, 1 chưa chắc (Bán đảo Sơn Trà: "View of Da Nang 4", có thể chụp từ bán đảo) → **≈ 96%** |
| Request | pull 50, harvest ~390 (geosearch bị 429 nhiều), load 173 |

Vòng đầu cho 30 hero nhưng 3 sai/không đạt (ảnh khỉ ở Sơn Trà, "View from the An Bàng Bridge" cho bãi biển An Bàng, "Resort development at Non Nuoc"). Đã thêm 3 quy tắc, có unit test: ảnh tên loài (tên Latin trong ngoặc) hoặc có người không làm hero; ảnh geosearch nói về loại địa điểm khác (cầu, resort…) không tính là bằng chứng tên; ảnh công trường/dự án là "không phải phong cảnh". Sau đó An Bàng nhận đúng "An Bàng Beach", Non Nước để trống.

21 POI chưa có ảnh: đa số không có mục Wikidata và tên không xuất hiện trong ảnh gần đó (chợ đêm, làng nghề, khu du lịch mới, Bảo tàng tranh 3D…). Nên bổ sung bằng S1 (`image_overrides.csv`) hoặc ảnh người dùng (S7). Báo cáo đầy đủ: `corepack pnpm poi:images gates --batch img-pilot-dn1` → `.local/poi/reports/images-img-pilot-dn1.md`.

## 6. Việc tiếp theo

1. Người kiểm duyệt đánh dấu mẫu hero trong báo cáo gates; hiệu chỉnh ngưỡng nếu precision < 95%.
2. Nạp snapshot Overture trên máy có dữ liệu, chạy theo tỉnh với `POI_IMAGES_USER_AGENT` có liên hệ (và OAuth nếu có).
3. Pha 3: CLIP/SigLIP + pHash + blurhash ở script riêng; gallery qua endpoint chi tiết.
4. Ảnh minh họa S8 theo loại/tỉnh, `is_placeholder = true`.
5. Định kỳ kiểm tra lại giấy phép và ảnh còn tồn tại; `status = 'takedown'` để gỡ (route ảnh trả 404 ngay ở lần cache miss tiếp theo).
