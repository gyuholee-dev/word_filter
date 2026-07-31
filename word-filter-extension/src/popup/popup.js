/**
 * popup.js
 * ---------------------------------------------------------------------------
 * 확장 아이콘을 눌렀을 때 열리는 작은 화면.
 *
 * [흐름]
 *   1) 활성 탭을 찾아 content script 에 REQUEST_FILTER_STATUS 를 보내 처리 개수와
 *      현재 방식을 받는다. (chrome:// 등 주입 불가 탭은 "적용 불가"로 표시)
 *   2) 토글/빠른 추가는 storage 를 갱신하고, content script 가 onChanged 로 즉시 반영한다.
 *   3) "지금 다시 적용"은 SPA 등에서 수동으로 전체 재스캔을 트리거한다.
 */
(() => {
  const {
    loadFilterSettings,
    updateFilterSettings,
    addFilteredPattern,
    validateRegexPattern,
    formatFilterColorToCssRgba,
    FILTERING_MODE,
    MATCH_TYPE,
  } = globalThis.wordFilterSettingsStorage;

  const MESSAGE_TYPE = {
    REQUEST_FILTER_STATUS: 'REQUEST_FILTER_STATUS',
    REQUEST_FILTER_REAPPLY: 'REQUEST_FILTER_REAPPLY',
  };

  /** 모드별로 개수 캡션 문구가 달라진다 (처리한 엘리먼트 수 vs 처리한 단어 수) */
  const COUNT_CAPTION_BY_MODE = {
    [FILTERING_MODE.BLOCK]: '이 페이지에서 처리한 블록',
    [FILTERING_MODE.WORD]: '이 페이지에서 처리한 단어',
  };

  const filteredTargetCountLabel = document.getElementById('filteredTargetCountLabel');
  const filteredTargetCountCaption = document.getElementById('filteredTargetCountCaption');
  const excludedSiteNote = document.getElementById('excludedSiteNote');
  const popupBlockModeRadio = document.getElementById('popupBlockModeRadio');
  const popupWordModeRadio = document.getElementById('popupWordModeRadio');
  const currentFilterColorSwatch = document.getElementById('currentFilterColorSwatch');
  const currentFilterColorSummary = document.getElementById('currentFilterColorSummary');
  const filteringEnabledCheckbox = document.getElementById('filteringEnabledCheckbox');
  const filteringEnabledStateLabel = document.getElementById('filteringEnabledStateLabel');
  const quickAddWordForm = document.getElementById('quickAddWordForm');
  const quickAddWordInput = document.getElementById('quickAddWordInput');
  const quickAddRegexForm = document.getElementById('quickAddRegexForm');
  const quickAddRegexInput = document.getElementById('quickAddRegexInput');
  const quickAddRegexButton = document.getElementById('quickAddRegexButton');
  const popupRegexFeedback = document.getElementById('popupRegexFeedback');
  const popupStatusMessage = document.getElementById('popupStatusMessage');
  const openOptionsPageButton = document.getElementById('openOptionsPageButton');
  const reapplyFilterButton = document.getElementById('reapplyFilterButton');

  /**
   * @param {string} messageText
   * @param {'info' | 'error'} messageTone
   */
  function showPopupStatusMessage(messageText, messageTone = 'info') {
    popupStatusMessage.textContent = messageText;
    popupStatusMessage.className = 'popup-status';
    if (messageTone === 'error') popupStatusMessage.classList.add('popup-status--error');
  }

  /** 현재 활성 탭을 가져온다. */
  async function getActiveTab() {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return activeTab ?? null;
  }

  /**
   * content script 에 메시지를 보낸다. 주입이 안 된 탭이면 null 을 반환한다.
   * @param {object} requestMessage
   */
  async function sendMessageToActiveTabContentScript(requestMessage) {
    const activeTab = await getActiveTab();
    if (!activeTab || typeof activeTab.id !== 'number') return null;
    try {
      return await chrome.tabs.sendMessage(activeTab.id, requestMessage);
    } catch {
      return null; // chrome:// , 웹스토어, 파일 미허용 페이지 등
    }
  }

  /** 활성 탭의 처리 개수를 화면에 반영한다. */
  async function refreshFilteredTargetCount() {
    const statusResponse = await sendMessageToActiveTabContentScript({
      type: MESSAGE_TYPE.REQUEST_FILTER_STATUS,
    });

    if (!statusResponse) {
      excludedSiteNote.hidden = true;
      filteredTargetCountLabel.textContent = '–';
      filteredTargetCountCaption.textContent = '이 탭에는 적용할 수 없습니다';
      return;
    }

    // 예외 사이트에서는 개수가 늘 0 이라 이유를 알려 주지 않으면 고장으로 보인다
    const isExcludedSite = Boolean(statusResponse.matchedExcludedSite);
    excludedSiteNote.hidden = !isExcludedSite;
    if (isExcludedSite) {
      excludedSiteNote.textContent =
        `${statusResponse.matchedExcludedSite} 은(는) 예외로 등록되어 필터링하지 않습니다.`;
    }

    filteredTargetCountLabel.textContent = String(statusResponse.filteredTargetCount);
    filteredTargetCountCaption.textContent = isExcludedSite
      ? '예외 사이트'
      : (COUNT_CAPTION_BY_MODE[statusResponse.filteringMode] ?? '이 페이지에서 처리한 항목');
  }

  /** @param {Awaited<ReturnType<typeof loadFilterSettings>>} settings */
  function renderSettingsToPopup(settings) {
    filteringEnabledCheckbox.checked = settings.isFilteringEnabled;
    filteringEnabledStateLabel.textContent = settings.isFilteringEnabled ? '사용 중' : '중지됨';

    // 모드와 무관하게 같은 컬러를 쓰므로 스와치는 항상 보여 준다.
    // 체크 무늬 위에 rgba 를 올려 Opacity 가 낮을 때의 투명도까지 드러나게 한다.
    const cssRgbaColor = formatFilterColorToCssRgba(settings.filterColor);
    const isWordFilteringMode = settings.filteringMode === FILTERING_MODE.WORD;
    popupBlockModeRadio.checked = !isWordFilteringMode;
    popupWordModeRadio.checked = isWordFilteringMode;
    currentFilterColorSwatch.style.setProperty('--current-filter-color', cssRgbaColor);
    currentFilterColorSwatch.title = cssRgbaColor;
    currentFilterColorSummary.textContent = cssRgbaColor;
  }

  filteringEnabledCheckbox.addEventListener('change', async () => {
    const settings = await updateFilterSettings({
      isFilteringEnabled: filteringEnabledCheckbox.checked,
    });
    renderSettingsToPopup(settings);
    // content script 가 재적용을 끝낼 시간을 아주 짧게 준 뒤 개수를 다시 읽는다.
    window.setTimeout(refreshFilteredTargetCount, 120);
  });

  // 모드를 바꾸면 세는 대상(블록 수 ↔ 단어 수)이 달라지므로 개수도 다시 읽는다
  [popupBlockModeRadio, popupWordModeRadio].forEach((modeRadioInput) => {
    modeRadioInput.addEventListener('change', async () => {
      if (!modeRadioInput.checked) return;
      const settings = await updateFilterSettings({ filteringMode: modeRadioInput.value });
      renderSettingsToPopup(settings);
      window.setTimeout(refreshFilteredTargetCount, 120);
    });
  });

  /**
   * 정규식 입력 중 문법을 검사해 결과를 보여 준다.
   * 잘못된 정규식이면 추가 버튼을 잠가 저장 자체를 막는다. 설정 화면과 같은 규칙이다.
   */
  function refreshPopupRegexFeedback() {
    const currentInputValue = quickAddRegexInput.value.trim();

    if (currentInputValue.length === 0) {
      popupRegexFeedback.hidden = true;
      popupRegexFeedback.textContent = '';
      popupRegexFeedback.classList.remove('regex-feedback--invalid');
      quickAddRegexButton.disabled = false;
      return;
    }

    const validationResult = validateRegexPattern(currentInputValue);
    popupRegexFeedback.hidden = false;
    popupRegexFeedback.textContent = validationResult.isValid
      ? '올바른 정규식입니다.'
      : validationResult.errorMessage;
    popupRegexFeedback.classList.toggle('regex-feedback--invalid', !validationResult.isValid);
    quickAddRegexButton.disabled = !validationResult.isValid;
  }

  quickAddRegexInput.addEventListener('input', refreshPopupRegexFeedback);

  quickAddRegexForm.addEventListener('submit', async (submitEvent) => {
    submitEvent.preventDefault();

    const patternToAdd = quickAddRegexInput.value.trim();
    const { didAdd, reason, errorMessage } = await addFilteredPattern(patternToAdd, MATCH_TYPE.REGEX);

    if (didAdd) {
      quickAddRegexInput.value = '';
      refreshPopupRegexFeedback();
      showPopupStatusMessage(`정규식 "${patternToAdd}" 추가됨`);
      window.setTimeout(refreshFilteredTargetCount, 120);
      return;
    }
    if (reason === 'invalidRegex') {
      showPopupStatusMessage(`정규식 오류: ${errorMessage}`, 'error');
    } else if (reason === 'duplicated') {
      showPopupStatusMessage('이미 등록된 정규식입니다.', 'error');
    } else {
      showPopupStatusMessage('정규식을 입력하세요.', 'error');
    }
  });

  quickAddWordForm.addEventListener('submit', async (submitEvent) => {
    submitEvent.preventDefault();
    const patternToAdd = quickAddWordInput.value.trim();
    // 팝업의 빠른 추가는 텍스트 전용이다. 정규식은 실시간 문법 검증이 필요해
    // 설정 화면에서만 등록할 수 있게 했다.
    const { didAdd, reason } = await addFilteredPattern(patternToAdd, MATCH_TYPE.TEXT);

    if (didAdd) {
      quickAddWordInput.value = '';
      showPopupStatusMessage(`단어 "${patternToAdd}" 추가됨`);
      window.setTimeout(refreshFilteredTargetCount, 120);
      return;
    }
    showPopupStatusMessage(
      reason === 'duplicated' ? '이미 등록된 단어입니다.' : '단어를 입력하세요.',
      'error',
    );
  });

  openOptionsPageButton.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  reapplyFilterButton.addEventListener('click', async () => {
    const reapplyResponse = await sendMessageToActiveTabContentScript({
      type: MESSAGE_TYPE.REQUEST_FILTER_REAPPLY,
    });
    if (!reapplyResponse) {
      showPopupStatusMessage('이 탭에서는 실행할 수 없습니다.', 'error');
      return;
    }
    filteredTargetCountLabel.textContent = String(reapplyResponse.filteredTargetCount);
    showPopupStatusMessage('다시 적용했습니다.');
  });

  loadFilterSettings().then(renderSettingsToPopup);
  refreshFilteredTargetCount();
})();
