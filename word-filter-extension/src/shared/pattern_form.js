/**
 * pattern_form.js
 * ---------------------------------------------------------------------------
 * "필터링 패턴 추가" 폼의 동작을 담는 공용 모듈.
 *
 * 설정 화면과 패턴 편집 페이지가 같은 폼을 쓴다. 매칭 방식 전환, 안내 문구 교체,
 * 정규식 실시간 검증, 추가 결과 처리가 모두 얽혀 있어 두 곳에 복사하면 규칙이 갈라진다.
 * 그래서 폼 엘리먼트만 받아 안쪽을 알아서 연결하는 초기화 함수 하나로 묶었다.
 *
 * 마크업 규약: 폼 안에 아래 클래스를 가진 요소가 있어야 한다.
 *   .pattern-form__input        입력창
 *   .pattern-form__add-button   추가 버튼
 *   .pattern-form__hint         안내 문구
 *   .regex-feedback             정규식 검증 결과
 *   input[type=radio][value=text|regex]  매칭 방식
 */
(() => {
  if (globalThis.wordFilterPatternForm) return;

  const { MATCH_TYPE, MAX_PATTERN_LENGTH, MAX_PATTERN_COUNT, addFilteredPattern, validateRegexPattern } =
    globalThis.wordFilterSettingsStorage;

  /** 매칭 방식별 입력 안내 문구 */
  const INPUT_HINT_BY_MATCH_TYPE = {
    [MATCH_TYPE.TEXT]:
      '부분 일치로 동작합니다. "결말"을 등록하면 "결말 주의"가 포함된 문단도 처리됩니다.',
    [MATCH_TYPE.REGEX]:
      '예) 결말|스포일러  ·  \\d+화  ·  ^\\[광고\\]  ·  시즌\\s?\\d+ · "대소문자 구분"을 끄면 i 플래그가 함께 적용됩니다.',
  };

  /** 매칭 방식별 입력창 placeholder */
  const INPUT_PLACEHOLDER_BY_MATCH_TYPE = {
    [MATCH_TYPE.TEXT]: '예: 스포일러',
    [MATCH_TYPE.REGEX]: '예: \\d+화|결말',
  };

  /**
   * 패턴 추가 폼을 동작하게 만든다.
   *
   * @param {object} options
   * @param {HTMLFormElement} options.formElement 폼 엘리먼트
   * @param {(messageText: string, messageTone: 'info' | 'error' | 'done') => void} options.onStatusMessage
   *        결과를 어디에 어떻게 보여 줄지는 화면마다 다르므로 호출자가 정한다.
   */
  function initializePatternForm({ formElement, onStatusMessage }) {
    const patternInput = formElement.querySelector('.pattern-form__input');
    const addButton = formElement.querySelector('.pattern-form__add-button');
    const hintElement = formElement.querySelector('.pattern-form__hint');
    const feedbackElement = formElement.querySelector('.regex-feedback');
    const textMatchTypeRadio = formElement.querySelector('input[type="radio"][value="text"]');
    const regexMatchTypeRadio = formElement.querySelector('input[type="radio"][value="regex"]');

    /** 현재 선택된 매칭 방식 */
    function getSelectedMatchType() {
      return regexMatchTypeRadio.checked ? MATCH_TYPE.REGEX : MATCH_TYPE.TEXT;
    }

    /**
     * 정규식 입력 중 문법을 실시간으로 검사해 결과를 보여 준다.
     * 잘못된 정규식이면 추가 버튼을 잠가 저장 자체를 막는다.
     */
    function refreshRegexFeedback() {
      const isRegexSelected = getSelectedMatchType() === MATCH_TYPE.REGEX;
      const currentInputValue = patternInput.value.trim();

      if (!isRegexSelected || currentInputValue.length === 0) {
        feedbackElement.hidden = true;
        feedbackElement.textContent = '';
        feedbackElement.classList.remove('regex-feedback--invalid');
        addButton.disabled = false;
        return;
      }

      const validationResult = validateRegexPattern(currentInputValue);
      feedbackElement.hidden = false;
      feedbackElement.textContent = validationResult.isValid
        ? '올바른 정규식입니다.'
        : validationResult.errorMessage;
      feedbackElement.classList.toggle('regex-feedback--invalid', !validationResult.isValid);
      addButton.disabled = !validationResult.isValid;
    }

    /** 매칭 방식에 따라 안내 문구와 placeholder 를 바꾼다. */
    function refreshPatternInputGuide() {
      const selectedMatchType = getSelectedMatchType();
      hintElement.textContent = INPUT_HINT_BY_MATCH_TYPE[selectedMatchType];
      patternInput.placeholder = INPUT_PLACEHOLDER_BY_MATCH_TYPE[selectedMatchType];
      refreshRegexFeedback();
    }

    formElement.addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();

      const patternToAdd = patternInput.value.trim();
      const selectedMatchType = getSelectedMatchType();
      const { didAdd, reason, errorMessage } = await addFilteredPattern(
        patternToAdd,
        selectedMatchType,
      );

      if (didAdd) {
        patternInput.value = '';
        refreshRegexFeedback();
        onStatusMessage(
          `${selectedMatchType === MATCH_TYPE.REGEX ? '정규식' : '텍스트'} "${patternToAdd}" 추가됨`,
          'done',
        );
      } else if (reason === 'empty') {
        onStatusMessage('추가할 패턴을 입력하세요.', 'error');
      } else if (reason === 'duplicated') {
        onStatusMessage(`"${patternToAdd}" 는 이미 같은 방식으로 등록되어 있습니다.`, 'error');
      } else if (reason === 'tooLong') {
        onStatusMessage(`패턴이 너무 깁니다. ${MAX_PATTERN_LENGTH}자 이내로 입력하세요.`, 'error');
      } else if (reason === 'invalidRegex') {
        onStatusMessage(`정규식 오류: ${errorMessage}`, 'error');
      } else if (reason === 'limitReached') {
        onStatusMessage(`패턴은 최대 ${MAX_PATTERN_COUNT}개까지 등록할 수 있습니다.`, 'error');
      }
      patternInput.focus();
    });

    // 매칭 방식을 바꾸면 안내 문구·placeholder·검증 상태를 함께 갱신한다
    [textMatchTypeRadio, regexMatchTypeRadio].forEach((matchTypeRadioInput) => {
      matchTypeRadioInput.addEventListener('change', refreshPatternInputGuide);
    });

    // 정규식은 입력하는 동안 계속 문법을 확인해 준다
    patternInput.addEventListener('input', refreshRegexFeedback);

    // maxlength 를 HTML 에 적어 두면 상수와 어긋날 수 있으므로 상수에서 설정한다
    patternInput.maxLength = MAX_PATTERN_LENGTH;
    refreshPatternInputGuide();
  }

  globalThis.wordFilterPatternForm = { initializePatternForm };
})();
