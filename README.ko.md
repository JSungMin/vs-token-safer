# vs-token-safer

**Claude Code가 C++/C# 코드를 Bash `grep` 대신 공식 언어 서버 인덱스로 검색하도록 강제한다** —
C/C++은 clangd(LLVM), C#/.NET은 Roslyn 기반 LSP. 결과는 간결한 `file:line` 목록으로 **토큰 캡**한다.
대규모 Unreal C++ / .NET 코드베이스에서 더 빠르고 토큰을 훨씬 적게 쓴다. **로컬 전용, IDE 불필요.**
Claude Code 플러그인(MCP 서버 + 훅 + 스킬)과 독립 CLI(`vts`, npm)로 제공된다.

> 🇺🇸 English: [README.md](README.md)

[rider-mcp-enforcer](https://github.com/JSungMin/rider-mcp-enforcer)의 IDE 비종속 형제 프로젝트다.
토큰 효율 목표는 같지만, 실행 중인 IDE의 MCP 서버를 프록시하는 대신 **공식 언어 서버를 헤드리스로
직접 실행**한다 — 그래서 에디터를 열지 않아도 Visual Studio / 임의의 C++·C# 프로젝트에서 동작한다.

---

## 왜 필요한가

큰 게임/.NET 코드베이스에서 `grep`/`rg`는 **수천 줄**을 모델 컨텍스트에 쏟아붓는다 — 대부분 무관하고,
심볼 의미 없는 단순 텍스트 매치다. vs-token-safer는 대신:

- **언어 서버 인덱스**에 심볼/참조/정의를 묻고(텍스트가 아닌 의미 기반),
- **토큰 캡된 `file:line` 목록**만 반환한다 — 소스 본문은 절대 포함하지 않는다.

1,000개 심볼 인덱스 응답 기준 **약 97% 토큰 절감**이다([벤치마크](#벤치마크)). `PreToolUse` 훅이
Bash의 코드 심볼 `grep`을 **차단**하고 인덱스 도구로 안내하므로 절감이 자동으로 일어난다.

## 동작 예시

```
$ vts symbol --q SpawnActor --projectPath ./MyGame
3 symbol(s) matching "SpawnActor" (backend: clangd, root: ./MyGame):
func SpawnActor (in AGameMode)  @ MyGame/Source/GameMode.cpp:142
method SpawnActorDeferred (in UWorld)  @ MyGame/Source/World.cpp:88
func SpawnActorFromClass  @ MyGame/Source/SpawnLib.cpp:31

✓ Saved ~4,200 tokens here (96.8% / 31× smaller than the raw index response).
```

---

## 설치

### Claude Code 플러그인으로

```
/plugin marketplace add JSungMin/vs-token-safer
/plugin install vs-token-safer
/reload-plugins
```

`vs-search` MCP 서버, grep 차단 훅, 라우팅 스킬이 연결된다. 첫 실행 시 MCP 서버가 의존성
(`@modelcontextprotocol/sdk`) 하나를 플러그인 데이터 디렉터리에 설치한다.

### 독립 CLI로 (IDE·Claude Code 불필요)

```
npm i -g vs-token-safer      # `vts` 제공
# 또는 일회성:
npx -p vs-token-safer vts symbol --q SpawnActor --projectPath /path/to/proj
```

### 사전 준비 — 언어 서버

vs-token-safer는 공식 엔진을 구동한다. 필요한 것을 설치한다:

| 백엔드 | 언어 | 엔진 | 설치 | 필요 조건 |
| --- | --- | --- | --- | --- |
| `clangd` | C/C++ | clangd (LLVM) | [LLVM 릴리스](https://github.com/clangd/clangd/releases) 또는 패키지 매니저 | `compile_commands.json` |
| `roslyn` | C#/.NET | `csharp-ls` (Roslyn) | `dotnet tool install --global csharp-ls` | `.sln` / `.csproj` |

**clangd는 컴파일 DB(`compile_commands.json`)가 필요하다:**
- **Unreal Engine:** UBT로 생성 — `<UE>/Engine/Build/BatchFiles/RunUBT … -mode=GenerateClangDatabase`.
- **CMake:** `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`로 구성.

C#은 `csharp-ls` 대신 Visual Studio 정확 엔진을 원하면 `VTS_ROSLYN_CMD`/`VTS_ROSLYN_ARGS`를
`Microsoft.CodeAnalysis.LanguageServer`로 지정한다.

---

## 사용법

### MCP 도구 (서버 이름: `vs-search`)

| 도구 | 용도 | 주요 인자 |
| --- | --- | --- |
| `search_symbol` | 이름/부분문자열로 심볼 선언 검색 | `q`, `projectPath`, `backend`, `maxResults` |
| `find_references` | 위치의 심볼에 대한 참조/사용처 | `path`, `line`, `character` (0-based), `includeDeclaration` |
| `goto_definition` | 위치의 심볼 정의 | `path`, `line`, `character` (0-based) |
| `vts_setup` | 설정 저장(`~/.vs-token-safer/config.json`) | `projectPath`, `backend`, `maxResults` |
| `vts_config` | 현재 유효 설정 표시 | — |
| `vts_savings` / `vts_savings_reset` | 토큰 절감 원장 | — |

### CLI (`vts`)

```
vts symbol      --q <name> --projectPath <dir> [--backend clangd|roslyn] [--maxResults N]
vts references  --path <file> --line N --character N [--includeDeclaration]
vts definition  --path <file> --line N --character N
vts setup       [--projectPath <dir>] [--backend …] [--maxResults N]
vts config
vts savings | vts savings-reset
```

슬래시 명령(플러그인): `/vs-token-safer:setup`, `/vs-token-safer:savings`.

---

## 설정

우선순위: **환경 변수(`VTS_*`) > `~/.vs-token-safer/config.json` > 기본값.**

| 설정 키 | 환경 변수 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `projectPath` | `VTS_PROJECT_PATH` | cwd | 프로젝트 루트(컴파일 DB / `.sln` 위치) |
| `backend` | `VTS_BACKEND` | auto | `clangd` \| `roslyn` (루트에서 자동 감지) |
| `maxResults` | `VTS_MAX_RESULTS` | `60` | 반환 `file:line` 개수 상한 |
| — | `VTS_CLANGD_CMD` / `VTS_CLANGD_ARGS` | `clangd` | clangd 실행 파일/인자 재정의 |
| — | `VTS_ROSLYN_CMD` / `VTS_ROSLYN_ARGS` | `csharp-ls` | C# LSP 실행 파일/인자 재정의 |
| — | `VTS_ENFORCE` | `1` | `0`/`false`/`off`이면 Bash 코드 grep 허용(탈출구) |

자동 감지: `compile_commands.json`(또는 `.uproject`) → **clangd**; `.sln`/`.csproj` → **roslyn**.

---

## grep 차단 훅

`PreToolUse`(Bash) 훅이 소스 파일(`.c/.cc/.cpp/.h/.hpp/.cs`, 또는 `src/`·`source/`·`engine/`·
`plugins/`)에 대한 코드 심볼 검색(`grep`/`rg`/`ack`/`ag`/`findstr`, 또는 `find -name`)을 차단하고
인덱스 도구를 쓰도록 안내한다. **정밀하다**: 명령 세그먼트의 실제 실행 파일이 검색 도구일 때만
발동하며, **원시 텍스트** 검색(로그, `.md`, `.json`, 설정, build/intermediate 디렉터리)은 그대로
통과시킨다. 언어 서버를 못 쓰면 `VTS_ENFORCE=0`으로 grep 차단을 끈다.

---

## 백엔드 지원 현황

| 백엔드 | 상태 | 비고 |
| --- | --- | --- |
| `clangd` (C/C++) | ✅ 주 타깃 | `compile_commands.json` 필요. Unreal은 UBT로 생성. |
| `roslyn` (C#/.NET) | ⚠️ 베스트 에포트 | 기본 `csharp-ls`; 실제 `.sln` 대상 CI 라이브 검증 전. 필요 시 MS C# LSP로 재정의. |

---

## 동작 원리 (아키텍처)

```
Claude Code ──(MCP / CLI)──▶ vs-token-safer  ──(stdio LSP)──▶ clangd / csharp-ls ──▶ 소스
                              └ runTool(): LSP 결과 토큰 캡 → file:line, 본문 없음
```

- `server/lsp.js` — 완전 자체 구현 **LSP 클라이언트**(JSON-RPC 2.0, `Content-Length` 프레이밍).
  유일하게 새로 만든 핵심.
- `server/backends/index.js` — 각 공식 엔진 실행 방법 + `pickBackend(root)` 자동 감지.
- `server/core.js` — async `runTool()` 디스패치, 토큰 캡 포매터, 절감 원장. 두 어댑터가 공유 →
  도구당 구현은 정확히 하나.
- `server/index.js` — MCP 서버(얇은 어댑터). `server/cli.js` — `vts` CLI(얇은 어댑터).

**엔진은 공식, 글루는 우리 것.** 분석은 clangd(LLVM)·Roslyn(Microsoft)이 하고, 이 저장소는
LSP↔MCP 글루만 작성한다. 소스 위에서 서드파티 MCP 서버가 돌지 않는다.

---

## 벤치마크

eval(`node eval/run.mjs`, 목 LSP — 툴체인 불필요)이 매 커밋 토큰 절감을 게이트한다:

```
raw index ~57,308 tok → capped output ~1,515 tok      = 97.4% 절감 (심볼 1,000개)
```

이는 응답 정형화 절감(원시 인덱스 응답 → 캡된 목록)이다. `grep` 출력을 컨텍스트에 붙이는 것 대비
절감은 보통 더 크다 — grep은 매칭 줄 전체를 반환하기 때문이다.

---

## 개인정보 & 보안

**로컬 전용, 전송 제로.** 언어 서버는 stdio로 로컬 실행되며, 유일한 외부 네트워크 호출은 첫 실행 시
MCP SDK의 `npm install`뿐이다. 텔레메트리·소스·쿼리가 기기를 떠나지 않는다.
[PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md) 참고.

## 개발

```
npm install            # 루트 개발 도구(eslint, prettier)
npm test               # node eval/run.mjs → EVAL PASSED
npm run lint
cd server && npm install   # MCP 서버 의존성, 이후 `node index.js`로 서버 시작
```

새 코드 경로에는 `eval/run.mjs`에 eval 가드를 추가한다. [CONTRIBUTING.md](CONTRIBUTING.md) 참고.

## 라이선스

[MIT](LICENSE) © JSungMin
