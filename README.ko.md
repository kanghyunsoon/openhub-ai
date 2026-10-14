# OpenHub AI

OpenHub AI는 프로젝트를 살펴보고 AI 코딩 Client(Claude Code·Codex·Cursor)에 맞는 MCP 서버를 추천한 뒤, 무엇이 바뀌는지 직접 확인·승인하면 대신 설치해 주는 데스크톱 앱(및 CLI)입니다. 설치한 서버가 실제로 시작되는지 확인하고, 업데이트·롤백하고, 무엇을 바꿨는지 보여 줍니다.

![DISCOVER·PROJECT·FOR YOU·INSTALLED 구역이 보이는 OpenHub AI 데스크톱 앱](docs/images/desktop.png)

## 다운로드

[최신 release](https://github.com/kanghyunsoon/openhub-ai/releases/latest)에서 받습니다.

| 내 컴퓨터 | 파일 |
| --- | --- |
| Windows 10/11, x64 | `OpenHub-AI-Setup-<버전>-x64.exe` |
| 데스크톱 환경이 있는 Linux x64 | `OpenHub-AI-<버전>-x86_64.AppImage` |
| macOS | 배포 파일 없음. 소스로 빌드할 수 있습니다([지원 플랫폼](docs/supported-platforms.md)). |

`SHA256SUMS`도 함께 받아 실행 전에 비교하세요. 이 비교는 받은 파일이 release 페이지에 게시된 파일과 같다는 것(전송 중 손상·바꿔치기 없음)만 보여 줍니다. `SHA256SUMS`도 같은 release 페이지에서 오므로 **누가 만들었는지 증명하지 않으며 악성코드 검사도 아닙니다**.

```powershell
# Windows(PowerShell): 출력된 hash가 SHA256SUMS의 해당 파일 줄과 같아야 합니다
Get-FileHash .\OpenHub-AI-Setup-<버전>-x64.exe -Algorithm SHA256
```

```sh
# Linux
sha256sum -c SHA256SUMS --ignore-missing
```

## 필요한 프로그램

앱 자체는 다른 프로그램이 필요 없습니다. 다만 각 MCP 서버는 미리 설치된 프로그램이 실행하므로, 실제로 설치할 도구에 필요한 프로그램만 있으면 됩니다. 아래 확인 명령은 직접 설치한 프로그램의 버전만 출력하며 MCP 서버를 실행하지 않습니다. OpenHub는 MCP 서버(제3자 코드)를 계획을 승인한 뒤에만 실행합니다(준비, Health 확인, 벤치마크).

| 설치할 도구 | 필요한 프로그램 | 확인 방법 |
| --- | --- | --- |
| Context7, Playwright MCP, Chrome DevTools MCP, MongoDB MCP Server, Kubernetes MCP Server(Memory MCP는 v0.2.0만, 아래 참고) | [Node.js](https://nodejs.org/)(npm·npx 포함) | `npx --version` |
| Postgres MCP Pro(Serena는 v0.2.0만, 아래 참고) | [uv](https://docs.astral.sh/uv/)(uvx 포함) | `uvx --version` |
| GitHub MCP Server(uv가 없을 때 Postgres MCP Pro) | [Docker](https://docs.docker.com/get-docker/), 실행 중 | `docker info` |

AI Client(Claude Code·Codex·Cursor) 중 하나도 있어야 합니다. 필요한 프로그램이 없으면 설치 계획이 어떤 backend를 찾지 못했는지 알려 주고 아무것도 바꾸지 않습니다.

## 설치

**Windows.** `OpenHub-AI-Setup-<버전>-x64.exe`를 실행합니다. 설치 파일은 **서명되지 않아** Windows SmartScreen·Smart App Control 경고("Windows의 PC 보호")가 나올 수 있습니다. 브라우저로 받은 파일이면 그 대신 또는 그와 함께 "파일 열기 - 보안 경고"(*게시자: 알 수 없는 게시자*)가 나올 수 있습니다. 서명이 없으면 게시자를 증명할 수 없습니다. 이 저장소의 release 페이지에서 직접 받았고 SHA256이 일치할 때만 실행하세요. 확신이 없으면 실행하지 마세요(CLI 패키지나 소스 빌드를 쓸 수 있습니다). Windows는 *추가 정보* → *실행*(SmartScreen) 또는 *실행*(보안 경고)을 제공하지만 이를 쓸지는 사용자 판단이며, 조직에서 막혀 있을 수 있습니다. 시작 메뉴에서 OpenHub AI를 엽니다.

**Linux.** AppImage에 실행 권한을 주고 실행합니다.

```sh
chmod +x OpenHub-AI-<버전>-x86_64.AppImage
./OpenHub-AI-<버전>-x86_64.AppImage
```

배포판에 FUSE가 없어 시작되지 않으면 `--appimage-extract-and-run`을 붙여 실행합니다.

## 처음 5분

1. **언어.** 시스템 언어가 한국어나 영어면 그 언어로 시작합니다(그 밖에는 영어). *언어*에서 언제든 바꿀 수 있고 다시 시작해도 유지됩니다.
2. **PROJECT → 프로젝트 선택.** 프로젝트 폴더를 고릅니다(홈 폴더가 아닌). OpenHub는 `package.json`·`pom.xml`·`pyproject.toml`·기존 MCP 설정 같은 파일을 읽기만 하고 프로젝트의 어떤 것도 실행하지 않습니다.
3. **FOR YOU.** 추천마다 *이유*(어떤 파일에서 어떤 기술을 찾았고 어떤 기능이 비어 있는지), Project Fit, OpenScore가 보입니다. OpenScore는 저장소 유지관리·활동성·커뮤니티 신호이며 보안·코드 품질 평가가 아닙니다. 추천이 없으면 이유(스택 미인식, 규칙 없음, 이미 사용 중, Client·OS 미지원)를 보여 줍니다.
4. **설치.** Client(Claude Code·Codex·Cursor)와 범위를 고릅니다. *Project*(기본)는 이 프로젝트의 파일만 쓰고, *User*는 홈 폴더의 파일을 써서 모든 프로젝트에 영향을 주므로 승인이 하나 더 필요합니다.
5. **계획 확인.** 정확한 실행 명령, 바뀌는 모든 파일, 다운로드, 동의할 항목이 나옵니다. 확인 대화상자에서 승인하기 전에는 아무것도 실행하지 않습니다. 계획과 실행 사이에 무언가 바뀌면 `PLAN_STALE`로 멈추고 다시 확인합니다.
6. **INSTALLED.** 도구와 버전이 보입니다. *Health Check*는 MCP 서버를 임시 폴더에서 잠깐 실행해 응답을 확인합니다. *Update*와 *이전 버전으로 롤백*도 같은 방식(계획·승인·실행·Health)입니다.

비밀값이 필요한 도구(예: `GITHUB_PERSONAL_ACCESS_TOKEN`, `DATABASE_URI`)는 계획에 변수 이름이 나옵니다. OpenHub는 값을 묻거나 읽거나 저장하지 않습니다. Client가 쓰는 환경에 직접 설정하세요.

## 내 컴퓨터에서 바뀌는 것

| 파일 | 언제 |
| --- | --- |
| 프로젝트의 `.mcp.json`(Claude Code), `.cursor/mcp.json`, `.codex/config.toml` | Project 범위 설치·업데이트·롤백·복구. 해당 서버 항목 하나만 바꾸고 다른 항목은 그대로 둡니다. JSON 파일은 들여쓰기로 다시 쓰므로 한 줄이던 파일이 여러 줄이 됩니다. 다른 항목의 내용은 바뀌지 않습니다. |
| `~/.cursor/mcp.json`, `~/.codex/config.toml` | 승인한 User 범위 설치만. `~/.claude.json`은 쓰지 않습니다. |
| `~/.openhub/state/` | OpenHub 자체 기록: Version State, 작업 기록, 잠금. |
| `~/.openhub/tool-config/` | OpenHub 관리 설정을 쓰는 도구(Kubernetes MCP Server)만. |
| npm·uv cache | 정확한 버전 도구(npx·uvx)용으로 받은 패키지. OpenHub는 cache 항목을 지우지 않습니다. |

## 문제가 생겼을 때

| 보이는 내용 | 의미와 할 일 |
| --- | --- |
| *backend not found* / *BACKEND_UNAVAILABLE* | 이 도구를 실행할 프로그램(Node.js·uv·Docker)이 없거나 PATH에 없습니다. 설치하고(필요한 프로그램 참고) OpenHub를 다시 시작한 뒤 다시 계획하세요. 바뀐 것은 없습니다. |
| `PLAN_STALE` | 승인 뒤 파일·버전·설정이 바뀌었습니다. 새 계획을 확인하고 다시 승인하세요. |
| Health 실패 | 서버가 시작되지 않았거나 시간 안에 응답하지 않았습니다. 업데이트·롤백이면 이전 설정으로 되돌리고 Version State는 바꾸지 않습니다. 필요한 환경변수, Docker 실행 여부를 확인한 뒤 다시 시도하세요. |
| *interrupted-update* | 업데이트·롤백·복구가 중간에 끝났습니다(앱 종료 등). 복구할 때까지 그 도구의 다른 작업이 막힙니다. v0.2.1부터 CLI(`openhub lifecycle recover <toolId>`)로 복구하며 INSTALLED가 정확한 명령을 보여 줍니다. v0.2.0에는 복구 명령이 없어 [v0.2.0 알려진 문제](docs/known-issues-v0.2.0.ko.md)대로 항목을 직접 고칩니다. [문제 해결](docs/troubleshooting.md)도 보세요. |
| `OPERATION_IN_PROGRESS` | 다른 OpenHub 창이나 터미널이 도구를 바꾸는 중입니다. 끝난 뒤 다시 시도하세요. |

CLI의 `openhub doctor`로 어떤 프로그램을 찾았는지 볼 수 있습니다. 자세한 내용은 [문제 해결](docs/troubleshooting.md)을 보세요.

## 도구와 OpenHub 제거

아직 제거 명령은 없습니다. OpenHub가 설치한 도구를 그만 쓰려면:

1. AI Client와 OpenHub 창을 닫습니다.
2. **먼저 설정 파일을 복사해 둡니다**(예: `.mcp.json` → `.mcp.json.bak`). 문제가 생기면 되돌릴 수 있습니다.
3. INSTALLED에 표시된 설정 파일을 열어 그 서버 항목만 지웁니다.
   - JSON 파일(`.mcp.json`, `.cursor/mcp.json`, `~/.cursor/mcp.json`): `mcpServers` 아래 `"<이름>": { … }` 멤버를 지우고 남은 멤버 사이의 쉼표를 맞춥니다. 파일이 올바른 JSON인지 확인하세요.
   - TOML 파일(`.codex/config.toml`, `~/.codex/config.toml`): `[mcp_servers.<이름>]` 머리 줄부터 다음 `[...]` 머리 줄 직전까지와, `[mcp_servers.<이름>.env]` 같은 그 서버의 하위 표만 지웁니다. 다른 `[mcp_servers.…]` 표는 건드리지 마세요.
4. OpenHub는 자체 기록을 유지하므로 INSTALLED와 `openhub lifecycle status`에 그 도구가 `missing-config`로 보입니다. 정상이며 해가 없습니다. 나중에 다시 설치하면 정상 상태로 돌아옵니다.

이 절차는 현재 코드로 확인했습니다: 다른 항목은 바이트 단위로 그대로이고, 지운 도구는 `missing-config`로 보이며, 다시 설치하면 `state-consistent`가 됩니다.

앱 제거: Windows는 *설정 → 앱 → 설치된 앱 → OpenHub AI → 제거*(또는 *제어판 → 프로그램 및 기능*), Linux는 AppImage 파일을 지웁니다. 앱을 제거해도 Client 설정 파일은 바뀌지 않습니다. OpenHub가 추가한 도구 항목은 위 절차로 지우기 전까지 남습니다. OpenHub 기록(Version State, journal, tool config)은 `~/.openhub`에 남으며, 지우려면 그 폴더를 삭제하세요. 앱 자체 데이터(브라우저 캐시와 선택한 언어)도 Windows는 `%APPDATA%\@openhub\desktop`, Linux는 `~/.config/@openhub/desktop`(`XDG_CONFIG_HOME`을 설정했다면 `$XDG_CONFIG_HOME/@openhub/desktop`)에 남습니다. 원하면 이 폴더도 지우세요. 두 폴더 모두 OpenHub AI를 닫은 뒤 지우세요.

**Windows 설정에 OpenHub AI가 보이지 않을 때.** Windows 11 테스트 PC 한 대에서, 설치된 OpenHub AI 0.2.1이 *설정 → 앱 → 설치된 앱*과 `winget list`에 보이지 않았고 한 번은 *프로그램 및 기능*에도 보이지 않았습니다. 레지스트리에는 제거 항목이 있었고, 같은 방식으로 설치된 다른 앱은 보였습니다. 원인은 아직 모르며 다른 Windows PC에서는 확인하지 않았습니다. 이때는 제거 프로그램을 직접 실행할 수 있습니다.

1. OpenHub AI를 닫습니다.
2. 설치에 등록된 제거 프로그램을 확인합니다. 아래 PowerShell 명령은 레지스트리를 읽기만 합니다.

   ```powershell
   Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
     Where-Object DisplayName -like 'OpenHub AI*' |
     Select-Object DisplayName, DisplayVersion, Publisher, UninstallString
   ```

   기본값인 "현재 사용자만"(전용) 설치라면 `%LOCALAPPDATA%\Programs\OpenHub AI\Uninstall OpenHub AI.exe`입니다. 설치할 때 다른 폴더를 골랐다면 그 폴더에 있습니다.
3. 실행하기 전에 이 설치의 제거 프로그램인지 확인합니다. `OpenHub AI.exe`와 같은 폴더에 있어야 하고, *속성 → 자세히*의 *제품 이름*이 "OpenHub AI", 버전이 설치한 버전이어야 합니다. 설치 파일처럼 서명이 없어 Windows가 *알 수 없는 게시자* 보안 경고를 띄울 수 있습니다. 다른 위치의 제거 프로그램은 실행하지 마세요.
4. 실행해 안내를 따릅니다. 파일이 지워지기까지 1~2분 걸릴 수 있습니다. 끝나면 프로그램 폴더, 시작 메뉴·바탕 화면 바로 가기, 제거 항목이 사라집니다.

제거해도 Client 설정 파일, `~/.openhub`, 위의 앱 데이터 폴더는 지워지지 않습니다.

`%LOCALAPPDATA%\@openhubdesktop-updater\installer.exe`(약 110MB)도 남습니다. 설치 프레임워크(electron-builder)가 업데이트 도구용으로 설치 파일을 그 위치에 복사해 두기 때문입니다. OpenHub는 스스로 업데이트하지 않고 이 파일을 읽지 않으며, 제거 프로그램은 이 파일을 지우지 않습니다. 공간을 비우려면 앱을 제거한 뒤 `@openhubdesktop-updater` 폴더를 지우세요. 그 전에 폴더 안에 `installer.exe`만 있는지 확인하세요. 나중에 다시 설치하면 새 사본이 만들어집니다.

## 지원 Client와 검증 범위

| Client | OpenHub가 쓰는 설정 |
| --- | --- |
| Claude Code | Project 범위(`.mcp.json`). User 범위 없음. |
| Codex | Project·User 범위. |
| Cursor | Project·User 범위. |

"설치 지원"과 "실행 검증"은 다릅니다. OpenHub는 세 Client 모두 설정을 쓰지만, *Client 설정으로* 도구를 실제 실행해 확인한 경우는 Kubernetes MCP Server의 Claude Code·Codex(Windows·Linux)뿐입니다. Cursor는 Windows·Linux에서 **검증되지 않았고**, macOS는 아무것도 검증하지 않았습니다. 앱은 설치 전에 Client·OS별 검증 수준을 보여 줍니다. 자세히: [지원 플랫폼](docs/supported-platforms.md).

Pinokio 지원은 pterm 0.0.25 기준입니다. 기본 테스트는 가짜 pinokiod를 쓰고 실제 Pinokio 연동은 OPENHUB_E2E=1일 때만 실행합니다. OpenHub는 제3자 Pinokio script를 실행하지 않고 보여 주기만 합니다.

## 알려진 문제

시작 전에 [v0.2.0 알려진 문제](docs/known-issues-v0.2.0.ko.md)를 읽어 주세요: 설치 중 프로젝트 전환, 중단된 업데이트, 새 PC의 Postgres MCP Pro, Windows에서 uvx 도구의 느린 첫 실행. 아직 릴리스하지 않은 `main` 코드의 제한은 [v0.2.1 알려진 문제](docs/known-issues-v0.2.1.ko.md)에 있습니다.

다운로드 파일은 v0.2.0입니다. 이 README는 아직 배포하지 않은 `main` 코드도 설명합니다. 차이:

| | v0.2.0(현재 release) | v0.2.1(미배포) |
| --- | --- | --- |
| 중단된 업데이트·롤백·복구 | 항목을 직접 고침(알려진 문제 참고) | `openhub lifecycle recover <toolId>`(CLI), 승인 후 복구 |
| 중단된 작업의 Desktop 안내 | 중단으로 인식하지 못함(config-drift로 보임) | 정확한 명령·CLI 받는 방법·확인 방법 |
| OpenHub 창·터미널 두 개가 동시에 도구 변경 | 기록이 사라질 수 있음 | 한 번에 하나(`OPERATION_IN_PROGRESS`) |
| Health·Benchmark가 MCP 서버에 넘기는 환경 | 내 환경 전체 | OS·경로 변수, 프록시·CA, backend 자체 설정, 도구가 선언한 변수만. 환경변수의 패키지 index·registry 설정을 그대로 넘길 수 없으면(예: 인증 정보가 든 URL) Health·Benchmark를 실행하지 않습니다. 그런 설정은 `uv.toml`·`.npmrc`에 두세요([보안 모델](docs/security-model.md)) |
| Windows에서 Postgres MCP Pro 첫 실행 | Health 시간 제한에 걸릴 수 있음 | 정확한 버전(`postgres-mcp==0.3.0`, `mcp==1.30.0`, wheel만)을 설정 쓰기 전에 준비하고, Client도 `--no-build`로 실행합니다 |
| Serena | 설치 가능. Client가 첫 실행 때 의존성(`proxy-tools`)을 소스에서 빌드 | **새 설치·업데이트·롤백·Health·repair·편입(adopt)·Benchmark를 하지 않습니다**: 그 빌드를 검증할 수 없습니다. 기존 Serena 항목과 Version State는 그대로 두고 지원 중단으로 표시하며, 중단된 작업은 복구할 수 있습니다. 원하면 [수동 제거 절차](#도구와-openhub-제거)로 지우세요. 재지원: [#59](https://github.com/kanghyunsoon/openhub-ai/issues/59) |
| Memory MCP | 설치 가능. 기본적으로 기억을 npx cache 안의 `memory.jsonl`에 저장 | **새 설치·업데이트·롤백·Health·repair·편입(adopt)·Benchmark를 하지 않습니다**: 새 버전이 나오면 그 파일이 지워지고, 다른 버전은 이전 기억 없이 시작합니다. 기존 항목, Version State, 기억 파일은 그대로 두고 지원 중단으로 표시하며, 중단된 작업은 복구할 수 있습니다. Client는 계속 실행할 수 있고 OpenHub가 파일을 보호해 주지 않으니, `memory.jsonl`을 백업하고 `MEMORY_FILE_PATH`에 npm cache 밖의 절대 경로를 지정하세요([알려진 문제](docs/known-issues-v0.2.1.ko.md)). 저장 경로 해결: [#69](https://github.com/kanghyunsoon/openhub-ai/issues/69) |
| 버전 고정 안 된 npx 도구(Context7, Chrome DevTools MCP, Playwright MCP)의 첫 Health | 20초 시작 제한 안에서 패키지를 내려받음 | 변경 없음. Context7은 빈 npm cache에서 Windows PC 1대 기준 약 15.8초, 나머지 둘은 미측정. `startup-timeout`이면 Health를 다시 실행([알려진 문제](docs/known-issues-v0.2.1.ko.md), [#70](https://github.com/kanghyunsoon/openhub-ai/issues/70)) |

## 데모

`pnpm demo`는 포함된 [데모 프로젝트](examples/demo-project/)(React + Spring Boot + PostgreSQL + Claude Code)로 전체 흐름을 보여 줍니다: Analyze → Existing tools → Recommend → Install preview → Adopt → Releases → Impact → Update preview → Discover → Benchmark preview. fixture 데이터만 쓰고 네트워크 요청·프로세스 실행이 없습니다. Install·Update·Benchmark는 계획까지만 보여 주고 데모가 승인을 거절합니다.

## 핵심 기능

- **프로젝트 분석**: manifest와 설정 파일로 언어·프레임워크·DB·인프라·AI Client를 찾습니다. 읽기만 합니다.
- **추천**: capability gap을 Project Fit 순으로, OpenScore는 따로 보여 줍니다.
- **설치**: npx·uvx·Docker backend, 필요한 설정 항목만 수정, 승인할 plan digest.
- **Lifecycle**: Version State, artifact lock, MCP Health Check, Health가 실패하면 되돌리는 업데이트, 별도 승인 롤백.
- **Adopt**: 이미 설정한 MCP 서버를 파일을 바꾸지 않고 등록합니다.
- **Release 정보**: release notes, 결정론 요약(Breaking·Security·Compatibility·Performance·Fix·Other), 업데이트 영향 판정. 선택형 AI Summary는 표시 전용입니다.
- **Discover**: New for your project·Trending·Verified Registry·Unverified Candidates. Trending은 과거 star 증가율이 아니라 현재 popularity와 최근 release·저장소 활동을 조합한 결정론 점수이며 보안·코드 품질을 평가하지 않습니다. Candidate는 UNVERIFIED 초안이고 설치·Adopt·업데이트할 수 없습니다.
- **Benchmark**: 승인 후 MCP 서버를 6번 실행해 시작·initialize·tools/list 시간을 잽니다. tool은 호출하지 않습니다.

## 동작 방식

Discover → Recommend → Install → Verify → Update → Rollback

1. **Discover**: 프로젝트 스캐너가 근거와 함께 profile을 만들고 Registry가 후보를 줍니다.
2. **Recommend**: gap을 Registry 도구와 맞추고 이유를 설명합니다.
3. **Install**: 계획에 정확한 명령·쓸 설정 파일·필요한 승인이 나옵니다. 실행 직전에 다시 만들어 무언가 바뀌었으면 `PLAN_STALE`로 멈춥니다.
4. **Verify**: Prepared·Configured·Detected 상태와 격리 임시 디렉터리의 MCP Health Check.
5. **Update**: 새 버전을 고정하고 항목을 교체한 뒤 Health가 통과할 때만 Version State를 바꿉니다. 아니면 이전 항목으로 되돌립니다.
6. **Rollback**: 별도 계획·승인으로 이전 revision으로 돌아갑니다.

## 보안과 승인 모델

- 모든 변경은 계획, 사람의 승인, 실행 직전 재확인을 거칩니다. `--yes`나 자동 승인 옵션은 없습니다.
- 명령은 shell 없이 실행합니다. 설정 수정은 대상 항목만, 원자적으로 하고 실패하면 되돌립니다.
- 비밀값은 저장하지 않습니다. 계획·결과·로그에는 환경변수 이름만 있고 값은 없습니다.
- 추천·점수·release notes·AI 요약은 정보일 뿐 승인이 아닙니다.

release 산출물에는 CycloneDX SBOM과 `SHA256SUMS`가 함께 있습니다. Syft는 Linux AppImage·CLI 패키지에서 구성 요소를 찾지 못하고 Electron app.asar 내부를 읽지 못하며, 번들된 JavaScript 의존성은 dependency SBOM이 덮습니다. Windows 실행 파일 branding(OpenHub AI) 때문에 Syft artifact inventory는 Electron 실행 파일을 Electron으로 식별하지 않을 수 있으며, Electron 버전은 dependency SBOM·실행 중 앱·공식 Electron 배포본으로 확인합니다.

[보안 모델](docs/security-model.md), [승인 모델](docs/approval-model.md), [Discovery 신뢰](docs/discovery-trust.md), [LLM 개인정보](docs/llm-privacy.md), [Release 절차](docs/release-process.md)를 보세요.

## CLI

CLI는 release의 `openhub-ai-<버전>.tgz` 파일입니다. Node.js 24.15 이상이 필요합니다.

```sh
npm install -g ./openhub-ai-<버전>.tgz
openhub --version
openhub doctor
openhub project recommend ./my-project
```

| 명령 | 하는 일 |
| --- | --- |
| `openhub project scan <path>` | 근거가 있는 프로젝트 profile |
| `openhub project recommend <path>` | 이유가 있는 추천, 설치하지 않음 |
| `openhub install <toolId>` | 설치 계획 → 승인 → 설치 |
| `openhub lifecycle status` | 설치한 도구의 Version State·drift·Health |
| `openhub update <toolId>` / `openhub rollback <toolId>` | Health Check와 함께 업데이트·롤백 |
| `openhub lifecycle health <toolId>` | 승인 후 Health Check |
| `openhub lifecycle recover <toolId>` | 중단된 작업의 복구를 확인·승인(v0.2.1부터) |
| `openhub adopt <toolId>` | 이미 설정된 도구 등록 |
| `openhub releases <toolId>` / `openhub impact <toolId>` | release notes·요약·업데이트 영향 |
| `openhub discover --view trending` | Discover 보기 |
| `openhub benchmark <toolId>` | 승인 후 시작 벤치마크, tool 호출 없음 |
| `openhub doctor` | 실행 환경·backend·Registry·Version State 확인 |

모든 옵션은 `openhub --help`로 봅니다.

## 데스크톱

네 구역입니다: **PROJECT**(폴더 선택·분석), **FOR YOU**(추천·설치 계획), **DISCOVER**(New for your project·Trending·Verified Registry·Unverified Candidates·도구 상세), **INSTALLED**(상태·업데이트·Health Check·롤백·Adopt·Benchmark·release notes·Pinokio 미리보기). 프로젝트를 고르기 전까지 짧은 안내가 보입니다. 승인은 네이티브 대화상자입니다.

## 구조

TypeScript monorepo입니다. `packages/core`에 분석·Registry·추천·설치·lifecycle·release 로직이 있고, `apps/cli`와 `apps/desktop`(Electron)은 그 위의 얇은 화면입니다. `registry/`에 검토된 Manifest가 있습니다. [Architecture](docs/architecture.md), [Roadmap](docs/roadmap.md), [specs](docs/specs/)를 보세요. 소스 빌드: `pnpm install`, `pnpm test`, `pnpm desktop`.

## 기여

코드와 Registry 기여를 환영합니다. 개발 환경·테스트·Candidate → Manifest 절차는 CONTRIBUTING.md, 취약점 신고는 SECURITY.md를 보세요.

## 라이선스

MIT. [LICENSE](LICENSE)와 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 보세요.
