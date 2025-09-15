import { NextRequest, NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';

// 强制动态路由，禁用所有缓存
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// 服务端专用函数，直接调用外部API
async function getRecommendedShortDramasInternal(
  category?: number,
  size = 10
) {
  const params = new URLSearchParams();
  if (category) params.append('category', category.toString());
  params.append('size', size.toString());

  const response = await fetch(
    `https://api.r2afosne.dpdns.org/vod/recommend?${params.toString()}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  const items = data.items || [];
  return items.map((item: any) => ({
    id: item.vod_id || item.id,
    name: item.vod_name || item.name,
    cover: item.vod_pic || item.cover,
    update_time: item.vod_time || item.update_time || new Date().toISOString(),
    score: item.vod_score || item.score || 0,
    episode_count: parseInt(item.vod_remarks?.replace(/[^\d]/g, '') || '1'),
    description: item.vod_content || item.description || '',
  }));
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const category = searchParams.get('category');
    const size = searchParams.get('size');

    const categoryNum = category ? parseInt(category) : undefined;
    const pageSize = size ? parseInt(size) : 10;

    if ((category && isNaN(categoryNum!)) || isNaN(pageSize)) {
      return NextResponse.json(
        { error: '参数格式错误' },
        { status: 400 }
      );
    }

    const result = await getRecommendedShortDramasInternal(categoryNum, pageSize);

    // 强力禁用所有层级的缓存
    const response = NextResponse.json(result);

    // 标准HTTP缓存控制
    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Expires', '0');

    // 移动端特定缓存控制
    response.headers.set('Surrogate-Control', 'no-store');
    response.headers.set('X-Accel-Expires', '0');

    // 防止代理缓存
    response.headers.set('Vary', 'Accept-Encoding, User-Agent');

    // 强制刷新标识
    response.headers.set('X-Cache-Status', 'MISS');
    response.headers.set('X-Debug-Timestamp', new Date().toISOString());
    response.headers.set('X-Force-Refresh', 'true');

    return response;
  } catch (error) {
    console.error('获取推荐短剧失败:', error);
    return NextResponse.json(
      { error: '服务器内部错误' },
      { status: 500 }
    );
  }
}