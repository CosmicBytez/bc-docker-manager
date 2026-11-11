#!/usr/bin/env python3
"""Diagnostics and post-review guard for .github/workflows/claude-code-review.yml.

Subcommands (every input arrives through the environment, never through ${{ }}):

  diag   Summarise claude-code-action's execution file (EXEC_FILE): result subtype,
         is_error, turns, cost, models, Agent/Task calls, background subagent launches
         and Claude's final message (credential-redacted, truncated). Writes the job log
         and $GITHUB_STEP_SUMMARY. Never fails the job.
  guard  Fail the job unless the code-review plugin really reviewed this PR, or stopped
         at its own step 1 for a reason this script can check (EXEC_FILE, REPO,
         PR_NUMBER, STARTED_AT, GH_TOKEN or GITHUB_TOKEN). Decisions: _run_guard.

Why: on 2026-10-15 the review job for PR #32 went green (4 turns, 14 s, $0.0876) and
posted nothing. claude-code-action drives the CLI through the Agent SDK and stops at
the FIRST result message. The plugin's subagent ran in the background (the CLI
default), so that first result was "the review agent is still running", the action
killed the CLI, and the finished review was thrown away. The workflow now forces
foreground subagents. This script proves, after the fact, that the fix held and that
a review was actually posted.

Python 3.8-compatible and stdlib-only: the self-hosted runner ships python3 3.8.10 and
gh 2.96.0, and nothing else (no jq) is guaranteed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, TextIO

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    GhRunner = Callable[[list[str]], str]

BOT_LOGIN = "claude[bot]"
REVIEW_HEADING = "## Code review"  # the plugin's summary comment; tag mode never posts it
ALL_CLEAR_MARKER = "No issues found"
AGENT_TOOLS = ("Agent", "Task")
INLINE_TOOL = "mcp__github_inline_comment__create_inline_comment"
_GH_PR_COMMENT = re.compile(r"\bgh\s+pr\s+comment\b")
_GH_PR_VIEW = re.compile(r"\bgh\s+pr\s+view\b")  # how the plugin's step 1 checks the PR
ASYNC_PREFIX = "Async agent launched"
MAX_CHARS = 1500
CLOCK_SKEW = timedelta(seconds=60)  # runner clock vs GitHub's created_at
ATTEMPTS = 3
RETRY_DELAY_S = 10
GH_TIMEOUT_S = 60
REPO_RE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
SIGNALS = (
    "task_started.is_backgrounded",
    "async tool_use_result",
    "'Async agent launched' on an Agent/Task result",
)

# --------------------------------------------------------------------------- redaction

# Every pattern must stay linear: the final message can quote anything in the PR, and a
# `\b[...]*` prefix backtracks quadratically on runs like "a-a-a-..." (12 s on 16 KB).
# Key-shaped runs therefore start only where the previous character cannot extend
# them (a lookbehind), and "is this key secret?" is decided in a callback.
_SECRET_WORD = re.compile(r"(?i)pass(?:word|wd)|secret|token(?!s)|api[_-]?key|_key")
_KEY_VALUE = re.compile(
    r"(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(\s*=\s*)"
    r"(\"[^\"]*\"|'[^']*'|[\"']?[^\s\"'&,;=?]*)"  # unquoted values stop at = and ?
)
# KEY: value (compose `environment:` maps, YAML). A key starts a word (after whitespace,
# a quote or a bracket) and the value is only looked at, never consumed, so "Note:
# PASSWORD: x" still reaches PASSWORD. Values cannot contain a key-start character, so
# no value is scanned twice.
_KEY_COLON = re.compile(
    r"(?:^|(?<=[\s\"'(\[{,;]))([A-Za-z0-9_.-]+)[ \t]*:[ \t]*"
    r"(?=(\"[^\"\n]*\"|'[^'\n]*'|[^\s\"',;&(\[{)\]}]+))"
)
_FLAG = re.compile(
    r"(?i)(?<![\w-])(--(?:password|passwd|token|secret|api[-_]?key)[ \t]+)"
    r"(\"[^\"\n]*\"|'[^'\n]*'|[^\s\"']+)"
)
_AUTH_HEADER = re.compile(
    r"(?i)\b(authorization[ \t]*:[ \t]*(?:bearer|basic|token)[ \t]+)[^\s\"']+"
)
_JSON_FIELD = re.compile(r"([\"'])([A-Za-z0-9_.-]+)\1(\s*:\s*)([\"'])((?:(?!\4)[^\\]|\\.)*)\4")
_REDACTIONS = [
    # PEM private keys, including a block the model cut off before its END line.
    (
        re.compile(
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:.*?-----END [A-Z0-9 ]*PRIVATE KEY-----|.*)",
            re.S,
        ),
        "[redacted]",
    ),
    (re.compile(r"sk-ant-[A-Za-z0-9_-]{10,}"), "[redacted]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"), "[redacted]"),
    (re.compile(r"\bgh[opsur]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}"), "[redacted]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "[redacted]"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "[redacted]"),
    (re.compile(r"(discord(?:app)?\.com/api/webhooks/)[0-9]+/[A-Za-z0-9_-]+"), r"\1[redacted]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"), "[redacted]"),
    # scheme://user:password@host, and scheme://:password@host (redis)
    (
        re.compile(r"(?i)(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*://[^/\s:@]*):[^/\s@]+@"),
        r"\1:[redacted]@",
    ),
    (re.compile(r"\b[0-9a-fA-F]{40,}\b"), "[redacted]"),
]
_BEARER = re.compile(r"(?i)\b(bearer|basic)(\s+)([A-Za-z0-9._~+/=-]{8,})")
_HIGH_ENTROPY = re.compile(r"[A-Za-z0-9+/_-]{32,}={0,2}")


def _looks_random(token: str) -> bool:
    has_upper = any(c.isupper() for c in token)
    has_lower = any(c.islower() for c in token)
    return any(c.isdigit() for c in token) and has_upper and has_lower


def _bearer(match: re.Match[str]) -> str:
    token = match.group(3)
    if _looks_random(token) or any(c.isdigit() or c in "._~+/=-" for c in token):
        return match.group(1) + match.group(2) + "[redacted]"
    return match.group(0)  # "basic functionality" is prose, not a credential


def _entropy(match: re.Match[str]) -> str:
    return "[redacted]" if _looks_random(match.group(0)) else match.group(0)


def _key_value(match: re.Match[str]) -> str:
    """KEY=value, *_KEY=value, PASSWORD="two words"."""
    if not _SECRET_WORD.search(match.group(1)) or not match.group(3):
        return match.group(0)
    return match.group(1) + match.group(2) + "[redacted]"


def _colon_secret(key: str, value: str) -> bool:
    """KEY: value is a credential when the key names one and the value could be one.
    Identifier-shaped keys (DB_PASSWORD, x-api-key, a.b.password, TOKEN) take any value;
    a bare word ("Secret: none were found") needs a quoted or digit-bearing value. Keys
    like "authenticate" never match, so "Failed to authenticate: ..." survives."""
    if not _SECRET_WORD.search(key) or not any(c.isalnum() for c in value):
        return False
    if value[0] in "\"'":
        return True
    if key.isupper() or any(c in "_-." for c in key):
        return True
    return any(c.isdigit() for c in value)


def _redact_colon_pairs(text: str) -> str:
    parts, last = [], 0
    for match in _KEY_COLON.finditer(text):
        value, start = match.group(2), match.end()
        if start < last or not _colon_secret(match.group(1), value):
            continue
        quote = value[0] if value[0] in "\"'" else ""
        parts += [text[last:start], quote, "[redacted]", quote]
        last = start + len(value)
    parts.append(text[last:])
    return "".join(parts)


def _json_field(match: re.Match[str]) -> str:
    """ "password": "...", 'client_secret': '...' (string values only)."""
    if not _SECRET_WORD.search(match.group(2)):
        return match.group(0)
    quote = match.group(4)
    return match.group(0)[: match.start(5) - match.start(0)] + "[redacted]" + quote


def redact(text: str) -> str:
    """Replace credential-shaped substrings with [redacted]. Long lower-case runs (file
    paths, prose) survive; only mixed-case-plus-digit runs are treated as random."""
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    text = _JSON_FIELD.sub(_json_field, text)
    text = _KEY_VALUE.sub(_key_value, text)
    text = _AUTH_HEADER.sub(r"\1[redacted]", text)
    text = _FLAG.sub(r"\1[redacted]", text)
    text = _redact_colon_pairs(text)
    text = _BEARER.sub(_bearer, text)
    return _HIGH_ENTROPY.sub(_entropy, text)


def clip(text: str) -> str:
    if len(text) <= MAX_CHARS:
        return text
    return f"{text[:MAX_CHARS]}\n... [truncated: {len(text)} chars total]"


# ------------------------------------------------------------- execution-file analysis


class Analysis:
    """What the execution file says about the review session."""

    def __init__(self) -> None:
        self.readable = False
        self.error = ""
        self.messages = 0
        self.results = 0
        self.result: dict[str, Any] = {}
        self.agent_calls = 0
        self.posting_attempts = 0  # create_inline_comment or `gh pr comment` tool_use
        self.pr_view_calls = 0  # Bash `gh pr view`, the plugin's step-1 check
        self.denials = 0
        self.posting_denials = 0
        self.background_signals = dict.fromkeys(SIGNALS, 0)
        self.final_message = ""

    @property
    def background(self) -> int:
        """Background subagent launches (each signal counts every launch it sees)."""
        return max(self.background_signals.values())


def _blocks(message: Any) -> list[dict[str, Any]]:
    inner = message.get("message") if isinstance(message, dict) else None
    content = inner.get("content") if isinstance(inner, dict) else None
    if not isinstance(content, list):
        return []
    return [block for block in content if isinstance(block, dict)]


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if isinstance(p, str))
    return ""


def _command(tool_input: Any) -> str:
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    return command if isinstance(command, str) else ""


def _is_posting(name: Any, tool_input: Any) -> bool:
    return name == INLINE_TOOL or (
        name == "Bash" and bool(_GH_PR_COMMENT.search(_command(tool_input)))
    )


def analyse_messages(messages: list[Any]) -> Analysis:
    analysis = Analysis()
    analysis.readable = True
    analysis.messages = len(messages)
    signals = analysis.background_signals
    agent_ids = set()
    # Every tool_use counts, subagents' included: in foreground mode the haiku step-1
    # agent's `gh pr view` arrives with parent_tool_use_id set.
    for message in messages:
        if isinstance(message, dict) and message.get("type") == "assistant":
            for block in _blocks(message):
                if block.get("type") != "tool_use":
                    continue
                name, tool_input = block.get("name"), block.get("input")
                if name in AGENT_TOOLS:
                    analysis.agent_calls += 1
                    if isinstance(block.get("id"), str):
                        agent_ids.add(block["id"])
                if _is_posting(name, tool_input):
                    analysis.posting_attempts += 1
                if name == "Bash" and _GH_PR_VIEW.search(_command(tool_input)):
                    analysis.pr_view_calls += 1

    first_result: dict[str, Any] | None = None
    last_text = ""
    for message in messages:
        if not isinstance(message, dict):
            continue
        kind = message.get("type")
        if kind == "result":
            analysis.results += 1
            if first_result is None:  # the action stops at the first result
                first_result = message
        elif kind == "system":
            if message.get("subtype") == "task_started" and message.get("is_backgrounded") is True:
                signals[SIGNALS[0]] += 1
        elif kind == "user":
            outcome = message.get("tool_use_result")
            if isinstance(outcome, dict) and (
                outcome.get("status") == "async_launched" or outcome.get("isAsync") is True
            ):
                signals[SIGNALS[1]] += 1
            for block in _blocks(message):
                tool_use_id = block.get("tool_use_id")
                if (
                    block.get("type") == "tool_result"
                    and isinstance(tool_use_id, str)
                    and tool_use_id in agent_ids
                    and _text(block.get("content")).lstrip().startswith(ASYNC_PREFIX)
                ):
                    signals[SIGNALS[2]] += 1
        elif kind == "assistant" and message.get("parent_tool_use_id") is None:
            for block in _blocks(message):
                text = block.get("text")
                if block.get("type") == "text" and isinstance(text, str) and text.strip():
                    last_text = text

    analysis.result = first_result or {}
    denials = analysis.result.get("permission_denials")
    denials = [d for d in denials if isinstance(d, dict)] if isinstance(denials, list) else []
    analysis.denials = len(denials)
    analysis.posting_denials = sum(
        1 for d in denials if _is_posting(d.get("tool_name"), d.get("tool_input"))
    )
    final = analysis.result.get("result")
    if not isinstance(final, str) or not final.strip():
        final = last_text
    # Redact BEFORE clipping, so a credential straddling the cut is never half-printed.
    analysis.final_message = clip(redact(final).strip())
    return analysis


def analyse_file(path: str) -> Analysis:
    """Read EXEC_FILE. No fallback to a default $RUNNER_TEMP path: on this persistent
    runner a file there may belong to another job, so empty means unreadable."""
    if not path:
        analysis = Analysis()
        analysis.error = "EXEC_FILE is empty: the action reported no execution file"
        return analysis
    try:
        with open(path, encoding="utf-8") as fh:
            messages = json.load(fh)
    except (OSError, ValueError) as exc:
        analysis = Analysis()
        analysis.error = f"{exc.__class__.__name__} reading the execution file"
        return analysis
    if not isinstance(messages, list):
        analysis = Analysis()
        analysis.error = "the execution file is not a JSON array of messages"
        return analysis
    return analyse_messages(messages)


# ------------------------------------------------------------------------ output helpers


def _show(value: Any) -> str:
    if value is None:
        return "n/a"
    return value if isinstance(value, str) else json.dumps(value)


def _breakdown(analysis: Analysis) -> str:
    return ", ".join(f"{name}={count}" for name, count in analysis.background_signals.items())


def diag_rows(analysis: Analysis) -> list[tuple[str, str]]:
    res = analysis.result
    usage = res.get("modelUsage")
    models = ", ".join(sorted(str(m) for m in usage)) if isinstance(usage, dict) else ""
    denials = res.get("permission_denials")
    denials = denials if isinstance(denials, list) else []
    denied = sorted({str(d.get("tool_name")) for d in denials if isinstance(d, dict)})
    stats = res.get("subagent_stats")
    rows = [
        (
            "execution file",
            (
                f"{analysis.messages} messages, {analysis.results} result message(s)"
                if analysis.readable
                else f"unreadable ({analysis.error})"
            ),
        ),
        ("result subtype", _show(res.get("subtype"))),
        ("is_error", _show(res.get("is_error"))),
        ("num_turns", _show(res.get("num_turns"))),
        ("total_cost_usd", _show(res.get("total_cost_usd"))),
        ("duration_ms", _show(res.get("duration_ms"))),
        ("models", models or "n/a"),
        ("Agent/Task calls", str(analysis.agent_calls) if analysis.readable else "unknown"),
        (
            "background launches",
            (f"{analysis.background} ({_breakdown(analysis)})" if analysis.readable else "unknown"),
        ),
        (
            "permission denials",
            f"{len(denials)} ({', '.join(denied)})" if denials else "0",
        ),
        (
            "gh pr view / posting calls",
            (
                f"{analysis.pr_view_calls} / {analysis.posting_attempts}"
                if analysis.readable
                else "unknown"
            ),
        ),
    ]
    if isinstance(stats, dict):
        requested = stats.get("requested")
        asked = requested.get("background") if isinstance(requested, dict) else None
        rows.append(
            (
                "CLI subagent stats",
                f"spawned={_show(stats.get('spawned'))}, requested_background={_show(asked)}, "
                f"started_in_background={_show(stats.get('started_in_background'))}",
            )
        )
    return [(key, redact(value).replace("\n", " ")) for key, value in rows]


def write_untrusted(out: TextIO, text: str) -> None:
    """Print text that came from the model (which read the PR) with workflow commands
    disabled, so "::error::" or "::add-mask::" in a PR cannot drive the runner."""
    token = secrets.token_hex(16)
    out.write(f"::stop-commands::{token}\n{text}\n::{token}::\n")


def fenced(text: str) -> str:
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}text\n{text}\n{fence}"


def append_summary(env: Mapping[str, str], text: str) -> None:
    path = env.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")
    except OSError:
        pass  # a summary is a convenience; never let it change the outcome


def _cell(value: str) -> str:
    return value.replace("|", "\\|")


# --------------------------------------------------------------------------------- diag


def cmd_diag(env: Mapping[str, str], out: TextIO) -> int:
    try:
        analysis = analyse_file(env.get("EXEC_FILE", ""))
        rows = diag_rows(analysis)
        final = analysis.final_message or "(no final assistant message in the execution file)"
        body = "\n".join(f"{key:<22}{value}" for key, value in rows)
        out.write("::group::Claude review diagnostics\n")
        write_untrusted(
            out,
            f"{body}\n--- Claude's final message (redacted, max {MAX_CHARS} chars) ---\n{final}",
        )
        out.write("::endgroup::\n")
        if analysis.readable and analysis.background:
            out.write(
                "::warning::A subagent was launched in the BACKGROUND. claude-code-action "
                "keeps only the first result message, so that subagent's output was "
                "discarded. The guard step will fail this job.\n"
            )
        summary = ["### Claude review diagnostics", "", "| | |", "|---|---|"]
        summary += [f"| {key} | {_cell(value)} |" for key, value in rows]
        summary += ["", f"**Final assistant message** (redacted, max {MAX_CHARS} chars):", ""]
        summary += [fenced(final), ""]
        append_summary(env, "\n".join(summary))
    except Exception as exc:  # diagnostics must never fail the job; the guard decides
        out.write(
            f"::warning::Review diagnostics crashed ({exc.__class__.__name__}). "
            "The guard step still decides pass or fail.\n"
        )
    return 0


# ---------------------------------------------------------------------------- GitHub API


class GhError(Exception):
    """`gh` failed, timed out, or printed something that is not JSON."""


def default_gh(env: Mapping[str, str]) -> GhRunner:
    child_env = dict(env)
    child_env.update({"GH_PROMPT_DISABLED": "1", "GH_NO_UPDATE_NOTIFIER": "1", "NO_COLOR": "1"})

    def run(args: list[str]) -> str:
        try:
            proc = subprocess.run(
                ["gh", *args],
                capture_output=True,
                text=True,
                timeout=GH_TIMEOUT_S,
                env=child_env,
                stdin=subprocess.DEVNULL,  # under `python3 -` stdin was the script itself
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise GhError(f"gh could not run ({exc.__class__.__name__})") from exc
        if proc.returncode != 0:
            lines = redact(proc.stderr).strip().splitlines() or ["no stderr"]
            raise GhError(f"gh exited {proc.returncode}: {lines[0][:200]}")
        return proc.stdout

    return run


def json_documents(text: str) -> list[Any]:
    """`gh api --paginate` prints each page's JSON array back to back: [..][..]."""
    decoder = json.JSONDecoder()
    documents: list[Any] = []
    index = 0
    while True:
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            return documents
        try:
            document, index = decoder.raw_decode(text, index)
        except ValueError as exc:
            raise GhError("gh printed something that is not JSON") from exc
        documents.append(document)


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


class Artefact:
    """Something claude[bot] (or anyone) left on the PR."""

    def __init__(self, kind: str, item: dict[str, Any], time_field: str) -> None:
        user = item.get("user")
        self.kind = kind
        self.login = user.get("login") if isinstance(user, dict) else None
        self.created = parse_time(item.get(time_field))
        self.url = str(item.get("html_url") or "")
        body, state = item.get("body"), item.get("state")
        self.body = body if isinstance(body, str) else ""
        self.state = state if isinstance(state, str) else ""

    @property
    def review_shaped(self) -> bool:
        """Inline comments and PR reviews only come from the review plugin; an issue
        comment counts only as the plugin's summary, never as a tag-mode reply."""
        return self.kind != "issue comment" or self.body.lstrip().startswith(REVIEW_HEADING)

    @property
    def step1_visible(self) -> bool:
        """Would the plugin's step 1 (`gh pr view <PR> --comments`) see this as Claude's
        earlier review? gh 2.96.0 prints issue comments plus pr.DisplayableReviews(),
        which drops PENDING reviews and COMMENTED reviews with an empty body, and never
        prints thread (inline) comments. A first review that found issues posts only
        inline comments (an empty COMMENTED review), so the plugin re-reviews every later
        push: those artefacts are this run's evidence when fresh, never a prior review."""
        if self.kind == "issue comment":
            return self.review_shaped
        if self.kind == "PR review":
            return self.state != "PENDING" and not (self.state == "COMMENTED" and not self.body)
        return False

    @property
    def all_clear(self) -> bool:
        return self.kind == "issue comment" and self.review_shaped and ALL_CLEAR_MARKER in self.body

    def describe(self) -> str:
        when = self.created.strftime("%Y-%m-%dT%H:%M:%SZ") if self.created else "unknown time"
        return f"{self.kind} at {when}: {self.url}"


ENDPOINTS = (
    ("issue comment", "issues/{pr}/comments", "created_at"),
    ("PR review", "pulls/{pr}/reviews", "submitted_at"),
    ("inline review comment", "pulls/{pr}/comments", "created_at"),
)


def list_artefacts(gh: GhRunner, repo: str, pr: str) -> list[Artefact]:
    artefacts = []
    for kind, path, time_field in ENDPOINTS:
        url = f"repos/{repo}/{path.format(pr=pr)}?per_page=100"
        for page in json_documents(gh(["api", "--paginate", url])):
            for item in page if isinstance(page, list) else [page]:
                if isinstance(item, dict):
                    artefacts.append(Artefact(kind, item, time_field))
    return artefacts


# -------------------------------------------------------------------------------- guard


class Verdict:
    def __init__(self, passed: bool, reason: str) -> None:
        self.passed = passed
        self.reason = reason


def _fresh_reviews(artefacts: list[Artefact], cutoff: datetime) -> list[Artefact]:
    return [
        a
        for a in artefacts
        if a.login == BOT_LOGIN
        and a.review_shaped
        and a.created is not None
        and a.created >= cutoff
    ]


def _run_guard(
    env: Mapping[str, str],
    out: TextIO,
    gh: GhRunner,
    sleep: Callable[[float], None],
    analysis: Analysis,
) -> Verdict:
    repo, pr = env.get("REPO", ""), env.get("PR_NUMBER", "")
    started = parse_time(env.get("STARTED_AT", ""))
    if not REPO_RE.fullmatch(repo):
        return Verdict(False, "REPO is not an owner/name repository slug.")
    if not re.fullmatch(r"[0-9]+", pr):
        return Verdict(False, "PR_NUMBER is not a pull request number.")
    if started is None:
        return Verdict(
            False,
            "STARTED_AT (the preflight step's review-start marker) is missing or not "
            "YYYY-MM-DDTHH:MM:SSZ, so new review artefacts cannot be told from old ones.",
        )
    if not (env.get("GH_TOKEN") or env.get("GITHUB_TOKEN")):
        return Verdict(False, "Neither GH_TOKEN nor GITHUB_TOKEN is set, so gh cannot read the PR.")

    if analysis.readable:
        out.write(
            f"Execution file: {analysis.agent_calls} Agent/Task call(s), "
            f"{analysis.background} background launch(es), {analysis.pr_view_calls} "
            f"`gh pr view` call(s), {analysis.posting_attempts} posting attempt(s).\n"
        )
        if analysis.background:
            return Verdict(
                False,
                f"claude-review launched a subagent in the BACKGROUND ({_breakdown(analysis)}). "
                "claude-code-action keeps only the FIRST result message and then kills the "
                "CLI, so that subagent's work was discarded: the 2026-10-15 PR #32 silent "
                "no-op. CLAUDE_CODE_DISABLE_BACKGROUND_TASKS did not take effect. Check the "
                "pinned action/CLI versions before trusting any review from this run, "
                "including anything it posted.",
            )

    # 1. Did claude[bot] post a review since the review step started? Retry for API
    #    failures and for read-after-write lag on a comment posted seconds ago.
    cutoff = started - CLOCK_SKEW
    artefacts, error = None, ""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            artefacts = list_artefacts(gh, repo, pr)
        except GhError as exc:
            error = str(exc)
            out.write(
                f"::warning::GitHub API query failed (attempt {attempt}/{ATTEMPTS}): {error}\n"
            )
        else:
            if _fresh_reviews(artefacts, cutoff):
                break
        if attempt < ATTEMPTS:
            sleep(RETRY_DELAY_S)
    if artefacts is None:
        return Verdict(
            False,
            f"Could not list PR #{pr}'s comments and reviews through the GitHub API "
            f"({error}), so the guard cannot verify the review was posted.",
        )

    fresh = _fresh_reviews(artefacts, cutoff)
    if fresh:
        for artefact in fresh:
            out.write(f"  - {artefact.describe()}\n")
        if not analysis.readable:
            out.write(
                f"::warning::The execution file was unreadable ({analysis.error}), so a "
                "background subagent launch could not be ruled out. A review was posted, "
                "but read it with that in mind.\n"
            )
        elif analysis.agent_calls == 0 and any(a.all_clear for a in fresh):
            out.write(
                "::warning::claude[bot] posted an all-clear but this session made no "
                "Agent/Task calls. The plugin fans its review out to subagents, so this "
                "'No issues found' may not rest on a real review.\n"
            )
        return Verdict(True, f"claude[bot] posted {len(fresh)} review artefact(s) on PR #{pr}.")

    # 2. Nothing new. Only the plugin's own step-1 stops excuse that, and only when the
    #    execution file shows a sound session.
    if not analysis.readable:
        return Verdict(
            False,
            f"The execution file was unreadable ({analysis.error}) and claude[bot] posted "
            f"no review on PR #{pr} during this run, so nothing shows a review happened.",
        )
    state = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            documents = json_documents(gh(["api", f"repos/{repo}/pulls/{pr}"]))
            state = documents[0] if documents and isinstance(documents[0], dict) else None
            if state is not None:
                break
            error = "unexpected response shape"
        except GhError as exc:
            error = str(exc)
        out.write(f"::warning::Reading PR #{pr} failed (attempt {attempt}/{ATTEMPTS}): {error}\n")
        if attempt < ATTEMPTS:
            sleep(RETRY_DELAY_S)
    if state is None:
        return Verdict(
            False,
            f"Nothing was posted, and PR #{pr}'s state could not be read ({error}) to check "
            "for a legitimate skip.",
        )
    if state.get("state") == "closed":
        merged = "merged" if state.get("merged") is True else "not merged"
        out.write(
            f"::notice::PR #{pr} was closed ({merged}) by the time the review finished. "
            "The plugin does not review closed PRs.\n"
        )
        return Verdict(True, f"No review posted: PR #{pr} is closed ({merged}).")
    if state.get("draft") is True:
        out.write(f"::notice::PR #{pr} is a draft again. The plugin does not review drafts.\n")
        return Verdict(True, f"No review posted: PR #{pr} is a draft.")
    mine = [a for a in artefacts if a.login == BOT_LOGIN]
    prior = [a for a in mine if a.step1_visible and a.created is not None and a.created < cutoff]
    if prior:
        latest = max(prior, key=lambda a: a.created or cutoff).describe()
        went_past = _past_step1(analysis)
        if went_past:
            return Verdict(
                False,
                f"claude[bot] reviewed PR #{pr} before this run ({latest}), but this session "
                f"went past the plugin's step-1 check ({went_past}) and nothing new was "
                "posted. The earlier review does not excuse that: this push was re-reviewed "
                "and the review was lost. Claude's final message is below.",
            )
        out.write(
            f"::notice::claude[bot] had already reviewed PR #{pr} before this run (latest: "
            f"{latest}). The plugin's step 1 stops once `gh pr view --comments` shows that "
            "review, so this push was not re-reviewed.\n"
        )
        return Verdict(True, f"No new review: PR #{pr} was already reviewed ({latest}).")
    others = len(mine) - len([a for a in mine if a.review_shaped])
    problem = _step1_problem(analysis)
    if not others and not problem:
        # Step 1 may also stop on "does not need code review (e.g. automated PR, trivial
        # change that is obviously correct)", which no API can confirm. Accept it only
        # from a clean step-1 session; the warning text is fixed and the model's message
        # stays inside a ::stop-commands:: block.
        out.write(
            "::warning::claude[bot] posted nothing. This session matches the code-review "
            "plugin's step-1 skip for a PR it judged not to need review (trivial or "
            "automated); no API check can confirm that judgement. Read Claude's final "
            "message in this step's log and review the PR by hand if you disagree.\n"
        )
        out.write("Claude's final message (redacted, truncated; model output, inert):\n")
        write_untrusted(out, analysis.final_message or "(no final assistant message captured)")
        return Verdict(
            True,
            f"No review posted: the plugin judged PR #{pr} not to need one (trivial or "
            "automated). See the warning.",
        )
    hint = (
        f" There are {others} other claude[bot] comment(s) on the PR (e.g. @claude tag-mode "
        "replies). Those are not reviews, but the plugin may have taken them for 'Claude "
        "has already commented'."
        if others
        else ""
    )
    trivial = " If Claude's final message below says it skipped the PR as trivial or automated"
    trivial += (
        f", note this session was not a clean step-1 stop ({problem}); check that before "
        "re-running."
        if problem
        else ", check that judgement before re-running."
    )
    return Verdict(
        False,
        f"claude-review reported success but posted nothing on PR #{pr} (no '{REVIEW_HEADING}' "
        "comment, PR review or inline comment by claude[bot] since the review started), and "
        f"the PR is open with no earlier review that step 1 can see. This is a silent "
        f"no-op.{hint}{trivial}",
    )


def _past_step1(analysis: Analysis) -> str:
    """Signs the session did more than the plugin's step-1 check (one haiku agent)."""
    signs = []
    if analysis.agent_calls > 1:
        signs.append(f"{analysis.agent_calls} Agent/Task calls")
    if analysis.posting_attempts:
        signs.append(f"{analysis.posting_attempts} posting attempt(s)")
    if analysis.posting_denials:
        signs.append(f"{analysis.posting_denials} denied posting call(s)")
    return ", ".join(signs)


def _step1_problem(analysis: Analysis) -> str:
    """Why this is not a clean step-1 stop, or '' when it is. `gh pr view` is the proof
    that step 1 ran at all: an unloaded plugin makes no gh calls."""
    signs = [_past_step1(analysis)] if _past_step1(analysis) else []
    if analysis.denials > analysis.posting_denials:
        signs.append(f"{analysis.denials - analysis.posting_denials} other permission denial(s)")
    if not analysis.pr_view_calls:
        signs.append("no `gh pr view` call, so step 1 never checked the PR")
    if analysis.result.get("subtype") != "success" or analysis.result.get("is_error") is True:
        signs.append(
            f"result subtype {_show(analysis.result.get('subtype'))}, "
            f"is_error {_show(analysis.result.get('is_error'))}"
        )
    return ", ".join(signs)


def cmd_guard(
    env: Mapping[str, str], out: TextIO, gh: GhRunner, sleep: Callable[[float], None]
) -> int:
    analysis = Analysis()
    try:
        analysis = analyse_file(env.get("EXEC_FILE", ""))
        verdict = _run_guard(env, out, gh, sleep, analysis)
    except Exception as exc:  # fail closed: a crashed guard vouches for nothing
        reason = redact(str(exc)).splitlines()[0][:200] if str(exc) else ""
        verdict = Verdict(False, f"The guard crashed ({exc.__class__.__name__}: {reason}).")
    if verdict.passed:
        out.write(verdict.reason + "\n")
    else:
        out.write(f"::error::{verdict.reason}\n")
        out.write("Claude's final message (redacted, truncated; model output, inert):\n")
        write_untrusted(out, analysis.final_message or "(no final assistant message captured)")
    status = "PASSED" if verdict.passed else "FAILED"
    append_summary(env, f"### Claude review guard: {status}\n\n{verdict.reason}\n")
    return 0 if verdict.passed else 1


# --------------------------------------------------------------------------------- main


def main(
    argv: list[str] | None = None,
    env: Mapping[str, str] | None = None,
    out: TextIO | None = None,
    gh: GhRunner | None = None,
    sleep: Callable[[float], None] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("command", choices=("diag", "guard"))
    command = parser.parse_args(argv).command
    env = os.environ if env is None else env
    out = sys.stdout if out is None else out
    if command == "diag":
        return cmd_diag(env, out)
    return cmd_guard(env, out, gh or default_gh(env), sleep or time.sleep)


if __name__ == "__main__":
    sys.exit(main())
