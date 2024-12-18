// types/giscus.d.ts

import { GiscusProps } from '@giscus/react';

// @giscus/react 패키지에서 GiscusProps 타입을 확장하여 `crossorigin` 속성 추가
declare module '@giscus/react' {
  export interface GiscusProps {
    crossorigin?: string;  // `crossorigin` 속성 추가
  }
}
