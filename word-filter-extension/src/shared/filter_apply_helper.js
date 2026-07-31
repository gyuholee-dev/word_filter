/**
 * filter_apply_helper.js
 * ---------------------------------------------------------------------------
 * 두 모드(블록 / 단어)의 "실제로 화면에 적용하는" 로직 공용 모듈.
 *
 * content script(실제 웹페이지)와 옵션 화면(미리보기)이 **같은 함수**를 쓴다.
 * 로직이 두 곳에 복제되면 미리보기와 실제 동작이 어긋나는 버그가 반드시 생긴다.
 *
 * [적용 방식]
 *  - 블록 모드: 대상 엘리먼트에 마커 속성 + CSS 변수(--word-filter-color)를 심고,
 *               opacity 만 인라인 !important 로 직접 지정한다.
 *               색 칠하기는 word_filter_styles.css 의 자손 셀렉터가 담당한다.
 *               (페이지 소유 엘리먼트라 자손까지 덮으려면 스타일시트가 필요)
 *  - 단어 모드: 우리가 만든 span 이므로 모든 스타일을 인라인 !important 로 넣는다.
 *               인라인 !important 는 CSS 우선순위상 가장 강하고, 복원할 때
 *               span 을 통째로 버리면 되므로 백업이 필요 없다.
 */
(() => {
  if (globalThis.wordFilterApplyHelper) return;

  const { formatFilterColorToCssRgb, MATCH_TYPE } = globalThis.wordFilterSettingsStorage;

  /** 블록 모드로 처리한 엘리먼트 마커 */
  const BLOCK_MARKER_ATTRIBUTE = 'data-word-filter-block';
  /** 단어 모드로 감싼 span 마커 */
  const WORD_MARKER_ATTRIBUTE = 'data-word-filter-word';
  /** 어떤 단어에 걸렸는지 기록 (디버깅용) */
  const MATCHED_WORD_ATTRIBUTE = 'data-word-filter-matched-word';
  /** 블록 모드 복원용: 원래 인라인 opacity 백업 */
  const ORIGINAL_OPACITY_BACKUP_ATTRIBUTE = 'data-word-filter-original-opacity';

  /** 스타일시트가 참조하는 CSS 변수 이름 */
  const FILTER_COLOR_CSS_VARIABLE = '--word-filter-color';

  // ───────────────────────── 블록 모드 ─────────────────────────

  /**
   * 블록 엘리먼트에 필터링 컬러를 적용한다.
   *
   * opacity 만 인라인으로 넣는 이유: 인라인 !important 는 페이지의 어떤 CSS 도 이길 수
   * 없는 최강 우선순위다. "안 보이게 한다"는 핵심 동작이 페이지 CSS 에 밀리면 안 되므로
   * 이것만은 인라인으로 확실히 못 박는다.
   *
   * @param {HTMLElement} targetElement
   * @param {{red: number, green: number, blue: number, opacity: number}} filterColor
   * @param {string} matchedWord
   * @returns {boolean} 새로 적용했으면 true (이미 적용된 엘리먼트면 false)
   */
  function applyBlockFilterToElement(targetElement, filterColor, matchedWord) {
    if (targetElement.hasAttribute(BLOCK_MARKER_ATTRIBUTE)) return false;

    // 원래 인라인 opacity 값을 백업 (없으면 빈 문자열)
    targetElement.setAttribute(
      ORIGINAL_OPACITY_BACKUP_ATTRIBUTE,
      targetElement.style.getPropertyValue('opacity'),
    );
    targetElement.style.setProperty(
      FILTER_COLOR_CSS_VARIABLE,
      formatFilterColorToCssRgb(filterColor),
    );
    targetElement.style.setProperty('opacity', String(filterColor.opacity), 'important');

    targetElement.setAttribute(BLOCK_MARKER_ATTRIBUTE, 'true');
    targetElement.setAttribute(MATCHED_WORD_ATTRIBUTE, matchedWord);
    return true;
  }

  /**
   * 지정한 루트 안의 블록 모드 적용을 모두 되돌린다.
   * @param {ParentNode} rootNode
   * @returns {number} 되돌린 엘리먼트 수
   */
  function restoreAllBlockFiltersWithin(rootNode) {
    const filteredBlockElementList = rootNode.querySelectorAll(`[${BLOCK_MARKER_ATTRIBUTE}]`);

    filteredBlockElementList.forEach((filteredBlockElement) => {
      const backedUpOpacity =
        filteredBlockElement.getAttribute(ORIGINAL_OPACITY_BACKUP_ATTRIBUTE) ?? '';

      filteredBlockElement.style.removeProperty(FILTER_COLOR_CSS_VARIABLE);
      if (backedUpOpacity === '') {
        filteredBlockElement.style.removeProperty('opacity');
      } else {
        filteredBlockElement.style.setProperty('opacity', backedUpOpacity);
      }

      filteredBlockElement.removeAttribute(ORIGINAL_OPACITY_BACKUP_ATTRIBUTE);
      filteredBlockElement.removeAttribute(BLOCK_MARKER_ATTRIBUTE);
      filteredBlockElement.removeAttribute(MATCHED_WORD_ATTRIBUTE);

      // style.removeProperty() 는 빈 style="" 속성을 남긴다.
      // 원래 다른 인라인 스타일이 없었던 엘리먼트라면 속성 자체를 지워 흔적을 남기지 않는다.
      if (filteredBlockElement.style.length === 0) filteredBlockElement.removeAttribute('style');
    });

    return filteredBlockElementList.length;
  }

  // ───────────────────────── 단어 모드 ─────────────────────────

  // ─────────────────── 패턴 컴파일 (텍스트 / 정규식 공통) ───────────────────

  /**
   * 저장된 패턴 목록을 "매칭에 바로 쓸 수 있는 형태"로 컴파일한다.
   *
   * 왜 미리 컴파일하는가: 정규식을 텍스트 노드마다 new RegExp 로 만들면 페이지 하나에
   * 수천 번 컴파일이 일어나 성능이 무너진다. 설정이 바뀔 때 한 번만 컴파일해 재사용한다.
   *
   * 정규식 플래그:
   *  - 'g' 를 항상 붙인다. 단어 모드에서 한 텍스트 안의 모든 매칭을 찾아야 하기 때문이다.
   *  - 대소문자 구분 설정이 꺼져 있으면 'i' 를 붙인다. 텍스트 타입에서 소문자로 비교하는 것과
   *    같은 옵션이 정규식에도 일관되게 적용된다.
   *
   * @param {Array<{pattern: string, matchType: string}>} filteredPatternList
   * @param {boolean} shouldMatchCaseSensitively
   * @returns {Array<{pattern: string, matchType: string, searchText: string, regex: RegExp | null}>}
   */
  function compileFilterPatternList(filteredPatternList, shouldMatchCaseSensitively) {
    if (!Array.isArray(filteredPatternList)) return [];

    const regexFlags = shouldMatchCaseSensitively ? 'g' : 'gi';
    /** @type {Array<{pattern: string, matchType: string, searchText: string, regex: RegExp | null}>} */
    const compiledPatternList = [];

    filteredPatternList.forEach(({ pattern, matchType }) => {
      if (typeof pattern !== 'string' || pattern.length === 0) return;

      if (matchType === MATCH_TYPE.REGEX) {
        try {
          compiledPatternList.push({
            pattern,
            matchType,
            searchText: '',
            regex: new RegExp(pattern, regexFlags),
          });
        } catch {
          // 저장 단계에서 이미 검증하지만, 손상된 저장값에 대비해 조용히 건너뛴다
        }
        return;
      }

      compiledPatternList.push({
        pattern,
        matchType: MATCH_TYPE.TEXT,
        searchText: shouldMatchCaseSensitively ? pattern : pattern.toLowerCase(),
        regex: null,
      });
    });

    return compiledPatternList;
  }

  /**
   * 텍스트 타입 비교에 쓸 문자열을 준비한다.
   * 대소문자 구분이 꺼져 있으면 소문자로 낮춘 사본을 만든다(한 번만).
   * @param {string} sourceText
   * @param {boolean} shouldMatchCaseSensitively
   * @returns {string}
   */
  function buildComparableText(sourceText, shouldMatchCaseSensitively) {
    return shouldMatchCaseSensitively ? sourceText : sourceText.toLowerCase();
  }

  /**
   * 블록 모드용: 텍스트에 걸리는 첫 패턴을 찾는다. 있으면 그 패턴, 없으면 null.
   *
   * 정규식은 'g' 플래그가 붙어 있어 test() 가 lastIndex 를 전진시킨다. 같은 정규식 객체를
   * 여러 텍스트 노드에 재사용하므로 **호출 전에 반드시 lastIndex 를 0 으로 되돌려야**
   * 두 번째 호출부터 매칭을 놓치는 버그가 생기지 않는다.
   *
   * @param {string} sourceText
   * @param {Array<{pattern: string, matchType: string, searchText: string, regex: RegExp | null}>} compiledPatternList
   * @param {boolean} shouldMatchCaseSensitively
   * @returns {string | null} 매칭된 패턴 문자열
   */
  function findFirstMatchingPattern(sourceText, compiledPatternList, shouldMatchCaseSensitively) {
    if (!sourceText || compiledPatternList.length === 0) return null;

    const comparableText = buildComparableText(sourceText, shouldMatchCaseSensitively);

    for (let patternIndex = 0; patternIndex < compiledPatternList.length; patternIndex += 1) {
      const compiledPattern = compiledPatternList[patternIndex];

      if (compiledPattern.regex) {
        compiledPattern.regex.lastIndex = 0;
        if (compiledPattern.regex.test(sourceText)) return compiledPattern.pattern;
        continue;
      }
      if (comparableText.includes(compiledPattern.searchText)) return compiledPattern.pattern;
    }
    return null;
  }

  /**
   * 단어 모드용: 텍스트에서 매칭되는 모든 구간을 찾아 정렬·병합한 목록을 만든다.
   *
   * 병합이 필요한 이유: "결말"과 "결말정리"를 둘 다 등록했다면 두 구간이 겹친다.
   * 겹친 채로 각각 span 을 만들면 인덱스가 어긋나므로 하나의 구간으로 합친다.
   * 텍스트 패턴과 정규식 패턴이 겹치는 경우도 같은 방식으로 처리된다.
   *
   * 정규식은 matchAll 로 순회한다. exec 수동 루프는 길이 0 매칭(예: `\b`, `a*`)에서
   * lastIndex 가 전진하지 않아 무한 루프에 빠지는데, matchAll 은 그 경우 자동으로
   * 한 칸 전진시켜 준다. 다만 길이 0 매칭으로 빈 span 을 만들 이유는 없으므로 걸러 낸다.
   *
   * @param {string} sourceText
   * @param {Array<{pattern: string, matchType: string, searchText: string, regex: RegExp | null}>} compiledPatternList
   * @param {boolean} shouldMatchCaseSensitively
   * @returns {Array<{startIndex: number, endIndex: number, matchedWord: string}>}
   */
  function collectMatchRangeListInText(
    sourceText,
    compiledPatternList,
    shouldMatchCaseSensitively,
  ) {
    if (!sourceText || compiledPatternList.length === 0) return [];

    const comparableText = buildComparableText(sourceText, shouldMatchCaseSensitively);

    /** @type {Array<{startIndex: number, endIndex: number, matchedWord: string}>} */
    const rawMatchRangeList = [];

    compiledPatternList.forEach((compiledPattern) => {
      // ── 정규식 패턴 ──
      if (compiledPattern.regex) {
        compiledPattern.regex.lastIndex = 0;
        for (const regexMatch of sourceText.matchAll(compiledPattern.regex)) {
          const matchedText = regexMatch[0];
          if (matchedText.length === 0) continue; // 길이 0 매칭은 칠할 대상이 없다
          rawMatchRangeList.push({
            startIndex: regexMatch.index,
            endIndex: regexMatch.index + matchedText.length,
            matchedWord: compiledPattern.pattern,
          });
        }
        return;
      }

      // ── 텍스트 패턴 ──
      let searchStartIndex = 0;
      for (;;) {
        const foundIndex = comparableText.indexOf(compiledPattern.searchText, searchStartIndex);
        if (foundIndex === -1) break;
        rawMatchRangeList.push({
          startIndex: foundIndex,
          endIndex: foundIndex + compiledPattern.searchText.length,
          matchedWord: compiledPattern.pattern,
        });
        searchStartIndex = foundIndex + 1; // 겹치는 매칭도 놓치지 않도록 1칸만 전진
      }
    });

    if (rawMatchRangeList.length === 0) return [];

    rawMatchRangeList.sort((leftRange, rightRange) => leftRange.startIndex - rightRange.startIndex);

    const mergedMatchRangeList = [rawMatchRangeList[0]];
    for (let rangeIndex = 1; rangeIndex < rawMatchRangeList.length; rangeIndex += 1) {
      const currentRange = rawMatchRangeList[rangeIndex];
      const lastMergedRange = mergedMatchRangeList[mergedMatchRangeList.length - 1];

      if (currentRange.startIndex <= lastMergedRange.endIndex) {
        // 겹치거나 맞닿음 → 끝 인덱스를 확장해서 하나로 합친다
        lastMergedRange.endIndex = Math.max(lastMergedRange.endIndex, currentRange.endIndex);
      } else {
        mergedMatchRangeList.push(currentRange);
      }
    }
    return mergedMatchRangeList;
  }

  /**
   * 단어를 감쌀 span 을 만든다. 우리가 만든 엘리먼트이므로 모든 스타일을
   * 인라인 !important 로 넣어 페이지 CSS 에 절대 밀리지 않게 한다.
   *
   * @param {string} matchedText 실제 화면에 있던 원본 문자열(대소문자 그대로)
   * @param {string} matchedWord 걸린 등록 단어
   * @param {{red: number, green: number, blue: number, opacity: number}} filterColor
   * @returns {HTMLSpanElement}
   */
  function createFilteredWordSpan(matchedText, matchedWord, filterColor) {
    const filteredWordSpan = document.createElement('span');
    filteredWordSpan.setAttribute(WORD_MARKER_ATTRIBUTE, 'true');
    filteredWordSpan.setAttribute(MATCHED_WORD_ATTRIBUTE, matchedWord);
    filteredWordSpan.textContent = matchedText;

    const cssRgbColor = formatFilterColorToCssRgb(filterColor);
    const inlineStyleEntryList = [
      ['background-color', cssRgbColor],
      ['background-image', 'none'],
      ['color', cssRgbColor],
      // 그라데이션 텍스트를 쓰는 사이트에서 글자가 드러나는 것을 막는다
      ['-webkit-text-fill-color', cssRgbColor],
      ['text-decoration-color', cssRgbColor],
      // 그림자로 글자 윤곽이 비치는 것을 막는다
      ['text-shadow', 'none'],
      ['opacity', String(filterColor.opacity)],
      // 페이지의 `span { display: block }` 같은 규칙으로 줄이 깨지지 않게 고정
      ['display', 'inline'],
      // 단어가 줄바꿈으로 쪼개져도 양쪽 줄 모두 칠해지게 한다
      ['box-decoration-break', 'clone'],
      ['-webkit-box-decoration-break', 'clone'],
    ];
    inlineStyleEntryList.forEach(([propertyName, propertyValue]) => {
      filteredWordSpan.style.setProperty(propertyName, propertyValue, 'important');
    });

    return filteredWordSpan;
  }

  /**
   * 텍스트 노드를 "일반 텍스트 + 단어 span" 조각들로 쪼갠 DocumentFragment 를 만든다.
   * 매칭이 없으면 null 을 반환한다(=DOM 을 건드리지 않는다).
   *
   * @param {Text} textNode
   * @param {Array<{pattern: string, matchType: string, searchText: string, regex: RegExp | null}>} compiledPatternList
   * @param {boolean} shouldMatchCaseSensitively
   * @param {{red: number, green: number, blue: number, opacity: number}} filterColor
   * @returns {{fragment: DocumentFragment, filteredWordCount: number} | null}
   */
  function buildFilteredFragmentFromTextNode(
    textNode,
    compiledPatternList,
    shouldMatchCaseSensitively,
    filterColor,
  ) {
    const originalText = textNode.nodeValue ?? '';
    const matchRangeList = collectMatchRangeListInText(
      originalText,
      compiledPatternList,
      shouldMatchCaseSensitively,
    );
    if (matchRangeList.length === 0) return null;

    const fragment = document.createDocumentFragment();
    let sliceCursorIndex = 0;

    matchRangeList.forEach(({ startIndex, endIndex, matchedWord }) => {
      // 매칭 구간 앞의 평범한 텍스트
      if (startIndex > sliceCursorIndex) {
        fragment.appendChild(
          document.createTextNode(originalText.slice(sliceCursorIndex, startIndex)),
        );
      }
      // 매칭 구간 → 단어 span
      fragment.appendChild(
        createFilteredWordSpan(originalText.slice(startIndex, endIndex), matchedWord, filterColor),
      );
      sliceCursorIndex = endIndex;
    });

    // 마지막 매칭 뒤에 남은 텍스트
    if (sliceCursorIndex < originalText.length) {
      fragment.appendChild(document.createTextNode(originalText.slice(sliceCursorIndex)));
    }

    return { fragment, filteredWordCount: matchRangeList.length };
  }

  /**
   * 지정한 루트 안에서 우리가 만든 단어 span 을 모두 원래 텍스트 노드로 되돌린다.
   *
   * span 을 텍스트 노드로 교체한 뒤 부모에 normalize() 를 호출해 쪼개진 인접 텍스트 노드를
   * 다시 하나로 합친다. 이 과정을 빼먹으면 재적용을 반복할 때마다 텍스트 노드가 계속
   * 잘게 쪼개져 성능이 떨어진다.
   *
   * @param {ParentNode} rootNode
   * @returns {number} 되돌린 span 개수
   */
  function unwrapAllFilteredWordsWithin(rootNode) {
    const filteredWordSpanList = rootNode.querySelectorAll(`[${WORD_MARKER_ATTRIBUTE}]`);
    if (filteredWordSpanList.length === 0) return 0;

    /** normalize() 를 한 번씩만 호출하기 위한 부모 수집 */
    const parentNodeSet = new Set();

    filteredWordSpanList.forEach((filteredWordSpan) => {
      const parentNode = filteredWordSpan.parentNode;
      if (!parentNode) return;
      parentNode.replaceChild(
        document.createTextNode(filteredWordSpan.textContent ?? ''),
        filteredWordSpan,
      );
      parentNodeSet.add(parentNode);
    });

    parentNodeSet.forEach((parentNode) => {
      if (typeof parentNode.normalize === 'function') parentNode.normalize();
    });

    return filteredWordSpanList.length;
  }

  /**
   * 두 모드의 흔적을 모두 되돌린다. 모드를 바꿀 때는 이전 모드의 흔적까지 지워야 하므로
   * 항상 둘 다 처리한다.
   * @param {ParentNode} rootNode
   */
  function restoreAllFiltersWithin(rootNode) {
    restoreAllBlockFiltersWithin(rootNode);
    unwrapAllFilteredWordsWithin(rootNode);
  }

  globalThis.wordFilterApplyHelper = {
    BLOCK_MARKER_ATTRIBUTE,
    WORD_MARKER_ATTRIBUTE,
    applyBlockFilterToElement,
    compileFilterPatternList,
    findFirstMatchingPattern,
    buildFilteredFragmentFromTextNode,
    restoreAllFiltersWithin,
  };
})();
