# .codex — OpenCode-Cursor 프록시 관리 시스템

이 폴더는 OpenCode-Cursor 프록시를 **수동으로 켜고 끄거나 백그라운드 트레이 앱으로 관리**할 수 있게 해주는 보조 도구 모음입니다.

> 🚨 **중요 안내**
> 이 레포지토리(`opencode-cursor`)는 기본적으로 **OpenCode의 플러그인**으로 동작합니다. 따라서 평소에 OpenCode 안에서만 Cursor 모델을 사용하신다면 **이 도구들을 실행할 필요가 전혀 없습니다!** OpenCode가 알아서 백그라운드에서 프록시를 켜고 끕니다.
> 
> 단, OpenCode 밖에서 다른 프로그램과 연결하기 위해 **독립적인(Standalone) 프록시 서버**가 항상 떠있어야 하거나, 테스트 및 디버깅을 위해 프록시를 강제로 켜두고 싶을 때 이 `.codex` 도구들을 유용하게 사용할 수 있습니다.

---

## 1. 폴더 구조

```
.codex/
├── README.md                       ← 이 문서 (매뉴얼 + 규칙 통합)
├── config.json                     ← 프록시 설정 (포트, 경로)
├── proxy.pid                       ← 실행 중인 프록시 PID (자동 생성)
├── launchers/                      ← 더블클릭 / CLI 진입점
│   ├── opencode-cursor.bat         ← 통합 CLI 래퍼 (모든 명령어)
│   ├── start-proxy.bat             ← 더블클릭: 프록시 시작
│   ├── stop-proxy.bat              ← 더블클릭: 프록시 중지
│   ├── quick-status.bat            ← 더블클릭: 상태 확인
│   └── start-tray.vbs              ← 더블클릭: 트레이 아이콘(백그라운드) 앱 시작
└── scripts/                        ← 핵심 PowerShell 스크립트
    ├── proxy-manager.ps1           ← 프록시 생명주기 관리
    ├── proxy-manager-menu.ps1      ← 대화형 메뉴 TUI
    └── tray-app.ps1                ← 백그라운드 트레이 앱 스크립트
```

---

### 최초 1회 설정 (OpenCode 환경)

가장 먼저 터미널(명령 프롬프트 또는 PowerShell)에서 프로젝트 의존성을 설치하고 빌드합니다.
```powershell
# 1) 의존성 설치
.codex\launchers\opencode-cursor.bat install-deps

# 2) 빌드
.codex\launchers\opencode-cursor.bat build

# 3) Cursor 로그인 (브라우저에서 인증)
opencode auth login --provider cursor
```
위 과정만 끝나면 OpenCode를 켜서 Cursor 모델을 자유롭게 사용하실 수 있습니다. 프록시는 OpenCode가 알아서 구동합니다.

---

### 독립(Standalone) 모드 일상 사용

다른 곳에서 사용하기 위해 프록시를 **강제로 상시 켜두고 싶을 때** 아래 명령어들을 사용합니다.

| 작업 | 명령어 | 더블클릭 |
|------|--------|----------|
| 프록시 시작 | `opencode-cursor.bat start` | `start-proxy.bat` |
| 프록시 중지 | `opencode-cursor.bat stop` | `stop-proxy.bat` |
| 상태 확인 | `opencode-cursor.bat status` | `quick-status.bat` |
| 트레이 앱 | `opencode-cursor.bat tray` | `start-tray.vbs` |
| 재시작 | `opencode-cursor.bat restart` | — |
| 대화형 메뉴 | `opencode-cursor.bat menu` | `opencode-cursor.bat` (인자 없이) |

---

## 3. CLI 명령어 레퍼런스

```
.codex\launchers\opencode-cursor.bat <command>
```

| Command | 설명 | 관리자 권한 |
|---------|------|-------------|
| `status` | 프록시 + 인증 + 의존성 + 설정 종합 상태 | 불필요 |
| `start` | 프록시 시작 (포트 32124) | 불필요 |
| `stop` | 프록시 중지 (포트 프로세스 강제 종료) | 불필요 |
| `restart` | stop → start 순차 실행 | 불필요 |
| `tray` | 트레이 앱 (백그라운드) 시작 | 불필요 |
| `auth-status` | Cursor 인증 파일 상태 확인 | 불필요 |
| `auth-status` | 인증 파일 확인 | 불필요 |
| `build` | `bun run build` 실행 | 불필요 |
| `install-deps` | `bun install` 실행 | 불필요 |
| `menu` | 대화형 메뉴 열기 (기본값) | 불필요 |

---

## 4. 대화형 메뉴

`opencode-cursor.bat` 또는 `opencode-cursor.bat menu` 실행 시:

```
═══════════════════════════════════════════════════════
 OPENCODE-CURSOR MANAGER
═══════════════════════════════════════════════════════
  Proxy: RUNNING (port 32124)

 ── Proxy Control ──
  1. Show full status          ← 종합 상태 (프록시/인증/의존성/설정)
  2. Start proxy               ← 프록시 시작
  3. Stop proxy                ← 프록시 중지
  4. Restart proxy             ← 재시작

 ── Authentication ──
  5. Auth status / login       ← 인증 확인 + cursor-agent login 옵션

 ── Configuration ──
  6. View/create OpenCode config  ← opencode.json 보기/생성
  7. Sync models from cursor-agent ← 모델 동기화

 ── Build & Setup ──
  8. Install dependencies      ← bun install
  9. Build project             ← bun run build

 ── Help ──
  L. Show log/debug instructions ← 디버그 모드 안내
  0. Exit
```

---

## 5. Status 출력 해석

```
[ PROXY ]
  Status      : RUNNING / UNHEALTHY / STOPPED
  Port        : 32124
  PID         : 38936 (bun)          ← 프로세스 이름 포함

[ AUTH ]
  Status      : AUTHENTICATED / NOT AUTHENTICATED
  Email       : user@example.com     ← JWT에서 자동 추출
  Format      : current (cli-config.json) / legacy (auth.json)

[ DEPENDENCIES ]
  bun         : 1.3.12              ← 버전 표시
  cursor-agent: found / NOT FOUND
  node        : v24.14.1 (optional)

[ OPENCODE CONFIG ]
  Config      : found / NOT FOUND
  Provider    : cursor-acp configured / MISSING
  Plugin      : registered / MISSING
```

**상태별 의미:**
- 🟢 `RUNNING` — 프록시가 정상 동작 중 (헬스체크 통과)
- 🟡 `UNHEALTHY` — 포트는 점유되어 있으나 헬스체크 실패
- 🔴 `STOPPED` — 프록시가 실행되지 않음

---

## 6. 전제 조건 (Prerequisites)

| 도구 | 필수 여부 | 설치 방법 |
|------|-----------|-----------|
| **bun** | 필수 | https://bun.sh |
| **cursor-agent** | 필수 (인증 + 모델) | https://cursor.com |
| **node** | 선택 | https://nodejs.org |
| **OpenCode** | 필수 (최종 사용) | https://github.com/sst/opencode |

---

## 7. 인증 경로 탐색 순서

스크립트는 다음 경로를 순서대로 확인합니다:

1. `%USERPROFILE%\.cursor\cli-config.json`
2. `%USERPROFILE%\.cursor\auth.json`
3. `%USERPROFILE%\.config\cursor\cli-config.json`
4. `%USERPROFILE%\.config\cursor\auth.json`

JWT `id_token`에서 이메일을 자동 추출하여 표시합니다.

---

## 8. OpenCode 설정 (`opencode.json`)

위치: `%USERPROFILE%\.config\opencode\opencode.json`

메뉴 6번에서 자동 생성 가능합니다. 최소 필요 설정:

```json
{
  "plugin": ["@rama_nigg/open-cursor@latest"],
  "provider": {
    "cursor-acp": {
      "name": "Cursor ACP",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:32124/v1"
      },
      "models": {
        "cursor-acp/auto": { "name": "Auto" }
      }
    }
  }
}
```

전체 모델 목록은 `sync-models` 명령으로 갱신하거나, 레포 루트의 `README.md`를 참고하세요.

---

## 9. 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `STOPPED` 상태 | 프록시 미실행 | `opencode-cursor.bat start` |
| `UNHEALTHY` 상태 | 포트 충돌 또는 크래시 | `opencode-cursor.bat restart` |
| `NOT AUTHENTICATED` | 인증 파일 없음 | `opencode auth login --provider cursor` |
| `bun: NOT FOUND` | PATH에 없음 | bun 설치 후 터미널 재시작 |
| 빌드 실패 | 의존성 미설치 | `opencode-cursor.bat install-deps` 후 `build` |
| Provider MISSING | opencode.json 미설정 | 메뉴 6번으로 자동 생성 |
| 모델 없음 | 모델 미동기화 | `opencode-cursor.bat sync-models` |

### 디버그 모드

```powershell
$env:CURSOR_ACP_LOG_LEVEL = "debug"
bun run src\plugin-entry.ts
```

또는 OpenCode에서 직접:

```powershell
$env:CURSOR_ACP_LOG_LEVEL = "debug"
opencode run "test prompt" --model cursor-acp/auto
```

---

## 10. 규칙 및 주의사항

### 파일 규칙

- ❌ `config.json`의 포트 번호를 변경할 경우, BAT/PS1 스크립트의 기본값도 함께 수정해야 함
- ❌ `proxy.pid` 파일을 수동으로 편집하지 마세요 (자동 관리됨)
- ✅ `launchers/*.bat` 파일은 항상 레포 루트 (`C:\NEW PRG\opencode-cursor`)에서 실행되도록 설계됨
- ✅ 모든 `.bat` 파일은 더블클릭 시 자동으로 `pause` 후 종료

### 포트 규칙

- 기본 포트: **32124** (opencode-cursor 공식 포트)
- 포트 충돌 시 `stop` → `start` 으로 해결
- `UNHEALTHY` 상태에서 `restart` 하면 기존 프로세스를 강제 종료 후 재시작

### 프로세스 규칙

- 프록시는 **bun 프로세스**로 백그라운드 실행됨
- `stop` 명령은 포트 32124을 점유한 모든 프로세스를 강제 종료
- Windows Service가 아니므로 관리자 권한 불필요
- 시스템 재부팅 시 자동 시작되지 않음 → 수동 `start` 필요

### 보안 규칙

- 인증 파일(`.cursor/` 내 JSON)은 git에 커밋하지 마세요
- `config.json`에는 민감 정보가 포함되지 않음 (커밋 안전)

---

## 11. PowerShell 직접 실행

BAT 래퍼 없이 직접 실행:

```powershell
# 상태 확인
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action status

# 프록시 시작
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action start

# 대화형 메뉴
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager-menu.ps1"
```

---

## 12. 아키텍처 참고

```
  OpenCode
    ↓ (plugin: @rama_nigg/open-cursor)
  @ai-sdk/openai-compatible
    ↓ POST /v1/chat/completions
  open-cursor proxy (:32124)     ← 이 .codex가 관리하는 대상
    ↓ spawn per request
  cursor-agent --output-format stream-json
    ↓ HTTPS
  Cursor API
```

프록시가 OpenCode와 Cursor API 사이에서 요청을 중개합니다.
자세한 아키텍처는 레포 루트의 `README.md` 및 `docs/architecture/` 를 참고하세요.
