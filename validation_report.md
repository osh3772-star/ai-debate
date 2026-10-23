# 설치·연결 확인 결과

확인일: 2026-10-19 (KST). 최종 사용자 지시: **연결 확인만 하고 토론은 진행하지 않음**. 실행 중 토론 프로세스를 종료했고 자동 재개/백그라운드 토론은 없다.

| 항목 | 결과 |
|---|---|
| Windows | Windows 11 Home, 10.0.26200 |
| Python | 기존 3.13.15 사용 (`py -3`) |
| Node.js / npm | 기존 24.19.0 / 11.17.0 보존 |
| Git | 기존 2.55.0.windows.3 보존 |
| Codex CLI | 기존 0.155.0 사용. ChatGPT 로그인 재사용 |
| Claude Code | 공식 네이티브 설치, 2.1.303. 사용자 브라우저 로그인 완료, `claude.ai` / Pro 확인 |
| Google | 공식 Antigravity CLI 1.4.2를 프로젝트 tools 폴더에 설치. 기존 공식 계정 인증 재사용 |
| Gemini CLI | 개인/Google One 서비스 전환 공지에 따라 설치하지 않음. Google 참가자는 공식 후속 CLI에서 Gemini 모델 명시 선택 |
| CLIProxyAPI | README/Windows 설치/구독 인증 제약 검토. 설치·실행하지 않음 |

## 실제 비대화형 연결 확인

모의 응답이 아닌 실제 호출이다. 요청한 임의 확인 문자열이 정확히 반환되었는지 대조했다.

- Codex: 17:24, `CODEX_SUBSCRIPTION_OK` 반환 및 `turn.completed` 확인. 원본 `runs/individual-tests/codex.json`.
- Claude: 17:34 이후, `CLAUDE_SUBSCRIPTION_OK_9d0d83c9` 정확히 반환. 원본 `runs/individual-tests/claude-e3b447c7.json`.
- Google/Gemini: `GOOGLE_SUBSCRIPTION_OK_a191386e` 정확히 반환. 원본 `runs/individual-tests/google-537a3283.json`의 init에 `gemini-3.8-flash-medium` 기록.

Google 최초 응답은 프롬프트 전달 실패를 확인하여 **테스트 성공에서 제외**했다. 실패 기록 `runs/individual-tests/google.json`도 보존했다. `-p`와 stdin을 조합하던 방식을 공식 NDJSON `event:user` 스트리밍 입력으로 수정한 후 재검증했다.

## 토론 상태

중단 요청 이전에 GPT 독립 조사 1회와 짧은 테스트 1라운드의 GPT 발언 1회가 완료되었다. 이 사실을 숨기거나 연결 테스트로 재분류하지 않는다. 원본 자료와 실행 로그는 보존했다.

- `runs/20261019-173043-research-320165`: GPT 독립 조사 1회 완료, 중단/보류.
- `runs/20261019-173453-smoke-3466d3`: GPT 발언 1회 후 사용자 요청으로 실행 프로세스 종료, `stopped_by_user` 기록.
- **3명×2라운드 실제 토론은 미완료**이며, 교차 검증·최종 C안·교수 비판의 실제 작동 완료를 주장하지 않는다.
- 연구자료 Markdown/JSON 출력과 재개 기능은 구현되어 있다. 오프라인 회귀 검사 5개는 통과했으며 실제 토론 검증에 포함하지 않는다.

## 보존·비용·제한

기존 구독 인증을 보존했고 API 키·인증 토큰을 출력하거나 복사하지 않았다. 공식 설치 스크립트가 다운로드 해시를 검증한 바이너리를 사용했다. Codex/Claude/Google 공식 CLI 직접 호출 외의 모델 API 경로·유료 API 폴백·구매 기능은 추가하지 않았다. 구독 한도는 실제 호출만큼 소비된다. Google의 추가 G1 크레딧 사용은 호출 동안 차단한다. Claude 계정의 Extra Usage 등 기존 초과 사용 정책과 실제 청구 내역은 이 프로그램에서 확인하지 못한다.

로그는 흔한 인증 문자열·이메일·전화번호·주민번호·학번_이름 패턴을 마스킹한다. 모든 개인정보를 자동 식별한다고 보장하지 않는다. 원본 Markdown 11개의 SHA-256은 `docs/materials_manifest.json`에 기록했다. K-IFRS 원문 미확보 항목은 미확인으로 남겼다. 웹 UI는 구현하지 않았다.

사용법: `README.md`. 연결 확인만 하려면 `doctor` 또는 `verify_provider.py`를 사용하고 `run`/`resume`은 실행하지 않는다.
