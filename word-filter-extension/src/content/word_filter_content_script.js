/**
 * word_filter_content_script.js
 * ---------------------------------------------------------------------------
 * 현재 열린 탭의 DOM 을 훑어 등록된 패턴(텍스트 또는 정규표현식)을 찾아 현재 모드로 처리한다.
 *
 *   [블록 모드] 패턴이 걸린 블록 엘리먼트(문단·카드·목록 항목) 전체를 필터링 컬러로
 *   [단어 모드] 걸린 부분만 필터링 컬러로
 *
 * 두 모드가 같은 "필터링 컬러(RGB + Opacity)"를 공유한다. Opacity 0 이면 대상이 완전히
 * 투명해져 보이지 않고, 1 이면 색이 꽉 찬 블록이 된다.
 *
 * [전체 흐름]
 *   1) 페이지 로드(document_idle) → loadFilterSettings() 로 설정을 읽는다.
 *   2) applyFilterToEntireDocument() → 전체 문서를 한 번 스캔해서 현재 모드로 처리한다.
 *   3) startObservingDomChanges() → MutationObserver 로 이후에 추가/변경되는
 *      DOM(무한 스크롤, SPA 라우팅, 댓글 로딩 등)도 계속 처리한다.
 *   4) chrome.storage.onChanged → 옵션 화면에서 패턴/모드/컬러를 바꾸면
 *      전체 복원 후 재적용한다. 새로고침이 필요 없다.
 *   5) 처리한 개수는 service worker 로 보내 확장 아이콘 배지에 표시한다.
 */
(() => {
  // 확장 리로드 등으로 중복 주입되는 경우를 방지
  if (globalThis.__wordFilterContentScriptInitialized) return;
  globalThis.__wordFilterContentScriptInitialized = true;

  const {
    loadFilterSettings,
    normalizeFilterSettings,
    FILTER_SETTINGS_STORAGE_KEY,
    FILTERING_MODE,
    DEFAULT_FILTER_SETTINGS,
  } = globalThis.wordFilterSettingsStorage;

  const {
    BLOCK_MARKER_ATTRIBUTE,
    WORD_MARKER_ATTRIBUTE,
    applyBlockFilterToElement,
    buildFilteredFragmentFromTextNode,
    compileFilterPatternList,
    findFirstMatchingPattern,
    restoreAllFiltersWithin,
  } = globalThis.wordFilterApplyHelper;

  // ───────────────────────── 상수 정의 ─────────────────────────

  /** 텍스트 스캔 대상에서 제외할 태그 (코드/스타일/스크립트 등은 화면 텍스트가 아니다) */
  const TEXT_SCAN_EXCLUDED_TAG_NAMES = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEXTAREA',
    'TITLE',
    'HEAD',
    'META',
    'LINK',
    'IFRAME',
    'SVG',
    'CANVAS',
  ]);

  /**
   * 블록 모드에서 부모로 올라갈 때, 이 태그를 만나면 더 올라가지 않는다.
   * 이 가드가 없으면 <body> 나 <main> 까지 올라가서 페이지 전체가 처리될 수 있다.
   */
  const ANCESTOR_CLIMB_STOP_TAG_NAMES = new Set([
    'BODY',
    'HTML',
    'MAIN',
    'HEADER',
    'FOOTER',
    'NAV',
    'ASIDE',
    'SECTION',
    'ARTICLE',
    'FORM',
    'TABLE',
    'TBODY',
    'THEAD',
    'UL',
    'OL',
    'DL',
  ]);

  /**
   * 이 display 값을 가진 엘리먼트는 "줄 안에 놓이는 조각"이므로 대상으로 삼지 않고 계속 올라간다.
   *
   * inline-block 계열을 포함하는 이유: 사이트가 제목 끝의 말머리를
   * <b style="display:inline-block">(펌)</b> 처럼 감싸는 경우가 흔한데, 여기서 멈추면
   * 한 줄 중 말머리 세 글자만 가려져 필터링이 안 먹은 것처럼 보인다.
   * 인라인 레벨 박스는 문장의 일부이지 독립된 덩어리가 아니므로 통과시킨다.
   */
  const INLINE_LEVEL_DISPLAY_VALUES = new Set([
    'inline',
    'inline-block',
    'inline-flex',
    'inline-grid',
    'inline-table',
    'contents',
    'ruby',
    'ruby-text',
  ]);

  /** 사용자가 직접 입력 중인 영역 셀렉터 (편집 방해 방지를 위해 제외) */
  const EDITABLE_AREA_SELECTOR = '[contenteditable="true"], [contenteditable=""]';

  /** DOM 변경이 폭주할 때 스캔 횟수를 줄이기 위한 디바운스 지연(ms) */
  const DOM_CHANGE_DEBOUNCE_DELAY_MS = 150;

  /** service worker / 팝업과 주고받는 메시지 타입 */
  const MESSAGE_TYPE = {
    REPORT_FILTERED_TARGET_COUNT: 'REPORT_FILTERED_TARGET_COUNT',
    REQUEST_FILTER_STATUS: 'REQUEST_FILTER_STATUS',
    REQUEST_FILTER_REAPPLY: 'REQUEST_FILTER_REAPPLY',
  };

  // ───────────────────────── 런타임 상태 ─────────────────────────

  /** @type {typeof DEFAULT_FILTER_SETTINGS} */
  let currentFilterSettings = { ...DEFAULT_FILTER_SETTINGS };

  /**
   * 컴파일된 패턴 목록. 설정이 바뀔 때 한 번만 만들어 재사용한다.
   * 정규식을 텍스트 노드마다 새로 컴파일하면 성능이 무너지기 때문이다.
   */
  let compiledPatternList = [];

  /**
   * 이번 페이지에서 처리한 개수.
   *  - 블록 모드: 처리한 엘리먼트 수
   *  - 단어 모드: 처리한 단어 수
   */
  let filteredTargetCount = 0;

  /** @type {MutationObserver | null} */
  let domChangeObserver = null;

  /** 디바운스 타이머 핸들 */
  let debounceTimerId = 0;

  /** 디바운스 동안 모아 둔, 다시 스캔해야 할 서브트리 루트들 */
  const pendingScanRootSet = new Set();

  // ───────────────────────── 단어 매칭 ─────────────────────────

  /** 설정이 바뀔 때마다 패턴 목록을 다시 컴파일한다. */
  function rebuildCompiledPatternList() {
    compiledPatternList = compileFilterPatternList(
      currentFilterSettings.filteredPatternList,
      currentFilterSettings.shouldMatchCaseSensitively,
    );
  }

  /**
   * 텍스트에 걸리는 패턴을 찾는다. 텍스트 타입은 부분 문자열, 정규식 타입은 정규식으로
   * 검사하며, 판정 로직은 공용 헬퍼가 담당한다.
   * @param {string} rawText
   * @returns {string | null} 매칭된 패턴 문자열. 없으면 null
   */
  function findMatchedPatternInText(rawText) {
    return findFirstMatchingPattern(
      rawText,
      compiledPatternList,
      currentFilterSettings.shouldMatchCaseSensitively,
    );
  }

  /** 현재 모드가 "단어" 모드인지 */
  function isWordFilteringMode() {
    return currentFilterSettings.filteringMode === FILTERING_MODE.WORD;
  }

  // ───────────────────── 스캔 대상 텍스트 노드 수집 ─────────────────────

  /**
   * 주어진 서브트리에서 "검사할 가치가 있는" 텍스트 노드만 모아 배열로 반환한다.
   *
   * DOM 을 바꾸면서 TreeWalker 를 순회하면 순회 위치가 흐트러질 수 있으므로,
   * **먼저 전부 수집한 뒤 나중에 한꺼번에 변경**하는 2단계 구조로 만들었다.
   *
   * @param {Node} scanRootNode
   * @returns {Text[]}
   */
  function collectScannableTextNodeList(scanRootNode) {
    /** @type {Text[]} */
    const scannableTextNodeList = [];

    const textNodeWalker = document.createTreeWalker(scanRootNode, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        const parentElement = textNode.parentElement;
        if (!parentElement) return NodeFilter.FILTER_REJECT;

        // 스크립트/스타일 등 화면에 보이지 않는 텍스트는 건너뛴다
        if (TEXT_SCAN_EXCLUDED_TAG_NAMES.has(parentElement.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        // 공백만 있는 노드 제외
        if (textNode.nodeValue === null || textNode.nodeValue.trim().length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        // 우리가 이미 만든 단어 span 내부의 텍스트는 다시 보지 않는다.
        // → 처리 → MutationObserver 감지 → 또 처리 로 이어지는 무한 루프를 막는 핵심 가드
        if (parentElement.closest(`[${WORD_MARKER_ATTRIBUTE}]`)) return NodeFilter.FILTER_REJECT;
        // 이미 블록 모드로 처리한 영역 내부도 다시 볼 필요가 없다 (성능)
        if (parentElement.closest(`[${BLOCK_MARKER_ATTRIBUTE}]`)) return NodeFilter.FILTER_REJECT;
        // 사용자가 입력 중인 영역은 건드리지 않는다
        if (parentElement.closest(EDITABLE_AREA_SELECTOR)) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    for (let textNode = textNodeWalker.nextNode(); textNode; textNode = textNodeWalker.nextNode()) {
      scannableTextNodeList.push(/** @type {Text} */ (textNode));
    }
    return scannableTextNodeList;
  }

  // ───────────────────────── 블록 모드 ─────────────────────────

  /**
   * 텍스트 노드에서 시작해 "처리해도 자연스러운 최소 단위 블록"을 찾아 올라간다.
   *
   * 예) <li><span>스포일러 단어</span> ...</li>
   *     → 텍스트 노드의 부모는 inline 인 <span> 이므로 한 단계 올라가 <li> 를 처리한다.
   *
   * @param {Text} textNode
   * @returns {HTMLElement | null}
   */
  function findBlockTargetElementFromTextNode(textNode) {
    /** @type {HTMLElement | null} */
    let candidateElement = textNode.parentElement;
    if (!candidateElement) return null;

    /**
     * 마지막으로 "처리해도 되는" 후보. stop 태그를 만났을 때 stop 태그 자신을 처리하면
     * (예: <section> 전체) 너무 많이 사라지므로, 직전 후보를 대신 반환한다.
     * @type {HTMLElement | null}
     */
    let lastSafeCandidateElement = null;

    while (candidateElement) {
      const isForbiddenToFilter =
        candidateElement === document.body ||
        candidateElement === document.documentElement ||
        ANCESTOR_CLIMB_STOP_TAG_NAMES.has(candidateElement.tagName);

      // stop 태그에 도달 → 직전 후보를 반환(없으면 처리하지 않음)
      if (isForbiddenToFilter) return lastSafeCandidateElement;

      lastSafeCandidateElement = candidateElement;

      const computedDisplay = window.getComputedStyle(candidateElement).display;
      if (!INLINE_LEVEL_DISPLAY_VALUES.has(computedDisplay)) {
        return candidateElement; // block / flex / grid / inline-block / list-item 등 → 여기서 멈춘다
      }

      candidateElement = candidateElement.parentElement;
    }
    return lastSafeCandidateElement;
  }

  /**
   * 블록 모드 적용: 매칭되는 블록 엘리먼트를 찾아 필터링 컬러를 적용한다.
   * @param {Text[]} scannableTextNodeList
   * @returns {number} 새로 처리한 엘리먼트 수
   */
  function applyBlockFilterToMatchingElements(scannableTextNodeList) {
    // 1) 후보 블록을 먼저 모은다. 한 블록 안에 텍스트 노드가 여러 개여도 한 번만 검사한다.
    /** @type {Set<HTMLElement>} */
    const candidateBlockSet = new Set();
    scannableTextNodeList.forEach((textNode) => {
      const targetElement = findBlockTargetElementFromTextNode(textNode);
      if (targetElement) candidateBlockSet.add(targetElement);
    });

    // 2) 판정은 텍스트 노드가 아니라 **블록 전체의 텍스트**로 한다.
    //    화면상 한 문장이 여러 엘리먼트로 쪼개져 있어도(예: <a>제목</a><b>(펌)</b>)
    //    이어 붙인 문자열에서 패턴을 찾을 수 있다.
    let newlyFilteredCount = 0;
    candidateBlockSet.forEach((targetElement) => {
      const matchedWord = findMatchedPatternInText(targetElement.textContent ?? '');
      if (!matchedWord) return;

      const didApply = applyBlockFilterToElement(
        targetElement,
        currentFilterSettings.filterColor,
        matchedWord,
      );
      if (didApply) newlyFilteredCount += 1;
    });
    return newlyFilteredCount;
  }

  // ───────────────────────── 단어 모드 ─────────────────────────

  /**
   * 단어 모드 적용: 텍스트 노드를 쪼개 매칭 구간만 span 으로 감싼다.
   *
   * 순서가 중요하다. 먼저 모든 텍스트 노드에 대한 교체용 fragment 를 만들어 두고,
   * 그다음에 replaceChild 로 한 번씩 교체한다. 교체 도중에 다른 텍스트 노드를
   * 다시 계산하면 이미 분리된 노드를 잡을 위험이 있다.
   *
   * @param {Text[]} scannableTextNodeList
   * @returns {number} 새로 처리한 단어 수
   */
  function applyWordFilterToMatchingWords(scannableTextNodeList) {
    /** @type {Array<{textNode: Text, fragment: DocumentFragment, filteredWordCount: number}>} */
    const wordFilterTaskList = [];

    scannableTextNodeList.forEach((textNode) => {
      const buildResult = buildFilteredFragmentFromTextNode(
        textNode,
        compiledPatternList,
        currentFilterSettings.shouldMatchCaseSensitively,
        currentFilterSettings.filterColor,
      );
      if (!buildResult) return;
      wordFilterTaskList.push({ textNode, ...buildResult });
    });

    let newlyFilteredWordCount = 0;
    wordFilterTaskList.forEach(({ textNode, fragment, filteredWordCount }) => {
      const parentNode = textNode.parentNode;
      if (!parentNode) return; // 그사이 페이지에서 제거된 노드
      parentNode.replaceChild(fragment, textNode);
      newlyFilteredWordCount += filteredWordCount;
    });
    return newlyFilteredWordCount;
  }

  // ───────────────────────── 스캔 진입점 ─────────────────────────

  /**
   * 주어진 서브트리에 현재 모드의 필터를 적용한다.
   * @param {Node} scanRootNode
   * @returns {number} 이번 호출에서 새로 처리한 개수
   */
  function applyFilterToSubtree(scanRootNode) {
    if (!currentFilterSettings.isFilteringEnabled) return 0;
    if (compiledPatternList.length === 0) return 0;
    if (!scanRootNode || !scanRootNode.isConnected) return 0;

    const scannableTextNodeList = collectScannableTextNodeList(scanRootNode);
    if (scannableTextNodeList.length === 0) return 0;

    const newlyFilteredCount = isWordFilteringMode()
      ? applyWordFilterToMatchingWords(scannableTextNodeList)
      : applyBlockFilterToMatchingElements(scannableTextNodeList);

    filteredTargetCount += newlyFilteredCount;
    return newlyFilteredCount;
  }

  /** 전체 문서를 복원 후 처음부터 다시 적용한다. */
  function applyFilterToEntireDocument() {
    // 모드를 바꿔도 이전 모드의 흔적이 남지 않도록 항상 둘 다 복원한다
    restoreAllFiltersWithin(document);
    filteredTargetCount = 0;

    if (currentFilterSettings.isFilteringEnabled) {
      applyFilterToSubtree(document.body ?? document.documentElement);
    }
    reportFilteredTargetCountToServiceWorker();
  }

  // ───────────────────────── DOM 변경 감시 ─────────────────────────

  /** 디바운스 타이머가 만료되면, 모아 둔 서브트리들만 부분 스캔한다. */
  function flushPendingScanRoots() {
    debounceTimerId = 0;
    if (pendingScanRootSet.size === 0) return;

    const scanRootList = [...pendingScanRootSet];
    pendingScanRootSet.clear();

    let newlyFilteredCount = 0;
    scanRootList.forEach((scanRootNode) => {
      newlyFilteredCount += applyFilterToSubtree(scanRootNode);
    });

    if (newlyFilteredCount > 0) reportFilteredTargetCountToServiceWorker();
  }

  /**
   * 이 노드가 우리가 만든 단어 span 인지(또는 그 내부인지) 판단한다.
   * 우리 변경이 다시 스캔 대기열에 들어가는 것을 막아 불필요한 재스캔을 줄인다.
   * @param {Node} node
   */
  function isOwnFilteredWordNode(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      return /** @type {Element} */ (node).hasAttribute(WORD_MARKER_ATTRIBUTE);
    }
    const parentElement = node.parentElement;
    return Boolean(parentElement && parentElement.closest(`[${WORD_MARKER_ATTRIBUTE}]`));
  }

  /** DOM 변경을 감시해 새로 들어온 콘텐츠에도 필터를 적용한다. */
  function startObservingDomChanges() {
    if (domChangeObserver) return;

    domChangeObserver = new MutationObserver((mutationRecordList) => {
      if (!currentFilterSettings.isFilteringEnabled) return;

      mutationRecordList.forEach((mutationRecord) => {
        if (mutationRecord.type === 'characterData') {
          // 텍스트가 바뀐 경우: 그 텍스트의 부모부터 다시 검사
          if (isOwnFilteredWordNode(mutationRecord.target)) return;
          const changedTextParentElement = mutationRecord.target.parentElement;
          if (changedTextParentElement) pendingScanRootSet.add(changedTextParentElement);
          return;
        }
        mutationRecord.addedNodes.forEach((addedNode) => {
          // 우리가 방금 삽입한 단어 span 은 무시 (재진입 방지)
          if (isOwnFilteredWordNode(addedNode)) return;

          if (addedNode.nodeType === Node.ELEMENT_NODE) {
            pendingScanRootSet.add(addedNode);
          } else if (addedNode.nodeType === Node.TEXT_NODE && addedNode.parentElement) {
            pendingScanRootSet.add(addedNode.parentElement);
          }
        });
      });

      if (pendingScanRootSet.size > 0 && debounceTimerId === 0) {
        debounceTimerId = window.setTimeout(flushPendingScanRoots, DOM_CHANGE_DEBOUNCE_DELAY_MS);
      }
    });

    domChangeObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      // attributes 는 감시하지 않는다 → 우리가 style 을 바꿀 때 무한 루프가 생기지 않는다.
    });
  }

  // ───────────────────────── 메시지 / 설정 동기화 ─────────────────────────

  /** 처리한 개수를 service worker 에 알려 아이콘 배지를 갱신한다. */
  function reportFilteredTargetCountToServiceWorker() {
    // 최상위 프레임만 배지를 갱신한다 (iframe 이 배지를 덮어쓰지 않도록)
    if (window.top !== window) return;
    chrome.runtime
      .sendMessage({
        type: MESSAGE_TYPE.REPORT_FILTERED_TARGET_COUNT,
        filteredTargetCount,
      })
      .catch(() => {
        /* service worker 가 잠들어 있거나 컨텍스트가 무효화된 경우는 무시 */
      });
  }

  /** 팝업이 현재 탭 상태를 물어보면 응답한다. */
  chrome.runtime.onMessage.addListener((requestMessage, _sender, sendResponse) => {
    if (requestMessage?.type === MESSAGE_TYPE.REQUEST_FILTER_STATUS) {
      sendResponse({
        filteredTargetCount,
        filteringMode: currentFilterSettings.filteringMode,
        isFilteringEnabled: currentFilterSettings.isFilteringEnabled,
        registeredPatternCount: currentFilterSettings.filteredPatternList.length,
      });
      return false;
    }
    if (requestMessage?.type === MESSAGE_TYPE.REQUEST_FILTER_REAPPLY) {
      applyFilterToEntireDocument();
      sendResponse({ filteredTargetCount, filteringMode: currentFilterSettings.filteringMode });
      return false;
    }
    return false;
  });

  /** 옵션 화면에서 설정을 저장하면 즉시 반영한다. */
  chrome.storage.onChanged.addListener((changeMap, areaName) => {
    if (areaName !== 'sync' || !changeMap[FILTER_SETTINGS_STORAGE_KEY]) return;
    currentFilterSettings = normalizeFilterSettings(changeMap[FILTER_SETTINGS_STORAGE_KEY].newValue);
    rebuildCompiledPatternList();
    applyFilterToEntireDocument();
  });

  // ───────────────────────── 초기화 ─────────────────────────

  async function initializeWordFilter() {
    currentFilterSettings = await loadFilterSettings();
    rebuildCompiledPatternList();
    applyFilterToEntireDocument();
    startObservingDomChanges();
  }

  initializeWordFilter();
})();
