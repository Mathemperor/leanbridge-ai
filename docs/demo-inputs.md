# LeanBridge AI — reproducible demo input candidates

These inputs are intentionally short, mathematically unambiguous, and chosen to exercise recognizable mathlib concepts. They are **candidates**, not promises about model behavior. Record actual live outputs from the exact submission commit before using any of them in the final video.

## Candidate A — natural-number addition commutes

### Source

```text
Let a and b be natural numbers. Prove that a + b = b + a.
```

### Intended semantic target

```lean
∀ a b : Nat, a + b = b + a
```

### Why use it

- extremely easy to explain on camera;
- likely to surface a recognizable mathlib theorem such as `Nat.add_comm` during Tavily grounding;
- good for proving that the external retrieval/model/Lean path works end to end;
- may verify on the first attempt, so it is not the best choice for demonstrating repair.

## Candidate B — a real square is nonnegative

### Source

```text
Let x be a real number. Prove that x^2 is nonnegative.
```

### Intended semantic target

```lean
∀ x : ℝ, 0 ≤ x ^ 2
```

### Why use it

- still understandable without formal-methods background;
- has standard mathlib support around square nonnegativity;
- leaves more room than Candidate A for the model to choose an imperfect theorem name, coercion, or tactic and therefore produce a useful compiler diagnostic;
- concise enough to retry during a live demo.

## Candidate C — adding a nonnegative real cannot decrease a value

### Source

```text
Let x and y be real numbers and assume 0 ≤ y. Prove that x ≤ x + y.
```

### Intended semantic target

```lean
∀ x y : ℝ, 0 ≤ y → x ≤ x + y
```

### Why use it

- makes the assumption explicit and avoids ambiguity;
- can be solved through standard order lemmas or linear arithmetic;
- useful for showing that Lean checks assumptions and types rather than accepting persuasive prose;
- small enough that compiler diagnostics remain readable in the right-hand trajectory panel.

## Live selection procedure

Before recording the final video, run each candidate several times on the exact deployed submission build with the same enabled integrations that will be claimed on Devpost.

For every run, record privately:

- submission commit SHA;
- active provider/model shown by `/api/config` or the UI;
- whether Tavily grounding was enabled;
- whether the Tavily call actually succeeded;
- number of Nemotron model calls;
- number of Lean compile attempts;
- whether the first Lean attempt verified;
- final job status;
- total wall-clock duration;
- any reproducible diagnostics that make the repair loop easy to understand.

Pick the final video input based on **reliability first**. A dramatic repair cycle is useful only if it is reproducible. Never induce or fake a compiler error solely to claim that the agent repaired itself.

## Semantic-fidelity check

Before treating a green Lean result as a successful demo, compare the generated theorem statement with the intended semantic target above. Kernel verification proves the generated Lean theorem; it does not by itself prove that the model formalized the user's informal statement faithfully.
