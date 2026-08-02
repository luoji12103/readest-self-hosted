import { NextResponse } from 'next/server';
import { getServerRuntimeConfig } from '@/services/runtimeConfig';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(getServerRuntimeConfig(), {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
