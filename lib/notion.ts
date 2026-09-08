import {
  type ExtendedRecordMap,
  type SearchParams,
  type SearchResults
} from 'notion-types'
import { mergeRecordMaps } from 'notion-utils'
import pMap from 'p-map'
import pMemoize from 'p-memoize'

import {
  isPreviewImageSupportEnabled,
  navigationLinks,
  navigationStyle
} from './config'
import { getTweetsMap } from './get-tweets'
import { notion } from './notion-api'
import { getPreviewImageMap } from './preview-images'

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

// 모든 Notion getPage 요청을 한 줄로 세워서 순차적으로 실행
let notionRequestQueue: Promise<void> = Promise.resolve()

async function getNotionPage(
  pageId: string,
  options?: Parameters<typeof notion.getPage>[1]
): Promise<ExtendedRecordMap> {
  const runRequest = async (): Promise<ExtendedRecordMap> => {
    const maxRetries = 4

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Notion 요청이 너무 빠르게 연속으로 나가지 않도록 간격 추가
      await sleep(1000)

      try {
        console.log('\nnotion page request', pageId)

        return await notion.getPage(pageId, options)
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

        // 429가 발생하면 3초 → 6초 → 12초 → 24초 대기
        const delay = 3000 * 2 ** attempt

        console.warn(
          `Notion rate limit (429). Retrying in ${delay / 1000}s...`
        )

        await sleep(delay)
      }
    }

    throw new Error(`Failed to load Notion page "${pageId}"`)
  }

  const result = notionRequestQueue.then(runRequest)

  // 성공/실패 여부와 관계없이 다음 요청이 계속 실행될 수 있도록 큐 유지
  notionRequestQueue = result.then(
    () => undefined,
    () => undefined
  )

  return result
}

const getNavigationLinkPages = pMemoize(
  async (): Promise<ExtendedRecordMap[]> => {
    const navigationLinkPageIds = (navigationLinks || [])
      .map((link) => link.pageId)
      .filter(Boolean)

    if (navigationStyle !== 'default' && navigationLinkPageIds.length) {
      return pMap(
        navigationLinkPageIds,
        async (navigationLinkPageId) =>
          getNotionPage(navigationLinkPageId, {
            chunkLimit: 1,
            fetchMissingBlocks: false,
            fetchCollections: false,
            signFileUrls: false
          }),
        {
          concurrency: 1
        }
      )
    }

    return []
  }
)

export async function getPage(pageId: string): Promise<ExtendedRecordMap> {
  let recordMap = await getNotionPage(pageId)

  if (navigationStyle !== 'default') {
    // ensure that any pages linked to in the custom navigation header have
    // their block info fully resolved in the page record map so we know
    // the page title, slug, etc.
    const navigationLinkRecordMaps = await getNavigationLinkPages()

    if (navigationLinkRecordMaps?.length) {
      recordMap = navigationLinkRecordMaps.reduce(
        (map, navigationLinkRecordMap) =>
          mergeRecordMaps(map, navigationLinkRecordMap),
        recordMap
      )
    }
  }

  if (isPreviewImageSupportEnabled) {
    const previewImageMap = await getPreviewImageMap(recordMap)
    ;(recordMap as any).preview_images = previewImageMap
  }

  await getTweetsMap(recordMap)

  return recordMap
}

export async function search(params: SearchParams): Promise<SearchResults> {
  return notion.search(params)
}
