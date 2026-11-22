/**
 * The 34 province-level administrative units of Vietnam in force since 1 July 2025
 * (Nghị quyết 202/2025/QH15), keyed by the official two-digit code from the national
 * administrative unit catalogue (danhmuchanhchinh.nso.gov.vn). Codes and short names were
 * cross-checked against thanglequoc/vietnamese-provinces-database (MIT); the source spells
 * "Thanh Hoá"/"Khánh Hoà", stored here as "Thanh Hóa"/"Khánh Hòa".
 * Hoàng Sa belongs to Đà Nẵng (48) and Trường Sa to Khánh Hòa (56).
 */
export const VN_PROVINCES = Object.freeze({
  '01': 'Hà Nội',
  '04': 'Cao Bằng',
  '08': 'Tuyên Quang',
  '11': 'Điện Biên',
  '12': 'Lai Châu',
  '14': 'Sơn La',
  '15': 'Lào Cai',
  '19': 'Thái Nguyên',
  '20': 'Lạng Sơn',
  '22': 'Quảng Ninh',
  '24': 'Bắc Ninh',
  '25': 'Phú Thọ',
  '31': 'Hải Phòng',
  '33': 'Hưng Yên',
  '37': 'Ninh Bình',
  '38': 'Thanh Hóa',
  '40': 'Nghệ An',
  '42': 'Hà Tĩnh',
  '44': 'Quảng Trị',
  '46': 'Huế',
  '48': 'Đà Nẵng',
  '51': 'Quảng Ngãi',
  '52': 'Gia Lai',
  '56': 'Khánh Hòa',
  '66': 'Đắk Lắk',
  '68': 'Lâm Đồng',
  '75': 'Đồng Nai',
  '79': 'Hồ Chí Minh',
  '80': 'Tây Ninh',
  '82': 'Đồng Tháp',
  '86': 'Vĩnh Long',
  '91': 'An Giang',
  '92': 'Cần Thơ',
  '96': 'Cà Mau',
} as const);
export type VnProvinceCode = keyof typeof VN_PROVINCES;

export function isVnProvinceCode(code: unknown): code is VnProvinceCode {
  return typeof code === 'string' && Object.hasOwn(VN_PROVINCES, code);
}
/** Vietnamese short name of a province code; '' when unknown or missing. */
export function vnProvinceName(code: string | null | undefined): string {
  return isVnProvinceCode(code) ? VN_PROVINCES[code] : '';
}
