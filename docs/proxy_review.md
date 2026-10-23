# CLIProxyAPI 검토 — 2026-10-19

기술 문서와 공급자 허용 범위는 별개다. 이 설치는 공식 CLI 원본을 직접 실행하며 프록시를 사용하지 않는다.

| 항목 | 확인 결과 | 출처 |
|---|---|---|
| Windows | 공식 배포 release 바이너리 직접 실행 또는 Go 빌드 안내 | https://help.router-for.me/introduction/quick-start |
| Codex·Gemini | 프로젝트 README에 OAuth 기반 지원을 안내 | https://github.com/router-for-me/CLIProxyAPI |
| Claude | 기술적 지원 주장과 별개로 Claude 구독 OAuth를 프록시에 전달하지 않음 | https://code.claude.com/docs/en/legal-and-compliance |
| 구독 약관 | 프록시 프로젝트 MIT 라이선스가 공급자 구독 권한을 부여하지 않음. 이번 사용에 대한 공급자 승인 확인 안 됨 | 같은 README 및 공급자 인증 문서 |
| 결정 | 설치·실행·포트 개방 없음. 공식 CLI 직접 호출만 사용 | 로컬 구현 `debate.py` |

따라서 localhost 바인딩이 필요한 프록시 자체가 실행되지 않는다. 나중에 별도 승인과 근거를 확보한 경우에도 `127.0.0.1` 한정 바인딩·관리 API 외부 차단·키 비기록을 적용해야 한다. 개인 Google/Google One의 Gemini CLI 이전 공지 때문에 Gemini CLI 프록시 연결이 적합하다고 추정하지 않는다.

공식 Claude Code를 개인의 로컬 프로그램이 직접 실행하고 본인 구독으로 인증하는 범위만 사용한다. 구독 자격 증명을 수집·대행·재판매하지 않고, Claude 바이너리·인증 메커니즘을 수정하지 않는다. 이 검토는 법률적 허가 판정이 아니다.
