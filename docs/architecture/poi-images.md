# Ảnh POI (POI-IMAGES)

Chiến lược gốc: bản "Chiến lược bổ sung ảnh cho dataset POI Wolfari (toàn quốc)" ngày 21/11/2026. Tài liệu này ghi phần **đã triển khai** (pha 0 pilot + pha 1 nền tảng), các quyết định đã chọn, chỗ khác với chiến lược và việc còn lại.

## 1. Đã triển khai

| Thành phần | Vị trí | Ghi chú |
|---|---|---|
| Migration travel V006 | `apps/travel-intelligence-service/migrations/V006.sql` | `poi_media`, `poi_entity_links`, `poi_media_batches`. Chỉ thêm. |
| Pipeline | `scripts/poi/images/` (`run.mjs`, `lib.mjs`, `batch.mjs`, `http.mjs`) | `corepack pnpm poi:images <pull\|harvest\|select\|load\|gates\|activate\|all>`; quy tắc chọn ảnh ở `lib.mjs`, ghi batch ở `batch.mjs` (đều thuần, có unit test) |
| Ảnh chọn tay (S1) | `data/poi/image_overrides.csv` | `key,commons_file,note`; `key` là `wolfari_key` (golden) hoặc GERS id (Overture); luôn thắng nguồn khác. Đã điền 3 điểm golden (mục 5.1) |
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
| 7 | Chọn tay (S1) | Có hỗ trợ, đã điền 3 điểm golden | Nhóm điền dần cho điểm golden quan trọng; chỉ thêm tệp đã kiểm giấy phép, kích thước và nội dung |

Các quyết định này có thể đổi; ngưỡng nằm trong `scripts/poi/images/lib.mjs` (`HERO_THRESHOLD`, `GALLERY_THRESHOLD`, allowlist trong `normalizeLicense`).

## 3. Cách pipeline chọn ảnh

1. **pull**: POI của snapshot đang bật (mặc định chỉ golden; `--tiers all --province <mã>` để chạy Overture của một tỉnh), thẻ OSM theo `osm_ref`, mục Wikidata có tọa độ trong các ô 0,1° chứa POI. Với `--tiers all`, POI Overture được lọc theo nhóm tìm kiếm `--groups` (mặc định `tourism`, ví dụ `tourism,accommodation`, `all` = không lọc); nhóm lấy từ `POI_SEARCH_CATEGORIES` (`packages/common`, cùng nhóm với Places API, mã loại do `scripts/poi/overture-taxonomy.mjs` gán), nên ATM, cửa hàng, dịch vụ bị bỏ qua. POI golden luôn được giữ. Cần `packages/common/dist` (`poi:overture` đã build; nếu thiếu: `corepack pnpm --filter @wolfari/common build`). Phạm vi lượt chạy ghi ở `run.json` và vào manifest.
2. **harvest**: nối POI ↔ Wikidata (thẻ OSM `wikidata` thắng nếu mục cách ≤ 5 km; còn lại theo khoảng cách theo loại: 150 m điểm / 1.500 m khu và điểm ngắm cảnh, tên bỏ dấu ≥ 0,6, P31 không mâu thuẫn, một-một; `coord_pileup` chỉ nhận tên trùng duy nhất). Đối tượng lớn có tọa độ Wikidata xa ghim: ngoài bán kính trên vẫn nối được tới **5 km** (điểm ngắm cảnh/đèo, núi, bán đảo, đảo, vịnh, khu thiên nhiên) hoặc **3 km** (khu khác: bãi biển, công viên, khu vui chơi…) nhưng **chỉ khi tên trùng hẳn** và không phải tên chung; điểm 0,6–0,7 nên luôn thua một ứng viên gần, method `exact_name_far`. Điểm (bảo tàng, chùa…) không được nới. Hai ứng viên sát điểm nhau: chọn ứng viên mang đúng tên chính (`name_vi`/`name_en`) của POI, không phải alias ("Đèo Hải Vân" thắng "Hải Vân Quan"); không có hoặc có nhiều thì bỏ. Ứng viên: P18, ảnh đầu bài Wikipedia vi/en, thành viên Commons category (P373 và thẻ OSM), tệp từ thẻ OSM, tệp Commons có tọa độ gần POI. Geosearch theo ô 0,02° (chia nhỏ khi đầy) **chỉ quanh POI golden và POI tham quan**; khách sạn, quán ăn vẫn nhận tệp tìm thấy trong ô lân cận đã quét. Lấy `imageinfo` + `extmetadata` theo lô 50.
3. **select**: `final = 0,35·match + 0,25·quality + 0,20·semantic + 0,10·prominence + 0,10·source_prior − penalties`. Hero ≥ 0,6, cạnh ngắn ≥ 800 px, tỉ lệ 0,75–2,0, không phải bản đồ/logo/tài liệu/chân dung; ảnh chỉ khớp khoảng cách không làm hero, chỉ vào gallery nếu ≤ 30 m và là điểm tham quan. Gallery ≤ 7, khử trùng theo SHA-1 của Commons, ≤ 2 ảnh mỗi tác giả. Quy tắc nội dung (`semantic`), sửa ngày 26/11/2026:
   - Chạy trên chữ **giữ dấu** (NFC, chữ thường), không trên chữ bỏ dấu. Trước đây "cờ" (lá cờ) bỏ dấu thành "co" nên trùng "cổ" (phố cổ, nhà cổ, chùa cổ), "Bàn Cờ", "Lăng Cô"; "tiền" trùng "Tiên", "Tiên Sa"; "tem" trùng "têm". Từ tiếng Anh vẫn như cũ (map, flag, stamp, sign, banknote, logo…; trừ "Flag Tower", "flagpole"). Từ tiếng Việt khớp dạng có dấu ("lá cờ", "quốc kỳ", "tờ tiền", "tiền xu", "bản đồ", "biển báo"…); dạng không dấu chỉ giữ cụm không thể là từ khác ("ban do", "chan dung", "bien bao"…).
   - Ảnh người: "my son", "my wife", "my daughter"… chỉ tính khi chữ sau viết thường và không theo sau bởi sanctuary/temple/group/ruins…, nên "Mỹ Sơn", "My Son Sanctuary", "My Son Group B" không còn bị coi là ảnh gia đình. "People's Committee", "People's Army" là tên, không phải đám đông; "Mr. …", "… meeting" là ảnh người. "người" đơn lẻ không còn tính ("Hình thuộc bản quyền người truyền lên"), chỉ "những người", "nhiều người", "đám đông"…; "gia dinh" không dấu bỏ (trùng Gia Định).
   - "construction", "development", "xây dựng", "dự án" chỉ xét ở tiêu đề và category: mô tả thường ghi "được xây dựng năm…" về ảnh tốt. "under construction", "đang xây dựng", "công trường xây dựng" xét cả mô tả; "công trường" đơn lẻ không tính (Công trường Lam Sơn là quảng trường).
   - Ảnh có watermark (category "Images with watermarks") bị loại.
   - Loài: "Monkey Mountain" (Sơn Trà) không phải ảnh khỉ; "buồm" (thuyền buồm) không phải "bướm".
4. **load**: chỉ tải ảnh đã chọn (thumbnail 1280 của Commons), đổi sang WebP 320/640/1280 (bỏ EXIF), khóa theo SHA-256, ghi `poi_media` + `poi_entity_links` vào một batch; `--activate` để bật. `--hero-only` chỉ tải hero (gallery chưa có API nào phục vụ; giảm ~6 lần số ảnh tải và dung lượng MinIO; `selection.json` và báo cáo gates vẫn ghi gallery đã chọn). `--into <batch>` nạp cộng dồn (mục 3.1). `--replace` nạp lại toàn bộ batch `--batch`.
5. **gates**: báo cáo `.local/poi/reports/images-<batch>.md|json` cho lượt chạy: độ phủ theo loại, nguồn hero, giấy phép, danh sách hero để người kiểm đánh dấu Đúng/Sai.

Lịch sự với Wikimedia: tối đa 2 request đồng thời, cách nhau ≥ 0,4 s mỗi host, geosearch cách 8 s; tôn trọng `Retry-After`; lỗi "too busy" thử lại; mọi phản hồi thành công được cache ở `.local/poi/images/cache` nên chạy lại không gọi lại. Đặt `POI_IMAGES_USER_AGENT` có liên hệ trước lượt chạy lớn.

### 3.1 Nhiều tỉnh vào một batch (`--into`)

Travel service đọc đúng **một** batch đang bật, nên muốn có ảnh toàn quốc thì các tỉnh phải nằm chung một batch. `--batch` là tên **lượt chạy** (thư mục `.local/poi/images/<batch>`, báo cáo gates); `--into <đích>` là batch trong DB:

- Một transaction: tạo batch đích nếu chưa có, khóa hàng batch (`SELECT … FOR UPDATE`, hai lượt cùng đích chạy tuần tự), xóa ảnh và liên kết Wikidata **chỉ của các POI trong lượt** rồi nạp lại, cập nhật manifest (`cumulative`, `runs[]` mỗi lượt một mục, tổng hero/gallery/tệp đếm trong DB). Ảnh của POI khác giữ nguyên.
- Idempotent: chạy lại cùng lượt cho cùng kết quả (mục `runs[]` của lượt đó được thay, không nhân đôi). POI có hero tải lỗi (ví dụ 429) **giữ ảnh cũ**, chạy lại `load` để thử tiếp. POI giờ không còn ảnh nào thì mất ảnh cũ (lượt mới nhất quyết định).
- Dòng `status = 'takedown'` không bị xóa: ảnh đã gỡ không quay lại khi chạy lại (chỉ mục duy nhất `(batch, key, sha256)` chặn nó). `--replace` và batch mới **không** mang theo takedown của batch cũ (như trước).
- Batch nạp trước đây không có `--into` vẫn dùng làm đích được: manifest cũ thành mục đầu của `runs[]`.
- `--into` vào batch **đang bật** đổi ảnh ngay (từng POI, trong một transaction) và không quay lại được; muốn quay lại thì dựng batch mới chưa bật rồi `activate`. Không dùng cùng `--replace`.
- Không đổi `apps/travel-intelligence-service`, không đổi schema V006.

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

### 5.1 Sửa quy tắc và ảnh chọn tay (26/11/2026, kiểm offline)

Chạy lại link + gom ứng viên + select **trong bộ nhớ** trên dữ liệu pilot (`pois/items/osm/candidates/infos.json` và cache geosearch của `img-pilot-dn1`, không gọi lại pull/harvest, không nạp DB/MinIO). Metadata của các tệp mới vào diện ứng viên của Đèo Hải Vân (P18 và 4 tệp geosearch trong 1,5 km) lấy bằng 1 request `imageinfo`; ảnh đầu bài Wikipedia và thành viên Commons category của liên kết mới không lấy được offline.

| Trường hợp | Có hero |
|---|---|
| Pilot (quy tắc cũ) | 28/49 |
| Quy tắc mới | 30/49 (+ Khu đền tháp Mỹ Sơn, + Đèo Hải Vân) |
| Quy tắc mới + `image_overrides.csv` | **31/49** (+ Làng rau Trà Quế) |

- **Mỹ Sơn**: trước bị loại toàn bộ 150 ứng viên vì "My Son" khớp "my son" (ảnh gia đình); giờ P18 "2024 - Mỹ Sơn Sanctuary Temple E7 - img 01" đạt 0,852 (đã xem ảnh: tháp E7, đúng).
- **Đèo Hải Vân**: thẻ OSM của way ghim trỏ Q1372266 (Quốc lộ 1, cách ~120 km) nên bị bỏ; mục Q1477078 "Đèo Hải Vân" cách ghim 2,1 km giờ nối được (`exact_name_far`, 0,683). Nhưng P18 của mục này ("File:Hai Van Pass.jpg") là **ảnh cận cảnh cây dương xỉ**, quy tắc metadata không phát hiện được, nên đã thêm ảnh chọn tay.
- **Đỉnh Bàn Cờ**: ứng viên duy nhất có tên ("Toàn cảnh Đà Nẵng từ đỉnh bàn cờ…png", 275 m) không còn bị loại vì "cờ" nhưng có watermark → vẫn chưa có hero.
- **Rạn Nam Ô** đổi hero từ "Nam Ô, Đà Nẵng.jpg" sang "Dinh cô hồn Nam Ô.jpg" (miếu ở làng chài, trước bị loại vì "cô"; hai ảnh cùng 0,691, hòa thì chọn theo tên). Cả hai là ảnh làng chài Nam Ô, không phải rạn đá: **cần người kiểm** quyết định hoặc thêm ảnh chọn tay.
- Không hero nào khác của pilot thay đổi; Bán đảo Sơn Trà vẫn là "View of Da Nang 4" (chưa chắc, như mục 5).

Ảnh chọn tay đã thêm (mỗi tệp: 1 request `imageinfo` xác nhận giấy phép allowlist và cạnh ngắn ≥ 800 px, và xem thumbnail 330 px):

| POI | Tệp Commons | Giấy phép, cỡ |
|---|---|---|
| `dn-deo-hai-van` | File:Hai Van Pass (38694610010).jpg (đường đèo, Mig Gilbert) | CC BY-SA 2.0, 6000×4000 |
| `dn-my-son` | File:2024 - Mỹ Sơn Group B, C and D - img 23.jpg (nhóm tháp B-C-D, ảnh đầu bài Wikipedia) | CC BY 4.0, 4032×3024 |
| `dn-lang-rau-tra-que` | File:Vegetables in Trà Quế 1.jpg (ruộng rau, Christophe95) | CC BY-SA 4.0, 4032×3024 |

Đã xem nhưng **không** thêm: "Vinpearl Land (49356972042)" cho VinWonders Nam Hội An (cổng với tên cũ Vinpearl Land), "Helio Center, Da Nang (49373166151)" cho Chợ đêm Helio (tàu lượn trẻ em, không phải chợ đêm), "Palm trees beach Da Nang" cho Bãi biển Non Nước (mô tả ghi Non Nước nhưng category ghi Mỹ Khê).

## 6. Chạy toàn quốc

Overture ~1,2 triệu POI không có sẵn trên mọi máy: dùng máy đã nạp snapshot Overture, hoặc chép `.local/poi/overture/` từ máy đó rồi `poi:overture --release 2026-10-21.0 --from-raw`, hoặc tải lại bằng `corepack pnpm poi:overture --release 2026-10-21.0` (cần mạng, DuckDB tối đa 3 GB RAM). Xem [poi-overture.md](poi-overture.md).

Cấu hình (không ghi giá trị vào tài liệu hay log):

- `apps/travel-intelligence-service/.env` (hoặc `--env <file>`): `DATABASE_URL` (travel_db), `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`; tạo bằng `corepack pnpm env:init`.
- Biến môi trường `POI_IMAGES_USER_AGENT`: tên công cụ + URL + **email liên hệ** của nhóm, theo chính sách User-Agent của Wikimedia. Bắt buộc với lượt chạy lớn.

Thứ tự:

```sh
corepack pnpm infra:up                                       # Postgres + MinIO local
corepack pnpm db:migrate --service travel                    # tới V006
corepack pnpm poi:load                                       # golden
corepack pnpm poi:overture --release 2026-10-21.0 --from-raw # snapshot Overture (chưa bật), build luôn @wolfari/common; chưa có file raw thì bỏ --from-raw
corepack pnpm poi:activate <snapshot in ra ở bước trên>
export POI_IMAGES_USER_AGENT="Wolfari-POI/1.0 (https://github.com/Wolfari-Labs; <email liên hệ của nhóm>)"

# Mỗi tỉnh một lượt (34 mã, bảng mã ở poi-overture.md), cùng một batch đích CHƯA bật:
corepack pnpm poi:images all --batch img-vn1-48 --province 48 --tiers all --hero-only --into img-vn1
corepack pnpm poi:images all --batch img-vn1-46 --province 46 --tiers all --hero-only --into img-vn1
# … kiểm .local/poi/reports/images-img-vn1-<mã>.md; sửa image_overrides.csv rồi chạy lại harvest → select → load của tỉnh đó
corepack pnpm poi:images activate --batch img-vn1            # bật cả nước một lần; quay lại = activate batch cũ
```

- Golden trong snapshot Overture có `province_code`, nên lượt `--province` gồm cả golden của tỉnh đó. Lượt bị ngắt thì chạy lại đúng lệnh: mọi phản hồi đã nhận nằm trong cache `.local/poi/images/cache`, ảnh đã tải nằm trong `.local/poi/images/<batch>/files`.
- Có thể chạy tỉnh nhỏ trước để ước lượng; bước harvest in số ô geosearch và thời gian tối thiểu trước khi gọi.

Ước lượng (chưa chạy thật toàn quốc; số liệu pilot Đà Nẵng 49 POI):

| Bước | Chi phí | Ghi chú |
|---|---|---|
| Geosearch Commons (**nút thắt**) | ≥ 8 s mỗi ô 0,02° (~2,2 × 2,2 km) chưa có trong cache; ô đầy (≥ 100 tệp) chia 4, tối đa 3 lần; thêm thời gian chờ khi bị 429 | Pilot: 49 POI → 26 ô. Ví dụ 5.000 ô ≈ 11 giờ, 20.000 ô ≈ 44 giờ chưa tính chia ô/429. Giữ `--groups tourism` (mặc định): chỉ ô có POI golden/tham quan được quét. Thêm `accommodation` không tăng số ô nhưng tăng truy vấn Wikidata/category. Lượt lớn nên có OAuth/bot hoặc dump Commons (mục 4). |
| Wikidata SPARQL | 1 truy vấn mỗi ô 0,1° chứa POI | Pilot: 13 ô. |
| `imageinfo` | 1 request / 50 tệp, ≥ 0,4 s | Pilot: 2.695 tệp. |
| Tải + đổi WebP (load) | 1 request / ảnh, ≤ 2 song song, ≥ 0,4 s mỗi host → ~2 ảnh/s, cộng thời gian sharp | `--hero-only`: số ảnh = số hero (pilot: 28 thay vì 161 tệp). |
| MinIO | ~274 KB / ảnh (3 biến thể WebP) | 10.000 hero ≈ 2,7 GB; kèm gallery khoảng ×6. |
| Đĩa local | Thumbnail gốc ~330 KB / ảnh trong `files/` (pilot 161 tệp = 53 MB); cache HTTP pilot 17 MB | Xóa `files/` sau khi load xong nếu thiếu chỗ; giữ cache để chạy lại không tốn request. |

## 7. Việc tiếp theo

1. Người kiểm duyệt đánh dấu mẫu hero trong báo cáo gates; hiệu chỉnh ngưỡng nếu precision < 95%; quyết định Rạn Nam Ô và Bán đảo Sơn Trà.
2. Chạy toàn quốc theo mục 6 trên máy có snapshot Overture, với `POI_IMAGES_USER_AGENT` có liên hệ (và OAuth nếu có).
3. Pha 3: CLIP/SigLIP + pHash + blurhash ở script riêng (P18 của Wikidata cũng có thể là ảnh cận cảnh, như Đèo Hải Vân); gallery qua endpoint chi tiết.
4. Ảnh minh họa S8 theo loại/tỉnh, `is_placeholder = true`.
5. Định kỳ kiểm tra lại giấy phép và ảnh còn tồn tại; `status = 'takedown'` để gỡ (route ảnh trả 404 ngay ở lần cache miss tiếp theo).
