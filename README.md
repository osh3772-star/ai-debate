# 회계윤리 AI토론

여러 AI가 회계윤리 사례를 조사하고 서로의 근거를 검토하는 연구 도구입니다.

[완료된 토론 결과 보기](https://osh3772-star.github.io/ai-debate/)

설정 화면과 분류별 요약을 함께 볼 수 있는 읽기 전용 공유 페이지입니다. 저장된 연구가 자동 선택되며, 게시자의 PC가 꺼져 있어도 접속할 수 있습니다.

## 저장소 범위

이 저장소는 프로그램 소스, 웹 UI, 오프라인 테스트 및 설계·검토 문서를 보관합니다. 계정 인증정보, 개인 UI 설정, 연구 원문 자료, 실행 결과와 로그, 설치된 CLI 바이너리는 포함하지 않습니다. 다른 PC에서는 사용할 공식 CLI를 설치·로그인한 뒤 자료를 직접 추가하세요. `claude.safe.json`과 `google.safe.json`은 인증정보가 아닌 실행 제한 정책입니다.

최근 검증: Python 207개, JS 요약 44개 및 제어판 계약 검사 통과(오프라인). 최신 기능·사용법은 [UI_GUIDE.md](UI_GUIDE.md), 설계 변경 이력은 [공유 검토 문서](docs/ai_review_exchange_astra_opus.md)를 참고하세요. 아래 과거 설치·검증 기록의 일부 링크는 로컬 전용 파일이라 저장소에 포함되지 않습니다.

Python 표준 라이브러리만 사용하는 Windows 터미널 프로그램입니다. OpenAI Codex, Anthropic Claude Code, Google Antigravity CLI와 Tencent CodeBuddy의 DeepSeek Flash를 **각 업체의 공식 CLI로 직접 호출**합니다. 토큰을 추출하거나 프록시로 중계하지 않습니다. API SDK·유료 API 키·임의 API 엔드포인트를 사용하지 않습니다. `wb-openai-gateway`는 사용하지 않습니다.

## 로컬 제어 UI

`start-ui.cmd`를 더블클릭하면 로컬 서버와 브라우저를 엽니다. 또는 PowerShell에서:

```powershell
py -3 .\ui_server.py --open
```

주소는 `http://127.0.0.1:8765`입니다. 이 PC에서만 접속하며 별도 설치 패키지·외부 웹 호스팅·원격 스크립트가 없습니다. 이미 실행 중이면 같은 제어판을 엽니다. Windows 자동 시작에는 등록하지 않습니다. 화면을 열거나 설정을 변경하고 자료·보고서를 읽는 것만으로 모델을 호출하지 않습니다.

1. 주제와 전체 명령을 입력하고 참가자 3~5명의 모델·추론 강도·개별 명령을 설정합니다. 모델이 비어 있으면 공식 CLI 기본 모델을 사용합니다. Gemini의 빈 모델은 기존에 확인한 `gemini-3.8-flash-medium`을 사용합니다. GPT 모델 후보는 로컬 캐시, Claude는 공식 별칭, Gemini는 기존 확인 목록을 표시합니다. 목록은 계정별 사용 권한을 보장하지 않으며, 미지원 모델/강도는 실행 오류로 표시하고 자동 유료 전환하지 않습니다.
2. 자료 체크박스로 전송할 파일을 고르고 미리보기로 내용을 확인합니다. 기본은 PBL+2~6주차 11개이며 해제·추가할 수 있습니다. `.md`/`.txt` 2MB 이하 파일을 추가하면 `ui_uploads/`에 로컬 사본을 저장합니다. 원본 파일은 변경하지 않습니다.
3. 설정 저장/불러오기는 로컬 `ui_config.json`만 사용하며 저장한 설정은 페이지를 열 때 복원합니다. 전송 동의는 저장하지 않습니다. 파일명·개별 지시·자료 변경만으로 토론이 실행되지 않습니다.
4. **외부 전송 동의 체크 → 연구 시작 → 확인창**을 사용자가 직접 눌러야 새 모델 호출이 시작됩니다. 연결 기록은 과거 검증 결과의 조회이며 화면을 열 때 새 테스트를 하지 않습니다.
5. 실행 모니터에서 발언 후 일시정지·현재 호출 즉시 중단·재개를 제어합니다. 재개는 저장된 실행의 설정/자료 사본을 사용하고 완료한 발언을 반복하지 않습니다. 화면의 새 설정은 새 연구 시작에 적용됩니다. 재개에도 전송 동의와 확인이 필요합니다.
6. Claude/Gemini가 보내는 공개 답변 텍스트는 생성 중 갱신합니다. Codex CLI는 완료된 메시지 중심 이벤트를 보내므로 작성 상태와 완료 발언을 즉시 표시합니다. 내부 추론 원문은 표시하지 않습니다. 중단된 부분 응답은 있으면 실행 폴더의 `interrupted_drafts.json`과 `debate.json`에 보존합니다.
7. 결과 선택 메뉴로 연구 자료집·C안·근거·AI 오류·교수 비판·SCQA 목차·원본 Markdown/JSON을 조회·다운로드합니다. 기존 연구를 선택해도 자동 재개되지 않습니다.

실행 모니터는 수신한 발언 수와 모든 참가자의 발언을 받은 단계 수를 따로 표시합니다. 중단된 연구에는 재개할 단계·참가자·발언 ID가 표시되며, 미완료 발언은 재개 시 처음부터 호출합니다. 분류별 요약의 '호출 시도 기록'에서 실패·취소·재시도를 볼 수 있습니다. 새 호출에는 `run_id`·`turn_id`·고유한 `attempt_id`를 기록하고, 완료 발언은 자신을 생성한 시도에 연결됩니다. 기존 `attempts[].id`는 호환성을 위해 발언 ID로 유지하며 이전 로그에 시도 ID를 소급 생성하지 않습니다. 전체 실행 완료는 모든 발언의 수신을 뜻하며 합의나 근거 검증 완료를 뜻하지 않습니다.

서버는 한 번에 한 연구만 실행합니다. 브라우저 탭을 닫아도 사용자가 시작한 토론은 서버에서 계속될 수 있으므로 중단 버튼을 사용하세요. PC를 종료하면 서버도 종료되며, 다음에 `start-ui.cmd`로 다시 열고 기록을 선택해 명시적으로 재개할 수 있습니다. 다른 공급자 앱의 작업은 중단하지 않습니다. 기존 실행기가 살아 있는 lock은 보존하며, 죽은 프로세스의 lock만 사용자의 시작/재개 요청 때 복구합니다.

UI 구현 검증은 `UI_GUIDE.md`와 `docs/ui_validation.json`을 확인하세요. DeepSeek 추가 작업은 `docs/codebuddy_validation.md`를 참고하세요. 실제 단독 연결은 확인했으며 사용자의 중단 지시에 따라 실제 토론 테스트는 수행하지 않았습니다.

## 실행

PowerShell에서 이 폴더로 이동한 후:

```powershell
py -3 .\debate.py doctor
py -3 .\debate.py preview
py -3 .\debate.py run --mode smoke --topic "상장 전 재무 오류 정정" --approve-transfer
py -3 .\debate.py run --mode research --topic "넥서스AI: 후보 1번과 3번 결합을 포함한 C안 검토" --approve-transfer
```

터미널 기본은 기존 3명이며 `--agents 4`는 DeepSeek Flash를 네 번째로, `--agents 5`는 추가 GPT 역할을 넣습니다. 별도 구독 계정을 만들지 않습니다. 연구 모드는 5단계 + 비판 반영 수정으로 18~30회, 테스트 모드는 3명 기준 2라운드 6회입니다. `--mode consensus --agents 4`는 독립 분석 → 교차 반박 → 재반론 → 최종 합의 검토의 16회 발언입니다. 전원 합의를 자동 가정하지 않고 각자의 명시적 동의·이견을 남깁니다. 독립 단계에는 다른 참가자 의견을 전달하지 않습니다. 이후에는 완료된 발언 전체를 전달합니다.

현재 저장한 UI 설정은 기존 세 AI의 모델·지시와 자료 12개를 유지한 채 DeepSeek를 추가한 4명·4단계 합의 모드입니다. 기존 3명 설정은 `ui_config.before-codebuddy.json`에 보존했고, 과거 실행을 재개하면 그 실행의 원래 참가자 구성을 사용합니다.

`--approve-transfer`는 **주제·제공 자료·다른 AI 발언을 해외 클라우드 공급자로 전송**하는 명시적 승인입니다. 기본 실행은 승인 없이 전송하지 않습니다. 과제 원본은 읽기만 하고 수정하지 않습니다. 원본 외에는 선택한 실행 폴더와 CLI 자체의 필수 인증/상태 저장이 발생할 수 있습니다. 입력과 출력의 흔한 토큰·이메일·전화번호를 마스킹하지만 모든 개인정보를 탐지할 수는 없으므로 이름·학번 등은 실행 전에 직접 확인하세요.

```powershell
# 현재 발언을 취소하고 중단: 실행 터미널에서 Ctrl+C
# 다른 터미널에서 현재 발언 완료 후 중단 요청
py -3 .\debate.py pause .\runs\실행폴더
# 완료한 발언은 다시 호출하지 않고 다음 발언부터 재개
py -3 .\debate.py resume .\runs\실행폴더
# 호출 횟수를 제한해 단계적으로 실행
py -3 .\debate.py run --approve-transfer --max-turns 3
```

`runner.lock`이 남은 경우 먼저 작업 관리자에서 해당 실행 프로세스가 종료되었는지 확인한 후 그 실행 폴더의 lock 파일만 삭제하세요. 실패한 발언은 재개 시 다시 호출되며, 취소 직전 공급자에서 이미 처리한 호출은 구독 한도를 소비했을 수 있습니다.

## 인증

```powershell
py -3 .\debate.py login codex
py -3 .\debate.py login claude
py -3 .\debate.py login google
```

브라우저에서 본인이 직접 로그인합니다. 비밀번호·코드·토큰을 채팅/로그에 넣지 마세요. Claude는 **Claude 구독**을 선택하며 Console/API 결제 로그인을 선택하지 않습니다. Google은 개인 OAuth를 사용합니다. 개인/Google One의 Gemini CLI 서비스가 Antigravity CLI로 이전한 공식 공지에 따라 Google 참가자는 `agy`로 선택했습니다. 조직 Gemini Code Assist Standard/Enterprise가 있는 사용자의 Gemini CLI는 별도 인증 정책 검토가 필요합니다.

## 연구 근거와 검증

자료는 상위 폴더의 PBL 및 2~6주차 Markdown 11개이며 SHA-256/파일명/행 번호를 기록합니다. 7주차 강의자료는 자동 포함하지 않습니다. 외부 K-IFRS 원문·법령·기사·학술자료는 자동 검색하거나 유료 로그인으로 가져오지 않습니다. 확인한 자료를 출처·확인일·문단·검증 범위와 함께 Markdown으로 정리해 `--evidence .\docs\verified_evidence.md`로 전달할 수 있습니다. 제공하지 않은 외부 원문은 미확인으로 분류합니다. 모델의 동의·자체 verified 표시를 독립 검증으로 승격하지 않습니다.

`evidence_register.md`의 시스템 확인은 원문 대조 대기로 유지합니다. 실제 오류 후보는 원발언/원질문/개선 질문/교정 후보와 함께 `ai_audit.md`에 보존합니다. 모델이 지적한 오류의 사실성은 사람이 원문과 대조해야 합니다. 오류가 3개 미만이면 억지로 채우지 않습니다. 이 제한은 과제의 3건 요구 충족을 보장하지 않으며 교수에게 실제 기록을 제시해야 합니다.

## 결과

`runs\날짜-모드-ID\`에 다음 파일이 매 발언 후 저장됩니다:

- `research_dossier.md`: 사례·강의 이론·검토 분석
- `alternatives_c.md`: 후보 비교·결합·선정·수정
- `evidence_register.md`: 주장별 출처·검증 상태
- `ai_audit.md`: 실제 오류 검토 후보와 프롬프트 개선
- `debate_log.md`: 전체 질문과 원답변(새 연구는 발언별로 실제 전달한 기준서 문단·강의 범위·누락 목록 포함)
- `report_outline.md`: 4페이지 작성 목차(새 연구는 결론 우선·부록 구성·주석 후보, 과제 요건 기록 대장과 과제·강의 용어 대응표)
- `professor_review.md`: 교수 관점 비판과 수정(새 회계 PBL 연구는 반례·사실 확인 기록 포함)
- `summary.md`: 잠정 결론·반박·입장 변경·미해결·채택/기각
- `ai_usage_appendix.md`: 부록용 AI 활용 내역(새 연구는 첫 생각·맹점, 실수·개선 질문, 학습 기록 작성란 포함)
- `debate.json`, `events.jsonl`: 상태·원본 CLI 응답(비밀 마스킹)·재개 기록

학생이 직접 쓴 첫 생각은 UI의 '내 첫 생각' 또는 터미널 `run --student-draft 파일경로`(3000자 이하)로 전달하며 교차 검증 단계에서만 공개됩니다.

오류 검토 후보의 재호출은 UI 창에서 하거나 터미널에서 `correct 실행폴더 --review-turn S2A1 --audit-index 0 --approve-transfer`로 실행합니다. AI 제안 대신 직접 고친 질문은 `--question "고친 질문" --reason "고친 이유"`로, 함께 보낼 기준서 문단은 `--unit K1115:B66`(최대 6개, 이 실행 자료에 있는 문단만)으로 지정합니다.

기존 실행 JSON은 덮어쓰지 않고 실행마다 새 폴더를 만듭니다. 학생 제출용 DOCX 최종 보고서는 자동 작성하지 않습니다.

## 비용·권한

Codex는 기존 사용자 설정을 읽지 않는 read-only 호출과 ChatGPT 로그인 강제를 사용합니다. Claude는 도구를 비활성화하고 MCP/프로젝트 설정/훅을 제한하며 구독 인증만 허용합니다. Google은 Gemini 3.8 Flash (Medium)을 명시적으로 선택합니다. Antigravity 1.4.2에는 세션별 설정 파일 옵션이 없어 `~/.gemini/antigravity-cli/settings.json`에 추가 G1 크레딧 사용 꺼짐·파일/명령/웹/MCP 거부를 호출 동안 임시 적용하고 종료 시 원래 바이트로 복원합니다. 기존 인증 저장소는 읽거나 복사하지 않습니다. Google 호출 중 다른 창에서 CLI 설정을 바꾸지 마세요. 강제 종료로 설정 lock이 남으면 자동 실행을 중단하고 상태부터 점검해야 합니다. 프로그램은 API/게이트웨이 환경변수를 자식 프로세스에서 제거하며 전역 환경변수는 바꾸지 않습니다. 공식 설치기가 추가한 프로젝트 agy PATH 항목은 제거했으며 절대 경로로 실행합니다. 권한 제어는 CLI의 구현에 의존하고 Windows 전체에 대한 OS 보안 경계는 아닙니다.

별도 API 키 기반 호출·자동 API 폴백·구매 기능은 없습니다. 기존 구독의 사용량과 한도는 소비되며, 계정 측에서 이미 켜 둔 초과 사용/유료 크레딧 정책까지 이 프로그램이 조회·해제하지는 못합니다. Claude의 Extra Usage 등은 공급자 계정에서 꺼져 있는지 확인하세요. 실제 청구 내역은 프로그램이 확인할 수 없습니다. 제한에 도달하면 중단 후 재개하세요.

CodeBuddy는 기존 설치 2.169.0의 `deepseek-v4.1-flash`를 명시하고 `-p --output-format json`을 사용합니다. 매 발언 새 임시 세션, 도구·MCP·훅 비활성화, 사용자 지정 모델 파일·API 키·API helper 비활성화를 자식 프로세스에 적용합니다. Windows에서는 빈 `--tools ""` 인자를 보존하기 위해 npm `codebuddy` 명령이 가리키는 동일 공식 Node 진입점을 실행합니다. 응답 모델 메타데이터가 일치하지 않으면 다른 모델로 대체하지 않고 중단합니다. 사용량·세션 ID·보고 모델은 JSON에 남기고 인증 토큰은 기록하지 않습니다. 한도/인증/타임아웃 오류는 자동 재시도하지 않으며 명시적 재개 때 미완료 발언만 다시 호출합니다. CodeBuddy JSON의 비용 `0`은 현재 버전의 고정값이므로 무과금 증거가 아닙니다.

CLIProxyAPI는 검토만 수행했습니다. Windows 바이너리 및 Codex/Gemini 연계 지원은 기술적 가능성일 뿐 각 공급자 구독 사용 허가를 의미하지 않습니다. 승인 범위가 확인되지 않아 설치·서비스·포트 개방을 하지 않습니다. Claude 구독 토큰을 프록시에 사용하지 않습니다.

## 로컬 검증

```powershell
py -3 -m unittest -v test_debate.py
```

위 테스트는 오프라인 회귀 검사이며 실제 AI 응답 검증에 포함하지 않습니다. 전체 Python 검사는 `py -3 -m unittest test_debate test_engine_ui test_ui_server test_codebuddy`입니다. 웹 분류/조회 검사는 `node test_summary_contract.js`와 `node test_controller_summary.js`입니다. 과거 실제 연결 검증 결과는 `validation_report.md`와 `runs\individual-tests\`에서 확인합니다.

## 공식 문서 (2026-10-19 확인)

- [Codex 비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode), [인증](https://learn.chatgpt.com/docs/auth)
- [Claude Code 설치](https://code.claude.com/docs/en/setup), [CLI 옵션](https://code.claude.com/docs/en/cli-reference), [인증과 준수](https://code.claude.com/docs/en/legal-and-compliance)
- [Gemini CLI 공식 저장소](https://github.com/google-gemini/gemini-cli), [개인 사용자 Antigravity 전환 공지](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- [Antigravity 설치](https://antigravity.google/docs/getting-started?tab=cli), [Headless](https://antigravity.google/docs/cli/headless), [권한](https://antigravity.google/docs/permissions), [크레딧](https://antigravity.google/docs/cli/credits)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), [Windows 설치 문서](https://help.router-for.me/introduction/quick-start)
- [CodeBuddy CLI 옵션](https://www.codebuddy.ai/docs/cli/cli-reference), [비대화형 실행·JSON](https://www.codebuddy.ai/docs/cli/headless), [모델 설정](https://www.codebuddy.ai/docs/cli/models)
