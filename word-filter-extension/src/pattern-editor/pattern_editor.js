/**
 * pattern_editor.js
 * ---------------------------------------------------------------------------
 * 등록된 필터링 패턴을 한눈에 보고 지우는 전용 화면.
 *
 * 설정 화면에서 목록을 뺀 이유: 패턴이 수십 개가 되면 목록이 화면을 다 차지해
 * 아래쪽 설정 항목까지 스크롤해야 한다. 목록은 이 페이지가 맡고, 설정 화면에는
 * 추가 폼만 남긴다.
 *
 * 추가 폼은 설정 화면과 같은 공용 모듈(pattern_form.js)을 쓴다. 두 화면에 복사하면
 * 정규식 검증 규칙이 갈라지기 때문이다.
 *
 * storage.onChanged 를 구독하므로 설정 화면에서 패턴을 추가하면 이 페이지도 바로 갱신된다.
 */
(() => {
  globalThis.wordFilterThemePreference.startFollowingThemePreference();

  const {
    loadFilterSettings,
    removeFilteredPattern,
    normalizeFilterSettings,
    FILTER_SETTINGS_STORAGE_KEY,
    MATCH_TYPE,
  } = globalThis.wordFilterSettingsStorage;

  const { initializePatternForm } = globalThis.wordFilterPatternForm;

  const STATUS_MESSAGE_CLEAR_DELAY_MS = 2600;

  const addPatternForm = document.getElementById('addPatternForm');
  const registeredPatternCountLabel = document.getElementById('registeredPatternCountLabel');
  const visiblePatternCountLabel = document.getElementById('visiblePatternCountLabel');
  const patternSearchInput = document.getElementById('patternSearchInput');
  const clearPatternSearchButton = document.getElementById('clearPatternSearchButton');
  const noSearchResultMessage = document.getElementById('noSearchResultMessage');
  const filteredPatternListElement = document.getElementById('filteredPatternList');
  const emptyPatternListMessage = document.getElementById('emptyPatternListMessage');
  const statusMessageElement = document.getElementById('statusMessage');
  const openOptionsButton = document.getElementById('openOptionsButton');

  let statusMessageTimerId = 0;

  /**
   * @param {string} messageText
   * @param {'info' | 'error' | 'done'} messageTone
   */
  function showStatusMessage(messageText, messageTone = 'info') {
    statusMessageElement.textContent = messageText;
    statusMessageElement.className = 'status';
    if (messageTone === 'error') statusMessageElement.classList.add('status--error');
    if (messageTone === 'done') statusMessageElement.classList.add('status--done');

    window.clearTimeout(statusMessageTimerId);
    statusMessageTimerId = window.setTimeout(() => {
      statusMessageElement.textContent = '';
      statusMessageElement.className = 'status';
    }, STATUS_MESSAGE_CLEAR_DELAY_MS);
  }

  /**
   * 패턴 한 줄을 만든다.
   *
   * innerHTML 을 쓰지 않고 textContent 로만 주입해 사용자 입력이 HTML 로 해석되지 않게 한다.
   * 정규식 항목에는 먹칠 커버를 만들지 않는다. 텍스트 패턴은 그 자체가 가려야 할 단어지만,
   * 정규식은 읽고 고쳐야 하는 값이라 가리면 오히려 불편하다.
   *
   * @param {{pattern: string, matchType: string}} filteredPattern
   * @returns {HTMLLIElement}
   */
  function createPatternListItemElement({ pattern, matchType }) {
    const isRegexPattern = matchType === MATCH_TYPE.REGEX;

    const patternItemElement = document.createElement('li');
    patternItemElement.className = `word-item ${isRegexPattern ? 'word-item--regex' : 'word-item--text'}`;

    const typeBadgeElement = document.createElement('span');
    typeBadgeElement.className = 'word-item__type';
    typeBadgeElement.textContent = isRegexPattern ? 'REGEX' : 'TEXT';

    const patternBarElement = document.createElement('div');
    patternBarElement.className = 'word-item__bar';

    const patternTextElement = document.createElement('span');
    patternTextElement.className = 'word-item__text';
    patternTextElement.textContent = pattern;
    patternBarElement.appendChild(patternTextElement);

    if (!isRegexPattern) {
      const redactionCoverElement = document.createElement('span');
      redactionCoverElement.className = 'word-item__cover';
      patternBarElement.appendChild(redactionCoverElement);
    }

    const deleteButtonElement = document.createElement('button');
    deleteButtonElement.type = 'button';
    deleteButtonElement.className = 'word-item__delete';
    deleteButtonElement.textContent = '삭제';
    deleteButtonElement.setAttribute('aria-label', `${pattern} 삭제`);
    // 같은 문자열이 텍스트/정규식으로 둘 다 등록될 수 있어 타입까지 실어 보낸다
    deleteButtonElement.dataset.targetPattern = pattern;
    deleteButtonElement.dataset.targetMatchType = matchType;

    patternItemElement.append(typeBadgeElement, patternBarElement, deleteButtonElement);
    return patternItemElement;
  }

  /**
   * 마지막으로 읽은 설정. 검색어만 바뀌었을 때 저장소를 다시 읽지 않기 위해 들고 있는다.
   * @type {Awaited<ReturnType<typeof loadFilterSettings>> | null}
   */
  let lastLoadedSettings = null;

  /**
   * 검색어에 걸리는 패턴만 남긴다.
   * 대소문자를 가리지 않고 부분 일치로 찾는다. 정규식으로 해석하지 않는 이유는,
   * 목록에 등록된 정규식 자체를 문자로 찾고 싶은 경우가 대부분이기 때문이다.
   *
   * @param {Array<{pattern: string, matchType: string}>} filteredPatternList
   * @param {string} searchKeyword
   */
  function selectPatternsMatchingSearch(filteredPatternList, searchKeyword) {
    const comparableKeyword = searchKeyword.trim().toLowerCase();
    if (comparableKeyword.length === 0) return filteredPatternList;
    return filteredPatternList.filter(({ pattern }) =>
      pattern.toLowerCase().includes(comparableKeyword),
    );
  }

  /** @param {Awaited<ReturnType<typeof loadFilterSettings>>} settings */
  function renderPatternList(settings) {
    lastLoadedSettings = settings;

    const searchKeyword = patternSearchInput.value;
    const isSearching = searchKeyword.trim().length > 0;
    const visiblePatternList = selectPatternsMatchingSearch(
      settings.filteredPatternList,
      searchKeyword,
    );

    filteredPatternListElement.replaceChildren(
      ...visiblePatternList.map(createPatternListItemElement),
    );

    const registeredCount = settings.filteredPatternList.length;
    registeredPatternCountLabel.textContent = `${registeredCount}개 등록`;
    // 검색 중일 때만 "몇 개 중 몇 개"를 보여 줘야 목록이 짧은 이유를 알 수 있다
    visiblePatternCountLabel.textContent = isSearching
      ? `${visiblePatternList.length}개 / 전체 ${registeredCount}개`
      : `${registeredCount}개`;

    emptyPatternListMessage.hidden = registeredCount > 0;
    noSearchResultMessage.hidden = !(isSearching && visiblePatternList.length === 0);
    clearPatternSearchButton.hidden = !isSearching;
  }

  // 목록은 다시 그려지므로 개별 버튼이 아니라 목록에 이벤트를 위임한다.
  filteredPatternListElement.addEventListener('click', async (clickEvent) => {
    const deleteButtonElement = clickEvent.target.closest('.word-item__delete');
    if (!deleteButtonElement) return;

    const patternToRemove = deleteButtonElement.dataset.targetPattern ?? '';
    const matchTypeToRemove = deleteButtonElement.dataset.targetMatchType ?? MATCH_TYPE.TEXT;
    await removeFilteredPattern(patternToRemove, matchTypeToRemove);
    showStatusMessage(`"${patternToRemove}" 삭제됨`);
  });

  // 검색어가 바뀌면 저장소를 다시 읽지 않고 들고 있던 설정으로 다시 그린다
  patternSearchInput.addEventListener('input', () => {
    if (lastLoadedSettings) renderPatternList(lastLoadedSettings);
  });

  clearPatternSearchButton.addEventListener('click', () => {
    patternSearchInput.value = '';
    if (lastLoadedSettings) renderPatternList(lastLoadedSettings);
    patternSearchInput.focus();
  });

  // 폼 동작(매칭 방식 전환·안내 문구·정규식 검증·추가)은 공용 모듈이 담당한다
  initializePatternForm({
    formElement: addPatternForm,
    onStatusMessage: showStatusMessage,
  });

  openOptionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // 설정 화면에서 패턴을 추가하면 이 페이지도 즉시 갱신된다.
  chrome.storage.onChanged.addListener((changeMap, areaName) => {
    if (areaName !== 'sync' || !changeMap[FILTER_SETTINGS_STORAGE_KEY]) return;
    renderPatternList(normalizeFilterSettings(changeMap[FILTER_SETTINGS_STORAGE_KEY].newValue));
  });

  loadFilterSettings().then(renderPatternList);
})();
