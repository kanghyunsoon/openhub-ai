# v0.2.1 알려진 문제

v0.2.1은 **아직 릴리스되지 않았습니다**. 이 문서는 v0.2.1에 들어갈 main 코드의 제한을 설명하며, 코드와 함께 갱신합니다. 공개된 v0.2.0의 문제와 수정 상태는 [v0.2.0 알려진 문제](known-issues-v0.2.0.ko.md)에, 이번 릴리스 범위는 [v0.2.1 릴리스 노트](release-notes/v0.2.1.md)(영어)에 있습니다.

## 요약

| 문제 | 상태 | 할 수 있는 일 |
| --- | --- | --- |
| Serena 신규 설치 불가 | v0.2.1 정책, 재지원은 #59 | 기존 항목은 유지하거나 직접 제거. 복구는 가능 |
| Memory MCP 신규 설치 불가 | v0.2.1 정책, 저장 경로 해결은 #69 | Client가 다시 시작하기 전에 `memory.jsonl` 백업, `MEMORY_FILE_PATH`에 절대 경로 지정. 복구는 가능 |
| Windows에서 Postgres MCP Pro 첫 Health가 시간 제한에 가까움 | 미수정, 20초 중 약 15초 측정 | Health 다시 실행 |
| 버전 고정 안 된 npx 도구(Chrome DevTools MCP, Playwright MCP)는 첫 Health에서 패키지를 내려받음 | 알려진 제한. 미측정. #70에서 추적 | Health 다시 실행 |
| v0.2.1 이전에 설치한 Context7 항목은 업데이트하기 전까지 버전이 고정되지 않음 | 의도한 동작(자동 변경 없음) | 검토된 4.1.0으로 업데이트하거나 다른 정확한 버전 선택 |
| 중단된 작업 복구는 CLI만 | v0.2.1 정책 | INSTALLED에 보이는 명령 실행 |
| Health·Benchmark 환경 제한은 sandbox가 아님 | 알려진 제한 | 아래 참고 |
| npm 설정(`.npmrc`의 `node-options`)으로 Node.js 옵션이 더해질 수 있음 | 알려진 제한, #63에서 추적 | `npm config get node-options` 확인 |
| 환경변수의 index·registry URL에 인증 정보 | Health·Benchmark가 서버를 시작하지 않음 | `uv.toml`이나 `.npmrc`로 옮기기 |
| 선언하지 않은 환경변수에 기대던 도구 | Health가 실패할 수 있음 | Manifest에 선언하거나 Client 실행에 맡기기 |
| 사용자 Registry: 일부 uvx 명령 형식 거부 | v0.2.1 정책 | 옵션을 띄어 쓰기 |
| 사용자 Registry: 고정되지 않은 uvx 도구는 소스 빌드 가능 | 알려진 제한. 고정된 도구만 준비 | 패키지와 모든 `--with` 의존성을 정확한 버전으로 고정 |
| v0.2.0에서 이어지는 제한 | Cursor·macOS 미검증, Kubernetes 0.0.67만, 설치 파일 미서명, FUSE로 직접 AppImage 실행 미검증 | 릴리스 노트 참고 |

## Serena 신규 설치 불가

- **내용:** Serena는 소스 코드로만 배포되는 의존성(`proxy-tools`)이 필요합니다. v0.2.1은 OpenHub가 검증할 수 없는 소스 빌드를 하지 않으므로 Serena를 Verified Registry에서 뺐습니다. 설치·업데이트·롤백·Health·repair·adopt·benchmark는 이 사유와 함께 거부합니다. 사용자 Registry나 이름이 다른 Manifest가 같은 패키지를 설치하려 해도 마찬가지입니다.
- **이미 Serena를 쓰는 경우:** Client 설정과 Version State는 바꾸거나 지우지 않습니다. `openhub lifecycle status`에 지원 중단 표시와 #59 링크가 나옵니다. Client는 전처럼 Serena를 실행할 수 있습니다. 즉 첫 실행 때 Client가 `proxy-tools`를 소스에서 빌드하며, 이 빌드는 OpenHub가 검토하지 않았습니다. OpenHub는 이 도구를 더 이상 관리하지 않습니다.
- **중단된 Serena 작업:** `openhub lifecycle recover serena`는 Registry 항목 없이도 동작합니다.
- **제거:** README의 수동 제거 절차를 따르세요(Client 설정 파일을 먼저 백업).
- **상태:** 재지원은 [#59](https://github.com/kanghyunsoon/openhub-ai/issues/59)에서 다룹니다. 이전 Serena 시험에서 Windows Prepare가 6번 중 1번 실패한 원인은 밝히지 못했으며, v0.2.1에서는 더 이상 쓰지 않는 경로입니다.

## Memory MCP 신규 설치 불가

- **내용:** Memory MCP는 `MEMORY_FILE_PATH`를 지정하지 않으면 npx cache 안의 패키지 폴더에 있는 `memory.jsonl`에 기억을 저장합니다. 고정되지 않은 명령에서 새 버전이 나오면 그 폴더가 바뀌면서 파일이 지워지고, 다른 버전으로 업데이트·롤백하면 이전 기억 없이 서버가 시작됩니다(둘 다 재현함). 그래서 Memory MCP를 Verified Registry에서 뺐습니다. 설치·업데이트·롤백·Health·repair·adopt·benchmark는 이 사유와 함께 거부합니다. 사용자 Registry나 이름이 다른 Manifest가 npm 패키지 `@modelcontextprotocol/server-memory`를 설치하려 해도 마찬가지입니다. 같은 `modelcontextprotocol/servers` 저장소의 다른 서버는 영향을 받지 않습니다.
- **이미 Memory MCP를 쓰는 경우:** Client 설정, Version State, 기억 파일은 바꾸거나 옮기거나 지우지 않습니다. `openhub lifecycle status`에 지원 중단 표시와 #69 링크가 나옵니다. OpenHub는 더 이상 이 서버를 실행하지 않지만 Client는 실행할 수 있고, OpenHub는 그 실행을 통제하지 않습니다. 다음 실행 전에 `memory.jsonl`을 백업하세요. 이미 지워진 파일은 OpenHub가 복구할 수 없습니다.
- **중단된 Memory MCP 작업:** `openhub lifecycle recover memory-mcp`는 Registry 항목 없이도 동작합니다.
- **기억은 직접 보호해야 합니다.** v0.2.1은 기억 파일을 옮기거나 복사하거나 보호하지 않으며, Client는 기존 설정으로 Memory MCP를 계속 시작합니다. 아무것도 하지 않으면 같은 손실이 여전히 일어날 수 있습니다. Client가 다시 시작하기 전에:
  1. 파일 찾기: `<npm cache>/_npx/<폴더>/node_modules/@modelcontextprotocol/server-memory/dist/` 아래의 `memory.jsonl`(`npm config get cache`로 npm cache 폴더 확인). 명령 형식·버전마다 폴더가 따로라 파일이 여러 개일 수 있습니다.
  2. npm cache 밖의 폴더로 복사합니다.
  3. 이 서버의 `MEMORY_FILE_PATH`에 복사본의 **절대 경로**를 지정합니다. 2026.x와 1.0.0은 절대 경로의 같은 파일을 읽고 씁니다. `~`(1.0.0 이전 버전은 확장하지 않음)나 상대 경로(버전마다 바뀌는 패키지 폴더 기준으로 해석됨)는 쓰지 마세요.
- **이미 지워진 파일:** 새 버전이나 npm cache 정리 등으로 이미 지워진 기억 파일은 OpenHub가 복구할 수 없습니다.
- **Client 항목에 `MEMORY_FILE_PATH`를 넣은 뒤:** `openhub lifecycle status`가 지원 중단 안내와 함께 `config-drift`를 표시합니다. 정상입니다. OpenHub는 이 도구를 더 이상 업데이트·repair하지 않으며 설정을 덮어쓰지 않습니다.
- **제거:** README의 수동 제거 절차를 따르세요(Client 설정 파일을 먼저 백업). Client 항목을 지워도 기억 파일은 지워지지 않습니다.
- **상태:** npm cache 밖의 안정적인 저장 경로와 승인을 거친 기존 기억 복사는 [#69](https://github.com/kanghyunsoon/openhub-ai/issues/69)에서 다룹니다.

## Windows에서 Postgres MCP Pro 첫 Health

- **증상:** 측정에서 Windows 설치 직후 첫 Health가 20초 제한 중 약 15초 걸렸습니다(Linux 약 3초). 느린 PC·디스크·네트워크에서는 `startup-timeout`으로 멈출 수 있습니다.
- **할 수 있는 일:** Health를 다시 실행하세요(INSTALLED → Health Check 또는 `openhub lifecycle health postgres-mcp`). 패키지는 설정을 쓰기 전에 준비돼 있어서 다음 실행은 더 빠릅니다(같은 측정에서 약 6.5초).
- **업데이트·롤백:** 다른 버전은 시작 시간이 따로 있습니다. 시험한 이전 버전(0.2.1)은 Windows에서 약 31초가 걸려 Health가 실패했고, OpenHub가 이전 설정과 Version State를 되돌렸습니다. 의도된 안전 동작이며 데이터 손실이 아닙니다.
- **상태:** 미수정. 20초 제한을 늘려서 감추지 않습니다.

## 버전 고정 안 된 npx 도구: 첫 Health가 패키지를 내려받음

- **대상:** Chrome DevTools MCP(`chrome-devtools-mcp@latest`), Playwright MCP(`@playwright/mcp@latest`). Registry 명령에 정확한 버전이 없어 설치 때 내려받지 않습니다(계획에 "launch-on-demand"와 `floating-artifact`가 표시됨).
- **내용:** 첫 Health(Client의 첫 실행도 같음)에서 npx가 최신 버전을 찾고 의존성과 함께 npx cache에 받은 뒤 서버를 시작합니다. 이 시간이 모두 20초 시작 제한에 들어갑니다.
- **측정:** Chrome DevTools MCP와 Playwright MCP는 **측정하지 않았습니다**. Context7도 v0.2.1에서 고정하기 전에는 같은 문제가 있었습니다. 빈 npm cache에서 첫 시작이 Windows 개발 PC 1대에서 약 15.8초, Linux에서 6.4~8.2초였고, 독립 테스트에서는 Windows 첫 Health 한 번이 약 29초 뒤 `startup-timeout`으로 멈췄습니다(재시도는 약 3초). 느린 네트워크·디스크·백신 검사는 `startup-timeout` 가능성을 높입니다.
- **v0.2.1의 Context7:** `@upstash/context7-mcp@4.1.0`으로 고정하고, 승인 뒤 Client 파일을 쓰기 전에 준비(Prepare)합니다. 그래서 첫 Health는 준비된 패키지를 실행합니다. 이전 버전으로 설치한 항목은 업데이트하기 전까지 고정되지 않은 명령을 그대로 씁니다. 업데이트 계획은 4.1.0(또는 입력한 정확한 버전)을 준비하고 Health를 실행하며, 둘 중 하나라도 실패하면 설정을 그대로 둡니다. Adopt는 검토된 명령만 받습니다. 다른 버전이나 버전 없는 항목은 편입하지 않습니다.
- **할 수 있는 일:** Health를 다시 실행하세요. 단독 Health 실패는 설정을 바꾸지 않고, 업데이트 중 Health 실패는 이전 설정과 Version State를 되돌립니다. 다음 시작부터는 받은 패키지를 쓰지만, 버전이 고정되지 않아 새 버전이 나오면 다시 받습니다.
- **상태:** 남은 고정 안 된 도구의 준비·고정 전략(계획 단계에서 정확한 버전 확정 → 승인 → Prepare → 그 버전으로 설정 기록)은 [#70](https://github.com/kanghyunsoon/openhub-ai/issues/70)에서 다룹니다. 20초 제한은 늘리지 않습니다.

## 복구는 CLI만

- Desktop 앱은 중단된 작업(`interrupted-update`)과 정확한 명령, CLI 받는 방법, 복구 후 확인 방법을 보여 주지만 직접 복구하지는 않습니다. 터미널에서 `openhub lifecycle recover <toolId>`를 실행하고 계획을 승인하세요.

## Health·Benchmark의 환경 제한

Health와 Benchmark는 허용 목록에 있는 환경변수만 MCP 서버에 넘깁니다. 셸에 있는 다른 비밀 값은 서버에 가지 않지만 다음 한계가 있습니다.

- **sandbox가 아닙니다.** 서버는 사용자 계정으로 실행되어 파일(비밀 값이 든 설정 파일 포함)을 읽고 네트워크를 쓸 수 있습니다.
- 도구를 준비할 때 쓴 패키지 출처가 이후 Health와 영구적으로 연결되지는 않습니다.
- `uv.toml`과 `.npmrc`의 내용은 승인한 계획에 포함되지 않습니다.
- npm 자체 설정인 `node-options`(사용자·전역 `.npmrc`, 또는 npx Prepare 때의 `npm_config_node_options`)는 npm이 자기가 시작하는 프로세스에 적용합니다. "실행 코드를 바꾸는 변수는 넘기지 않는다"는 규칙은 환경변수에 대한 것이라 이 경로는 막지 않습니다. 이미 사용자의 `.npmrc`나 환경을 바꿀 수 있는 사람만 쓸 수 있는 경로입니다. 직접 설정한 적이 없다면 `npm config get node-options`의 결과는 `null`이어야 합니다. [#63](https://github.com/kanghyunsoon/openhub-ai/issues/63)에서 추적합니다.
- URL 경로에 숨긴 인증 정보는 일반 경로와 구별할 수 없어 탐지하지 못합니다.
- Client(Claude Code, Codex, Cursor)가 서버를 실행할 때의 환경은 OpenHub가 아니라 Client가 정합니다.

[보안 모델](security-model.md)(영어)을 참고하세요.

## 인증 정보가 든 index·registry URL

- **증상:** 환경변수의 패키지 index·registry 설정(예: URL에 사용자와 비밀번호가 든 `UV_INDEX_URL`, `NPM_CONFIG_REGISTRY`)을 그대로 넘길 수 없어 Health나 Benchmark가 서버를 시작하지 않습니다. 공개 index로 대신 받지 않습니다.
- **할 수 있는 일:** index와 인증 정보를 `uv.toml`이나 `.npmrc`에 넣고 환경변수에서 지운 뒤 새 계획을 만드세요.

## 선언하지 않은 환경변수에 기대던 도구

- **증상:** v0.2.0에서는 Manifest에 선언되지 않은 환경변수를 읽어서 Health를 통과하던 도구가, v0.2.1에서는 그 변수를 받지 못해 Health에 실패할 수 있습니다.
- **할 수 있는 일:** Registry 도구라면 알려 주세요. Manifest에 변수를 선언하겠습니다. Client가 서버를 실행하는 방식은 바뀌지 않습니다.

## 사용자 Registry의 uvx 명령 형식

- **증상:** 사용자 Registry Manifest의 uvx 명령이 `MANIFEST_COMMAND_REJECTED`로 거부됩니다. 이유는 두 가지로 다릅니다.
  - **Manifest만으로 패키지를 식별할 수 없음:** URL, 경로, VCS, wheel·압축 파일, `--with-editable`, `--with-requirements`. uv 0.12.3의 `uvx --help`에 없는 옵션도 값을 받는지 알 수 없어 같은 이유로 거부하며, 이후 uv 버전에서 추가된 옵션은 검토 전까지 거부합니다.
  - **패키지는 식별되지만 OpenHub의 Prepare·update 처리 범위 밖인 형식:** `--from=패키지`, `--with=패키지`, `-w패키지`, `-w=패키지`, `-qw` 같은 짧은 플래그 묶음, 쉼표로 이은 `--with` 목록, `--`. uvx는 이 형식을 받고 OpenHub도 그 안의 패키지를 읽습니다(지원 중단 도구를 이렇게 써도 지원 중단으로 알아보고 거부합니다). 다만 Prepare·update·버전 확인은 띄어 쓴 옵션만 다루므로, 일부만 처리하지 않고 거부합니다.
- **할 수 있는 일:** 옵션을 띄어 쓰고 URL·경로·파일 대신 패키지 이름을 쓰세요. 예: `uvx --from package==1.2.3 --with dependency==4.5.6 command`.

## 사용자 Registry: 고정되지 않은 uvx 도구

- **내용:** 정확한 버전으로 고정된 uvx 도구(`--from package==X.Y.Z`와 모든 `--with dependency==A.B.C`)만 wheel만으로 준비하고 `--no-build`로 실행합니다. 고정되지 않은 uvx 도구는 준비하지 않고 처음 실행할 때 내려받으며, Client 설정·Health·Benchmark 모두 `--no-build`를 붙이지 않습니다. 그래서 uv가 OpenHub가 검토하지 않은 패키지를 소스에서 빌드할 수 있습니다. 설치 계획은 이를 floating artifact로 표시하고 그 승인을 따로 받습니다.
- **할 수 있는 일:** 패키지와 모든 `--with` 의존성을 정확한 버전으로 고정하세요. Verified Registry의 uvx 도구(Postgres MCP Pro)는 고정돼 있습니다.

## v0.2.0에서 이어지는 제한

- Cursor에서 도구 실행은 어떤 플랫폼에서도 검증하지 않았습니다.
- macOS는 아무것도 검증하지 않았고 공식 macOS 파일도 없습니다.
- Kubernetes MCP Server는 0.0.67만 허용합니다.
- Windows 설치 파일은 미서명이며, SmartScreen·Smart App Control 반응은 관찰하지 않았습니다.
- Linux AppImage는 압축을 풀어 시험했고, FUSE로 직접 실행하는 경우는 시험하지 않았습니다.
- Verified Registry는 7개이며 이전 목표 25~40개는 이월됩니다.
