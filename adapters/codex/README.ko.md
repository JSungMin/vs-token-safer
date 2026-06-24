# vs-token-safer × Codex CLI

**[English](./README.md)** · 한국어

OpenAI [Codex CLI](https://developers.openai.com/codex/)에서 vs-token-safer를 사용합니다. Codex는 MCP를
지원하므로 **도구는 그대로 이식됩니다** — `search_symbol`, `find_references`, `goto_definition`,
`concept_search`, 심볼 편집 도구, `search_text`/`find_files`, git/p4 압축기 — 모두 동일한 토큰캡된
`file:line`으로 답하고, 전부 로컬이며 아무것도 전송하지 않습니다.

이식되지 **않는** 것은 Claude Code 강제(enforcement) 훅뿐입니다(여기선 떠도는 `grep`을 자동으로 다시 쓸 수
없음). Codex에서는 교체가 **가로채기가 아니라 지시(instructed)** 방식입니다: `AGENTS.md`의 라우팅 블록(아래)이
에이전트에게 vts 도구를 습관적으로 우선 쓰도록 알려줍니다. 도구 결과 *안에* 실려 따라가는 것들(정밀도
인증서, 빈 결과 steer, 네비게이션 nudge)은 그대로 작동합니다 — 훅이 아니라 답의 일부니까요.

## 1. MCP 서버 등록

**CLI 헬퍼(권장)** — Codex가 올바른 `config.toml` 테이블을 직접 작성합니다:

```bash
# 이 repo의 로컬 클론 (npm 게시 불필요):
codex mcp add vs-search -- node /ABSOLUTE/PATH/TO/vs-token-safer/server/index.js

# …또는 게시된 npm 패키지(vs-token-safer가 npm에 올라간 경우):
codex mcp add vs-search -- npx -y vs-token-safer
```

**또는 `~/.codex/config.toml`을 직접 편집** — 이 디렉터리의 [`config.toml`](./config.toml) 테이블을
복사합니다. 선택적 `env` 블록(`PROJECT_PATH`, `VTS_SCOPE`, `VTS_CLANGD_CMD`, …)도 함께 보여줍니다.

연결 확인:

```bash
codex mcp list      # vs-search 가 보여야 함
```

## 2. 라우팅 지침 추가

이 디렉터리의 [`AGENTS.md`](./AGENTS.md) 블록을 프로젝트의 `AGENTS.md`에 덧붙입니다. 엔진과 동기를 유지하도록
언제든 다시 생성할 수 있습니다:

```bash
vts routing --native "Codex의 read_file / shell(grep, sed) / apply_patch" >> AGENTS.md
```

## 3. (선택) 폴백으로서의 `vts` CLI

MCP 없이도 Codex `shell` 단계에서 `vts` CLI를 직접 호출할 수 있습니다 — 같은 엔진입니다:

```bash
vts symbol --q SpawnActor --projectPath /path/to/project
vts references --symbol HandlePayment --projectPath /path/to/project
vts concept --q "auth login flow" --projectPath /path/to/project
```

이것이 최저 공통분모 경로입니다 — Codex뿐 아니라 셸을 실행할 수 있는 모든 에이전트에서 작동합니다.

## 참고

- **동일한 신뢰 모델**: 로컬 전용, 공식 언어 서버(clangd / Roslyn / tsserver / pyright) + tree-sitter,
  임베딩 없음, 아무것도 머신을 떠나지 않음.
- **C++ / Unreal**: `compile_commands.json`과 clangd ≥ 22 필요(VS 번들 19.1.x는 UE TU에서 교착).
  generate-DB 절차(`vts gen-compile-db`)는 repo 루트의 `CLAUDE.md` / `README.md` 참고.
- **버전**: repo에 고정 — 하나의 엔진, 모든 어댑터가 같은 버전(하네스별 fork 없음).
