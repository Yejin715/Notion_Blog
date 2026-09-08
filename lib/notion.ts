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
      // 재시도 시에만 간격을 두고, 첫 요청은 즉시 실행
      if (attempt > 0) {
        await sleep(500)
      }

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


/**
 * notion-client는 collection_view의 format.property_filters(링크드 데이터베이스 필터)를
 * queryCollection 호출 시 서버에 전달하지 않아서 모든 뷰가 필터 없이 전체 항목을 반환합니다.
 * 이 함수는 format.property_filters를 읽어 collection_query 결과를 서버 사이드에서 필터링합니다.
 */
function applyPropertyFilters(recordMap: ExtendedRecordMap): void {
  const collectionViews = recordMap.collection_view
  if (!collectionViews) return

  for (const [viewId, viewData] of Object.entries(collectionViews)) {
    const viewValue = (viewData as any)?.value?.value
    if (!viewValue) continue

    const propertyFilters: any[] = viewValue.format?.property_filters
    if (!propertyFilters?.length) continue

    const collectionId = viewValue.format?.collection_pointer?.id
    if (!collectionId) continue

    const collectionQuery = (recordMap as any).collection_query
    if (!collectionQuery?.[collectionId]?.[viewId]) continue

    const queryResult = collectionQuery[collectionId][viewId]

    // collection_query의 blockIds 위치는 API 응답 구조에 따라 다름
    const groupResults = queryResult.collection_group_results
    let blockIds: string[] = groupResults?.blockIds ?? queryResult.blockIds ?? []
    if (!blockIds.length) continue

    // 각 property_filter를 순서대로 적용해 blockIds를 필터링
    for (const pf of propertyFilters) {
      const filter = pf.filter?.filter
      const property = pf.filter?.property
      if (!filter || !property) continue

      const { operator, value } = filter

      if (operator === 'enum_is' && value?.type === 'exact') {
        const filterValue = value.value as string
        blockIds = blockIds.filter((blockId) => {
          const block = (recordMap.block[blockId] as any)?.value?.value
          if (!block) return false
          // Notion select 속성 값은 [["Dev Tools"]] 형태로 저장됨
          const cellValue = block.properties?.[property]?.[0]?.[0]
          return cellValue === filterValue
        })
      }
    }

    // 필터링된 blockIds로 collection_query 업데이트
    if (groupResults) {
      groupResults.blockIds = blockIds
    } else {
      queryResult.blockIds = blockIds
    }

    console.log(
      `[applyPropertyFilters] view "${viewValue.name}": ${
        (groupResults?.blockIds ?? queryResult.blockIds ?? []).length
      } items after filter`
    )
  }
}

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

  // format.property_filters(링크드 DB 필터)를 notion-client가 적용하지 않으므로 수동으로 필터링
  applyPropertyFilters(recordMap)

  return recordMap
}

export async function search(params: SearchParams): Promise<SearchResults> {
  return notion.search(params)
}
