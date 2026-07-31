/**
 * options.js
 * ---------------------------------------------------------------------------
 * 설정 화면 로직.
 *
 * [흐름]
 *   1) DOM 로드 → loadFilterSettings() → renderSettingsToScreen()
 *   2) 사용자가 단어/모드/컬러를 바꾸면 storage 에 저장한다.
 *   3) storage.onChanged 를 구독하고 있으므로 저장 결과가 다시 화면으로 흘러
 *      들어온다(단일 방향 데이터 흐름). 팝업에서 토글을 바꿔도 이 화면이 같이 갱신된다.
 *   4) 동시에 각 탭의 content script 도 같은 이벤트를 받아 즉시 재적용한다.
 *
 * 미리보기는 content script 와 **같은 공용 함수**(wordFilterApplyHelper)와
 * **같은 스타일시트**(word_filter_styles.css)를 사용한다. 그래서 미리보기와 실제
 * 동작이 어긋날 수 없다.
 */
(() => {
  const {
    loadFilterSettings,
    updateFilterSettings,
    removeFilteredPattern,
    addExcludedSite,
    removeExcludedSite,
    normalizeFilterSettings,
    formatFilterColorToCssRgba,
    formatFilterColorToHex,
    parseHexColorToRgbChannels,
    serializeFilterSettingsToJson,
    parseFilterSettingsFromJson,
    restoreFilterSettings,
    buildExportFileName,
    FILTER_SETTINGS_STORAGE_KEY,
    FILTERING_MODE,
    THEME_PREFERENCE,
    MATCH_TYPE,
    MAX_EXCLUDED_SITE_COUNT,
    DEFAULT_FILTER_COLOR,
  } = globalThis.wordFilterSettingsStorage;

  const { initializePatternForm } = globalThis.wordFilterPatternForm;
  const { applyThemePreference } = globalThis.wordFilterThemePreference;

  const {
    applyBlockFilterToElement,
    buildFilteredFragmentFromTextNode,
    compileFilterPatternList,
    findFirstMatchingPattern,
    restoreAllFiltersWithin,
  } = globalThis.wordFilterApplyHelper;

  const STATUS_MESSAGE_CLEAR_DELAY_MS = 2600;

  // ── DOM 참조 ─────────────────────────────────────────────────────────────
  const addPatternForm = document.getElementById('addPatternForm');
  const openPatternEditorButton = document.getElementById('openPatternEditorButton');
  const registeredPatternCountLabel = document.getElementById('registeredPatternCountLabel');
  const statusMessageElement = document.getElementById('statusMessage');

  const addExcludedSiteForm = document.getElementById('addExcludedSiteForm');
  const newExcludedSiteInput = document.getElementById('newExcludedSiteInput');
  const excludedSiteListElement = document.getElementById('excludedSiteList');
  const emptyExcludedSiteMessage = document.getElementById('emptyExcludedSiteMessage');
  const excludedSiteCountLabel = document.getElementById('excludedSiteCountLabel');
  const siteStatusMessage = document.getElementById('siteStatusMessage');

  const exportSettingsButton = document.getElementById('exportSettingsButton');
  const restoreSettingsButton = document.getElementById('restoreSettingsButton');
  const restoreFileInput = document.getElementById('restoreFileInput');
  const transferStatusMessage = document.getElementById('transferStatusMessage');

  const themePreferenceRadioList = [
    document.getElementById('systemThemeRadio'),
    document.getElementById('lightThemeRadio'),
    document.getElementById('darkThemeRadio'),
  ];

  const blockModeRadio = document.getElementById('blockModeRadio');
  const wordModeRadio = document.getElementById('wordModeRadio');

  const filterColorPickerInput = document.getElementById('filterColorPickerInput');
  const redChannelInput = document.getElementById('redChannelInput');
  const greenChannelInput = document.getElementById('greenChannelInput');
  const blueChannelInput = document.getElementById('blueChannelInput');
  const filterOpacityRange = document.getElementById('filterOpacityRange');
  const filterOpacityValueLabel = document.getElementById('filterOpacityValueLabel');
  const filterColorSummaryLabel = document.getElementById('filterColorSummaryLabel');
  const filterColorChip = document.getElementById('filterColorChip');
  const resetFilterColorButton = document.getElementById('resetFilterColorButton');

  const filteringEnabledCheckbox = document.getElementById('filteringEnabledCheckbox');
  const filteringEnabledStateLabel = document.getElementById('filteringEnabledStateLabel');
  const caseSensitiveCheckbox = document.getElementById('caseSensitiveCheckbox');
  const caseSensitiveStateLabel = document.getElementById('caseSensitiveStateLabel');

  const previewContainer = document.getElementById('previewContainer');
  const previewModeLabel = document.getElementById('previewModeLabel');

  /** RGB 채널 입력 3개를 함께 다루기 위한 대응표 */
  const RGB_CHANNEL_INPUT_MAP = {
    red: redChannelInput,
    green: greenChannelInput,
    blue: blueChannelInput,
  };

  let statusMessageTimerId = 0;

  // ── 상태 메시지 ──────────────────────────────────────────────────────────

  /**
   * 지정한 자리에 상태 메시지를 띄운다.
   *
   * 메시지 자리가 두 곳(패턴 목록 위, 백업 패널 안)인데 서로 멀어서 한쪽 메시지가 다른 쪽
   * 작업 결과로 보이면 혼란스럽다. 그래서 대상 엘리먼트를 인자로 받아 각자 자리에만 띄운다.
   *
   * @param {HTMLElement} targetElement
   * @param {string} messageText
   * @param {'info' | 'error' | 'done'} messageTone
   */
  function showMessageAt(targetElement, messageText, messageTone = 'info') {
    targetElement.textContent = messageText;
    targetElement.className = 'status';
    if (messageTone === 'error') targetElement.classList.add('status--error');
    if (messageTone === 'done') targetElement.classList.add('status--done');
  }

  /**
   * 패턴 목록 위 메시지. 잠시 뒤 자동으로 지워진다.
   * @param {string} messageText
   * @param {'info' | 'error' | 'done'} messageTone
   */
  function showStatusMessage(messageText, messageTone = 'info') {
    showMessageAt(statusMessageElement, messageText, messageTone);

    window.clearTimeout(statusMessageTimerId);
    statusMessageTimerId = window.setTimeout(() => {
      showMessageAt(statusMessageElement, '');
    }, STATUS_MESSAGE_CLEAR_DELAY_MS);
  }

  // ── 렌더링: 단어 목록 ────────────────────────────────────────────────────

  /**
   * 예외 사이트 한 줄을 만든다. 도메인은 읽고 확인해야 하는 값이라 먹칠하지 않는다.
   * @param {string} hostName
   * @returns {HTMLLIElement}
   */
  function createExcludedSiteItemElement(hostName) {
    const siteItemElement = document.createElement('li');
    siteItemElement.className = 'word-item word-item--site';

    const siteBarElement = document.createElement('div');
    siteBarElement.className = 'word-item__bar';

    const siteTextElement = document.createElement('span');
    siteTextElement.className = 'word-item__text';
    siteTextElement.textContent = hostName;
    siteBarElement.appendChild(siteTextElement);

    const deleteButtonElement = document.createElement('button');
    deleteButtonElement.type = 'button';
    deleteButtonElement.className = 'word-item__delete';
    deleteButtonElement.textContent = '삭제';
    deleteButtonElement.setAttribute('aria-label', `${hostName} 삭제`);
    deleteButtonElement.dataset.targetHostName = hostName;

    siteItemElement.append(siteBarElement, deleteButtonElement);
    return siteItemElement;
  }

  // ── 렌더링: 미리보기 ─────────────────────────────────────────────────────

  /**
   * 미리보기 문장에 현재 설정을 그대로 적용한다.
   * 매번 "완전 복원 → 재적용" 순서로 처리해 이전 상태가 누적되지 않게 한다.
   * @param {ReturnType<typeof normalizeFilterSettings>} settings
   */
  function renderPreviewLines(settings) {
    restoreAllFiltersWithin(previewContainer);

    const isWordFilteringMode = settings.filteringMode === FILTERING_MODE.WORD;
    previewModeLabel.textContent = isWordFilteringMode ? '단어' : '블록';

    if (!settings.isFilteringEnabled) return;

    previewContainer.querySelectorAll('.preview__line').forEach((previewLineElement) => {
      // 줄마다 data-preview-pattern 으로 예시 단어를 지정해 둔다.
      // 등록한 패턴 목록과 분리해야 목록이 비어 있어도 현재 모드·컬러를 항상 보여 줄 수 있다.
      const previewPattern = previewLineElement.dataset.previewPattern;
      if (!previewPattern) return;

      // 판정과 적용은 content script 와 같은 공용 함수를 쓴다. 미리보기와 실제 동작이
      // 어긋날 수 없도록 하기 위한 것이다.
      const compiledPatternList = compileFilterPatternList(
        [{ pattern: previewPattern, matchType: MATCH_TYPE.TEXT }],
        settings.shouldMatchCaseSensitively,
      );

      if (isWordFilteringMode) {
        // 단어 모드: 예시 단어 부분만 감싼다
        const firstChildTextNode = previewLineElement.firstChild;
        if (!firstChildTextNode || firstChildTextNode.nodeType !== Node.TEXT_NODE) return;

        const buildResult = buildFilteredFragmentFromTextNode(
          firstChildTextNode,
          compiledPatternList,
          settings.shouldMatchCaseSensitively,
          settings.filterColor,
        );
        if (buildResult) previewLineElement.replaceChild(buildResult.fragment, firstChildTextNode);
        return;
      }

      // 블록 모드: 줄 전체가 대상이 된다 (실제 페이지에서는 문단·카드가 대상)
      const matchedPattern = findFirstMatchingPattern(
        previewLineElement.textContent ?? '',
        compiledPatternList,
        settings.shouldMatchCaseSensitively,
      );
      if (matchedPattern) {
        applyBlockFilterToElement(previewLineElement, settings.filterColor, matchedPattern);
      }
    });
  }

  // ── 렌더링: 전체 ─────────────────────────────────────────────────────────

  /**
   * 설정 객체 하나로 화면 전체를 다시 그린다.
   * @param {ReturnType<typeof normalizeFilterSettings>} settings
   */
  function renderSettingsToScreen(settings) {
    registeredPatternCountLabel.textContent = `${settings.filteredPatternList.length}개 등록`;

    // 예외 사이트 목록
    excludedSiteListElement.replaceChildren(
      ...settings.excludedSiteList.map(createExcludedSiteItemElement),
    );
    emptyExcludedSiteMessage.hidden = settings.excludedSiteList.length > 0;
    excludedSiteCountLabel.textContent = `${settings.excludedSiteList.length}개 등록`;

    // 테마
    themePreferenceRadioList.forEach((themeRadioInput) => {
      themeRadioInput.checked = themeRadioInput.value === settings.themePreference;
    });
    applyThemePreference(settings.themePreference);

    // 필터링 모드
    const isWordFilteringMode = settings.filteringMode === FILTERING_MODE.WORD;
    blockModeRadio.checked = !isWordFilteringMode;
    wordModeRadio.checked = isWordFilteringMode;

    // 필터링 컬러 — 입력 중인 요소는 덮어쓰지 않는다 (커서/입력값 튐 방지)
    filterColorPickerInput.value = formatFilterColorToHex(settings.filterColor);
    Object.entries(RGB_CHANNEL_INPUT_MAP).forEach(([channelName, channelInputElement]) => {
      if (document.activeElement !== channelInputElement) {
        channelInputElement.value = String(settings.filterColor[channelName]);
      }
    });
    if (document.activeElement !== filterOpacityRange) {
      filterOpacityRange.value = String(settings.filterColor.opacity);
    }
    filterOpacityValueLabel.textContent = settings.filterColor.opacity.toFixed(2);

    const cssRgbaColor = formatFilterColorToCssRgba(settings.filterColor);
    filterColorSummaryLabel.textContent = cssRgbaColor;
    filterColorChip.style.setProperty('--current-filter-color', cssRgbaColor);

    // 공통 설정
    filteringEnabledCheckbox.checked = settings.isFilteringEnabled;
    filteringEnabledStateLabel.textContent = settings.isFilteringEnabled ? '사용 중' : '중지됨';
    caseSensitiveCheckbox.checked = settings.shouldMatchCaseSensitively;
    caseSensitiveStateLabel.textContent = settings.shouldMatchCaseSensitively
      ? '구분함'
      : '구분 안 함';

    renderPreviewLines(settings);
  }

  // ── 이벤트: 패턴 추가 ────────────────────────────────────────────────────

  // 폼 동작(매칭 방식 전환·안내 문구·정규식 검증·추가)은 공용 모듈이 담당한다.
  // 결과 메시지를 어디에 띄울지만 이 화면이 정한다.
  initializePatternForm({
    formElement: addPatternForm,
    onStatusMessage: showStatusMessage,
  });

  /**
   * 패턴 편집 페이지를 연다.
   *
   * 창 이름을 지정하면 이미 열려 있는 탭을 다시 쓰므로, 버튼을 여러 번 눌러도 탭이 쌓이지 않는다.
   * chrome.tabs 로 기존 탭을 찾으려면 tabs 권한이 필요해 이 방식을 골랐다.
   */
  openPatternEditorButton.addEventListener('click', () => {
    window.open(
      chrome.runtime.getURL('src/pattern-editor/pattern_editor.html'),
      'wordFilterPatternEditor',
    );
  });

  // ── 이벤트: 백업 및 복원 ─────────────────────────────────────────────────

  /**
   * 백업 패널 안 메시지. 결과를 계속 볼 수 있도록 자동으로 지우지 않는다.
   * @param {string} messageText
   * @param {'info' | 'error' | 'done'} messageTone
   */
  function showTransferStatusMessage(messageText, messageTone = 'info') {
    showMessageAt(transferStatusMessage, messageText, messageTone);
  }

  /**
   * 문자열을 파일로 내려받게 한다.
   *
   * chrome.downloads 권한을 요청하지 않기 위해 Blob URL + 임시 <a download> 클릭 방식을 쓴다.
   * 사용이 끝난 Blob URL 은 즉시 해제해 메모리에 남지 않게 한다.
   *
   * @param {string} fileText
   * @param {string} fileName
   */
  function downloadTextAsFile(fileText, fileName) {
    const fileBlob = new Blob([fileText], { type: 'application/json' });
    const blobObjectUrl = URL.createObjectURL(fileBlob);

    const temporaryDownloadLink = document.createElement('a');
    temporaryDownloadLink.href = blobObjectUrl;
    temporaryDownloadLink.download = fileName;
    document.body.appendChild(temporaryDownloadLink);
    temporaryDownloadLink.click();
    temporaryDownloadLink.remove();

    URL.revokeObjectURL(blobObjectUrl);
  }

  exportSettingsButton.addEventListener('click', async () => {
    const settings = await loadFilterSettings();
    const backupFileName = buildExportFileName();

    downloadTextAsFile(serializeFilterSettingsToJson(settings), backupFileName);
    showTransferStatusMessage(`설정 전체를 ${backupFileName} 으로 저장했습니다.`, 'done');
  });

  restoreSettingsButton.addEventListener('click', () => restoreFileInput.click());

  restoreFileInput.addEventListener('change', async () => {
    const [selectedFile] = restoreFileInput.files ?? [];
    if (!selectedFile) return;

    // 같은 파일을 다시 골라도 change 가 발생하도록 값을 비워 둔다
    restoreFileInput.value = '';

    let rawFileText;
    try {
      rawFileText = await selectedFile.text();
    } catch (fileReadError) {
      showTransferStatusMessage(`파일을 읽지 못했습니다: ${fileReadError.message}`, 'error');
      return;
    }

    const parseResult = parseFilterSettingsFromJson(rawFileText);
    if (!parseResult.isValid) {
      showTransferStatusMessage(parseResult.errorMessage, 'error');
      return;
    }

    // 현재 설정을 전부 덮어쓰는 동작이므로 되돌릴 수 없다는 점을 먼저 확인받는다
    const didConfirm = window.confirm(
      `현재 설정을 백업 파일 내용으로 모두 덮어씁니다.\n` +
        `복원할 패턴 ${parseResult.settings.filteredPatternList.length}개. 계속하시겠습니까?`,
    );
    if (!didConfirm) {
      showTransferStatusMessage('복원을 취소했습니다.');
      return;
    }

    try {
      await restoreFilterSettings(parseResult.settings);
    } catch (restoreError) {
      showTransferStatusMessage(restoreError.message, 'error');
      return;
    }
    showTransferStatusMessage(
      `설정을 복원했습니다. 패턴 ${parseResult.settings.filteredPatternList.length}개.`,
      'done',
    );
  });

  // ── 이벤트: 사이트 예외 ──────────────────────────────────────────────────

  addExcludedSiteForm.addEventListener('submit', async (submitEvent) => {
    submitEvent.preventDefault();

    const rawInput = newExcludedSiteInput.value.trim();
    const { didAdd, hostName, reason } = await addExcludedSite(rawInput);

    if (didAdd) {
      newExcludedSiteInput.value = '';
      showMessageAt(siteStatusMessage, `${hostName} 을(를) 예외로 등록했습니다.`, 'done');
    } else if (reason === 'invalid') {
      showMessageAt(siteStatusMessage, '주소를 읽을 수 없습니다. example.com 형식으로 입력하세요.', 'error');
    } else if (reason === 'duplicated') {
      showMessageAt(siteStatusMessage, `${hostName} 은(는) 이미 등록되어 있습니다.`, 'error');
    } else if (reason === 'limitReached') {
      showMessageAt(siteStatusMessage, `예외 사이트는 최대 ${MAX_EXCLUDED_SITE_COUNT}개까지 등록할 수 있습니다.`, 'error');
    }
    newExcludedSiteInput.focus();
  });

  excludedSiteListElement.addEventListener('click', async (clickEvent) => {
    const deleteButtonElement = clickEvent.target.closest('.word-item__delete');
    if (!deleteButtonElement) return;

    const hostNameToRemove = deleteButtonElement.dataset.targetHostName ?? '';
    await removeExcludedSite(hostNameToRemove);
    showMessageAt(siteStatusMessage, `${hostNameToRemove} 예외를 해제했습니다.`);
  });

  // ── 이벤트: 테마 전환 ────────────────────────────────────────────────────

  // 저장하면 storage.onChanged 로 팝업·편집 페이지에도 같은 테마가 적용된다
  themePreferenceRadioList.forEach((themeRadioInput) => {
    themeRadioInput.addEventListener('change', async () => {
      if (!themeRadioInput.checked) return;
      applyThemePreference(themeRadioInput.value);
      await updateFilterSettings({ themePreference: themeRadioInput.value });
    });
  });

  // ── 이벤트: 필터링 모드 전환 ─────────────────────────────────────────────

  [blockModeRadio, wordModeRadio].forEach((modeRadioInput) => {
    modeRadioInput.addEventListener('change', async () => {
      if (!modeRadioInput.checked) return;
      await updateFilterSettings({ filteringMode: modeRadioInput.value });
      showStatusMessage(
        modeRadioInput.value === FILTERING_MODE.WORD
          ? '단어 모드로 변경했습니다.'
          : '블록 모드로 변경했습니다.',
        'done',
      );
    });
  });

  // ── 이벤트: 필터링 컬러 ──────────────────────────────────────────────────

  // 컬러 피커: 드래그 중(input)에는 채널 입력만 맞추고, 확정(change) 시 저장한다
  filterColorPickerInput.addEventListener('input', () => {
    const rgbChannels = parseHexColorToRgbChannels(filterColorPickerInput.value);
    if (!rgbChannels) return;
    Object.entries(RGB_CHANNEL_INPUT_MAP).forEach(([channelName, channelInputElement]) => {
      channelInputElement.value = String(rgbChannels[channelName]);
    });
  });

  filterColorPickerInput.addEventListener('change', async () => {
    const rgbChannels = parseHexColorToRgbChannels(filterColorPickerInput.value);
    if (!rgbChannels) return;
    await updateFilterSettings({ filterColor: rgbChannels });
  });

  // R/G/B 숫자 입력: 값이 확정될 때 저장한다.
  // 범위를 벗어난 값은 storage 계층의 normalizeFilterColor 가 0~255 로 잘라 준다.
  Object.entries(RGB_CHANNEL_INPUT_MAP).forEach(([channelName, channelInputElement]) => {
    channelInputElement.addEventListener('change', async () => {
      await updateFilterSettings({ filterColor: { [channelName]: channelInputElement.value } });
    });
  });

  // Opacity: 드래그 중(input)에는 라벨만 갱신하고, 손을 뗐을 때(change) 저장한다
  filterOpacityRange.addEventListener('input', () => {
    filterOpacityValueLabel.textContent = Number(filterOpacityRange.value).toFixed(2);
  });

  filterOpacityRange.addEventListener('change', async () => {
    await updateFilterSettings({ filterColor: { opacity: Number(filterOpacityRange.value) } });
  });

  resetFilterColorButton.addEventListener('click', async () => {
    await updateFilterSettings({ filterColor: DEFAULT_FILTER_COLOR });

    // 문구에 값을 직접 적으면 상수와 어긋날 수 있으므로 상수에서 만들어 쓴다.
    const { red, green, blue, opacity } = DEFAULT_FILTER_COLOR;
    showStatusMessage(
      `필터링 컬러를 기본값(RGB ${red},${green},${blue} / Opacity ${opacity.toFixed(2)})으로 되돌렸습니다.`,
    );
  });

  // ── 이벤트: 공통 설정 ────────────────────────────────────────────────────

  filteringEnabledCheckbox.addEventListener('change', async () => {
    await updateFilterSettings({ isFilteringEnabled: filteringEnabledCheckbox.checked });
    showStatusMessage(
      filteringEnabledCheckbox.checked ? '필터링을 켰습니다.' : '필터링을 껐습니다.',
    );
  });

  caseSensitiveCheckbox.addEventListener('change', async () => {
    await updateFilterSettings({ shouldMatchCaseSensitively: caseSensitiveCheckbox.checked });
  });

  // 다른 화면(팝업)에서 바꾼 설정도 즉시 반영한다.
  chrome.storage.onChanged.addListener((changeMap, areaName) => {
    if (areaName !== 'sync' || !changeMap[FILTER_SETTINGS_STORAGE_KEY]) return;
    renderSettingsToScreen(normalizeFilterSettings(changeMap[FILTER_SETTINGS_STORAGE_KEY].newValue));
  });

  // ── 초기 렌더 ────────────────────────────────────────────────────────────
  loadFilterSettings().then(renderSettingsToScreen);
})();
