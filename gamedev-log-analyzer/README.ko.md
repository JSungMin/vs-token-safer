# gamedev-log-analyzer

[English](README.md) · **한국어** · [rider-mcp-enforcer 마켓플레이스](../README.ko.md#마켓플레이스--2개-플러그인)의 일부

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![CLI](https://img.shields.io/badge/CLI-zero%20deps-1f6feb)](#claude가-사용하는-법-기본-cli)
[![npm](https://img.shields.io/npm/v/gamedev-log-analyzer)](https://www.npmjs.com/package/gamedev-log-analyzer)
[![release](https://img.shields.io/github/v/release/JSungMin/rider-mcp-enforcer)](https://github.com/JSungMin/rider-mcp-enforcer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../LICENSE)
[![Stars](https://img.shields.io/github/stars/JSungMin/rider-mcp-enforcer?style=social)](https://github.com/JSungMin/rider-mcp-enforcer/stargazers)

거대한 에디터 로그를 컨텍스트를 터뜨리지 않고 읽는 Claude Code 플러그인입니다. Unreal
`Saved/Logs/*.log`나 Unity `Editor.log`는 보통 수십 MB짜리 반복 스팸이라, `cat`이나 `grep`으로 열면
그게 전부 대화로 쏟아집니다. 이 플러그인은 로그를 대신 파싱하고 중복을 제거하고 분류합니다. IDE는
필요 없고, 순수 파일 파싱입니다.

## 왜 빠른가 (실측)

실제 Unreal 로그 측정 (프로젝트 소스 미노출):

| 작업 | raw | 이 플러그인 | 절감 |
| --- | ---: | ---: | ---: |
| 57MB UE 로그 읽기 | ~1,250,000 tok | ~2,500 tok (dedup 요약) | **~99.8%** |
| 트레이스 태그 1개 검색 (9,226 매치) | ~690,000 tok | ~1,700 tok (콜사이트 롤업) | **~99.8% (~410×)** |
| 윈도에서 결정적 스칼라 추출 | ~35,000 tok (raw dump) | ~160 tok (`log_fields`) | **~99.5%** |

핵심: raw 로그 줄을 컨텍스트에 절대 안 넣음 — dedup 그룹, 콜사이트 롤업, 또는 답을 결정하는 스칼라
컬럼만 출력.

## 무엇을 하나

- 각 줄을 `{severity, category, file:line, message}`로 **파싱** — 여러 엔진 지원(아래 지원 매트릭스),
  미인식 줄은 범용 severity-키워드 폴백.
- **템플릿 dedup:** 숫자/주소/GUID/경로/인스턴스ID 정규화 → 반복 스팸을 `×count` 한 그룹으로.
- **검색/필터:** `severityMin`·`category`·`file`·`query`; `groupBy:"callsite"`는 `file:line`별 롤업
  (로그를 뭐가 도배하는지 파악에 최적), `groupBy:"code"`는 진단 코드(`C4996`·`LNK2019`·`CS1002` …)별 롤업
  — warning 수백 개짜리 빌드를 코드당 한 줄(`C4996: … (×37)`)로 접어 grep 대신 즉시 triage.
- **`log_fields`:** dense 프레임 로그용 범용 컬럼 추출 — 선택 스칼라만 (`Key`, `Key.x|.y|.z`,
  `Key.Y|.P|.R`, `ts`, `dts`, `d:Key`, `step:Key`).
- **`log_diff`:** 두 로그 비교 후 **델타만**(신규/사라짐/카운트변경, 변경없는 그룹 생략).
- **`log_locate`:** 매칭 엔트리의 distinct `file:line` 점프 리스트(소스 열기용).
- **강제(enforcement, opt-out):** `PreToolUse` 훅이 Bash 생(raw) 로그 덤프(`grep`/`tail`/`cat`/`rg`
  로 `.log`/`.jsonl`/`Logs` 대상) **및 대용량(≥ 200 KB) 로그의 무제한 `Read`**를 가로채 이 도구로
  유도 — 토큰 절약 경로가 기본이 됨. 슬라이스 `Read`(`offset`/`limit`)는 항상 통과(막혀도 막다른 길
  없음). `warn`(기본)=허용+안내, `block`=차단+안내, `off`=해제. `gamedev-log enforce <mode>` 또는
  `GDLOG_ENFORCE`로 전환.

## 지원 로그 포맷

| 소스 | 예시 | 카테고리 | 검증 |
| --- | --- | --- | --- |
| **Unreal 런타임** | `[..][f]LogTemp: Error: msg` | `Log*` | ✅ 라이브 검증(18–57 MB 실로그) |
| **MSVC/UBT/MSBuild 컴파일** | `Foo.cpp(120): error C2065: msg` | `Build` | ✅ 라이브 검증 |
| **MSVC/UBT 링커** | `Foo.obj : error LNK2019: msg` | `Build` | ✅ 라이브 검증 |
| **Unity C# 컴파일** | `Assets/X.cs(12,34): error CS1002: msg` | `Build` | ✅ 검증(컴파일 경로 공유) |
| **Unity 런타임/스택** | `NullReferenceException …`, `(at Assets/X.cs:42)` | 범용+위치 | ⚠️ best-effort — 실 Unity 로그 **미검증** |
| **Godot** | `SCRIPT ERROR: …`, `at: f (res://x.gd:42)` | `Godot` | ⚠️ best-effort — 실 Godot 로그 **미검증** |
| **JSONL** (UE 구조화 / bunyan / pino / Serilog) | `{"ts":..,"verbosity":..,"stage":..,"message":..}` | `stage`/`logger`/`category` | ✅ 라이브 검증(실 UE `AIMovementDebug.jsonl`) |
| **Python logging** | `2024-01-02 03:04:05,123 - app - ERROR - msg` | logger 이름 | ⚠️ best-effort |
| **브래킷 레벨** | `[WARN] msg`, `[ERROR] msg` | `Log` | ⚠️ best-effort |
| **그 외** | severity 키워드(`error`/`warning`/`exception`/…) | 범용+위치 | 부분 폴백 |

**JSONL 완전 지원** (`log_fields` 포함): top-level 키(`ts` 등) + `message` 안의 `Key=value` /
`Key=(x,y,z)` 모두 추출. 즉 `{"ts":…,"stage":"Pos","message":"Pawn=A Actor=(x,y,z) Vel=…"}` 같은
프레임 트레이스를 `gamedev-log fields --category Pos --fields ts,Actor.x,Actor.y,Vel,step:Actor --window t0,t1`로 바로 처리.

> ⚠️ **Unity 심층 및 Godot 파싱은 각 엔진 공개 문서/콘솔 출력 기반 best-effort로, 실제 Unity/Godot
> 프로젝트 로그에 대해 아직 검증되지 않았습니다.** 미인식 줄은 범용 폴백으로 처리되며, 로컬 **learnings
> 원장**(`gamedev-log learnings`)이 미파싱 라인 템플릿을 보고해 실제 갭을 파서 후보로 드러냅니다.
> 파싱률이 낮으면 `summary`/`search`/`fields`가 `⚠ Only N% parsed` 한 줄도 출력 — JSONL 지원을 키운
> 바로 그 자가학습 루프(skill의 *Growing format coverage* 참고). 실 Unity/Godot 로그 샘플(sanitized)은
> 환영 — 이슈를 열어주세요.

## Claude가 사용하는 법 (기본 CLI)
Claude는 **skill**을 통해 `gamedev-log` CLI를 셸 호출합니다 — **상시 컨텍스트 비용이 없습니다**(로그가
실제로 관련될 때까지 프롬프트에 아무것도 안 올라감). "에디터 로그 확인해줘" / "뭐가 로그를 도배해?" /
"지난 실행 대비 뭐가 바뀌었어?"라고 묻거나 `/gamedev-log-analyzer:logs` 명령을 쓰면 됩니다. 내부 실행:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" <command> [--flags]
```

**명령어**(`gamedev-log <command>`): `detect`, `summary`, `search`, `fields`(`--stats`로 컬럼별
min/max/avg/Δ), `diff`, `locate`, `tail`, `learnings`, `learnings-reset`, `savings`, `savings-reset`,
`enforce`(`block`/`warn`/`off`), `setup`, `config`.

## `log-analyst` 서브에이전트

플러그인은 `gamedev-log-analyzer:log-analyst` 서브에이전트를 제공합니다. CLI를 내 컨텍스트에서 돌리는
대신 작업을 통째로 넘기면, 서브에이전트가 자기 컨텍스트에서 파싱과 읽기를 하고 답만 돌려줍니다. raw
로그 줄이 메인 컨텍스트에 들어오지 않으므로, 수십 MB 로그도 수백 토큰으로 끝나고 작업 세트도 작게
유지됩니다.

그냥 자연스럽게 물으면 Claude가 description을 보고 알아서 위임합니다:

> "`…/Saved/Logs/Editor.log` 분석해줘 — 주요 에러/경고, 빌드 경고는 코드별로 묶어서"

`gamedev-log-analyst`로 직접 부를 수도 있습니다. 알맞은 명령(`summary`/`search`/`diff`/`locate`/
`fields`/`--groupBy code`)을 골라 실행하고, dedup된 severity 그림과 열어볼 `file:line`만 답합니다.
raw 덤프는 없습니다. Node만 있으면 됩니다(CLI를 셸 호출). 아래 강제 훅은 raw `grep`이나 `Read`가
새어나갈 때를 위한 폴백입니다.

## 강제(enforcement)

`tail … | grep …`으로, 또는 `Read` 도구로 대용량 로그를 열면 생 라인이 그대로 컨텍스트에 쏟아집니다.
`PreToolUse` 훅이 두 경로를 모두 막습니다:

- **Bash**: **로그 대상**(`.log`/`.jsonl`/회전된 `.log.N`/`Logs`·`Saved/Logs` 경로)에 대한 **무제한**
  읽기(`cat`, 맨 `grep`/`rg`, `tail -f`, `tail -n +N`, 큰 `tail -n N`)를 가로챔 — 경로가 셸 변수에
  담겨 읽기와 경로가 다른 세그먼트여도(`log="….log"; cat "$log"`) 잡음. **bounded peek**(≤50줄
  `tail`/`head`(기본10), count-only `grep -c`/`rg -c`)는 **통과** — 출력이 몇 줄/숫자 1개라 폭주 아님
  (Read slice escape의 Bash판). (`.output` 같은 비-`.log`/`.jsonl` 확장자는 `Logs/` 아래가 아니면
  미매칭 — Bash size-gate 불가라 의도적.)
- **Read 도구**: 대용량(≥ 200 KB) 로그의 **무제한** 읽기를 가로챔. 슬라이스 읽기(`offset`/`limit`)는
  항상 통과 — 한 단계 escape이자 분석기가 잘 못 파싱하는 포맷의 fallback이라, 막힌 Read가 막다른 길이
  되지 않음. 작은 로그(< 200 KB)는 통과(이미 쌈).

코드 grep(`.cpp`/`.cs`/`src/…`)·비로그 읽기는 통과 — 그 도메인은 [rider-mcp-enforcer](../README.md)
담당(로그는 일부러 통과). `Grep` 도구는 건드리지 않음 — 이미 line-scoped + 결과 cap이라 컨텍스트 폭주 아님.

| 모드 | 동작 |
| --- | --- |
| `warn` *(기본)* | 명령 허용 + `gamedev-log` 대안을 모델 컨텍스트에 nudge 주입. 마찰 없이 유도. |
| `block` | 명령 차단(exit 2) + 안내. 생 읽기 **실행 안 됨**. opt-in 강제. |
| `off` | 조용히 통과 — 강제 없음. |

`warn` 기본 이유: hard-block 보장은 항상 구멍이 있었음 — `Grep` 툴·MCP 검색·`Read`가 enforcement를
완전 우회 — 그래서 기본 차단은 (로그 경로를 *언급만* 한 명령까지 막는) 마찰을 지키지도 못할 보장 위해
지불. `warn`은 유도는 유지, 마찰만 제거; hard gate 필요하면 `block` 한 명령이면 됨.

```bash
gamedev-log enforce            # 현재 모드+출처 표시
gamedev-log enforce block      # hard 차단 opt-in
gamedev-log enforce off        # 완전 해제
gamedev-log enforce warn       # 기본(nudge만)으로 복귀
GDLOG_ENFORCE=block <cmd>      # 셸 단위 오버라이드(env가 config보다 우선)
```

**투명 재작성(transparent rewrite).** 생 로그 읽기가 깔끔한 단일 명령(`grep PATTERN x.log`,
`cat x.log`, `tail -n 5000 x.log`)이면 훅은 안내에 그치지 않고 아예 gamedev-log 대응 명령으로
**바꿔서**(`grep`→`search`, `cat`/`tail`→`summary`) 실행시킵니다. 덕분에 모델의 작업 흐름은
끊기지 않으면서 출력은 파싱과 토큰 상한이 보장되죠. 파이프라인이나 셸 변수, 따옴표 묶음, 경로가
여러 개인 경우처럼 조금이라도 애매하면 재작성하지 않고 안내로 물러납니다 — 추측으로 명령을 바꾸는
일은 없습니다. 이 동작이 싫으면 `GDLOG_REWRITE=0`으로 끄세요(그러면 안내만 하거나, `enforce block`
상태면 차단합니다).

### 놓친 절감 찾기 — `gamedev-log discover`

```bash
gamedev-log discover           # 이 프로젝트: gamedev-log를 거친 로그 읽기 vs 생으로 우회한 읽기
gamedev-log discover --since 7 # 최근 7일
gamedev-log discover --all     # 전체 프로젝트(교차 집계)
```

로컬 Claude Code 트랜스크립트를 훑어서, 로그를 `gamedev-log`로 거치지 않고 생으로 읽은 횟수와
커버리지 비율을 집계로 보여줍니다. **로컬 전용**입니다 — 트랜스크립트만 읽을 뿐 어디로도 전송하지
않고, 결과로 내놓는 건 집계 수치와 대략적인 *추정* 토큰값뿐입니다. 명령이나 경로, 로그 내용은
**절대** 담기지 않습니다. (RTK의 `discover`에서 아이디어를 가져와 로그 쪽으로 범위를 좁힌 것입니다.)

모드 읽기 순서: **env `GDLOG_ENFORCE` > `~/.gamedev-log-analyzer/config.json` > 기본 `warn`**. 훅은
fail-open — 파싱/IO 오류(파일 없음·권한 거부·디렉터리·stat 불가) 시 허용(워크플로를 막지 않음).

```bash
# 직접 실행도 가능 — 스크립트/CI/임의 에이전트에서 (순수 Node, 의존성 0):
node server/cli.js detect --projectPath /path/to/UEProject
node server/cli.js search --path Editor.log --severityMin Error --groupBy callsite
node server/cli.js fields --path trace.log --fields Pawn,Alpha,ts --query Tick --max 20
node server/cli.js diff   --pathA before.log --pathB after.log --severityMin Error
node server/cli.js locate --path Editor.log --severityMin Error --basename
node server/cli.js --help
```

**로그 에러 → 소스 점프** — `locate`는 매칭 엔트리의 distinct `file:line`만(메시지 본문 없음) 출력.
[rider-mcp-enforcer](../README.ko.md)가 설치돼 있으면 각 basename을 그 플러그인의
`find_files_by_name_keyword`로 해석한 뒤 `read_file`로 해당 라인 주변만 읽음 — 전체 파일 덤프 금지.

## 선택: MCP 서버 켜기
같은 엔진([`server/logs.js`](server/logs.js) + [`server/core.js`](server/core.js))을 MCP 서버로도
돌릴 수 있습니다(타입드 `log_*` 도구, Claude Code 내 자동 발견). **기본 비활성**입니다 — 연결된 MCP
서버는 **모든** 세션 프롬프트에 툴 스키마를 주입(상시 ~1–1.5k tok)하지만 CLI는 쓰기 전엔 0이기
때문입니다. **~99% 절감은 출력 압축이라 양쪽 동일** — 차이는 상시 오버헤드뿐.

타입드 도구/구조화 인자(셸 따옴표 불요)를 원하면 켜세요:

```bash
# 1) MCP SDK 1회 설치 (CLI는 의존성 0, MCP 서버만 필요)
cd server && npm install && cd ..
# 2) 플러그인 루트에 .mcp.json 추가 후 /reload-plugins:
#    { "mcpServers": { "gamedev-log": { "command": "node",
#      "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.js"] } } }
```

도구: `log_detect`, `log_summary`, `log_search`, `log_fields`, `log_diff`, `log_tail`,
`log_learnings`, `log_learnings_reset`, `log_savings`, `log_savings_reset`, `log_setup`, `log_config`
— CLI와 byte 동일 출력.

## 사전 요구사항
- PATH에 **Node.js ≥ 18**. (Rider/Unity 설치 불필요 — 로그 파일만 읽음. 기본 CLI 경로는 **npm 의존성
  0**; 선택적 MCP 서버만 `npm install` 필요.)

## 설치
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install gamedev-log-analyzer@rider-mcp-enforcer
/reload-plugins
/gamedev-log-analyzer:logs                         # 또는 "에디터 로그 확인해줘"
```
빌드도, `npm install`도 없음 — CLI는 순수 Node. (`rider-mcp-enforcer`를 설치하면 이것도 자동으로 함께
설치됩니다.) 타입드 MCP 도구를 원하면 [선택: MCP 서버 켜기](#선택-mcp-서버-켜기) 참고.

### 독립 CLI (npm — Claude Code 불필요)
**[npm](https://www.npmjs.com/package/gamedev-log-analyzer)**에도 게시되어 스크립트/CI/타 에이전트 등
어디서나 실행 가능:
```bash
npx -p gamedev-log-analyzer gamedev-log --help
npx -p gamedev-log-analyzer gamedev-log search --path Editor.log --severityMin Error --groupBy callsite
npx -p gamedev-log-analyzer gamedev-log fields --path trace.jsonl --category Pos --fields ts,Actor.x,Vel,step:Actor
# 전역 설치 후 `gamedev-log <command>`:
npm i -g gamedev-log-analyzer
```

## 설정
설정은 `~/.gamedev-log-analyzer/config.json` (우선순위: env > config > 기본값). `gamedev-log setup …`(예:
`node server/cli.js setup --projectPath "<dir>"`) 또는 환경변수로 설정:

| env | config 키 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `GDLOG_PROJECT_PATH` | `projectPath` | — | 프로젝트 루트; UE 로그를 `<root>/Saved/Logs`(서브 1단계 포함)에서 자동탐지. |
| `GDLOG_PATH` | `logPath` | — | 명시 기본 로그 파일. |
| `GDLOG_MAX_BYTES` | `logMaxBytes` | `5000000` | 거대 로그는 마지막 N바이트만 읽음. |
| `GDLOG_MAX_GROUPS` | `maxGroups` | `40` | `log_search` 당 최대 dedup 그룹. |
| `GDLOG_MAX_LINE_CHARS` | `maxLineChars` | `200` | 표시 스니펫 최대 글자수. |

## rider-mcp-enforcer와 함께
로그 항목은 `file:line`을 담습니다. [rider-mcp-enforcer](../README.ko.md)도 설치돼 있으면 그 위치를
해당 플러그인의 `get_symbol_info`/`read_file`에 넘겨 소스로 바로 점프. [두 플러그인 함께
쓰기](../README.ko.md#두-플러그인-함께-쓰기) 참고.

## 버전 히스토리
**[Releases](https://github.com/JSungMin/rider-mcp-enforcer/releases)** 페이지 참고 — 각 `v*` 태그마다
카테고리·PR 링크 노트가 자동 생성됩니다. 상단 릴리스 배지는 항상 최신을 가리킵니다.

## 라이선스
MIT © 2026 JSungMin
