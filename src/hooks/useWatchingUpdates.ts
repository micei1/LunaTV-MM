'use client';

/**
 * 追番更新检查的 TanStack Query Hook
 *
 * 功能：
 * - 自动检查用户观看过的剧集是否有新集数更新
 * - 使用 TanStack Query 管理数据获取和缓存
 * - 替代 watching-updates.ts 的手动缓存实现
 *
 * 工作原理：
 * 1. 获取所有播放记录
 * 2. 获取数据源映射表
 * 3. 并发检查每个剧集的最新集数
 * 4. 对比原始集数，判断是否有更新
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePlayRecordsArrayQuery } from './usePlayRecordsQuery';
import { useSourceMapQuery } from './useSourcesQuery';
import type { PlayRecord } from '@/lib/types';

// ============================================================================
// Types
// ============================================================================

export interface WatchingUpdate {
  hasUpdates: boolean;
  timestamp: number;
  updatedCount: number;
  continueWatchingCount: number;
  newReleasesCount: number;
  updatedSeries: {
    title: string;
    source_name: string;
    year: string;
    cover: string;
    sourceKey: string;
    videoId: string;
    currentEpisode: number;
    totalEpisodes: number;
    hasNewEpisode: boolean;
    hasContinueWatching: boolean;
    hasNewRelease: boolean;
    newEpisodes?: number;
    remainingEpisodes?: number;
    latestEpisodes?: number;
    remarks?: string;
    releaseDate?: string;
  }[];
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 检查单个剧集的更新状态
 */
async function checkSingleRecordUpdate(
  record: PlayRecord & { key: string },
  videoId: string,
  sourceKey: string,
): Promise<{
  hasUpdate: boolean;
  hasNewEpisode: boolean;
  hasContinueWatching: boolean;
  hasNewRelease: boolean;
  newEpisodes: number;
  remainingEpisodes: number;
  latestEpisodes: number;
}> {
  try {
    // 调用 API 获取最新详情
    const apiUrl = `/api/detail?source=${sourceKey}&id=${videoId}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
      console.warn(`获取${record.title}详情失败:`, response.status);
      return {
        hasUpdate: false,
        hasNewEpisode: false,
        hasContinueWatching: false,
        hasNewRelease: false,
        newEpisodes: 0,
        remainingEpisodes: 0,
        latestEpisodes: record.total_episodes,
      };
    }

    const detailData = await response.json();
    const latestEpisodes = detailData.total || record.total_episodes;

    // 获取原始集数（观看时的集数）
    const originalTotalEpisodes = record.original_episodes || record.total_episodes;

    // 检查是否有新集数
    const hasNewEpisode = latestEpisodes > originalTotalEpisodes;
    const newEpisodes = hasNewEpisode ? latestEpisodes - originalTotalEpisodes : 0;

    // 检查是否需要继续观看（未看完）
    const hasContinueWatching = record.index < latestEpisodes;
    const remainingEpisodes = hasContinueWatching ? latestEpisodes - record.index : 0;

    // 检查是否为新上映（原始集数为0或很少，现在有集数了）
    const hasNewRelease = originalTotalEpisodes <= 1 && latestEpisodes > 1;

    return {
      hasUpdate: hasNewEpisode || hasContinueWatching,
      hasNewEpisode,
      hasContinueWatching,
      hasNewRelease,
      newEpisodes,
      remainingEpisodes,
      latestEpisodes,
    };
  } catch (error) {
    console.error(`检查${record.title}更新失败:`, error);
    return {
      hasUpdate: false,
      hasNewEpisode: false,
      hasContinueWatching: false,
      hasNewRelease: false,
      newEpisodes: 0,
      remainingEpisodes: 0,
      latestEpisodes: record.total_episodes,
    };
  }
}

// ============================================================================
// Hook: 检查追番更新
// ============================================================================

/**
 * 检查追番更新
 *
 * @example
 * ```tsx
 * function UserMenu() {
 *   const { data: updates, isLoading } = useWatchingUpdatesQuery({
 *     enabled: isOpen && authInfo?.username,
 *   });
 *
 *   if (updates?.hasUpdates) {
 *     return <div>{updates.updatedCount}部有新集</div>;
 *   }
 * }
 * ```
 */
export function useWatchingUpdatesQuery(options?: {
  enabled?: boolean;
  forceRefresh?: boolean;
}) {
  const queryClient = useQueryClient();

  // 获取播放记录
  const { data: playRecordsArray } = usePlayRecordsArrayQuery({
    enabled: options?.enabled,
  });

  // 获取数据源映射
  const { data: sourceMap } = useSourceMapQuery({
    enabled: options?.enabled,
  });

  return useQuery({
    queryKey: ['watchingUpdates', options?.forceRefresh ? Date.now() : 'cached'] as const,
    queryFn: async (): Promise<WatchingUpdate> => {
      if (!playRecordsArray || playRecordsArray.length === 0) {
        return {
          hasUpdates: false,
          timestamp: Date.now(),
          updatedCount: 0,
          continueWatchingCount: 0,
          newReleasesCount: 0,
          updatedSeries: [],
        };
      }

      console.log('开始检查追番更新...');

      // 筛选候选记录（观看时间超过2分钟，且不是电影）
      const candidateRecords = playRecordsArray.filter((record) => {
        // 必须有观看时间
        if (record.play_time < 120) return false;

        // 排除电影（单集内容）
        if (record.total_episodes <= 1) return false;

        return true;
      });

      console.log(`找到 ${candidateRecords.length} 个可能有更新的剧集`);

      if (candidateRecords.length === 0) {
        return {
          hasUpdates: false,
          timestamp: Date.now(),
          updatedCount: 0,
          continueWatchingCount: 0,
          newReleasesCount: 0,
          updatedSeries: [],
        };
      }

      let updatedCount = 0;
      let continueWatchingCount = 0;
      let newReleasesCount = 0;
      const updatedSeries: WatchingUpdate['updatedSeries'] = [];

      // 并发检查所有记录的更新状态
      const updatePromises = candidateRecords.map(async (record) => {
        try {
          // 从存储key中解析出videoId
          const [sourceName, videoId] = record.key.split('+');

          // 映射数据源名称到 key
          let sourceKey = sourceName;
          if (sourceMap) {
            const mappedSource = sourceMap.get(sourceName);
            if (mappedSource) {
              sourceKey = mappedSource;
            }
          }

          const updateInfo = await checkSingleRecordUpdate(record, videoId, sourceKey);

          // 统计更新
          if (updateInfo.hasNewEpisode) {
            updatedCount++;
          }
          if (updateInfo.hasContinueWatching) {
            continueWatchingCount++;
          }
          if (updateInfo.hasNewRelease) {
            newReleasesCount++;
          }

          // 只添加有更新或需要继续观看的剧集
          if (updateInfo.hasUpdate) {
            updatedSeries.push({
              title: record.title,
              source_name: record.source_name,
              year: record.year,
              cover: record.cover,
              sourceKey,
              videoId,
              currentEpisode: record.index,
              totalEpisodes: record.total_episodes,
              hasNewEpisode: updateInfo.hasNewEpisode,
              hasContinueWatching: updateInfo.hasContinueWatching,
              hasNewRelease: updateInfo.hasNewRelease,
              newEpisodes: updateInfo.newEpisodes,
              remainingEpisodes: updateInfo.remainingEpisodes,
              latestEpisodes: updateInfo.latestEpisodes,
            });
          }
        } catch (error) {
          console.error(`检查${record.title}更新失败:`, error);
        }
      });

      // 等待所有检查完成
      await Promise.all(updatePromises);

      const hasUpdates = updatedCount > 0 || continueWatchingCount > 0 || newReleasesCount > 0;

      console.log('追番更新检查完成:', {
        hasUpdates,
        updatedCount,
        continueWatchingCount,
        newReleasesCount,
      });

      return {
        hasUpdates,
        timestamp: Date.now(),
        updatedCount,
        continueWatchingCount,
        newReleasesCount,
        updatedSeries,
      };
    },
    // 30分钟缓存，避免频繁检查
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    // 只在有播放记录和数据源映射时才执行
    enabled: options?.enabled && !!playRecordsArray && !!sourceMap,
    // 不自动重试，避免过多请求
    retry: false,
  });
}

/**
 * 手动触发追番更新检查
 */
export function useRefreshWatchingUpdates() {
  const queryClient = useQueryClient();

  return () => {
    // 强制刷新播放记录
    queryClient.invalidateQueries({ queryKey: ['playRecords'] });
    // 强制刷新追番更新
    queryClient.invalidateQueries({ queryKey: ['watchingUpdates'] });
  };
}
