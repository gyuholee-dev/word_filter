/**
 * filter_settings_storage.js
 * ---------------------------------------------------------------------------
 * 확장 프로그램 전체(content script / options / popup)가 공유하는 설정 저장소.
 *
 * 왜 ES module이 아니라 "전역 네임스페이스 + IIFE" 방식인가?
 *  - MV3의 content script는 기본적으로 ES module(import/export)을 지원하지 않는다.
 *  - manifest의 content_scripts.js 배열에 나열된 파일들은 "같은 isolated world"를
 *    공유하므로, 이 파일에서 globalThis에 붙인 객체를 다음 파일에서 바로 쓸 수 있다.
 *  - 확장 프로그램이 리로드되어 스크립트가 두 번 주입되는 상황을 대비해
 *    이미 정의되어 있으면 조용히 반환한다(const 재선언 에러 방지).
 */
(() => {
  if (globalThis.wordFilterSettingsStorage) return;

  /** chrome.storage.sync 에서 사용하는 단일 키 */
  const FILTER_SETTINGS_STORAGE_KEY = 'wordFilterSettings';

  /**
   * 필터링 모드.
   *  - BLOCK : 단어가 포함된 블록 엘리먼트(문단·카드·목록 항목) 전체를 처리
   *  - WORD  : 걸린 단어 부분만 처리
   *
   * 두 모드는 처리 "범위"만 다르고, 적용하는 색(필터링 컬러)은 공유한다.
   */
  const FILTERING_MODE = Object.freeze({
    BLOCK: 'block',
    WORD: 'word',
  });

  /**
   * 패턴 매칭 방식. 항목마다 따로 지정한다.
   *  - TEXT  : 부분 문자열 포함 검사
   *  - REGEX : 정규표현식 검사
   *
   * 전역 토글이 아니라 항목별로 타입을 두는 이유: 전역이면 "C++", "(주)" 처럼 정규식
   * 메타문자를 포함한 텍스트가 패턴으로 해석되어 오작동하거나 문법 오류가 된다.
   * 항목별 타입이면 텍스트와 정규식을 한 목록에 섞어 쓸 수 있다.
   */
  const MATCH_TYPE = Object.freeze({
    TEXT: 'text',
    REGEX: 'regex',
  });

  /** 백업 파일을 식별하는 이름. 복원할 때 형식 확인에 쓴다. */
  const SETTINGS_FILE_FORMAT_NAME = 'word-filter-settings';

  /** 파일 구조의 버전. 구조가 달라지면 이 값을 올려 복원 쪽에서 분기한다. */
  const FILE_FORMAT_VERSION = 1;

  /**
   * 저장할 수 있는 최대 패턴 수.
   *
   * chrome.storage.sync 는 항목 하나당 약 8KB 로 제한된다. 패턴 하나가 대략 40~60바이트를
   * 차지하므로 이 값을 넘기면 저장이 실패한다. 조용히 실패하는 대신 미리 막고 알려 준다.
   */
  const MAX_PATTERN_COUNT = 100;

  /**
   * 화면 테마.
   *  - SYSTEM : 크롬(운영체제) 설정을 따른다
   *  - LIGHT / DARK : 시스템 설정과 무관하게 고정한다
   */
  const THEME_PREFERENCE = Object.freeze({
    SYSTEM: 'system',
    LIGHT: 'light',
    DARK: 'dark',
  });

  /** 예외로 등록할 수 있는 사이트 최대 개수 (저장 용량 한도를 넘지 않도록) */
  const MAX_EXCLUDED_SITE_COUNT = 100;

  /**
   * 패턴 최대 길이.
   * 정규식은 백트래킹 폭발(ReDoS)로 페이지를 멈추게 할 수 있어 입력 자체를 제한한다.
   * 완벽한 방어는 아니지만 실수로 만든 거대 패턴을 걸러 준다.
   */
  const MAX_PATTERN_LENGTH = 200;

  /**
   * 정규식 문법이 올바른지 검사한다. 저장 전에 호출해 잘못된 패턴이 들어가는 것을 막는다.
   * @param {string} rawPattern
   * @returns {{isValid: boolean, errorMessage: string}}
   */
  function validateRegexPattern(rawPattern) {
    const pattern = String(rawPattern ?? '').trim();

    if (pattern.length === 0) {
      return { isValid: false, errorMessage: '정규식을 입력하세요.' };
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return {
        isValid: false,
        errorMessage: `정규식이 너무 깁니다. ${MAX_PATTERN_LENGTH}자 이내로 입력하세요.`,
      };
    }
    try {
      new RegExp(pattern);
      return { isValid: true, errorMessage: '' };
    } catch (regexSyntaxError) {
      return { isValid: false, errorMessage: regexSyntaxError.message };
    }
  }

  /**
   * 필터링 컬러 기본값.
   *  - RGB 0,0,0 (검정)
   *  - opacity 1        : 색이 꽉 찬 블록으로 덮인 상태
   *                       (opacity 를 0 으로 내리면 대상이 완전히 투명해져 아무것도 보이지 않는다)
   */
  const DEFAULT_FILTER_COLOR = Object.freeze({ red: 0, green: 0, blue: 0, opacity: 1 });

  /** 설정 값이 하나도 없을 때 사용할 기본값 */
  const DEFAULT_FILTER_SETTINGS = Object.freeze({
    /** 필터링 기능 전체 on/off */
    isFilteringEnabled: true,
    /**
     * 필터링할 패턴 목록.
     * 각 항목은 { pattern: string, matchType: 'text' | 'regex' } 형태다.
     */
    filteredPatternList: [],
    /** 필터링 모드 (FILTERING_MODE 중 하나) */
    filteringMode: FILTERING_MODE.BLOCK,
    /** 필터링 컬러 { red, green, blue, opacity } */
    filterColor: DEFAULT_FILTER_COLOR,
    /** true면 대소문자를 구분해서 매칭 */
    shouldMatchCaseSensitively: false,
    /** 필터링을 하지 않을 사이트 호스트 목록 (예: ['example.com']) */
    excludedSiteList: [],
    /** 설정 화면·팝업·편집 페이지의 테마 (THEME_PREFERENCE 중 하나) */
    themePreference: THEME_PREFERENCE.SYSTEM,
  });

  // ───────────────────────── 컬러 유틸 ─────────────────────────

  /**
   * 값을 정수 0~255 범위로 자른다. 숫자가 아니면 대체값을 쓴다.
   * @param {unknown} rawChannelValue
   * @param {number} fallbackChannelValue
   * @returns {number}
   */
  function clampColorChannel(rawChannelValue, fallbackChannelValue) {
    const parsedChannelValue = Number(rawChannelValue);
    if (!Number.isFinite(parsedChannelValue)) return fallbackChannelValue;
    return Math.min(255, Math.max(0, Math.round(parsedChannelValue)));
  }

  /**
   * 값을 0~1 범위로 자른다. 숫자가 아니면 대체값을 쓴다.
   * @param {unknown} rawOpacityValue
   * @param {number} fallbackOpacityValue
   * @returns {number}
   */
  function clampOpacity(rawOpacityValue, fallbackOpacityValue) {
    const parsedOpacityValue = Number(rawOpacityValue);
    if (!Number.isFinite(parsedOpacityValue)) return fallbackOpacityValue;
    return Math.min(1, Math.max(0, parsedOpacityValue));
  }

  /**
   * 손상된 값이 들어와도 항상 안전한 컬러 객체를 만들어 준다.
   * @param {unknown} rawFilterColor
   * @returns {{red: number, green: number, blue: number, opacity: number}}
   */
  function normalizeFilterColor(rawFilterColor) {
    const sourceColor =
      rawFilterColor && typeof rawFilterColor === 'object' ? rawFilterColor : {};
    return {
      red: clampColorChannel(sourceColor.red, DEFAULT_FILTER_COLOR.red),
      green: clampColorChannel(sourceColor.green, DEFAULT_FILTER_COLOR.green),
      blue: clampColorChannel(sourceColor.blue, DEFAULT_FILTER_COLOR.blue),
      opacity: clampOpacity(sourceColor.opacity, DEFAULT_FILTER_COLOR.opacity),
    };
  }

  /**
   * CSS 에 넣을 'rgb(r, g, b)' 문자열. opacity 는 CSS opacity 속성으로 따로 적용하므로
   * 여기서는 알파를 넣지 않는다.
   * @param {{red: number, green: number, blue: number}} filterColor
   * @returns {string}
   */
  function formatFilterColorToCssRgb(filterColor) {
    return `rgb(${filterColor.red}, ${filterColor.green}, ${filterColor.blue})`;
  }

  /**
   * 설정 화면 스와치처럼 "한눈에 보여 주는" 용도의 'rgba(r, g, b, a)' 문자열.
   * @param {{red: number, green: number, blue: number, opacity: number}} filterColor
   * @returns {string}
   */
  function formatFilterColorToCssRgba(filterColor) {
    return `rgba(${filterColor.red}, ${filterColor.green}, ${filterColor.blue}, ${filterColor.opacity})`;
  }

  /**
   * <input type="color"> 에 넣을 '#rrggbb' 문자열.
   * @param {{red: number, green: number, blue: number}} filterColor
   * @returns {string}
   */
  function formatFilterColorToHex(filterColor) {
    const toTwoDigitHex = (channelValue) => channelValue.toString(16).padStart(2, '0');
    return `#${toTwoDigitHex(filterColor.red)}${toTwoDigitHex(filterColor.green)}${toTwoDigitHex(
      filterColor.blue,
    )}`;
  }

  /**
   * '#rrggbb' / '#rgb' / 'rrggbb' 를 RGB 채널로 변환한다. 형식이 틀리면 null.
   * @param {unknown} rawHexColor
   * @returns {{red: number, green: number, blue: number} | null}
   */
  function parseHexColorToRgbChannels(rawHexColor) {
    if (typeof rawHexColor !== 'string') return null;

    let hexDigits = rawHexColor.trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(hexDigits)) {
      // 3자리 축약형은 각 자리를 두 번 반복해 6자리로 확장한다 ('0f8' → '00ff88')
      hexDigits = hexDigits
        .split('')
        .map((hexDigit) => hexDigit + hexDigit)
        .join('');
    }
    if (!/^[0-9a-f]{6}$/.test(hexDigits)) return null;

    return {
      red: parseInt(hexDigits.slice(0, 2), 16),
      green: parseInt(hexDigits.slice(2, 4), 16),
      blue: parseInt(hexDigits.slice(4, 6), 16),
    };
  }

  // ───────────────────────── 사이트 예외 ─────────────────────────

  /**
   * 사용자가 입력한 값에서 호스트 이름만 뽑아낸다.
   *
   * 주소 전체를 붙여 넣어도 되고 도메인만 적어도 되게 한다.
   *   'https://gall.dcinside.com/board/lists/?id=x' → 'gall.dcinside.com'
   *   'dcinside.com'                                → 'dcinside.com'
   *   'www.example.com'                             → 'example.com'
   *
   * 앞의 www. 를 떼는 이유: 사용자가 주소창에서 복사하면 www 가 붙는 경우가 많은데,
   * 그대로 저장하면 www 없는 주소가 예외에서 빠져 같은 사이트가 갈라진다.
   *
   * @param {string} rawInput
   * @returns {string | null} 호스트 이름. 주소로 해석할 수 없으면 null
   */
  function extractHostNameFromInput(rawInput) {
    const trimmedInput = String(rawInput ?? '').trim();
    if (trimmedInput.length === 0) return null;

    // 스킴이 없으면 붙여서 URL 로 해석한다. URL 파서에 맡겨야 포트·경로·인증정보를 정확히 걷어낸다.
    const inputWithScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedInput)
      ? trimmedInput
      : `https://${trimmedInput}`;

    let hostName;
    try {
      hostName = new URL(inputWithScheme).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (hostName.length === 0) return null;

    // 호스트로 볼 수 없는 값(공백, 잘못된 문자 등)을 걸러 낸다
    if (!/^[a-z0-9.-]+$/.test(hostName)) return null;

    return hostName.replace(/^www\./, '');
  }

  /**
   * 예외 목록을 항상 안전한 형태로 만든다. 해석할 수 없는 값은 버리고 중복은 합친다.
   * @param {unknown} rawSiteList
   * @returns {string[]}
   */
  function normalizeExcludedSiteList(rawSiteList) {
    if (!Array.isArray(rawSiteList)) return [];

    const seenHostNameSet = new Set();
    const normalizedSiteList = [];
    rawSiteList.forEach((rawSite) => {
      const hostName = extractHostNameFromInput(rawSite);
      if (!hostName || seenHostNameSet.has(hostName)) return;
      if (normalizedSiteList.length >= MAX_EXCLUDED_SITE_COUNT) return;
      seenHostNameSet.add(hostName);
      normalizedSiteList.push(hostName);
    });
    return normalizedSiteList;
  }

  /**
   * 현재 호스트가 예외 목록에 걸리는지 판단한다.
   *
   * 등록한 도메인과 그 하위 도메인을 모두 예외로 본다. 'dcinside.com' 하나만 등록해도
   * 'gall.dcinside.com' 이 함께 제외되도록 하기 위한 것이다.
   *
   * 단순히 endsWith 로 비교하면 'evil-dcinside.com' 처럼 뒤만 같은 다른 사이트가 걸리므로
   * 반드시 점 경계에서 끊어 비교한다.
   *
   * @param {string} currentHostName
   * @param {string[]} excludedSiteList
   * @returns {string | null} 걸린 등록 항목. 없으면 null
   */
  function findMatchingExcludedSite(currentHostName, excludedSiteList) {
    if (!currentHostName || !Array.isArray(excludedSiteList)) return null;

    const comparableHostName = currentHostName.toLowerCase().replace(/^www\./, '');
    return (
      excludedSiteList.find(
        (excludedSite) =>
          comparableHostName === excludedSite ||
          comparableHostName.endsWith(`.${excludedSite}`),
      ) ?? null
    );
  }

  // ───────────────────────── 패턴 목록 정규화 ─────────────────────────

  /**
   * 중복 판정에 쓰는 키를 만든다. 정규화·추가·가져오기가 모두 이 함수를 쓰므로
   * 세 경로의 중복 기준이 어긋날 수 없다.
   *
   * 타입마다 기준이 다르다.
   *  - 텍스트: 대소문자를 무시한다.
   *  - 정규식: 대소문자를 구분한다. [A-Z] 와 [a-z] 는 의미가 다른 패턴이므로 합쳐선 안 된다.
   *
   * @param {{pattern: string, matchType: string}} filteredPattern
   * @returns {string}
   */
  function buildPatternDedupeKey({ pattern, matchType }) {
    return matchType === MATCH_TYPE.REGEX
      ? `${MATCH_TYPE.REGEX}:${pattern}`
      : `${MATCH_TYPE.TEXT}:${pattern.toLowerCase()}`;
  }


  /**
   * 패턴 목록을 항상 안전한 형태로 만들어 준다.
   *
   * 항목이 문자열이면 텍스트 타입으로 해석한다. 백업 파일에 패턴을 목록으로만 적어 두는
   * 경우를 지원하기 위한 것이다.
   *   ['결말', '스포일러'] → [{pattern:'결말',matchType:'text'}, {pattern:'스포일러',matchType:'text'}]
   *
   * 중복 판정은 buildPatternDedupeKey 에 맡긴다.
   *
   * @param {unknown} rawPatternList
   * @returns {Array<{pattern: string, matchType: string}>}
   */
  function normalizeFilteredPatternList(rawPatternList) {
    if (!Array.isArray(rawPatternList)) return [];

    const seenDedupeKeySet = new Set();
    /** @type {Array<{pattern: string, matchType: string}>} */
    const normalizedPatternList = [];

    rawPatternList.forEach((rawPatternEntry) => {
      const isPlainStringEntry = typeof rawPatternEntry === 'string';
      const pattern = isPlainStringEntry
        ? rawPatternEntry.trim()
        : String(rawPatternEntry?.pattern ?? '').trim();

      if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return;

      const matchType =
        !isPlainStringEntry && rawPatternEntry?.matchType === MATCH_TYPE.REGEX
          ? MATCH_TYPE.REGEX
          : MATCH_TYPE.TEXT;

      // 문법이 깨진 정규식은 저장 단계에서 걸러 낸다 (매칭 때마다 try/catch 하지 않도록)
      if (matchType === MATCH_TYPE.REGEX && !validateRegexPattern(pattern).isValid) return;

      const dedupeKey = buildPatternDedupeKey({ pattern, matchType });
      if (seenDedupeKeySet.has(dedupeKey)) return;
      seenDedupeKeySet.add(dedupeKey);

      normalizedPatternList.push({ pattern, matchType });
    });

    return normalizedPatternList;
  }

  // ───────────────────────── 설정 정규화 ─────────────────────────

  /**
   * 저장된 값이 손상되었거나 일부만 들어 있어도 항상 안전한 설정 객체를 만들어 준다.
   * 알 수 없는 값이나 빠진 항목은 기본값으로 채운다.
   *
   * @param {unknown} rawStoredSettings
   * @returns {typeof DEFAULT_FILTER_SETTINGS}
   */
  function normalizeFilterSettings(rawStoredSettings) {
    const storedSettings =
      rawStoredSettings && typeof rawStoredSettings === 'object' ? rawStoredSettings : {};

    const resolvedPatternList = normalizeFilteredPatternList(storedSettings.filteredPatternList);

    const isKnownFilteringMode = Object.values(FILTERING_MODE).includes(
      storedSettings.filteringMode,
    );
    const resolvedFilteringMode = isKnownFilteringMode
      ? storedSettings.filteringMode
      : DEFAULT_FILTER_SETTINGS.filteringMode;

    const resolvedFilterColor = normalizeFilterColor(storedSettings.filterColor);

    return {
      isFilteringEnabled:
        typeof storedSettings.isFilteringEnabled === 'boolean'
          ? storedSettings.isFilteringEnabled
          : DEFAULT_FILTER_SETTINGS.isFilteringEnabled,
      filteredPatternList: resolvedPatternList,
      filteringMode: resolvedFilteringMode,
      filterColor: resolvedFilterColor,
      shouldMatchCaseSensitively:
        typeof storedSettings.shouldMatchCaseSensitively === 'boolean'
          ? storedSettings.shouldMatchCaseSensitively
          : DEFAULT_FILTER_SETTINGS.shouldMatchCaseSensitively,
      excludedSiteList: normalizeExcludedSiteList(storedSettings.excludedSiteList),
      themePreference: Object.values(THEME_PREFERENCE).includes(storedSettings.themePreference)
        ? storedSettings.themePreference
        : DEFAULT_FILTER_SETTINGS.themePreference,
    };
  }

  // ───────────────────────── 읽기 / 쓰기 ─────────────────────────

  /**
   * 현재 설정을 읽어온다. 저장된 값이 없으면 기본값을 반환한다.
   * @returns {Promise<typeof DEFAULT_FILTER_SETTINGS>}
   */
  async function loadFilterSettings() {
    const storageResult = await chrome.storage.sync.get(FILTER_SETTINGS_STORAGE_KEY);
    return normalizeFilterSettings(storageResult[FILTER_SETTINGS_STORAGE_KEY]);
  }

  /**
   * 설정 일부만 병합 저장한다. 저장이 끝나면 storage.onChanged 가 발생하고,
   * 열려 있는 모든 탭의 content script 가 이를 감지해 즉시 재적용한다.
   *
   * filterColor 는 객체이므로 얕은 병합이 아니라 "채널 단위 병합"이 필요하다.
   * (예: opacity 만 바꿀 때 RGB 가 기본값으로 되돌아가면 안 된다)
   *
   * @param {Partial<typeof DEFAULT_FILTER_SETTINGS>} partialSettings
   * @returns {Promise<typeof DEFAULT_FILTER_SETTINGS>} 병합 후의 전체 설정
   */
  async function updateFilterSettings(partialSettings) {
    const currentSettings = await loadFilterSettings();
    const mergedSettings = normalizeFilterSettings({
      ...currentSettings,
      ...partialSettings,
      filterColor: {
        ...currentSettings.filterColor,
        ...(partialSettings.filterColor ?? {}),
      },
    });
    try {
      await chrome.storage.sync.set({ [FILTER_SETTINGS_STORAGE_KEY]: mergedSettings });
    } catch (storageWriteError) {
      // chrome.storage.sync 의 항목당 용량(약 8KB)을 넘기면 여기로 온다.
      // 원인을 알 수 없는 저장 실패로 보이지 않도록 메시지를 붙여 다시 던진다.
      throw new Error(`설정을 저장하지 못했습니다: ${storageWriteError.message}`);
    }
    return mergedSettings;
  }

  /**
   * 패턴을 목록에 추가한다.
   * @param {string} patternToAdd
   * @param {'text' | 'regex'} matchType
   * @returns {Promise<{didAdd: boolean, settings: typeof DEFAULT_FILTER_SETTINGS, reason?: string, errorMessage?: string}>}
   */
  async function addFilteredPattern(patternToAdd, matchType = MATCH_TYPE.TEXT) {
    const trimmedPattern = String(patternToAdd ?? '').trim();
    const resolvedMatchType = matchType === MATCH_TYPE.REGEX ? MATCH_TYPE.REGEX : MATCH_TYPE.TEXT;
    const currentSettings = await loadFilterSettings();

    if (trimmedPattern.length === 0) {
      return { didAdd: false, settings: currentSettings, reason: 'empty' };
    }
    if (trimmedPattern.length > MAX_PATTERN_LENGTH) {
      return { didAdd: false, settings: currentSettings, reason: 'tooLong' };
    }

    // 정규식은 저장 전에 문법을 검사해 잘못된 패턴이 들어가는 것을 막는다
    if (resolvedMatchType === MATCH_TYPE.REGEX) {
      const validationResult = validateRegexPattern(trimmedPattern);
      if (!validationResult.isValid) {
        return {
          didAdd: false,
          settings: currentSettings,
          reason: 'invalidRegex',
          errorMessage: validationResult.errorMessage,
        };
      }
    }

    const newPatternDedupeKey = buildPatternDedupeKey({
      pattern: trimmedPattern,
      matchType: resolvedMatchType,
    });
    const isAlreadyRegistered = currentSettings.filteredPatternList.some(
      (registeredPattern) => buildPatternDedupeKey(registeredPattern) === newPatternDedupeKey,
    );
    if (isAlreadyRegistered) {
      return { didAdd: false, settings: currentSettings, reason: 'duplicated' };
    }
    if (currentSettings.filteredPatternList.length >= MAX_PATTERN_COUNT) {
      return { didAdd: false, settings: currentSettings, reason: 'limitReached' };
    }

    const settings = await updateFilterSettings({
      filteredPatternList: [
        ...currentSettings.filteredPatternList,
        { pattern: trimmedPattern, matchType: resolvedMatchType },
      ],
    });
    return { didAdd: true, settings };
  }

  /**
   * 패턴을 목록에서 제거한다. 같은 문자열이 텍스트/정규식으로 둘 다 등록될 수 있으므로
   * 타입까지 함께 비교해야 한다.
   * @param {string} patternToRemove
   * @param {'text' | 'regex'} matchType
   * @returns {Promise<typeof DEFAULT_FILTER_SETTINGS>}
   */
  async function removeFilteredPattern(patternToRemove, matchType) {
    const currentSettings = await loadFilterSettings();
    return updateFilterSettings({
      filteredPatternList: currentSettings.filteredPatternList.filter(
        (registeredPattern) =>
          !(
            registeredPattern.pattern === patternToRemove &&
            registeredPattern.matchType === matchType
          ),
      ),
    });
  }

  /**
   * 사이트를 예외 목록에 추가한다.
   * @param {string} rawInput 주소 또는 도메인
   * @returns {Promise<{didAdd: boolean, hostName: string | null, reason?: string}>}
   */
  async function addExcludedSite(rawInput) {
    const hostName = extractHostNameFromInput(rawInput);
    const currentSettings = await loadFilterSettings();

    if (!hostName) return { didAdd: false, hostName: null, reason: 'invalid' };
    if (currentSettings.excludedSiteList.includes(hostName)) {
      return { didAdd: false, hostName, reason: 'duplicated' };
    }
    if (currentSettings.excludedSiteList.length >= MAX_EXCLUDED_SITE_COUNT) {
      return { didAdd: false, hostName, reason: 'limitReached' };
    }

    await updateFilterSettings({
      excludedSiteList: [...currentSettings.excludedSiteList, hostName],
    });
    return { didAdd: true, hostName };
  }

  /**
   * 사이트를 예외 목록에서 제거한다.
   * @param {string} hostNameToRemove
   * @returns {Promise<typeof DEFAULT_FILTER_SETTINGS>}
   */
  async function removeExcludedSite(hostNameToRemove) {
    const currentSettings = await loadFilterSettings();
    return updateFilterSettings({
      excludedSiteList: currentSettings.excludedSiteList.filter(
        (excludedSite) => excludedSite !== hostNameToRemove,
      ),
    });
  }

  // ───────────────────── 백업 / 복원 ─────────────────────

  /**
   * 백업 파일에 붙일 이름을 만든다. (예: word-filter-settings-2026-07-30.json)
   * @returns {string}
   */
  function buildExportFileName() {
    const [datePart] = new Date().toISOString().split('T');
    return `${SETTINGS_FILE_FORMAT_NAME}-${datePart}.json`;
  }

  /**
   * 설정 전체를 백업 파일용 JSON 문자열로 만든다.
   * 패턴뿐 아니라 모드·컬러·대소문자 옵션까지 담아 그대로 복원할 수 있게 한다.
   *
   * @param {typeof DEFAULT_FILTER_SETTINGS} settings
   * @returns {string}
   */
  function serializeFilterSettingsToJson(settings) {
    const backupDocument = {
      format: SETTINGS_FILE_FORMAT_NAME,
      formatVersion: FILE_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
    };
    return `${JSON.stringify(backupDocument, null, 2)}\n`;
  }

  /**
   * 백업 파일 내용을 파싱해 설정 객체로 만든다.
   *
   * settings 키가 없으면 파일 자체를 설정 객체로 간주한다. 손으로 만든 파일이나
   * 설정만 따로 떼어 둔 파일도 받아들이기 위한 것이다.
   * 값 검증은 normalizeFilterSettings 가 담당하므로 잘못된 필드는 기본값으로 채워진다.
   *
   * @param {string} rawFileText
   * @returns {{isValid: boolean, settings: typeof DEFAULT_FILTER_SETTINGS | null, errorMessage: string}}
   */
  function parseFilterSettingsFromJson(rawFileText) {
    let parsedDocument;
    try {
      parsedDocument = JSON.parse(rawFileText);
    } catch (jsonParseError) {
      return {
        isValid: false,
        settings: null,
        errorMessage: `JSON 형식이 아닙니다. ${jsonParseError.message}`,
      };
    }

    const rawSettings = parsedDocument?.settings ?? parsedDocument;
    if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
      return {
        isValid: false,
        settings: null,
        errorMessage: '설정 객체를 찾을 수 없습니다. 설정 백업 파일이 맞는지 확인하세요.',
      };
    }

    return { isValid: true, settings: normalizeFilterSettings(rawSettings), errorMessage: '' };
  }

  /**
   * 설정 전체를 덮어쓴다. 백업 파일 복원에 쓴다.
   * @param {typeof DEFAULT_FILTER_SETTINGS} settingsToRestore
   * @returns {Promise<typeof DEFAULT_FILTER_SETTINGS>}
   */
  async function restoreFilterSettings(settingsToRestore) {
    return updateFilterSettings(normalizeFilterSettings(settingsToRestore));
  }

  /**
   * 저장된 설정이 하나도 없을 때만 기본값을 써 넣는다.
   *
   * 이미 저장된 값이 있으면 절대 건드리지 않는다. 설치·업데이트 시점에 무조건 다시 쓰면,
   * 저장된 형태를 정규화가 알아보지 못하는 경우 기본값이 그대로 덮어써져 되돌릴 수 없다.
   *
   * @returns {Promise<boolean>} 기본값을 새로 써 넣었으면 true
   */
  async function seedDefaultFilterSettingsIfMissing() {
    const storageResult = await chrome.storage.sync.get(FILTER_SETTINGS_STORAGE_KEY);
    if (storageResult[FILTER_SETTINGS_STORAGE_KEY]) return false;

    await updateFilterSettings(DEFAULT_FILTER_SETTINGS);
    return true;
  }

  globalThis.wordFilterSettingsStorage = {
    FILTER_SETTINGS_STORAGE_KEY,
    FILTERING_MODE,
    MATCH_TYPE,
    MAX_PATTERN_LENGTH,
    MAX_PATTERN_COUNT,
    MAX_EXCLUDED_SITE_COUNT,
    THEME_PREFERENCE,
    DEFAULT_FILTER_COLOR,
    DEFAULT_FILTER_SETTINGS,
    validateRegexPattern,
    normalizeFilterColor,
    formatFilterColorToCssRgb,
    formatFilterColorToCssRgba,
    formatFilterColorToHex,
    parseHexColorToRgbChannels,
    normalizeFilterSettings,
    loadFilterSettings,
    updateFilterSettings,
    addFilteredPattern,
    removeFilteredPattern,
    extractHostNameFromInput,
    findMatchingExcludedSite,
    addExcludedSite,
    removeExcludedSite,
    serializeFilterSettingsToJson,
    parseFilterSettingsFromJson,
    restoreFilterSettings,
    seedDefaultFilterSettingsIfMissing,
    buildExportFileName,
  };
})();
