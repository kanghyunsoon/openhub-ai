# OpenHub Registry

검증된 OpenHub Manifest(`REQ-001`)를 카테고리별로 보관한다(`REQ-002`).

- 위치: `registry/<category>/<name>.yaml` — 파일 이름과 `name`이 같아야 하고, 디렉터리 카테고리는 `category` 목록에 있어야 한다.
- 카테고리: mcp, skill, coding-agent, testing, browser, context, memory, security, automation, database
- 검증: `pnpm registry:validate` (CI에서도 실행)
- `verification`: 사람이 작성·리뷰한 Manifest는 `community`, Sandbox 설치 테스트(M6)를 통과하면 `verified`, AI가 만든 초안은 `draft`이며 실행 대상이 아니다(CON-005).
- 설치 기술 고유 설정은 `install` 아래에만 둔다(CON-003).
- 등록일: `registry/catalog.yaml`(Catalog Metadata v1)에 Manifest마다 `addedAt: YYYY-MM-DD | null`을 하나씩 적는다. null은 등록일 미상이며 NEW FOR YOUR PROJECT에서 빠진다. 새 Tool은 사람이 수용한 날짜를 적는다(`registry validate`가 1:1·날짜 형식·미래 날짜를 검사).
