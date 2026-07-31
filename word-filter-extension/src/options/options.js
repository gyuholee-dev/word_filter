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
    addFilteredPattern,
    removeFilteredPattern,
    validateRegexPattern,
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
    MATCH_TYPE,
    MAX_PATTERN_COUNT,
    MAX_PATTERN_LENGTH,
    DEFAULT_FILTER_COLOR,
  } = globalThis.wordFilterSettingsStorage;

  const {
    applyBlockFilterToElement,
    buildFilteredFragmentFromTextNode,
    compileFilterPatternList,
    findFirstMatchingPattern,
    restoreAllFiltersWithin,
  } = globalThis.wordFilterApplyHelper;

  const STATUS_MESSAGE_CLEAR_DELAY_MS = 2600;

  /** 매칭 방식별 입력 안내 문구 */
  const INPUT_HINT_BY_MATCH_TYPE = {
    [MATCH_TYPE.TEXT]:
      '부분 일치로 동작합니다. "결말"을 등록하면 "결말 주의"가 포함된 문단도 처리됩니다.',
    [MATCH_TYPE.REGEX]:
      '예) 결말|스포일러  ·  \\d+화  ·  ^\\[광고\\]  ·  시즌\\s?\\d+ · 아래 "대소문자 구분"을 끄면 i 플래그가 함께 적용됩니다.',
  };

  /** 매칭 방식별 입력창 placeholder */
  const INPUT_PLACEHOLDER_BY_MATCH_TYPE = {
    [MATCH_TYPE.TEXT]: '예: 스포일러',
    [MATCH_TYPE.REGEX]: '예: \\d+화|결말',
  };

  // ── DOM 참조 ─────────────────────────────────────────────────────────────
  const addPatternForm = document.getElementById('addPatternForm');
  const newPatternInput = document.getElementById('newPatternInput');
  const textMatchTypeRadio = document.getElementById('textMatchTypeRadio');
  const regexMatchTypeRadio = document.getElementById('regexMatchTypeRadio');
  const addPatternButton = document.getElementById('addPatternButton');
  const patternInputHint = document.getElementById('patternInputHint');
  const regexFeedbackMessage = document.getElementById('regexFeedbackMessage');
  const filteredPatternListElement = document.getElementById('filteredPatternList');
  const emptyPatternListMessage = document.getElementById('emptyPatternListMessage');
  const registeredPatternCountLabel = document.getElementById('registeredPatternCountLabel');
  const statusMessageElement = document.getElementById('statusMessage');

  const exportSettingsButton = document.getElementById('exportSettingsButton');
  const restoreSettingsButton = document.getElementById('restoreSettingsButton');
  const restoreFileInput = document.getElementById('restoreFileInput');
  const transferStatusMessage = document.getElementById('transferStatusMessage');

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

  /** 현재 선택된 매칭 방식 */
  function getSelectedMatchType() {
    return regexMatchTypeRadio.checked ? MATCH_TYPE.REGEX : MATCH_TYPE.TEXT;
  }

  /**
   * 패턴 하나를 나타내는 목록 아이템을 만든다.
   *
   * innerHTML 을 쓰지 않고 textContent 로만 주입해 사용자 입력이 HTML 로 해석되지 않게 한다.
   * 정규식 패턴에는 먹칠 커버를 만들지 않는다. 텍스트 패턴은 그 자체가 가려야 할 단어지만,
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
   * 정규식 입력 중 문법을 실시간으로 검사해 결과를 보여 준다.
   * 잘못된 정규식이면 추가 버튼을 잠가 저장 자체를 막는다.
   */
  function refreshRegexFeedback() {
    const isRegexSelected = getSelectedMatchType() === MATCH_TYPE.REGEX;
    const currentInputValue = newPatternInput.value.trim();

    if (!isRegexSelected || currentInputValue.length === 0) {
      regexFeedbackMessage.hidden = true;
      regexFeedbackMessage.textContent = '';
      regexFeedbackMessage.classList.remove('regex-feedback--invalid');
      addPatternButton.disabled = false;
      return;
    }

    const validationResult = validateRegexPattern(currentInputValue);
    regexFeedbackMessage.hidden = false;

    if (validationResult.isValid) {
      regexFeedbackMessage.textContent = '올바른 정규식입니다.';
      regexFeedbackMessage.classList.remove('regex-feedback--invalid');
      addPatternButton.disabled = false;
      return;
    }
    regexFeedbackMessage.textContent = validationResult.errorMessage;
    regexFeedbackMessage.classList.add('regex-feedback--invalid');
    addPatternButton.disabled = true;
  }

  /** 매칭 방식에 따라 입력창 안내를 바꾼다. */
  function refreshPatternInputGuide() {
    const selectedMatchType = getSelectedMatchType();
    patternInputHint.textContent = INPUT_HINT_BY_MATCH_TYPE[selectedMatchType];
    newPatternInput.placeholder = INPUT_PLACEHOLDER_BY_MATCH_TYPE[selectedMatchType];
    refreshRegexFeedback();
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
    // 패턴 목록
    filteredPatternListElement.replaceChildren(
      ...settings.filteredPatternList.map(createPatternListItemElement),
    );

    const hasRegisteredPattern = settings.filteredPatternList.length > 0;
    emptyPatternListMessage.hidden = hasRegisteredPattern;
    registeredPatternCountLabel.textContent = `${settings.filteredPatternList.length}개 등록`;

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

  // ── 이벤트: 단어 추가 / 삭제 ─────────────────────────────────────────────

  addPatternForm.addEventListener('submit', async (submitEvent) => {
    submitEvent.preventDefault();

    const patternToAdd = newPatternInput.value.trim();
    const selectedMatchType = getSelectedMatchType();
    const { didAdd, reason, errorMessage } = await addFilteredPattern(
      patternToAdd,
      selectedMatchType,
    );

    if (didAdd) {
      newPatternInput.value = '';
      refreshRegexFeedback();
      showStatusMessage(
        `${selectedMatchType === MATCH_TYPE.REGEX ? '정규식' : '텍스트'} "${patternToAdd}" 추가됨`,
        'done',
      );
    } else if (reason === 'empty') {
      showStatusMessage('추가할 패턴을 입력하세요.', 'error');
    } else if (reason === 'duplicated') {
      showStatusMessage(`"${patternToAdd}" 는 이미 같은 방식으로 등록되어 있습니다.`, 'error');
    } else if (reason === 'tooLong') {
      showStatusMessage('패턴이 너무 깁니다. 200자 이내로 입력하세요.', 'error');
    } else if (reason === 'invalidRegex') {
      showStatusMessage(`정규식 오류: ${errorMessage}`, 'error');
    } else if (reason === 'limitReached') {
      showStatusMessage(`패턴은 최대 ${MAX_PATTERN_COUNT}개까지 등록할 수 있습니다.`, 'error');
    }
    newPatternInput.focus();
  });

  // 매칭 방식을 바꾸면 안내 문구·placeholder·검증 상태를 함께 갱신한다
  [textMatchTypeRadio, regexMatchTypeRadio].forEach((matchTypeRadioInput) => {
    matchTypeRadioInput.addEventListener('change', refreshPatternInputGuide);
  });

  // 정규식은 입력하는 동안 계속 문법을 확인해 준다
  newPatternInput.addEventListener('input', refreshRegexFeedback);

  // 목록은 다시 그려지므로 개별 버튼이 아니라 목록에 이벤트를 위임한다.
  filteredPatternListElement.addEventListener('click', async (clickEvent) => {
    const deleteButtonElement = clickEvent.target.closest('.word-item__delete');
    if (!deleteButtonElement) return;

    const patternToRemove = deleteButtonElement.dataset.targetPattern ?? '';
    const matchTypeToRemove = deleteButtonElement.dataset.targetMatchType ?? MATCH_TYPE.TEXT;
    await removeFilteredPattern(patternToRemove, matchTypeToRemove);
    showStatusMessage(`"${patternToRemove}" 삭제됨`);
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
  // maxlength 를 HTML 에 적어 두면 상수와 어긋날 수 있으므로 상수에서 설정한다
  newPatternInput.maxLength = MAX_PATTERN_LENGTH;
  refreshPatternInputGuide();
  loadFilterSettings().then(renderSettingsToScreen);
})();
