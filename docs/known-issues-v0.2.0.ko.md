# v0.2.0 알려진 문제

공개된 v0.2.0 릴리스에 해당하는 문제입니다. 릴리스와 첨부 파일은 바꾸지 않으며, 수정은 다음 릴리스에 들어갑니다. "main에 반영"은 수정이 병합됐지만 **아직 릴리스되지 않았다**는 뜻이고, "수정 검토 중"은 PR이 열려 있다는 뜻입니다.

[v0.2.0 릴리스 노트](release-notes/v0.2.0.md)의 기존 제한도 함께 확인하세요. Cursor 실제 실행 미검증, macOS 미검증, Kubernetes는 `kubernetes-mcp-server@0.0.67`만 허용, Windows 설치 파일 미서명입니다.

## 요약

아래 문제는 모두 공개된 v0.2.0에 있습니다. 상태는 main `5be23af`(2026-10-11) 기준이며, 아직 어떤 릴리스에도 수정이 포함되지 않았습니다.

| 문제 | 상태 | v0.2.0 우회 방법 |
| --- | --- | --- |
| 프로젝트를 바꾸는 중 설치 | main에서 수정됨(#34) | 있음 |
| 홈 폴더를 프로젝트로 사용 | main에서 수정됨(#34) | 있음 |
| 검토되지 않은 옵션이 있는 항목 Adopt | main에서 수정됨(#37) | 있음(직접 확인) |
| 업데이트 중 Health 오류 시 새 설정이 남음 | main에서 수정됨(#36) | 일부(파일 확인) |
| 손상된 `lifecycle.json`에서도 설치가 씀 | main에서 수정됨(#36) | 있음(`.bak` 복원) |
| 업데이트 중단 후 앱 안 복구 없음 | 수정 검토 중(#40), Desktop 복구 화면은 아직 없음 | 있음(직접 수정) |
| 동시 설치·업데이트 시 기록 유실 | 수정 검토 중(#38) | 있음(하나씩 실행, Adopt) |
| 새 환경에서 Postgres MCP Pro 시작 실패 | 수정 검토 중(#39) | 있음(인자 직접 수정) |
| Windows uvx 도구 첫 실행 느림 | 미수정, uvx Prepare 설계 승인(#41)·구현 대기 | 있음(Health 재실행) |

## 프로젝트를 바꾸는 중 설치(Desktop)

- **증상:** A 프로젝트 추천이 보이는 상태에서 B 프로젝트를 고르고, B 분석이 끝나기 전에 목록에서 설치하면 B 설정에 기록될 수 있습니다.
- **우회:** 새 프로젝트 분석이 끝나고 목록이 바뀐 뒤 설치하세요. 승인 대화상자에 바뀔 설정 파일이 나오니 확인한 뒤 승인하세요.
- **상태:** main에 반영(#34). 대화상자에 대상 프로젝트도 표시합니다.

## 홈 폴더를 프로젝트로 사용

- **증상:** 프로젝트 폴더가 홈 폴더(또는 그 링크)이면 Cursor·Codex 프로젝트 범위 설치가 사용자 범위 파일(`~/.cursor/mcp.json`, `~/.codex/config.toml`)을 사용자 범위 승인 없이 바꿉니다.
- **우회:** 홈 폴더를 프로젝트로 열지 마세요. 실제 프로젝트 폴더를 고르거나, 의도한 경우 사용자 범위로 설치하세요.
- **상태:** main에 반영(#34). `PROJECT_TARGET_IS_USER_CONFIG`로 차단합니다.

## Update 중단(Health 중 앱 종료·강제 종료)

- **증상:** 업데이트·롤백·복구가 중간에 끝나면 `config-drift`로 보입니다. Update·Health는 막히고, 첫 업데이트라면 Rollback 대상이 없으며, Repair는 OpenHub tool config를 쓰는 도구에만 쓸 수 있습니다.
- **우회:** `openhub lifecycle status`에 나온 설정 파일을 열어 해당 서버 항목을 그 도구의 Registry Manifest(이 저장소의 `registry/<분류>/<도구>.yaml`, `install.options.command`) 명령으로 직접 되돌리거나, 항목을 지우고 다시 설치하세요. OpenHub가 파일을 대신 바꾸지는 않습니다.
- **상태:** 수정 검토 중(#40). 작업 기록(Journal)과 `openhub lifecycle recover <도구>`를 추가합니다. 중단된 작업을 보여 주고, 승인한 경우에만, 그리고 파일이 OpenHub가 쓰던 내용과 그대로 같을 때만 이전 항목으로 되돌립니다.
- **Desktop:** Desktop 앱에는 아직 복구 화면이 없습니다. #40이 배포된 뒤에도 Desktop 사용자는 터미널에서 복구합니다. `openhub lifecycle status`로 도구가 `interrupted-update`인지 확인하고, `openhub lifecycle recover <도구>`를 실행해 계획을 읽은 뒤 승인하세요. 그 전까지는 위의 직접 수정 방법을 쓰세요.

## 설치·업데이트 동시 실행

- **증상:** CLI와 Desktop(또는 터미널 두 개)에서 동시에 도구를 바꾸면 Version State 기록 하나가 사라질 수 있습니다. 그 도구는 미관리(untracked)로 보입니다.
- **우회:** 설치·업데이트·롤백·복구·Health는 한 번에 하나만 실행하세요. 이후 미관리로 보이면 Adopt(Desktop INSTALLED 또는 `openhub adopt`)로 다시 등록하세요.
- **상태:** 수정 검토 중(#38). 한 번에 하나의 작업만 실행하고, 나머지는 `OPERATION_IN_PROGRESS`로 아무것도 바꾸지 않고 멈춥니다.

## 새 환경에서 Postgres MCP Pro가 시작하지 않음

- **증상:** uv 캐시에 이 도구가 없는 컴퓨터에서는 `postgres-mcp`가 `No module named 'mcp.server.fastmcp'` 오류로 종료합니다. Health가 실패하고 Client도 서버를 띄우지 못합니다. 패키지가 MCP SDK 2.x를 허용하는데, 2.x에서 해당 모듈 이름이 바뀌었기 때문입니다.
- **우회:** Client 설정에서 이 서버의 인자를 `--from postgres-mcp --with mcp==1.30.0 postgres-mcp --access-mode=restricted`(명령 `uvx`)로 바꾸세요. Windows에서는 그 뒤 첫 Health가 uv 설치 때문에 시간 초과될 수 있으니(아래 참고) Health를 한 번 더 실행하세요.
- **상태:** 수정 검토 중(#39).

## Windows에서 uvx 도구 첫 실행이 느림(serena, postgres-mcp)

- **증상:** Windows에서 serena나 postgres-mcp를 설치한 직후 첫 Health가 `startup-timeout`으로 멈출 수 있습니다. uv가 20초 제한 안에서 Python 패키지를 내려받아 설치하기 때문입니다. 이후 실행은 더 빠릅니다(측정: serena 약 6초, postgres-mcp 약 10초).
- **우회:** Health를 다시 실행하거나(`openhub lifecycle health <도구>` 또는 Desktop 버튼), Client를 한 번 시작해 서버가 뜰 때까지 기다리세요.
- **상태:** 미수정. uvx Prepare 설계 승인(#41), 구현 대기. 측정에서 Linux는 제한 안이었습니다.

## 추가 옵션이 있는 항목을 Adopt한 경우

- **증상:** v0.2.0 Adopt는 기존 설정 항목의 패키지가 Registry와 같으면, Registry가 검토하지 않은 옵션이 있어도 등록합니다. 예를 들어 다른 패키지 저장소를 쓰거나, `--readOnly`·`--read-only`가 빠졌거나, `--access-mode=unrestricted`인 경우입니다. 그러면 OpenHub가 그 항목을 관리 대상으로 표시합니다.
- **우회:** v0.2.0에서 Adopt한 항목이 있다면 명령과 인자를 그 도구의 Registry Manifest(`registry/<분류>/<도구>.yaml`, `install.options.command`)와 비교하세요. 다르면 항목을 지우고 OpenHub로 다시 설치하거나, 직접 관리하세요.
- **상태:** main에 반영(#37). Adopt는 검토된 인자와 같을 때만 등록합니다.

## 그 밖에 v0.2.0에서 발견된 문제

- **업데이트 중 Health 오류**(예: 임시 폴더 생성 실패): 평소의 원상 복구 없이 새 설정이 남을 수 있습니다. 업데이트가 결과 대신 오류로 끝나면 파일을 확인하세요. main에서 수정됨(#36): 설정을 되돌리고, Registry Manifest를 읽지 못하면 Health 자체를 실행하지 않습니다.
- **손상된 `~/.openhub/state/lifecycle.json`**: 설치는 Client 설정을 쓰지만 기록하지 못해 미관리로 보입니다. `lifecycle.json.bak`이 정상이면 그것으로 복원하세요. main에서 수정됨(#36): 파일을 읽을 수 있을 때까지 설치를 거부합니다.

