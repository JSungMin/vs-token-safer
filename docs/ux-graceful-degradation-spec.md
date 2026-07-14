# 통합 기획서 — Graceful degradation & 자연스러운 ladder 에스컬레이션 UX

*대상: vs-token-safer server/. 목표: clangd 상태(미설치 / 콜드 / 부분·stale)에 따라 CC가 끊김 없이 tree-sitter → fuzzy → 상위 레이어로 흐르게. 모든 경로는 토큰 절약형.*

---

## 0. 원칙 (모든 변경에 적용)

1. **degrade는 항상 "지금 최선의 답 + 상위로 가는 한 수"를 같이 준다.** raw 에러나 침묵 대기 금지. 에이전트가 다음에 뭘 할지 매번 안다.
2. **토큰 절약이 degrade의 존재 이유다.** 새 경로는 (a) 본문 없는 compact `file:line`만, (b) 프로브는 예산 제한·mtime/count만(파일 본문 안 읽음), (c) 백그라운드 빌드/워밍은 크리티컬 패스 밖 → 컨텍스트로 아무 출력 안 흘림. degrade가 토큰을 더 쓰면 설계 실패.
3. **절대 블록 안 함(정확성 라벨은 함).** stale/부분도 답은 주고 인증서로만 강등. 흐름 우선.
4. **한 줄 ladder 상태로 통일.** 현재 산재한 buildHint/advisory/climb 스티어를 단일 계약으로 수렴.

---

## 1. 통합 ladder 상태 계약 (모든 시나리오 공통)

degrade하는 모든 locate 응답 끝에 **한 줄**을 붙인다:

```
[ladder: <RUNG> — <이유 3~6단어>. climb: <구체 명령 1개>]
```

- `<RUNG>` ∈ EXACT / SYNTACTIC / FUZZY / SECTION (기존 `completenessCert` 발판과 동일 어휘).
- 예:
  - `[ladder: SYNTACTIC — clangd 미설치. climb: LLVM≥22 설치 후 goto_definition]`
  - `[ladder: SYNTACTIC — clangd 콜드, 백그라운드 인덱싱 중. climb: 잠시 후 재질의하면 EXACT]`
  - `[ladder: SYNTACTIC·STALE — 빌드 후 N개 파일 변경. climb: vts index (재빌드)]`
  - `[ladder: FUZZY — 이름 미상. climb: 이름 잡히면 find_references symbol="X"]`

**구현 지점**: `core.js:1264-1302 completenessCert()`를 SSOT로 확장. 새 헬퍼 `ladderLine({rung, reason, climb})` 추가, 각 degrade 반환부에서 기존 개별 buildHint/advisory 대신 이걸 호출. `VTS_CERT=0`면 숨김(기존 스위치 재사용). **토큰**: 산재 다줄 advisory → 1줄. 순감소.

---

## 2. S1 — clangd 미설치 / unprobeable

### 현 상태 (갭)
- `backends/index.js:48` — `clangdMajor→null`이면 일부러 침묵.
- `backends/index.js:461-466 pickBackend` — 컴파일 DB/.uproject 있으면 바이너리 존재 여부 무관하게 `"clangd"` 반환.
- `lsp.js:88` — spawn 실패 시 raw `failed to spawn clangd: …`. 시맨틱 툴(goto/hover/rename/diagnostics) 하드 에러.

### 설계
1. **`clangdAvailable(cmd)` 헬퍼** (`backends/index.js`, `clangdMajor` 옆). `clangdMajor`가 이미 `--version`을 1회 캐시 probe 하므로 재활용: `available = major !== null`. spawn 전에 알 수 있음. 캐시 10s(기존과 동일).
2. **locate 툴 경로**(search_symbol/find_references/document_symbols/read_symbol): clangd DB 감지됐지만 `!clangdAvailable`이면 → **즉시 syntactic tier로 자동 fallback**(이미 degrade 경로 존재: `core.js:2658-2688`, `syntacticSymbols`). 여기에 1회성 ladder 라인:
   `[ladder: SYNTACTIC — clangd 미설치. climb: LLVM≥22 설치 / vts setup]`
   기존 `clangdCrawlLikely` 프리엠프트 게이트(`core.js:2703` 등)에 `!clangdAvailable(cmd)` OR 분기 추가 → "콜드"와 동일 프리엠프트 재사용, 새 코드 최소.
3. **시맨틱 전용 툴**(goto_definition/hover/rename/diagnostics): raw spawn 에러 대신 구조화 반환.
   `lsp.js:88` `_failAll` 직전, backend가 clangd이고 unavailable이면 friendly 메시지로 치환:
   `clangd(시맨틱)가 필요하지만 PATH에 없음. 설치: <OS별 한 줄>. 대안(구문): search_symbol / read_symbol.`
   `backends/index.js`에 `clangdMissingAdvisory(cmd)` 문자열 헬퍼.
4. **`pickBackend` 힌트**: unavailable clangd일 때, 시맨틱 요구가 아니면 backendName은 clangd 유지하되 `preferSyntactic=true` 플래그를 태워 프리엠프트가 확실히 타게(라우팅 자체는 안 바꿈 — 설치되면 자동 EXACT 복귀).

### 토큰
fallback 답 = 이미 compact syntactic `file:line`. advisory 1줄/프로세스. 시맨틱 구조화 메시지 = raw 에러와 동급 크기지만, 에이전트가 혼란→grep 재시도하는 걸 막음. 순절약.

---

## 3. S2 — clangd 세팅됨, 콜드 / 미인덱스 (120s 침묵 제거 + 자동 빌드)

### 현 상태 (갭)
- `clangdCrawlLikely`(`core.js:951-961`)가 ≤8000 TU + 컴파일 DB + (warm client 유무 무관 아님) → 중간 트리는 crawl=false.
- 결과: 첫 쿼리가 `backends/index.js:389-395 afterInit` COLD 분기에서 **최대 `VTS_LSP_INDEX_WAIT_MS`=120000ms 블록**. 진행 메시지 없음.
- 커밋 인덱스 자동 빌드 없음(넛지만: `core.js:2720 buildHint`).

### 설계 (결정: 완전 자동 `.vts-index` 백그라운드 빌드)
1. **콜드 clangd 첫 locate = 논블로킹.** `clangdCrawlLikely`에 "cold start" 분기를 확장: **warm client 없음 AND syntactic 답 가능(커밋 인덱스 or tree-sitter)** 이면 TU 수 무관 crawl=true. → syntactic 즉시 반환 + clangd는 백그라운드 워밍(afterInit 폴링은 유지, 단 크리티컬 패스에서 분리).
   - 반환에 ladder: `[ladder: SYNTACTIC — clangd 콜드, 인덱싱 중. climb: 곧 재질의 시 EXACT]`.
   - `afterInit` COLD 블록의 대기 상한을 locate 경로에서 우회(짧은 floor만 대기 후 syntactic로 답, clangd는 뒤에서 계속 준비). 시맨틱 전용 툴만 종전대로 기다림(정확성 필요).
2. **자동 `.vts-index` 백그라운드 빌드.** 커밋 인덱스 없음 + 트리 locate 발생 시:
   - 신규 `ensureAutoIndex(root)` (`symindex.js` 또는 `warmset.js`). 조건: `!hasSymIndex(root)` && 아직 이 root에 대해 빌드 안 걸림(프로세스 내 dedupe set + 디스크 락 `~/.vts-local/autoindex.lock`).
   - **detached 백그라운드**로 `vts index`(기존 빌더) 실행. stdout/stderr는 컨텍스트로 안 흘림(파일 로그만). 완료 전 쿼리는 라이브 tree-sitter로 답, 완료 후 자동으로 커밋 인덱스 서빙(기존 `syntacticSymbols` 우선순위).
   - 진행 신호: 첫 답 ladder에 `인덱스 빌드 시작됨(백그라운드)` 1회. 이후 조용.
   - 산출물은 `.vts-index/symbols.jsonl`(사용자 트리). git status에 뜰 수 있음 → ladder에 1회 `커밋하면 팀 공유: git add .vts-index` 넛지. 자동 커밋은 안 함.
   - 킬 스위치 `VTS_AUTO_INDEX=0`.
3. **불가피한 대기 시 진행 줄.** 시맨틱 툴이 정말 clangd를 기다려야 하면, 침묵 대신 `clangdIndexAdvisory`(`core.js:982-1004`) 재활용해 "clangd 인덱싱 ~N% (Ns)" 1줄.

### 토큰
논블로킹 = 120s 타임아웃 에러 + 에이전트 grep 폴백(수천 토큰) 회피. 백그라운드 빌드 출력은 컨텍스트 밖. 즉답은 compact syntactic. 큰 순절약.

---

## 4. S3 — 인덱스 존재하나 부분/stale (조용히 틀린 답 제거)

### 현 상태 (갭, 최대 정확성 리스크)
- 커밋 `.vts-index/symbols.jsonl`에 **쿼리 시점 staleness 체크 없음**. `symindex.js:508-510 loadSymIndex`는 jsonl 자체 mtime만 봄, 소스와 대조 안 함.
- 결과: 빌드 후 바뀐 파일의 stale `file:line`을 `SYNTACTIC…COMPLETE`로 자신만만하게 서빙.
- `meta.partial`(`core.js:2240`)은 time-box 빌드만, "빌드 후 변경"은 못 잡음.

### 설계 (결정: 라벨+climb만, 블록 안 함)
1. **빌드 시 freshness 스탬프 저장.** `vts index` 빌더가 매니페스트(`symindex.js:78-84,150-182`, 이미 파일별 mtime/size/hash 있음)에 트리 요약을 추가: `builtAt`(jsonl 생성 시각), `fileCount`, `maxMtime`(스캔 소스 최대 mtime). 저비용(빌드는 이미 전 파일 stat).
2. **쿼리 시점 저비용 프로브** `indexFreshness(root, meta)`:
   - 예산 제한 워크(`bigTreeLikely` `core.js:963-980`의 400ms 예산·확장자 필터 재활용) — **파일 본문 안 읽음, mtime/존재만**.
   - stale 판정: 현재 트리에 `mtime > meta.maxMtime`인 소스 존재, OR 현재 count가 `meta.fileCount`와 유의미 차이(추가/삭제). 첫 hit에서 조기 종료(전수 아님).
   - 결과 캐시(root+jsonl mtime 키, 프로세스 내) → 매 쿼리 재프로브 안 함.
3. **stale면 인증서 강등**: `completenessCert`가 `SYNTACTIC · STALE (N개 파일 변경)`, ladder `climb: vts index (재빌드)`. **답 자체는 그대로 반환.**
4. **자동 리빌드 안 함**(S3 결정). 단 S2의 `VTS_AUTO_INDEX`가 켜져 있고 stale 심각(>임계 %)이면 백그라운드 리빌드를 *선택적으로* 트리거하되 이번 답은 라벨만 — S2 자동빌드와 동일 경로 재사용, 기본은 라벨만.

### 토큰
프로브는 mtime/count만(본문 0바이트). 캐시로 반복 프로브 제거. stale 라벨 1줄이 에이전트의 "틀린 위치로 이동→재검색" 왕복(수천 토큰)을 막음. 순절약.

---

## 5. Fuzzy 구축 & 에스컬레이션 연속성 (흐름의 핵심)

### 현 상태
- EXACT→FUZZY 하강: `core.js:2794-2800 intentSteer`(멀티워드 miss 시 concept 스티어).
- FUZZY→EXACT 상승: `core.js:2422-2424`(concept hit 시 find_references/goto 스티어).
- 백엔드 degrade 경로(S1/S2/S3)는 이 사다리와 **분리**돼 있어 CC가 "clangd 죽음 → tree-sitter → fuzzy → 다시 위"를 하나의 흐름으로 못 봄.

### 설계
1. **degrade 경로도 fuzzy 하강을 잇는다.** syntactic tier(S1/S2)에서 **miss**면(선언 못 찾음) 자동으로 `intentSteer`와 동일한 concept 하강 스티어를 붙임 → "clangd 없어 tree-sitter로 봤는데 선언 없음, 이름 모르면 concept_search로".
   - ladder 체인 예: `[ladder: SYNTACTIC miss — clangd 미설치. descend: concept_search q="…"]`.
2. **fuzzy 구축 자동화.** concept 사전이 아직 없으면(첫 fuzzy 질의) `concept.js` 마이닝을 백그라운드로 준비(S2 자동빌드와 유사, 크리티컬 패스 밖). 준비 전엔 라이브 스캔으로 답.
3. **상승 재확인은 가능한 tier로.** fuzzy hit → 이름 확보 시, clangd 있으면 EXACT(goto/find_references), 없으면(S1) SYNTACTIC(search_symbol)로 상승 — climb 명령을 현재 사용 가능 backend에 맞춰 생성(`clangdAvailable` 참조).

### 토큰
스티어는 1줄. fuzzy 사전 백그라운드 마이닝은 컨텍스트 밖. 상승 명령이 정확 tier를 가리켜 헛질의 방지.

---

## 6. 신규/변경 env 플래그

| 플래그 | 기본 | 효과 |
| --- | --- | --- |
| `VTS_AUTO_INDEX` | on | 콜드/무인덱스 트리에서 `.vts-index` 백그라운드 자동 빌드 (S2/S3) |
| `VTS_LADDER_LINE` | on | 통합 ladder 상태 줄 (없으면 `VTS_CERT` 따름) |
| (재사용) `VTS_SYMBOL_PREEMPT` | on | S1/S2 syntactic 프리엠프트 마스터 |
| (재사용) `VTS_CONCEPT_STEER` | on | fuzzy 하강/상승 스티어 |
| (재사용) `VTS_LSP_INDEX_WAIT_MS` | 120000 | 시맨틱 전용 툴의 clangd 대기 상한(locate는 우회) |

---

## 7. 터치 포인트 요약 (구현 체크리스트)

- `backends/index.js`: `clangdAvailable(cmd)`, `clangdMissingAdvisory(cmd)`; `pickBackend` `preferSyntactic` 힌트; COLD `afterInit`를 locate 경로에서 우회.
- `core.js`: `ladderLine()` 헬퍼 + `completenessCert` 확장(STALE 추가); `clangdCrawlLikely`에 `!clangdAvailable` / 콜드 무조건 분기; S1/S2/S3 degrade 반환부를 ladder로 통일; syntactic-miss→concept 하강 스티어; climb 명령을 backend 가용성에 맞춰 생성.
- `symindex.js`: 매니페스트 freshness 스탬프(`builtAt/fileCount/maxMtime`); `indexFreshness(root, meta)` 프로브 + 캐시; `ensureAutoIndex(root)` detached 빌드.
- `lsp.js`: `_failAll` clangd-missing 치환(friendly + 대안).
- `warmset.js`/`hooks/prewarm.js`: 자동 인덱스/워밍 백그라운드 훅(옵션).
- `concept.js`: 첫 질의 시 사전 백그라운드 준비(옵션).

## 8. 검증 계획

- 시나리오 3종 재현 픽스처: (S1) clangd 없는 PATH + 컴파일 DB, (S2) 콜드 clangd 중간 트리, (S3) 빌드 후 소스 1개 touch.
- 각 시나리오: (a) 응답이 compact `file:line` + 올바른 ladder 라인, (b) 토큰이 grep 폴백보다 작음(`vts savings` 대조), (c) 시맨틱 툴은 friendly 메시지, (d) stale는 STALE 라벨.
- charter-safe eval 가드(90+개) 회귀 없음. 기본 플래그 off로 기존 동작 보존 확인.

---

## 9. tree-sitter를 "fallback"이 아니라 1급 즉답 tier로 (실사용서 강력함 확인)

관찰: tree-sitter tier가 실제로 매우 강력·빠르다. 그래서 clangd 부재/콜드 때만 쓰는 **폴백**이 아니라, **항상 먼저 답하고 clangd는 EXACT 업그레이드로 뒤따르는** 기본 경로로 승격한다. 사다리 방향을 "clangd 실패 → tree-sitter"에서 "**tree-sitter 즉답 → 필요 시 EXACT 상승**"으로 뒤집는다.

### 9.1 tree-sitter-first 응답 (clangd 있어도)
- locate 툴(search_symbol/find_references/document_symbols/read_symbol)에서, clangd가 **아직 warm이 아니면**(콜드/인덱싱 중) TU 수·설치 여부 무관하게 **커밋 tree-sitter 인덱스로 먼저 답한다**. clangd가 warm이 된 뒤의 재질의만 EXACT로 승격.
  - 구현: `clangdCrawlLikely`(core.js:951-961)의 "warm client 없음" 판정을 S1/S2와 공유(이미 §2·§3에서 확장). 여기에 "warm clangd + 답 일치 시에만 EXACT로 라벨" 규칙 추가.
  - ladder: `[ladder: SYNTACTIC (즉답) — clangd 워밍 중. climb: 재질의 시 EXACT 확인]`.
- **결과 일치 시 조용히 EXACT로 승격**: 백그라운드 clangd가 warm되면 동일 쿼리의 다음 답은 EXACT 인증서. tree-sitter 답과 clangd 답이 어긋나면 그때만 노트(드묾).

### 9.2 커밋 tree-sitter 인덱스 자동·상시 구축
- §3의 `ensureAutoIndex`를 clangd 유무와 **독립**으로 항상 켠다(`VTS_AUTO_INDEX` 기본 on). C/C++·C#·JS/TS·파이썬뿐 아니라 tree-sitter가 커버하는 전 언어에서 `.vts-index/symbols.jsonl`를 백그라운드 유지 → 첫 답이 clangd 콜드스타트를 안 기다림.
- 증분 재빌드: 매니페스트 mtime/hash(symindex.js:78-84,150-182) 재활용해 바뀐 파일만 재파싱. 상시 최신에 가깝게.

### 9.3 tree-sitter 선언 추출 커버리지 확대
- 현재 튜닝 언어 17/36. `defn-patterns.mjs`(qvts) 및 server tree-sitter 추출 규칙을 확장해 더 많은 언어에서 SYNTACTIC이 진짜 선언을 잡게. 우선순위: 사용 빈도 높은 미튜닝 문법부터.
- 매크로/상수/필드 등 clangd-미해석 심볼도 tree-sitter가 잡도록 규칙 보강(이미 qvts에서 `#define`/const 패턴 반영 — 서버 tree-sitter tier에도 반영).

### 9.4 tree-sitter로 더 많은 답
- `document_symbols` 아웃라인, `read_symbol` 스팬, 파일 구조 요약을 tree-sitter로 즉시 — clangd 대기 없이 "파일 구조/선언 위치" 질의를 항상 빠르게.
- SECTION tier(md/html/css/toml/yaml)도 같은 tree-sitter 엔진 — 문서/설정 질의도 1급.

### 토큰
tree-sitter 즉답 = clangd 콜드 대기(120s→타임아웃→grep 폴백 수천 토큰) 완전 회피. 커밋 인덱스는 본문 없는 compact 심볼 목록. 증분 빌드는 백그라운드(컨텍스트 밖). 커버리지 확대 = grep 폴백 빈도↓ = 순절약.

### 터치 포인트 (추가)
- `core.js`: warm-여부 기반 tree-sitter-first 게이트 + EXACT 승격 라벨 로직.
- `symindex.js`/`warmset.js`: `ensureAutoIndex` clangd-독립 상시화 + 증분 재빌드.
- `defn-patterns.mjs` / server tree-sitter 추출: 언어 커버리지·심볼종류 확대.
- 검증: tree-sitter 즉답이 clangd EXACT와 위치 일치하는지 대조 픽스처(일치율 회귀 가드).
