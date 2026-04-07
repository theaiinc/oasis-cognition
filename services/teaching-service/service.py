"""Teaching service: validates user assertions, searches for evidence, asks clarifying questions."""

from __future__ import annotations

import logging
from typing import Any

from packages.reasoning_schema.models import TeachingAssertion, ValidationResult
from packages.shared_utils.config import Settings
from packages.shared_utils.llm_client import LLMClient

from services.teaching_service.web_search import search as web_search

logger = logging.getLogger(__name__)

EXTRACT_PROMPT = """\
You are analyzing a user message that is teaching or asserting something. Extract the core assertion as literally and faithfully as possible.

IMPORTANT: Decompose complex assertions into ATOMIC rules. Each rule should express exactly ONE testable claim.
- Good: "React useEffect runs after every render by default"
- Bad: "React useEffect runs after every render and you should use cleanup functions and avoid infinite loops"
  (this should be 3 separate rules)

IMPORTANT: Rules must be GENERAL GROUND TRUTH — verifiable against official documentation or widely accepted knowledge.
- Good: "Python lists are mutable" (verifiable from Python docs)
- Good: "You must proactively explore the codebase before making changes" (behavior rule)
- Bad: "The user service is in src/services/user.ts" (codebase-specific — belongs in Knowledge Graph, not rules)
- Bad: "The API uses port 3001" (project-specific configuration)

If the assertion is codebase-specific (references specific file paths, variable names, project configuration, or internal architecture), set category to "codebase_knowledge" so it gets routed to the Knowledge Graph instead.

Output a JSON object with exactly these fields:
{
  "assertion": "<the specific claim or rule the user is teaching, staying as close as possible to the user's own wording. Do NOT invent new sentences such as 'I will remember my commitment' that the user did not clearly state. If the user is giving a rule that starts with 'you ...' or 'you must ...', keep it in second person (e.g. 'You must proactively explore the codebase...').>",
  "atomic_rules": ["<list of individual atomic rules if the assertion contains multiple claims; each should be independently verifiable. If the assertion is already atomic, return a list with just that one rule.>"],
  "category": "<rule | fact | preference | pattern | correction | codebase_knowledge>",
  "domain": "<coding | business | strategy | design | operations | general>",
  "is_codebase_specific": <true if the assertion references specific file paths, variable names, project config, or internal architecture; false if it's general knowledge>,
  "supporting_context": "<any supporting reasoning the user provided; include meta-notes like 'this is a rule for the assistant' if present>",
  "search_query": "<a good web search query to verify this assertion. For codebase_knowledge, use empty string.>"
}

Output ONLY valid JSON.
"""

VALIDATE_TEMPLATE = (
    "You are a critical thinking assistant validating an assertion against web search results.\n\n"
    "Assertion: {assertion}\n"
    "{supporting_block}"
    "Category: {category}\n"
    "Domain: {domain}\n\n"
    "Web search results:\n{sources}\n\n"
    "Your task:\n"
    "1. Compare the assertion against the web sources.\n"
    "2. Identify any CONTRADICTIONS where trusted sources disagree.\n"
    "3. Identify the UNDERLYING CONCEPT — the deeper principle.\n"
    "4. Generate CLARIFYING QUESTIONS using this framework:\n"
    "   - WHY does this hold? What's the reasoning?\n"
    "   - HOW should this be applied? What are edge cases?\n"
    "   - WHAT is the underlying concept or principle?\n"
    "   - WHEN does this NOT apply? What are exceptions?\n"
    "   Ask **at most ONE** SHORT, DIRECT clarifying question. Pick the single most important uncertainty.\n"
    "   Do NOT include long explanations, advice, or psychology inside the question itself — just ask the question.\n"
    "   Keep your questions tightly focused on the user's exact assertion and domain.\n"
    "   If the assertion is a rule about assistant behavior, tool usage, or how the agent should manage work (e.g. \"you must proactively explore the codebase\"), then:\n"
    "     - Prefer to store the rule **without** asking any clarifying question when it is already concrete enough to follow.\n"
    "     - Only ask a question if you truly cannot tell what behavior is required (e.g. an ambiguous or conflicting instruction).\n"
    "     - Any such question must be about the assistant's behavior (e.g. when to auto-read files), NOT about the user's personal workflow or psychology.\n"
    "5. Assess confidence (0.0-1.0) in the assertion being correct.\n\n"
    "**Scoped / clarified claims:** If user-provided context narrows the claim (e.g. applies to "
    "shipping implementation but not to unit tests, or is a workflow preference for the assistant), "
    "then web snippets about a *different* scope are **not** contradictions. Prefer "
    "`is_validated: true`, empty `clarifying_questions`, and empty `contradictions` when the "
    "scoped claim is clear and coherent.\n\n"
    "**Preferences and agent workflow rules:** Category `preference` or rules about how the assistant "
    "should build software (e.g. avoid mock implementations in product code) are not falsified by "
    "general articles about mocks in unit testing — those are a different topic.\n\n"
    'Output a JSON object with keys: "is_validated" (bool), "contradictions" (list of strings), '
    '"underlying_concept" (string), "clarifying_questions" (list of strings), '
    '"confidence" (float 0-1), "summary" (string).\n\n'
    "If no web results were found, analyze based on your knowledge.\n"
    "Be constructive — help the user refine their knowledge.\n"
    "Output ONLY valid JSON."
)


class TeachingService:
    """Validates teaching assertions against web sources and generates clarifying questions."""

    def __init__(self, settings: Settings, llm: LLMClient | None = None) -> None:
        self._settings = settings
        self._llm = llm or LLMClient(settings)

    async def extract_assertion(self, raw_input: str, semantic_context: dict[str, Any] | None = None) -> tuple[TeachingAssertion, str]:
        """Extract the core assertion from user input.

        Returns (assertion, search_query). The assertion includes:
        - atomic_rules: list of individual verifiable rules
        - is_codebase_specific: True if this should go to Knowledge Graph instead
        """
        logger.info("Extracting assertion from: %s", raw_input[:100])

        try:
            parsed = self._llm.chat_json(system=EXTRACT_PROMPT, user_message=raw_input)
        except Exception as e:
            logger.error("Failed to extract assertion: %s", e)
            return TeachingAssertion(assertion=raw_input, category="fact", domain="general"), raw_input

        atomic_rules = parsed.get("atomic_rules", [parsed.get("assertion", raw_input)])
        is_codebase_specific = bool(parsed.get("is_codebase_specific", False))

        # If codebase_knowledge detected, override category
        category = str(parsed.get("category", "fact"))
        if is_codebase_specific and category != "codebase_knowledge":
            category = "codebase_knowledge"

        assertion = TeachingAssertion(
            assertion=str(parsed.get("assertion", raw_input)),
            category=category,
            domain=str(parsed.get("domain", "general")),
            supporting_context=str(parsed.get("supporting_context", "")),
            atomic_rules=atomic_rules,
            is_codebase_specific=is_codebase_specific,
        )

        search_query = str(parsed.get("search_query", parsed.get("assertion", raw_input)))
        return assertion, search_query

    async def validate(self, assertion: TeachingAssertion, search_query: str) -> ValidationResult:
        """Validate an assertion by searching the web and analyzing contradictions."""
        logger.info("Validating assertion: %s (domain=%s)", assertion.assertion[:80], assertion.domain)

        # Step 1: Web search
        web_results = await web_search(search_query, num_results=5)
        logger.info("Web search returned %d results", len(web_results))

        # Step 2: LLM analysis of assertion vs sources
        sources_text = ""
        if web_results:
            for i, r in enumerate(web_results, 1):
                sources_text += f"\n{i}. [{r.get('title', 'Untitled')}]({r.get('url', '')})\n   {r.get('snippet', 'No snippet')}\n"
        else:
            sources_text = "(No web results found — validate based on your knowledge)"

        supporting = (assertion.supporting_context or "").strip()
        supporting_block = ""
        if supporting:
            supporting_block = (
                "User-provided context (scopes, clarifications, how the claim should be read — "
                "use this to decide whether web snippets actually contradict the intended meaning):\n"
                f"{supporting}\n\n"
            )

        prompt = VALIDATE_TEMPLATE.format(
            assertion=assertion.assertion,
            supporting_block=supporting_block,
            category=assertion.category,
            domain=assertion.domain,
            sources=sources_text,
        )
        if "User clarification:" in supporting:
            prompt += (
                "\n\nNOTE: The user already replied to a prior clarifying turn. If their message "
                "rescopes the claim, generic web hits about a different scope are not contradictions. "
                "Prefer `is_validated: true` with empty `clarifying_questions` unless something "
                "material is still unclear about what they want stored."
            )

        try:
            user_msg = f"Validate: {assertion.assertion}"
            if supporting:
                user_msg += f"\n\nContext to apply:\n{supporting}"
            parsed = self._llm.chat_json(system=prompt, user_message=user_msg)
        except Exception as e:
            logger.error("Validation LLM call failed: %s", e)
            return ValidationResult(
                assertion=assertion.assertion,
                is_validated=False,
                clarifying_questions=["Could you explain more about why you believe this?"],
                confidence=0.3,
                summary="Validation could not be completed. Please elaborate.",
            )

        # Coerce types defensively – ensure lists of plain strings
        contradictions_raw = parsed.get("contradictions", [])
        if not isinstance(contradictions_raw, list):
            contradictions_raw = [contradictions_raw] if contradictions_raw else []
        contradictions: list[str] = []
        for c in contradictions_raw:
            if isinstance(c, dict):
                # Join all dict values into a single string for readability.
                contradictions.append(" ".join(str(v) for v in c.values()))
            else:
                contradictions.append(str(c))

        questions_raw = parsed.get("clarifying_questions", [])
        if not isinstance(questions_raw, list):
            questions_raw = [questions_raw] if questions_raw else []
        questions: list[str] = []
        for q in questions_raw:
            if isinstance(q, dict):
                # Some models may emit structured questions like {"why_question": "..."}; flatten values.
                questions.append(" ".join(str(v) for v in q.values()))
            else:
                questions.append(str(q))
        # Heuristic: assistant workflow / implementation-discipline rules — avoid nitpicking via web.
        text = f"{assertion.assertion or ''} {assertion.supporting_context or ''}".lower()
        is_behavior_rule = any(
            phrase in text
            for phrase in (
                "you must ",
                "you need to ",
                "you should ",
                "assistant must ",
                "the agent must ",
                "proactively",
                "explore the codebase",
                "explore the files",
                "never implement",
                "do not mock",
                "don't mock",
                "dont mock",
                "no mock",
                "avoid mock",
                "real implementation",
                "stub implementation",
                " mock",
                "mocking ",
            )
        )
        is_preference = (assertion.category or "").lower() == "preference"
        if is_behavior_rule or is_preference:
            questions = []
        else:
            # Otherwise, keep at most one clarifying question to reduce user burden.
            if len(questions) > 1:
                questions = questions[:1]

        confidence = parsed.get("confidence", 0.5)
        if not isinstance(confidence, (int, float)):
            try:
                confidence = float(confidence)
            except (ValueError, TypeError):
                confidence = 0.5

        return ValidationResult(
            assertion=assertion.assertion,
            is_validated=bool(parsed.get("is_validated", False)),
            web_sources=web_results,
            contradictions=contradictions,
            clarifying_questions=questions,
            underlying_concept=str(parsed.get("underlying_concept", "")),
            confidence=min(1.0, max(0.0, confidence)),
            summary=str(parsed.get("summary", "")),
        )

    def _accept_after_scope_clarification(
        self,
        refined: TeachingAssertion,
        validation: ValidationResult,
        user_clarification: str,
    ) -> ValidationResult:
        """If the user separated implementation vs testing (etc.), stop re-asking the same question."""
        u = (user_clarification or "").lower().strip()
        if len(u) < 12:
            return validation
        implies_impl_vs_test = (
            (("not" in u or "n't" in u) and "test" in u)
            or ("aside" in u and "test" in u)
            or ("except" in u and "test" in u)
            or (("implementation" in u or "implement" in u) and ("mock" in u or "stub" in u or "lazy" in u))
            or ("in test" in u and ("fine" in u or "ok" in u or "okay" in u))
        )
        if not implies_impl_vs_test:
            return validation
        return ValidationResult(
            assertion=validation.assertion,
            is_validated=True,
            web_sources=validation.web_sources,
            contradictions=[],
            clarifying_questions=[],
            underlying_concept=validation.underlying_concept
            or (refined.supporting_context[:500] if refined.supporting_context else ""),
            confidence=max(float(validation.confidence or 0), 0.72),
            summary=(
                "Accepted with your clarification: the stored rule is scoped to what you meant "
                "(distinct from generic web material about a different context such as unit testing)."
            ),
        )

    async def continue_from_clarification(
        self,
        assertion: TeachingAssertion,
        search_query: str,
        user_clarification: str,
        prior_validation: dict[str, Any] | None = None,
    ) -> tuple[TeachingAssertion, str, ValidationResult]:
        """Re-validate after user answers: refine assertion + query, then validate."""
        merged_supporting = (
            (assertion.supporting_context or "")
            + (
                "\n\nPrior validation summary:\n" + str(prior_validation.get("summary"))
                if prior_validation and prior_validation.get("summary")
                else ""
            )
            + (f"\n\nUser clarification:\n{user_clarification.strip()}" if user_clarification else "")
        ).strip()

        refine_payload = (
            "The user is clarifying a teaching statement they gave earlier.\n\n"
            f"Previously extracted assertion: {assertion.assertion}\n"
            f"Category: {assertion.category} | Domain: {assertion.domain}\n\n"
            "User's clarification (their latest message):\n"
            f"{user_clarification.strip()}\n\n"
            "Merge into a single clear assertion that reflects BOTH. If they narrowed scope "
            "(e.g. not about unit tests / about shipping implementation), state that scope "
            "EXPLICITLY in the assertion text so validators are not confused by adjacent topics."
        )

        try:
            refined, new_query = await self.extract_assertion(refine_payload)
            if assertion.is_codebase_specific and not refined.is_codebase_specific:
                refined = refined.model_copy(
                    update={"is_codebase_specific": True, "category": "codebase_knowledge"}
                )
            refined = refined.model_copy(update={"supporting_context": merged_supporting})
        except Exception:
            refined = TeachingAssertion(
                assertion=assertion.assertion,
                category=assertion.category,
                domain=assertion.domain,
                supporting_context=merged_supporting,
                atomic_rules=assertion.atomic_rules,
                is_codebase_specific=assertion.is_codebase_specific,
            )
            new_query = search_query or refined.assertion

        sq = (new_query or "").strip()
        if sq.lower() == (assertion.assertion or "").strip().lower() and user_clarification.strip():
            sq = f"{assertion.assertion} {user_clarification.strip()}"[:280]

        validation = await self.validate(refined, sq or refined.assertion)
        validation = self._accept_after_scope_clarification(refined, validation, user_clarification)
        return refined, sq or refined.assertion, validation
