import { statsCsv } from '../../../lib/facts-stats';

export function GET() {
  return new Response(statsCsv(), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
  });
}
