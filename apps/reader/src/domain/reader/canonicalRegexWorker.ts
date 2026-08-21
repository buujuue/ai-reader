import {
  collectRegexMatchOffsets,
  type RegexMatchOffset,
  type SearchBudgetErrorCode,
} from './canonicalSearch';

interface RegexWorkerRequest {
  text: string;
  pattern: string;
  matchCase: boolean;
}

interface RegexWorkerResponse {
  type: 'result' | 'error';
  offsets?: RegexMatchOffset[];
  code?: SearchBudgetErrorCode;
  message?: string;
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RegexWorkerRequest>) => void) | null;
  postMessage(message: RegexWorkerResponse): void;
};

scope.onmessage = (event) => {
  try {
    scope.postMessage({
      type: 'result',
      offsets: collectRegexMatchOffsets(event.data.text, event.data.pattern, event.data.matchCase),
    });
  } catch (error) {
    const typed = error as { code?: SearchBudgetErrorCode; message?: string };
    scope.postMessage({
      type: 'error',
      code: typed.code ?? 'REGEX_TIMEOUT',
      message: typed.message ?? '正则搜索失败',
    });
  }
};
