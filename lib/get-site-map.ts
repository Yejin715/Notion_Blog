import {
  getAllPagesInSpace,
  getBlockValue,
  getPageProperty,
  uuidToId
} from 'notion-utils'
import pMemoize from 'p-memoize'

import type * as types from './types'
import * as config from './config'
import { includeNotionIdInUrls } from './config'
import { getCanonicalPageId } from './get-canonical-page-id'
import { notion } from './notion-api'

const uuid = !!includeNotionIdInUrls

export async function getSiteMap(): Promise<types.SiteMap> {
  const partialSiteMap = await getAllPages(
    config.rootNotionPageId,
    config.rootNotionSpaceId ?? undefined
  )

  return {
    site: {
      ...config.site,
      rootNotionSpaceId: config.rootNotionSpaceId ?? null
    },
    ...partialSiteMap
  } as types.SiteMap
}

const getAllPages = pMemoize(getAllPagesImpl, {
  cacheKey: (...args) => JSON.stringify(args)
})

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Notion API 요청을 하나씩 실행하기 위한 전역 큐
let notionRequestQueue: Promise<void> = Promise.resolve()

const getPage = async (pageId: string, ...args: any[]) => {
  const runRequest = async () => {
    const maxRetries = 4

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 재시도 시에만 간격을 두고, 첫 요청은 즉시 실행
      if (attempt > 0) {
        await sleep(500)
      }

      try {
        console.log('\nnotion getPage', uuidToId(pageId))

        return await notion.getPage(pageId, ...args)
      } catch (err: any) {
        const status =
          err?.response?.status ??
          err?.status ??
          err?.statusCode

        const message = String(err?.message ?? err)

        const isRateLimit =
          status === 429 ||
          message.includes('429') ||
          message.includes('Too Many Requests')

        if (!isRateLimit || attempt === maxRetries) {
          throw err
        }

        const delay = 2000 * 2 ** attempt

        console.warn(
          `Notion rate limit (429). Retrying in ${delay / 1000}s...`
        )

        await sleep(delay)
      }
    }

    throw new Error(`Failed to load Notion page "${pageId}"`)
  }

  // 앞선 요청이 끝날 때까지 기다린 뒤 현재 요청 실행
  const result = notionRequestQueue.then(runRequest)

  // 현재 요청이 성공하든 실패하든 다음 요청이 이어질 수 있도록 큐 유지
  notionRequestQueue = result.then(
    () => undefined,
    () => undefined
  )

  return result
}

async function getAllPagesImpl(
  rootNotionPageId: string,
  rootNotionSpaceId?: string,
  {
    maxDepth = 1
  }: {
    maxDepth?: number
  } = {}
): Promise<Partial<types.SiteMap>> {
  const pageMap = await getAllPagesInSpace(
    rootNotionPageId,
    rootNotionSpaceId,
    getPage,
    {
      maxDepth,
      concurrency: 1
    }
  )

  const canonicalPageMap = Object.keys(pageMap).reduce(
    (map: Record<string, string>, pageId: string) => {
      const recordMap = pageMap[pageId]

      if (!recordMap) {
        throw new Error(`Error loading page "${pageId}"`)
      }

      const block = getBlockValue(recordMap.block[pageId])

      if (
        !(getPageProperty<boolean | null>('Public', block!, recordMap) ?? true)
      ) {
        return map
      }

      const canonicalPageId = getCanonicalPageId(pageId, recordMap, {
        uuid
      })!

      if (map[canonicalPageId]) {
        console.warn('error duplicate canonical page id', {
          canonicalPageId,
          pageId,
          existingPageId: map[canonicalPageId]
        })

        return map
      } else {
        return {
          ...map,
          [canonicalPageId]: pageId
        }
      }
    },
    {}
  )

  return {
    pageMap,
    canonicalPageMap
  }
}
