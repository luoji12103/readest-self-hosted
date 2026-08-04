import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const validateUserAndTokenMock = vi.fn();
const getUploadSignedUrlMock = vi.fn();
const createSupabaseAdminClientMock = vi.fn();

vi.mock('@/utils/cors', () => ({
  corsAllMethods: {},
  runMiddleware: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/utils/access', () => ({
  validateUserAndToken: (...args: unknown[]) => validateUserAndTokenMock(...args),
  getStoragePlanData: vi.fn().mockReturnValue({ usage: 0, quota: 10 ** 12 }),
  STORAGE_QUOTA_GRACE_BYTES: 0,
}));
vi.mock('@/utils/object', () => ({
  isSafeObjectKeyName: () => true,
  getUploadSignedUrl: (...args: unknown[]) => getUploadSignedUrlMock(...args),
  getDownloadSignedUrl: vi.fn(),
}));
vi.mock('@/utils/supabase', () => ({
  createSupabaseAdminClient: (...args: unknown[]) => createSupabaseAdminClientMock(...args),
}));
vi.mock('@/services/runtimeConfig', () => ({
  isBookFileUploadEnabled: () => false,
}));

import handler from '@/pages/api/storage/upload';

const makeReqRes = (body: Record<string, unknown>) => {
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body,
  } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  return { req, res };
};

beforeEach(() => {
  validateUserAndTokenMock.mockResolvedValue({ user: { id: 'user-id' }, token: 'token' });
  getUploadSignedUrlMock.mockReset().mockResolvedValue('https://storage/upload');
  const single = vi
    .fn()
    .mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } })
    .mockResolvedValueOnce({ data: { file_size: 123 }, error: null });
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'limit', 'insert']) builder[method] = () => builder;
  builder['single'] = single;
  createSupabaseAdminClientMock.mockReturnValue({ from: () => builder });
});

describe('POST /api/storage/upload book-file policy', () => {
  it('rejects book content by canonical path even when bookHash is omitted', async () => {
    const { req, res } = makeReqRes({
      fileName: 'Readest/Books/hash/book.epub',
      fileSize: 123,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Book file uploads are disabled' });
    expect(createSupabaseAdminClientMock).not.toHaveBeenCalled();
    expect(getUploadSignedUrlMock).not.toHaveBeenCalled();
  });

  it('continues to allow canonical cover uploads', async () => {
    const { req, res } = makeReqRes({
      fileName: 'Readest/Books/hash/cover.png',
      fileSize: 123,
      bookHash: 'hash',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(getUploadSignedUrlMock).toHaveBeenCalled();
  });
});
