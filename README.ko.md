# vs-token-safer · gamedev-log-analyzer

[English](README.md) · **한국어**

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![MCP](https://img.shields.io/badge/MCP-server-1f6feb)](https://modelcontextprotocol.io)
[![release](https://img.shields.io/github/v/release/JSungMin/vs-token-safer)](https://github.com/JSungMin/vs-token-safer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/JSungMin/vs-token-safer/pulls)
[![Stars](https://img.shields.io/github/stars/JSungMin/vs-token-safer?style=social)](https://github.com/JSungMin/vs-token-safer/stargazers)

> 대형 Unreal C++ · Visual Studio · .NET 프로젝트용 Claude Code 플러그인 두 개. 코드베이스는 `grep`
> 대신 공식 언어 서버 인덱스(clangd / Roslyn)로 검색하고, 수십 MB짜리 에디터 로그는 대화에 통째로
> 쏟지 않고 읽습니다. 둘 다 토큰을 약 99% 적게 씁니다. **로컬 전용, IDE 불필요.**

### 실제 모습
```text
# Claude가 코드를 grep 시도 → 훅이 그 자리에서 인덱스 쿼리로 재작성:
$ grep -rn "SpawnActor" Source/**/*.cpp
↻ [vs-token-safer] 재라우팅 → search_symbol "SpawnActor"   # 텍스트 매치가 아닌 의미 기반
  func SpawnActor (in AGameMode)   @ Source/GameMode.cpp:142   (+2 more)
  → ~120 토큰   (grep이면 수천 줄 덤프)
# 막다른 길 없음: 검색은 인덱스를 통해 그대로 실행됨. 차단을 원하면 VTS_REWRITE=0.

# 1MB 에디터 로그 → 파싱·dedup·분류 (동봉된 gamedev-log-analyzer):
▶ /gamedev-log-analyzer:logs
  41,233줄 · 에러 7 · 경고 312
  ERROR   [LogStreaming] Failed to load asset <addr>         (×128)   @ AssetManager.cpp:210
  WARNING [LogPhysics]   Penetration depth <n> exceeds limit (×4,051) @ MyComponent.cpp:88
  → ~130 토큰   (raw 로그 ≈ 267,000)
```
<sub>공개 Unreal Engine 심볼을 쓴 예시 출력.</sub>

### 이런 경험 있나요?
- 🔍 거대 Unreal C++ / .NET repo에서 `grep`이 컨텍스트를 폭발시킴 → clangd/Roslyn 인덱스로 검색하면 토큰 상한 (**~97–99% 절감**, [벤치마크](#성능-실측)).
- 🪵 50MB 에디터 로그는 그대로는 못 읽음 → 파싱하고 dedup하고 분류하면 수백 토큰으로 줄어듦.
- 🤖 Claude가 자꾸 코드를 `grep` → 훅이 차단만 하지 않고 **그 자리에서 인덱스 쿼리로 재작성**하니 검색은 그대로 실행되고 흐름이 안 끊김.
- 📊 grep이 얼마나 새고 있는지 안 보임 → `vts discover`가 최근 세션을 읽어 인덱스를 우회한 검색과 그 토큰 비용을 정확히 보여줌.
- 🖥️ IDE 프록시 방식과 달리 언어 서버를 헤드리스로 실행하니 에디터를 열 필요가 없음.

### 목차
- [마켓플레이스 — 2개 플러그인](#마켓플레이스--2개-플러그인) · [합산 절감](#합산-토큰-절감-실측) · [두 플러그인 함께 쓰기](#두-플러그인-함께-쓰기)
- [무엇을 하나](#무엇을-하나) · [성능](#성능-실측) · [사전 인덱싱과 hit-rate](#사전-인덱싱pre-warm과-hit-rate)
- [사전 요구사항](#사전-요구사항) · [설치](#설치) · [설정](#설정-명령어) · [업데이트](#새-버전으로-업데이트)
- [설정 항목](#설정-항목-env) · [문제 해결](#문제-해결) · [상태 / 주의](#상태--주의) · [기여](#기여) · [Releases](https://github.com/JSungMin/vs-token-safer/releases)

---

Claude가 Bash `grep` 대신 공식 언어 서버 인덱스로 심볼 검색, 참조(references) 찾기, 정의로 이동을 하게
만드는 Claude Code 플러그인입니다(C/C++은 **clangd**(LLVM), C#/.NET은 Roslyn 기반 LSP
`Microsoft.CodeAnalysis.LanguageServer`(Visual Studio / C# Dev Kit 엔진), JS/TS는
**typescript-language-server**(tsserver), Python은 **pyright**). hover, 파일 아웃라인, 프로젝트 전역
rename도 같은 인덱스로 처리합니다. 검색이 폭발할 때는 간결한 `file:line` 목록(소스 본문 없음)만 반환해
토큰을 상한선으로 막습니다. `grep`이 느리고 컨텍스트를 잡아먹는 대형 Unreal C++ 및 .NET/C# 코드베이스를
위해 만들었습니다. JS/Python 백엔드 덕분에 플러그인이 자기 소스도 검색할 수 있어, 개발하면서 직접
dogfood합니다.

[rider-mcp-enforcer](https://github.com/JSungMin/rider-mcp-enforcer)의 IDE 비종속 형제 프로젝트입니다.
토큰 효율 목표는 같지만 실행 중인 IDE의 MCP 서버를 프록시하지 않고 공식 언어 서버를 헤드리스로
실행합니다. 그래서 에디터를 열지 않아도 Visual Studio나 임의의 C++·C# 프로젝트에서 동작합니다.

## 마켓플레이스 — 2개 플러그인

이 repo는 **"큰 것을 싸게 읽는다"** 는 한 가지 목표를 공유하는 플러그인 두 개가 든 Claude Code
플러그인 마켓플레이스입니다:

| 플러그인 | 기능 | 필요 |
| --- | --- | --- |
| **vs-token-safer** (이 페이지) | 코드 검색을 grep 대신 clangd/Roslyn/tsserver/pyright 인덱스로 강제(기본 하드 차단, 탈출구 opt-out), `file:line`으로 토큰 캡 | Node + 언어 서버: clangd / Roslyn(직접 설치), JS/TS + Python(자동 설치). IDE 불필요. |
| **[gamedev-log-analyzer](gamedev-log-analyzer/README.ko.md)** | 거대 Unreal/Unity/Godot/MSVC-UBT-MSBuild 로그 파싱·dedup·분류·검색·diff·locate·스칼라 추출 (CLI 우선) | Node만 (IDE 불필요) |

**한 번에 설치.** `vs-token-safer`가 `gamedev-log-analyzer`를 의존성으로 선언하므로 한 번 설치하면 둘
다 깔립니다. 각 서버의 `npm install`은 첫 세션에 자동 실행되니 수동 설정은 없습니다:
```bash
/plugin marketplace add JSungMin/vs-token-safer
/plugin install vs-token-safer@vs-token-safer        # gamedev-log-analyzer도 자동 설치
/reload-plugins                                       # 첫 실행 시 둘 다 의존성 자동 설치
```
로그 분석기만 원하면 단독 설치: `/plugin install gamedev-log-analyzer@vs-token-safer`.

### 합산 토큰 절감 (실측)
| 작업 | Bash / raw | 플러그인 | 절감 |
| --- | ---: | ---: | ---: |
| 실제 UE5 repo 심볼 검색 (`FGameplayTag`) | ~282,194 tok | ~2,048 tok | **~99.3% (~138×)** |
| raw 인덱스 응답 → 캡된 목록 (eval, 심볼 1,000개) | ~57,308 tok | ~1,515 tok | **~97.4%** |
| ~1MB 에디터 로그 읽기 (`summary`) | ~267,000 tok | ~130 tok | **~99.95%** |

### 두 플러그인 함께 쓰기
로그 분석기는 각 항목의 `file:line`을 출력하고 vs-token-safer는 그 `file:line`을 실제 심볼/소스로
바꿉니다. 전형적인 흐름은 이렇습니다:
1. `/gamedev-log-analyzer:logs` → 에러/경고와 그 `file:line` 찾기.
2. 그 위치를 vs-token-safer의 `goto_definition`/`find_references`(또는 `search_symbol`)에 넘겨 코드를
   엽니다. raw 로그를 grep하거나 덤프하지 않고요.

역방향도 동작합니다: 코드 검색(vs-search 도구나 Bash/Grep 검색)이 로그를 겨냥하면 — `Logs/` 디렉터리나
`.log`/`.jsonl` 파일 — vs-token-safer가 코드 인덱스에서 빈 결과를 주는 대신 gamedev-log로 안내합니다.
언어 서버 인덱스는 소스를 다루지 로그를 다루지 않으니까요.

## 무엇을 하나

clangd와 Roslyn은 그 자체로 이미 의미 기반 심볼/참조 분석을 합니다. 이 플러그인이 그 위에 더하는 건
강제, 토큰 캡, 헤드리스 실행 + warm-up입니다. Claude가 grep 대신 인덱스를 실제로 쓰게 만들죠:

| 레이어 | 파일 | 효과 |
| --- | --- | --- |
| **재작성/강제 훅(hook)** | `hooks/block-code-grep.js` | 소스 파일(`.c/.cc/.cpp/.h/.hpp/.cs/.ts/.py`…, 또는 `src/`·`source/`·`engine/`·`plugins/`) 대상 Bash `grep`/`rg`/`ack`/`ag`/`findstr`/`git grep` 및 `find -name`을 가로채, 명령이 단일 안전 세그먼트면 **그 자리에서 동등한 `vts` 쿼리로 재작성**합니다(식별자 → 의미 기반 `search_symbol`, 리터럴 → `search_text`, `find -name` → `find_files`). 모델 흐름이 안 끊기고 출력은 항상 토큰 캡입니다. 모호하면(파이프라인, 비리터럴 패턴) 하드 차단으로 폴백. 정밀합니다: 세그먼트의 실제 실행 파일이 검색 도구일 때만 발동하고, 원시 텍스트 검색(로그·`.md`·`.json`·설정·build 디렉터리)은 통과시킵니다. `VTS_REWRITE=0` → 재작성 대신 차단, `excludeCommands`로 특정 명령 제외, `VTS_ENFORCE=0`으로 비활성화. |
| **라우팅 스킬** | `skills/vs-search/SKILL.md` | Claude가 인덱스 도구를 먼저 쓰도록 유도하는 규칙입니다. 심볼/참조/정의 검색은 `search_symbol`/`find_references`/`goto_definition`로 가고, grep은 최후수단입니다. |
| **토큰 캡 코어** | `server/core.js` | 두 어댑터가 공유하는 `runTool()`. LSP 결과를 `kind name (in container) @ file:line`으로 바꾸고 `maxResults`로 상한을 걸고 `… N more` 푸터를 붙입니다. range/kind/소스 본문은 절대 넣지 않습니다. 잘린 `find_files`/`search_text`는 전체 결과를 복구(tee) 파일로 써서 조용히 누락되지 않게 합니다. |
| **절감 + discover** | `server/core.js` | 로컬 원장이 검색마다 절감 토큰을 기록하고(`vts savings`의 30일 그래프·일별/이력·추정 가치), `vts discover`는 최근 Claude 세션에서 인덱스를 *우회한* 코드 검색과 그 토큰 비용을 보고합니다 — 성공만이 아니라 catch-rate가 보입니다. |
| **헤드리스 LSP 클라이언트** | `server/lsp.js` + `server/backends/index.js` | 완전 자체 구현 LSP 클라이언트(JSON-RPC 2.0, `Content-Length` 프레이밍)가 공식 엔진을 stdio로 실행합니다. 실행 설정, `pickBackend(root)` 자동 감지, IDE식 pre-warm(`afterInit`)을 포함합니다. |

> **엔진은 공식, 글루는 우리 것.** 분석은 clangd(LLVM)·Roslyn(Microsoft)이 하고, 이 저장소는
> LSP↔MCP 글루만 작성합니다. 소스 위에서 서드파티 MCP 서버가 돌지 않습니다.

> **쓸수록 좋아집니다.** 조각들이 피드백 루프로 결합합니다: 재작성이 식별자를 *의미 기반* `search_symbol`로
> 보내고(단순 텍스트 grep이 아님), `vts discover --learn`이 과거 검색이 실제로 맞춘 파일들을 warm-up 세트에
> 넣어 다음 세션이 미리 열게 하며, `discover`가 catch-rate를 보고해 무엇이 아직 새는지 알려줍니다. 세션마다
> 인덱스는 더 따뜻해지고 강제는 더 촘촘해집니다.

### 명령어 & 도구
- `/vs-token-safer:setup` — 플러그인 설정 ([설정](#설정-명령어) 참고).
- `/vs-token-safer:savings` — 누적 토큰 절감량 표시.
- MCP 도구(서버 `vs-search`): `search_symbol`, `find_references`, `goto_definition`, `hover`,
  `document_symbols`, `rename`, `find_files`, `search_text`, `vts_warmup`, `vts_setup`, `vts_config`,
  `vts_savings`, `vts_savings_reset`, `vts_discover`. `find_files`와 `search_text`는 심볼이 아니라 파일명이나
  raw 텍스트가 필요할 때 쓰는 `find -name`·`grep`의 토큰캡 대체입니다. `rename`은 프로젝트 전역 의미 기반 이름
  변경으로, 기본은 미리보기이고 `apply=true`일 때만 편집을 기록합니다. `vts_discover`는 인덱스를 우회한 코드
  검색(놓친 절감)을 찾고, `learn=true`면 그 결과 파일을 warm-up 세트에 넣습니다.
- CLI (`vts`): `symbol`, `references`, `definition`, `hover`, `symbols`, `rename`, `files`, `text`,
  `warmup`, `setup`, `config`, `savings`(`--graph`/`--daily`/`--history`), `savings-reset`,
  `discover`(`--since N`/`--all`/`--learn`).
- "X가 어디 / Y를 누가 호출 / W 파일 찾기" 같은 조회는 `code-locator` 서브에이전트에 통째로 맡기세요.
  자기 컨텍스트에서 검색하고 `file:line` 표만 돌려줍니다.

```
$ vts symbol --q SpawnActor --projectPath ./MyGame
3 symbol(s) matching "SpawnActor" (backend: clangd, root: ./MyGame):
func SpawnActor (in AGameMode)  @ MyGame/Source/GameMode.cpp:142
method SpawnActorDeferred (in UWorld)  @ MyGame/Source/World.cpp:88
func SpawnActorFromClass  @ MyGame/Source/SpawnLib.cpp:31

✓ Saved ~4,200 tokens here (96.8% / 31× smaller than the raw index response).
```

## 성능 (실측)

대형 Unreal Engine 5 프로젝트에서 공개 엔진 심볼 한 개(`FGameplayTag`)를 Bash grep-and-paste vs 이
플러그인으로 찾은 실측 A/B입니다. 프로젝트 소스는 공개하지 않고 집계 수치만 씁니다. 방법은
[BENCHMARK.md](BENCHMARK.md)를 참고하세요.

| | Bash grep-and-paste (전체 repo) | **플러그인 (clangd 인덱스, 캡)** |
| --- | ---: | ---: |
| 모델이 받는 것 | 5,654줄 / 1,010 파일 | 47개 의미 기반 선언 (`file:line`) |
| 모델로 가는 토큰 | ~282,194 | **~2,048** |

- **토큰: ~99.3% 절감 (~138×).** grep은 매칭 줄의 전체 텍스트를 반환하고, 텍스트로 매칭하니 더 많은
  줄(주석, 문자열, 무관한 식별자)을 끌어옵니다. 플러그인은 의미 기반 히트당 `file:line` 하나만, 그것도
  캡해서 반환합니다.
- 목-LSP eval(`node eval/run.mjs`, 툴체인 불필요)이 매 커밋 응답 정형화 절감을 게이트합니다: raw 인덱스
  `~57,308 tok` → 캡된 출력 `~1,515 tok` = **97.4%** (체크 32/32).

### 정확도 차이와 그 이유
"누가 더 맞다"가 아니라 정밀도/재현율 트레이드오프입니다:
- **재현율:** 플러그인은 모든 텍스트 occurrence가 아니라 상위 `N`개(cap)만 반환합니다. 빠진 꼬리는
  대부분 주석, include, 부분문자열 노이즈입니다. 전수가 필요하면 `maxResults`를 올리거나 grep을 쓰세요.
- **정밀도:** grep은 모든 부분문자열을 매칭하므로(`Foo` 검색이 `FooBar`도 매칭) 과다보고합니다. 인덱스는
  distinct한 의미 기반 선언을 반환합니다. `search_symbol`은 심볼 인덱스 질의이고
  `find_references`/`goto_definition`은 텍스트 매치가 아니라 위치의 심볼을 해석합니다.

> 정리하면 탐색(정의 + 대표 사용처) 용도에는 플러그인이 더 정확하고 훨씬 저렴합니다. 전수 감사라면 cap을
> 올리거나 일부러 grep을 쓰세요.

## 사전 인덱싱(pre-warm)과 hit-rate

clangd는 비동기로 인덱싱하므로 서버 기동 후 *첫* 검색은 1회 warm-up 비용(엔진 헤더 인덱싱)을 치릅니다.
vts는 이를 IDE처럼 처리합니다.

- **MCP 서버가 기동 시 pre-warm** (`VTS_PREWARM`, `projectPath` 설정 시 기본 on). 첫 검색 시점엔 이미
  인덱스가 데워지는 중이고 클라이언트는 서버 수명 동안 캐시됩니다. 그래서 warm-up은 쿼리마다가 아니라
  **세션당 1회**입니다(이후 검색은 sub-초).
- **`vts warmup`**. CLI/CI용으로 clangd 온디스크 인덱스(`.cache/clangd`)를 미리 구축합니다.
- **`VTS_CLANGD_REMOTE`**. clangd를 공유/사전구축 clangd-index-server로 연결하면 개발자별 warm-up이
  ~0이 됩니다(팀/CI가 사전구축 인덱스 하나를 질의).

무엇을 먼저 데우느냐가 중요합니다. clangd는 열린 파일의 인덱싱 우선순위를 높이므로 vts는 warm-up
대상을 곧 검색할 것 우선으로 정렬합니다. 순서는 **쿼리 이력**(과거 검색이 반환한 파일), **지금 편집
중**(`git status` 수정/미추적 + Perforce `p4 opened`), **git 커밋 최근성**, **include 중심성**(여러
후보가 `#include`하는 헤더. 적응형이라 영속 include-그래프 캐시를 매 warm-up마다 시간예산만큼 채워
커버리지가 회차에 걸쳐 늘어남), 그리고 mtime입니다. 거대한 트리에선 일부(언리얼의 수만 TU 중 수백
개)만 데울 수 있으니, 이 정렬이 warm 윈도가 실제 검색 대상을 포함하게 만드는 핵심입니다. git과
Perforce 모두 지원합니다.

측정된 향상 (`node eval/bench-hitrate.mjs`, 실제 `orderForWarm()`, 현실적 locality 합성 워크로드, 2,000 파일):

| warm-up cap | 임의 순서 | 이력 기반 정렬 | 향상 |
| --- | --- | --- | --- |
| 파일의 3% | 1.5% | **54.3%** | **36×** |
| 5% | 7.8% | **56.5%** | 7.3× |
| 10% | 11.3% | **62.5%** | 5.6× |
| 20% | 24.8% | **68.5%** | 2.8× |
| 50% | 46.3% | **80.5%** | 1.7× |

데울 수 있는 비율이 작을수록 효과가 큽니다. 임의 순서는 거의 못 맞히고, 정렬은 대부분을 맞힙니다.

## 얼마나 절약했나? (토큰 절감 명령어)

코어는 검색마다 언어 서버 raw 인덱스 응답 대비 절약한 토큰을 기록합니다. 누적 합계는 이렇게 확인합니다:

- **Claude Code에서:** `/vs-token-safer:savings` 실행 (또는 "플러그인이 얼마나 아꼈어?"라고 질문).
  `vts_savings` MCP 도구를 호출합니다.
- **셸에서:** `vts savings`
- **리셋:** `vts_savings_reset` 도구 호출 (또는 `vts savings-reset`).

출력 예시:
```
vs-token-safer savings (local, 1 search(es))
  total saved: ~4,200 tokens vs forwarding raw index responses
  raw → output: 4,340 → 140 tok (~31× smaller)
  biggest single run: 4,340 → 140 tok
  est. value: ~$0.01 (@ $3/Mtok — rough, set VTS_USD_PER_MTOK)
```
`vts savings --graph`는 30일 ASCII 절감 그래프를, `--daily`·`--history`는 일별·최근 실행별 분석을 추가합니다.
이건 *잡은* 쪽입니다. *놓친* 쪽은 `vts discover`가 최근 Claude 세션에서 인덱스를 우회한 코드 검색과 그 비용을
스캔해 보여줍니다 — 둘을 합치면 막연한 총합이 아니라 catch-rate가 나옵니다:
```
$ vts discover --since 7
vs-token-safer discover — missed token savings (local scan, last 7 day(s), 9 transcript(s))
  314 code search(es) bypassed vts (Grep×261, grep×43, find×9, findstr×1)
  raw tool output ingested: ~129,052 tok — routed through vts most of this is avoidable
  catch-rate: ~681,036 tok caught (via vts) vs ~129,052 still bypassing → 84.1% routed through vts
```
> 여기서 "saved"는 언어 서버의 *raw* 인덱스 응답을 기준으로 합니다. Bash grep 대비 절감은 보통 훨씬
> 큽니다. [BENCHMARK.md](BENCHMARK.md)를 참고하세요. `discover`는 로컬·읽기 전용입니다 — 대화 기록
> 메타데이터와 도구 입출력 크기만 읽고, 어떤 것도 외부로 보내지 않습니다.

## 사전 요구사항

- PATH에 **Node.js ≥ 18**.
- 검색할 언어의 언어 서버:
  - **C/C++ → clangd ≥ 22** ([clangd 릴리스](https://github.com/clangd/clangd/releases)). Visual
    Studio에 동봉된 clangd 19.1.x(`…/VC/Tools/Llvm/bin/clangd.exe`)는 실제 Unreal TU를 서버 모드에서
    인덱싱할 때 **데드락**합니다. vts가 오래된 버전을 감지하면 경고합니다. `compile_commands.json`
    컴파일 DB가 필요합니다.
  - **C#/.NET → Roslyn LSP.** VS Code C# 확장(`ms-dotnettools.csharp`)을 설치하면 vts가 번들에서
    `Microsoft.CodeAnalysis.LanguageServer`와 그 전용 .NET 런타임을 자동 감지합니다. 폴백은
    `dotnet tool install --global csharp-ls`. `.sln`/`.csproj`가 필요합니다.
  - **JS/TS → typescript-language-server, Python → pyright.** 플러그인 의존성으로 동봉되어 첫 세션에
    자동 설치됩니다 — 따로 할 일 없습니다. vts가 번들 복사본을 `node`로 실행하니 전역 설치나 PATH 설정이
    필요 없습니다. 원하면 `VTS_TS_CMD`/`VTS_PY_CMD`로 직접 지정하세요. (참고: 동봉으로 첫 실행 `npm
    install`에 1회 ~50MB가 추가되고, JS/TS 서버는 **Node 20+**를 권장합니다 — Node 18에서는 건너뛰며
    나머지 백엔드는 정상 동작합니다.)
- IDE는 실행 중이지 않아도 됩니다.

clangd는 컴파일 DB(`compile_commands.json`)가 필요합니다:
- **Unreal Engine:** UBT로 생성합니다. `<UE>/Engine/Build/BatchFiles/RunUBT … -mode=GenerateClangDatabase`.
  타겟이 clang-cl로 빌드되면 **`-Compiler=VisualCpp`**를 추가하세요. 안 그러면
  `GenerateClangDatabase`가 clang 툴체인 검증에 실패합니다(`Unable to find valid C++ toolchain for
  Clang x64`). MSVC-컴파일러 DB도 clangd용 전체 엔진 include 그래프를 해석합니다.
- **CMake:** `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`로 구성.

## 설치

```bash
# 1) 마켓플레이스 추가 + 설치 (gamedev-log-analyzer도 자동 설치)
/plugin marketplace add JSungMin/vs-token-safer
/plugin install vs-token-safer@vs-token-safer
/reload-plugins        # 첫 실행 시 서버 의존성 자동 설치 (수동 npm 불필요)

# 2) 설정 — Claude Code 안에서 그냥 실행:
/vs-token-safer:setup
#   백엔드를 감지하고, 프로젝트 경로를 물어본 뒤 config를 기록합니다.
```

`vs-search` MCP 서버와 도구들이 보이는지, `grep src/**/*.cpp`이 인덱스 도구 유도와 함께 차단되는지
(또는 `VTS_ENFORCE=0`이면 자유롭게 실행되는지) 확인하세요. MCP 서버의 의존성 하나
(`@modelcontextprotocol/sdk`)는 첫 세션에 플러그인 데이터 디렉터리로 자동 설치됩니다.

### 독립 CLI로 (IDE·Claude Code 불필요)

vs-token-safer는 npm에 배포하지 않으니 `vts` CLI를 클론해서 설치합니다:

```bash
git clone https://github.com/JSungMin/vs-token-safer
cd vs-token-safer/server && npm install && npm link   # `vts` 제공
# 또는 link 없이 직접 실행:
node /path/to/vs-token-safer/server/cli.js symbol --q SpawnActor --projectPath /path/to/proj
```

## 설정 명령어

OS 환경변수를 직접 편집하지 않습니다. 설정은 CLI와 MCP 서버가 시작할 때 읽는 config 파일
(`~/.vs-token-safer/config.json`)에 저장됩니다. 설정 방법은 다음과 같습니다:

- **Claude Code에서 (권장):** `/vs-token-safer:setup`가 가이드해 줍니다. 현재 설정을 보여주고
  (`vts_config`), 백엔드를 감지하고, `projectPath`를 물어본 뒤 `vts_setup` 도구로 적용합니다. 그 후
  `/reload-plugins`.
- **도구 직접 호출:** Claude에게 `vts_setup { "projectPath": "…", "backend": "clangd" }`를 호출하거나
  `vts_config`로 유효 설정을 보여달라고 요청하세요.
- **셸에서:**
  ```bash
  vts setup --projectPath <root> --backend clangd
  vts config
  ```

백엔드는 루트에서 자동 감지합니다. `compile_commands.json`(또는 `.uproject`)이면 **clangd**,
`.sln`/`.csproj`이면 **roslyn**. 설정은 시작할 때 읽으니 **변경 후 `/reload-plugins`를 실행하세요**.
우선순위는 **환경변수(`VTS_*`) > config 파일 > 기본값**이라, 같은 이름 환경변수가 있으면 그게
이깁니다.

## 새 버전으로 업데이트

Claude Code는 마켓플레이스 repo를 캐시하므로 새 커밋이 **자동으로 받아지지 않습니다**. 새 버전을
받으려면:

```bash
# 1) 캐시된 마켓플레이스 카탈로그 갱신
/plugin marketplace update vs-token-safer

# 2) 설치된 플러그인 업데이트 (확실히 하려면 uninstall 후 install)
/plugin update vs-token-safer
#   안 되면: /plugin uninstall vs-token-safer  그 다음  /plugin install vs-token-safer@vs-token-safer

# 3) 새 훅/명령어/MCP 서버 적용 (의존성은 세션 시작 시 자동 재설치)
/reload-plugins        # 또는 Claude Code 재시작
```

`/plugin`으로 설치 상태와 버전을 확인할 수 있습니다. `/vs-token-safer:setup` 같은 명령이 안 보이면
설치본이 구버전이니 위 절차로 업데이트하세요.

> 유지보수 참고: `.claude-plugin/plugin.json`(과 마켓플레이스 엔트리)의 `version` 필드가 업데이트
> 게이트입니다. 클라이언트가 변경을 받게 하려면 버전을 올리세요. 변경이 동봉된 `gamedev-log-analyzer`
> (자체 독립 semver 유지)에만 있더라도 헤드라인 플러그인을 올려야 합니다(아니면 "already at latest").
> 버전 히스토리는 README가 아니라 [Releases](https://github.com/JSungMin/vs-token-safer/releases)에
> 있습니다(각 `v*` 태그마다 자동 생성).

## 설정 항목 (env)

우선순위: **환경변수(`VTS_*`) > `~/.vs-token-safer/config.json` > 기본값.**

| 설정 키 | 환경변수 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `projectPath` | `VTS_PROJECT_PATH` | cwd | 프로젝트 루트(컴파일 DB / `.sln` 위치). |
| `backend` | `VTS_BACKEND` | auto | `clangd` \| `roslyn` (루트에서 자동 감지). |
| `maxResults` | `VTS_MAX_RESULTS` | `60` | 반환 `file:line` 개수 상한. |
| — | `VTS_CLANGD_CMD` / `VTS_CLANGD_ARGS` | `clangd` | clangd 실행 파일/인자 재정의. |
| — | `VTS_ROSLYN_DLL` | auto | 특정 `Microsoft.CodeAnalysis.LanguageServer.dll` 경로. |
| — | `VTS_ROSLYN_CMD` / `VTS_ROSLYN_ARGS` | auto(MS 엔진) → `csharp-ls` | C# LSP 실행 파일/인자 재정의. |
| — | `VTS_TS_CMD` / `VTS_TS_ARGS` | 동봉 `typescript-language-server` | JS/TS LSP 실행 파일/인자 재정의. |
| — | `VTS_PY_CMD` / `VTS_PY_ARGS` | 동봉 `pyright-langserver` | Python LSP 실행 파일/인자 재정의. |
| — | `VTS_TS_OPEN_CAP` / `VTS_PY_OPEN_CAP` | `60` | JS/TS · Python warm-up이 서버를 데우려 여는 파일 최대 수. |
| — | `VTS_LSP_TIMEOUT_MS` | `30000` | 요청당 LSP 타임아웃. 차갑고 큰(예: UE) 인덱스면 올림. |
| — | `VTS_LSP_INDEX_WAIT_MS` | `120000` | clangd warm-up이 첫 쿼리 전 백그라운드 인덱싱 완료를 기다리는 시간. |
| — | `VTS_CLANGD_OPEN_CAP` | `100` | warm-up이 clangd 인덱스를 데우려 여는 파일 최대 수. |
| — | `VTS_PREWARM` | on (`projectPath` 설정 시) | MCP 서버가 기동 시 인덱스 pre-warm(IDE식); `0`이면 비활성. |
| — | `VTS_PREWARM_HOOK` | `0` | SessionStart 훅도 detached `vts warmup`으로 pre-warm(opt-in; 주로 CLI/비-MCP). |
| — | `VTS_PREWARM_BACKENDS` | auto | pre-warm할 백엔드. `auto`=감지된 단일/우세 백엔드 하나; `all`=repo에 존재하는 모든 언어(각 언어 파일수에 비례해 warm); 또는 `clangd,typescript` 같은 콤마 목록. |
| — | `VTS_WARM_CAP_RATIO` | `0.1` | 적응형 warm-up: 한 언어 파일의 ~이 비율만큼 open(큰 언어가 더 많이 warm), `[백엔드별 base, VTS_WARM_CAP_MAX]`로 clamp. `VTS_*_OPEN_CAP` 명시 시 그게 우선. |
| — | `VTS_WARM_CAP_MAX` | `300` | 적응형 백엔드별 warm-up open-cap 상한. |
| — | `VTS_CLANGD_REMOTE` | — | 공유/사전구축 clangd 인덱스 서버 주소(`--remote-index-address`); 개발자별 warmup ~0. |
| — | `VTS_QUERY_HISTORY` | `~/.vs-token-safer/query-history.json` | 쿼리 이력 원장 위치(warm-up 세트를 곧-검색-우선으로 정렬하는 데 사용). |
| — | `VTS_CENTRALITY_MAX` | `20000` | 중심성 스캔이 순회할 후보 상한; `0`이면 중심성 비활성. |
| — | `VTS_CENTRALITY_BUDGET_MS` | `400` | warm-up당 *신규* include-프리픽스 읽기 예산. 중심성은 적응형이라, 매 warm-up이 예산만큼 새/변경 파일을 영속 include-그래프 캐시(`VTS_INCLUDE_GRAPH`)에 채워 회차마다 커버리지가 늘어남(`0`=캐시만). |
| — | `VTS_ENFORCE` | `1` | `0`/`false`/`off`이면 Bash 코드 grep 허용(언어 서버 불가 시 탈출구). |
| — | `VTS_REWRITE` | `1` | `0`이면 코드 grep을 `vts` 쿼리로 재작성하지 않고 차단합니다. |
| — | `VTS_EXCLUDE_COMMANDS` | — | 재작성/차단에서 제외할 실행 파일 콤마 목록(예: `rg,find`). config.json의 `excludeCommands`도 가능. |
| — | `VTS_TEE` | `truncate` | `truncate`면 잘린 `find_files`/`search_text` 전체 결과를 복구 파일로 씁니다. `off`면 비활성화. 디렉터리: `VTS_TEE_DIR`. |
| — | `VTS_USD_PER_MTOK` | `3` | `vts savings`/`discover`의 추정 가치 줄에 쓰는 $/Mtok 단가. 참고용. |
| — | `VTS_CLAUDE_PROJECTS` | `~/.claude/projects` | `vts discover`가 스캔할 대화 기록 위치. |

## 강제(enforcement) 동작 방식

- **훅**은 모든 Bash 호출 전에 실행됩니다. 명령이 코드 검색(grep/rg/ack/ag/findstr/`git grep` 또는 코드
  확장자 `*.c/.cc/.cpp/.h/.hpp/.cs/.ts/.tsx/.js/.jsx/.mjs/.cjs/.py`·`src|source|engine|plugins/` 대상
  `find -name`)이고 로그/md/json/빌드 경로가 *아니면*, **그 자리에서 동등한 `vts` 쿼리로 재작성**합니다
  (식별자 → 의미 기반 `symbol`, 리터럴 → `text`, `find -name` → `files`). 그래서 검색은 토큰 캡으로 그대로
  실행됩니다. 안전한 재작성을 만들 수 없으면(파이프라인, 셸 메타문자 패턴) 차단으로 폴백합니다.
  `VTS_REWRITE=0`이면 차단 전용, `excludeCommands`/`VTS_EXCLUDE_COMMANDS`로 제외, `VTS_ENFORCE=0`이면 완전 비활성화.
- **스킬**은 Claude가 인덱스 도구를 선제적으로 쓰도록 유도합니다.
- **코어**는 Claude가 도구를 어떻게 호출하든 토큰 상한을 보장하고, 잘린 `find_files`/`search_text`는 전체
  결과를 tee 파일로 남겨 조용한 누락을 막습니다.

## 문제 해결

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| `/vs-token-safer:setup`가 자동완성에 안 뜸 | 플러그인 미설치(마켓플레이스만 add) 또는 구버전 | `/plugin install vs-token-safer@vs-token-safer` → `/reload-plugins`. `/plugin`에서 버전 확인. |
| 첫 clangd 쿼리가 매우 느리거나 타임아웃 | 차가운 UE-스케일 인덱스, clangd가 엔진 헤더 인덱싱 중 | pre-warm(`VTS_PREWARM` on, 또는 `vts warmup`); `VTS_LSP_TIMEOUT_MS`/`VTS_LSP_INDEX_WAIT_MS` 올림. MCP 서버를 띄워둬 인덱스를 warm 유지. |
| 실제 UE 프로젝트에서 clangd 쿼리가 영영 안 돌아옴(hang) | VS 동봉 clangd 19.1.x가 UE TU에서 **데드락** | **clangd ≥ 22** 설치 후 `VTS_CLANGD_CMD`로 지정. 오래된 clangd 감지 시 vts가 버전 경고 출력. |
| `GenerateClangDatabase` 실패: "Unable to find valid C++ toolchain for Clang x64" | 타겟이 clang-cl 빌드; UBT가 Clang 툴체인 검증 | UBT 명령에 **`-Compiler=VisualCpp`** 추가. MSVC DB도 include 그래프를 해석함. |
| clangd가 헤더 없는 심볼만 해석 | 컴파일 DB에 include 경로 없음 → 시스템/서드파티 헤더 미해석 | UBT 생성 DB 사용(경로 포함); 수작업 `compile_commands.json`은 include 경로를 명시해야 함. |
| C# 결과 없음 / "No backend resolved" | Roslyn 엔진 미발견 | VS Code C# 확장(`ms-dotnettools.csharp`) 설치, 또는 `dotnet tool install --global csharp-ls`; 또는 `VTS_ROSLYN_DLL`/`VTS_ROSLYN_CMD` 설정. |
| JS/TS·Python 결과 없음 | 동봉 LSP 미설치(오프라인 첫 실행, npm 실패) | 세션을 다시 시작해 의존성 재설치, 또는 PATH의 `typescript-language-server`/`pyright-langserver`를 `VTS_TS_CMD`/`VTS_PY_CMD`로 지정. |
| 원하던 grep인데 코드 검색이 차단됨 | 훅이 인덱스로 유도 중 | `VTS_ENFORCE=0`으로 grep 허용(예: 언어 서버 불가 시). |
| 잘못된 백엔드 선택됨 | 루트 아래 프로젝트 파일이 여럿 | 고정: `VTS_BACKEND=clangd`(또는 `roslyn`), 또는 호출마다 `backend` 전달. |

## 상태 / 주의

- **clangd 라이브 검증됨.** `compile_commands.json` 프로젝트 대상 실제 clangd로
  `search_symbol`/`find_references`/`goto_definition`을 확인했고, **실제 Unreal 5.x 게임 프로젝트
  end-to-end**도 포함합니다(게임 `UCLASS`와 그 `*.generated.h` 심볼을 반환). 정확한 컴파일 DB(include
  경로 포함)와 **clangd ≥ 22**가 필요합니다. 오래된 clangd는 실제 UE TU에서 데드락합니다.
- **Roslyn 라이브 검증됨.** 실제 `.csproj` 대상 **Microsoft.CodeAnalysis.LanguageServer**(VS 실제
  엔진)로 확인했습니다. VS Code C# 확장 번들에서 자동 감지하며 `csharp-ls`로 폴백합니다.
- 차가운 UE-스케일 인덱스는 첫 쿼리가 느리니 pre-warm하거나 LSP wait/timeout 환경변수를 올리세요.
- 절감 원장과 벤치마크 수치는 응답 정형화(raw 인덱스 → 캡) 기준입니다. grep 대비 절감은 더 큽니다.
  [BENCHMARK.md](BENCHMARK.md)를 참고하세요.

## 권한 & 안전

전부 **로컬**에서 동작하고 아무것도 업로드하지 않습니다:

- **훅**(`PreToolUse` Bash)은 명령 문자열만 검사해 code-grep을 인덱스로 리다이렉트할지 결정합니다. 파일
  내용을 읽거나 무언가를 실행하지 않습니다. `VTS_ENFORCE=0`을 존중합니다.
- **언어 서버**는 기기에서 stdio로 실행됩니다. 유일한 외부 네트워크 호출은 첫 실행 시 MCP SDK의
  `npm install`뿐입니다. 텔레메트리도 소스도 쿼리도 기기를 떠나지 않고, `~/.vs-token-safer/`에 설정과
  로컬 토큰절감 원장만 기록합니다.
- **gamedev-log-analyzer**는 지정한 로컬 로그 파일을 읽어 요약만 출력합니다.

[SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md)를 참고하세요.

## 버전 히스토리

**[Releases](https://github.com/JSungMin/vs-token-safer/releases)** 페이지를 참고하세요. 버전 태그마다
카테고리·PR 링크된 노트(🚀 Features / 🐛 Bug Fixes / 📝 Documentation / 🔧 Maintenance)가 자동
생성됩니다. 상단 배지는 항상 최신을 가리킵니다. 지금까지의 하이라이트는 다음과 같습니다:

- **v0.1.0** — 초기 vs-token-safer: clangd/Roslyn 기반 `search_symbol`/`find_references`/
  `goto_definition`, 토큰 캡 코어, grep 차단 훅, 라우팅 스킬, MCP 서버 + `vts` CLI.
- **v0.2.0** — clangd ≥ 22 권고(오래된 clangd는 UE에서 데드락), 설정 가능한 LSP 타임아웃, 동봉된
  gamedev-log-analyzer 마켓플레이스 플러그인.
- **v0.3.0** — 기동 시 IDE식 pre-warm + hit-rate 정렬 warm-up 세트(git/Perforce), 공유/사전구축 원격
  인덱스(`VTS_CLANGD_REMOTE`).
- **v0.4.0** — warm-up 정렬에 working-now(`git status` / `p4 opened`)와 include 중심성 추가;
  gamedev-log-analyzer 0.10.1.
- **v0.5.0** — README와 커뮤니티 문서를 성숙한 repo 수준으로(배지, env 표, 트러블슈팅, 버전 이력).
- **v0.6.0** — 적응형 include 중심성: 프리픽스 읽기, warm-up당 시간 예산, 회차마다 커버리지가 늘어나는
  영속 include-그래프 캐시로 큰 모듈을 건너뛰지 않음.
- **v0.7.0** — Rider 형제와 내비게이션 패리티: `hover`, `document_symbols`, `find_files`,
  `search_text`, 컨텍스트 격리형 `code-locator` 서브에이전트 — 그리고 `rename`(기본은 미리보기,
  `apply=true`일 때만 기록하는 의미 기반 프로젝트 전역 이름 변경).
- **v0.8.0** — 백엔드 두 개 추가: **JS/TS**(typescript-language-server)와 **Python**(pyright). 둘 다
  플러그인 의존성으로 동봉되어 자동 설치됩니다. 이제 vts가 자기 소스도 검색할 수 있어, 개발하면서 직접
  dogfood합니다.
- **v0.9.0** — 로그 분석 토스: 코드 검색이 `Logs/` 디렉터리나 `.log`/`.jsonl` 파일을 겨냥하면 코드
  인덱스의 빈 결과 대신 gamedev-log로 안내합니다. grep-block 훅이 내장 Grep 툴도 커버합니다(warn 전용).
- **v0.10.0** — 언어 인식 setup·warm-up. `vts_setup`이 프로젝트 언어를 인구조사해 `prewarmBackends`를
  자동 선택하고, warm-up open-cap이 각 언어 파일수에 비례 스케일하며 멀티언어 repo는 모든 백엔드를 비율로
  warm할 수 있습니다(`VTS_PREWARM_BACKENDS`). `search_text`가 JS/TS/Python도 스캔하고(기존 C/C++/C#만),
  tsserver/pyright의 `search_symbol`은 인덱스가 안 연 심볼에 대해 리터럴 텍스트 검색으로 폴백합니다.
  동봉 gamedev-log-analyzer → 0.10.3.
- **v0.11.0** — 최초 사용 setup 유도(미설정이면 첫 결과와 grep-block 훅이 `/vs-token-safer:setup`을
  안내); LSP 버퍼 신선도(warm-up 후 디스크에서 바뀐 파일을 `didChange`/`didClose`로 갱신, stale 버퍼로
  답하지 않음)와 LSP 스펙 적합성 강화(서버요청 응답, 타임아웃 시 `$/cancelRequest`, capability 선언).
  `scripts/sync-gamedev.mjs`로 동봉 플러그인 버전 드리프트 방지.
- **v0.12.0** — `compile_commands.json` 없는 C++ 프로젝트도 조용한 빈 결과 대신: clangd가 DB 생성법을
  안내하고, `search_symbol`은 리터럴 텍스트 검색으로 폴백하며, `vts_setup`이 미리 경고합니다. 새
  `vts_gen_compile_db`가 UBT `GenerateClangDatabase` 명령을 구성(옵션으로 실행)합니다 — 풀 semantic
  clangd와 경량 no-DB 모드 사이의 선택권.
- **v0.13.0** — grep-block 훅이 이제 Bash 코드 검색(`grep`/`rg`/`findstr`/`git grep`/`find -name`)을 차단만
  하지 않고 동등한 토큰-캡 `vts` 명령으로 **재작성**합니다. 모델 흐름이 끊기지 않고 출력은 항상 캡됩니다
  (`VTS_REWRITE=0`이면 기존 차단 유지, `excludeCommands`/`VTS_EXCLUDE_COMMANDS`로 특정 명령 제외).
  새 `vts discover`는 최근 Claude 대화 기록에서 vts를 우회한 검색과 소모한 토큰을 보고하고, `vts savings`는
  30일 그래프·일별/이력 분석·추정 가치를 추가하며, 잘린 `find_files`/`search_text`는 전체 결과를 복구
  (tee) 파일로 씁니다. 이들은 자기개선으로 결합됩니다: 재작성은 식별자 패턴을 텍스트 grep이 아닌 **semantic**
  `search_symbol`로 보내고(백엔드가 없으면 텍스트로 자동 폴백), `vts discover --learn`은 우회한 검색이 맞춘
  파일들을 warm-up 세트에 넣어 다음 prewarm이 먼저 열게 하며, `discover`는 **catch-rate**(vts가 잡은 토큰 vs
  여전히 우회 중)를 보고합니다. 또한 `document_symbols`가 아웃라인 노이즈(익명 콜백/중첩 로컬)를 숨기고,
  잘린 스윕은 조용히 캡되지 않고 표시됩니다.

## 기여

이슈와 PR 환영합니다. 버그 리포트, 새 백엔드/엔진, 언어 매핑 추가, 문서 모두 좋습니다.

이 repo는 AI 보조 리뷰로 유지보수합니다. PR은 diff와 설명과 증거로 판단하니 **작고, 명확히 설명되고,
증거가 있고, 사내정보(실제 경로·심볼·프로젝트 식별자)가 없게** 올려주세요. 새 코드 경로에는
`eval/run.mjs`에 eval 가드를 추가하세요. PR 전 **[CONTRIBUTING.md](CONTRIBUTING.md)**를 읽어주세요.

**⭐ 토큰이나 디버깅 시간을 아꼈다면, star가 다른 사람들의 발견을 돕습니다.**

## 개인정보

이 플러그인들은 개인정보를 수집하지 않고 모든 처리를 로컬에서 합니다. [PRIVACY.md](PRIVACY.md)를 참고하세요.

## 라이선스

MIT © 2026 JSungMin
