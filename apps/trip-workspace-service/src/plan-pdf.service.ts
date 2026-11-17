import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { TripV1 } from '@wolfari/contracts/grpc';
import PDFDocument from 'pdfkit';
import { resolve } from 'node:path';
import { fail, uuid } from './trip-common';
import { readPlanLists } from './planning/plan.projection';

export function pdfText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '');
}
export async function renderPlanPdf(snapshot: {
  trip: {
    name: string;
    description: string | null;
    start_at: Date;
    end_at: Date;
    timezone: string;
    plan_version: number;
  };
  plan: Awaited<ReturnType<typeof readPlanLists>>;
}) {
  const { trip, plan } = snapshot;
  if (
    plan.activities.length + plan.packing_items.length + plan.dress_codes.length > 1000 ||
    JSON.stringify(snapshot).length > 400000
  )
    return fail('STATE_CONFLICT', 409);
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    bufferPages: true,
    info: { Title: pdfText(trip.name), Author: 'Wolfari', Subject: 'Kế hoạch chuyến đi' },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    let total = 0;
    doc.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 10 * 1024 * 1024) doc.destroy(Error('PDF too large'));
      else chunks.push(chunk);
    });
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.font(resolve(__dirname, '../assets/fonts/Nunito-SemiBold.ttf'));
  const stamp = (value: string | Date) =>
    new Intl.DateTimeFormat('vi-VN', {
      timeZone: trip.timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));
  const text = (value: unknown) =>
    doc.fontSize(10).fillColor('#213B43').text(pdfText(value), { lineGap: 3, paragraphGap: 5 });
  const heading = (value: string) => {
    if (doc.y > 730) doc.addPage();
    doc.moveDown(0.6).fontSize(15).fillColor('#087E8B').text(value);
    doc.moveDown(0.3);
  };
  doc.fontSize(10).fillColor('#087E8B').text('WOLFARI / KẾ HOẠCH CHUYẾN ĐI');
  doc.moveDown().fontSize(25).fillColor('#103E49').text(pdfText(trip.name));
  doc.moveDown(0.4);
  text(
    `${stamp(trip.start_at)} - ${stamp(new Date(trip.end_at.getTime() - 1))} (${trip.timezone})`,
  );
  text(`Phiên bản kế hoạch: ${trip.plan_version}. Xuất lúc: ${stamp(new Date())}.`);
  if (trip.description) text(trip.description);
  heading('Lịch trình');
  if (!plan.activities.length) text('Chưa có hoạt động.');
  for (const item of plan.activities) {
    if (doc.y > 720) doc.addPage();
    const schedule = item.starts_at
      ? stamp(item.starts_at)
      : item.scheduled_date
        ? `${item.scheduled_date} / Cả ngày`
        : 'Chưa xếp lịch';
    text(
      `${item.position + 1}. ${item.title} / ${item.status === 'COMPLETED' ? 'Đã hoàn thành' : 'Chưa hoàn thành'}`,
    );
    text(schedule);
    const place = plan.selected_locations.find((p) => p.id === item.selected_location_id);
    if (place) text(`Địa điểm: ${place.name}${place.address ? ' - ' + place.address : ''}`);
    if (item.description) text(item.description);
    doc.moveDown(0.25);
  }
  heading('Hành lý');
  if (!plan.packing_items.length) text('Chưa có vật dụng.');
  for (const item of plan.packing_items) {
    text(
      `${item.status === 'COMPLETED' ? '[X]' : '[ ]'} ${item.name} / ${item.quantity} ${item.unit ?? ''}${item.due_at ? ' / Hạn: ' + stamp(item.due_at) : ''}`,
    );
    if (item.note) text(item.note);
  }
  heading('Dress code');
  if (!plan.dress_codes.length) text('Chưa có dress code.');
  for (const item of plan.dress_codes) {
    const activity = plan.activities.find((a) => a.id === item.activity_id);
    text(`${item.label} / ${activity?.title ?? item.plan_date ?? 'Cả chuyến đi'}`);
    if (item.description) text(item.description);
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc
      .fontSize(8)
      .fillColor('#617982')
      .text(`Wolfari / Kế hoạch riêng của nhóm / ${i + 1} / ${range.count}`, 48, 810, {
        lineBreak: false,
      });
  }
  doc.end();
  return result;
}

@Injectable()
export class PlanPdfService {
  private active = 0;
  constructor(private readonly database: DatabaseProvider) {}
  async export(raw: TripV1.ExportPlanPdfRequest) {
    if (this.active >= 2) return fail('SERVICE_UNAVAILABLE', 503);
    this.active++;
    try {
      const tripId = uuid(raw.trip_id),
        actor = uuid(raw.actor_user_id);
      const snapshot = await this.database.withTransaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        const trip =
          (
            await client.query<{
              name: string;
              description: string | null;
              start_at: Date;
              end_at: Date;
              timezone: string;
              plan_version: number;
            }>(
              'SELECT t.name,t.description,t.start_at,t.end_at,t.timezone,t.plan_version FROM trips t JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL WHERE t.id=$1 AND t.deleted_at IS NULL',
              [tripId, actor],
            )
          ).rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
        return { trip, plan: await readPlanLists(client, tripId, trip.plan_version) };
      });
      const content = await renderPlanPdf(snapshot);
      const access = await this.database.query(
        'SELECT 1 FROM trips t JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL WHERE t.id=$1 AND t.deleted_at IS NULL',
        [tripId, actor],
      );
      if (!access.rowCount) return fail('RESOURCE_NOT_FOUND', 404);
      return {
        content,
        filename: `wolfari-plan-${tripId}.pdf`,
        plan_version: snapshot.trip.plan_version,
      };
    } finally {
      this.active--;
    }
  }
}
